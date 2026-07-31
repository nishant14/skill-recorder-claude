import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_FOUNDRY_DEPLOYMENT,
  normalizeFoundryEndpoint,
  type FoundryConfig,
  type FoundryConfigSource,
  type FoundryConnectionInfo,
} from "../../common/foundry";
import { createLogger } from "../logger";

/**
 * Resolves the Azure AI Foundry connection for this computer, in precedence order
 * **env → file**, and persists the file half.
 *
 * Env comes first so CI, the eval harness, and `AZURE_OPENAI_*`-shaped shells keep
 * working without touching the user profile; the file (`<configDir>/foundry.json`)
 * is what the in-app connection form writes. `SKILL_RECORDER_MODEL` overrides the
 * deployment from *either* source because the evals' `--model` flag sets it.
 *
 * Electron-free on purpose (no `app.getPath`): the eval harness loads this module
 * outside Electron, so the config dir is derived from env + `os.homedir()`.
 */

const log = createLogger("FoundryConfig");

/** `SKILL_RECORDER_CONFIG_DIR` (used by tests/evals to stay out of the real home dir). */
function configDir(): string {
  return process.env.SKILL_RECORDER_CONFIG_DIR || path.join(os.homedir(), ".skill-recorder");
}

/** Absolute path of the stored connection — shown in the UI as the manual fallback. */
export function foundryConfigFile(): string {
  return path.join(configDir(), "foundry.json");
}

/** What we tolerate reading out of `foundry.json` — every field is unvalidated JSON. */
interface StoredFoundryConfig {
  endpoint?: unknown;
  apiKey?: unknown;
  deployment?: unknown;
  apiVersion?: unknown;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Deployment override that applies to both sources (evals' `--model`). */
function modelOverride(): string {
  return str(process.env.SKILL_RECORDER_MODEL);
}

/**
 * Endpoint *and* key must both be present in the environment, or env is skipped
 * entirely — a half-configured env (endpoint only) must fall through to the file
 * rather than shadow it with an unusable connection.
 */
function fromEnv(): FoundryConfig | null {
  const endpoint = str(process.env.AZURE_OPENAI_ENDPOINT || process.env.FOUNDRY_ENDPOINT);
  const apiKey = str(process.env.AZURE_OPENAI_API_KEY || process.env.FOUNDRY_API_KEY);
  if (!endpoint || !apiKey) return null;
  const deployment = modelOverride() || str(process.env.AZURE_OPENAI_DEPLOYMENT) || DEFAULT_FOUNDRY_DEPLOYMENT;
  const apiVersion = str(process.env.AZURE_OPENAI_API_VERSION);
  return {
    endpoint: normalizeFoundryEndpoint(endpoint),
    apiKey,
    deployment,
    ...(apiVersion ? { apiVersion } : {}),
  };
}

/**
 * Read the stored connection. A missing, unreadable, or unparseable file is not an
 * error — it just means "not configured", so a corrupt file can never wedge the app
 * (the user can re-save from the connection form).
 */
function fromFile(): FoundryConfig | null {
  const file = foundryConfigFile();
  if (!existsSync(file)) return null;
  let stored: unknown;
  try {
    stored = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    log.warn(`could not read ${file}:`, err instanceof Error ? err.message : String(err));
    return null;
  }
  if (!stored || typeof stored !== "object") {
    log.warn(`ignoring ${file}: expected a JSON object.`);
    return null;
  }
  const raw = stored as StoredFoundryConfig;
  const endpoint = str(raw.endpoint);
  const apiKey = str(raw.apiKey);
  if (!endpoint || !apiKey) return null;
  const deployment = modelOverride() || str(raw.deployment) || DEFAULT_FOUNDRY_DEPLOYMENT;
  const apiVersion = str(raw.apiVersion);
  return {
    endpoint: normalizeFoundryEndpoint(endpoint),
    apiKey,
    deployment,
    ...(apiVersion ? { apiVersion } : {}),
  };
}

/** The active connection plus where it came from, or null when unconfigured. */
export function loadFoundryConfig(): { config: FoundryConfig; source: FoundryConfigSource } | null {
  const env = fromEnv();
  if (env) return { config: env, source: "env" };
  const file = fromFile();
  if (file) return { config: file, source: "file" };
  return null;
}

/**
 * Validate and persist a connection from the in-app form. Throws user-facing
 * messages (they land in the form's error slot verbatim). The file is written
 * `0600` — a no-op on Windows, which is acceptable because it sits in the user
 * profile there.
 */
export function saveFoundryConfig(input: {
  endpoint: string;
  apiKey: string;
  deployment?: string;
  apiVersion?: string;
}): FoundryConfig {
  const endpoint = normalizeFoundryEndpoint(input.endpoint ?? "");
  if (!endpoint.startsWith("https://")) {
    throw new Error("The endpoint must be an https:// URL from your Azure AI Foundry resource.");
  }
  const apiKey = (input.apiKey ?? "").trim();
  if (!apiKey) throw new Error("An API key is required.");
  const apiVersion = (input.apiVersion ?? "").trim();
  const config: FoundryConfig = {
    endpoint,
    apiKey,
    deployment: (input.deployment ?? "").trim() || DEFAULT_FOUNDRY_DEPLOYMENT,
    ...(apiVersion ? { apiVersion } : {}),
  };
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(foundryConfigFile(), JSON.stringify(config, null, 2), { mode: 0o600 });
  return config;
}

/** `loadFoundryConfig()` minus the key — safe to hand to the renderer. */
export function foundryConnectionInfo(): FoundryConnectionInfo {
  const loaded = loadFoundryConfig();
  if (!loaded) return { configured: false, endpoint: null, deployment: null, source: null };
  return {
    configured: true,
    endpoint: loaded.config.endpoint,
    deployment: loaded.config.deployment,
    source: loaded.source,
  };
}
