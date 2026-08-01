import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import {
  DEFAULT_FOUNDRY_DEPLOYMENT,
  DEFAULT_FOUNDRY_TRANSCRIPTION_DEPLOYMENT,
  normalizeFoundryEndpoint,
} from "../../common/foundry";
import { foundryConfigFile, foundryConnectionInfo, loadFoundryConfig, saveFoundryConfig } from "./config";

/**
 * Covers the Foundry connection resolver: the env → file precedence (including a
 * half-configured env falling through), the save/load round-trip, the
 * `SKILL_RECORDER_MODEL` deployment override, save-time validation and endpoint
 * normalization, corrupt-file tolerance, and the two secret-handling guarantees
 * (key-free connection info, `0600` on the stored file).
 */

/** Verbatim copies of the user-facing messages — the assertions are the contract. */
const HTTPS_ERROR = "The endpoint must be an https:// URL from your Azure AI Foundry resource.";
const API_KEY_ERROR = "An API key is required.";

/**
 * Every var the module reads. Each test gets them cleared and a private config dir,
 * and the originals go back afterwards so nothing leaks into the other test files
 * sharing this process.
 */
const MANAGED_ENV = [
  "SKILL_RECORDER_CONFIG_DIR",
  "SKILL_RECORDER_MODEL",
  "AZURE_OPENAI_ENDPOINT",
  "FOUNDRY_ENDPOINT",
  "AZURE_OPENAI_API_KEY",
  "FOUNDRY_API_KEY",
  "AZURE_OPENAI_DEPLOYMENT",
  "AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT",
  "FOUNDRY_TRANSCRIPTION_DEPLOYMENT",
  "AZURE_OPENAI_API_VERSION",
] as const;

const savedEnv = new Map<string, string | undefined>();
let configDir = "";

beforeEach(() => {
  for (const name of MANAGED_ENV) {
    savedEnv.set(name, process.env[name]);
    // Cleared, not just saved: a developer shell or CI runner with real
    // AZURE_OPENAI_* values would otherwise defeat the file-fallback tests.
    delete process.env[name];
  }
  configDir = mkdtempSync(path.join(os.tmpdir(), "skill-recorder-foundry-"));
  process.env.SKILL_RECORDER_CONFIG_DIR = configDir;
});

afterEach(() => {
  for (const name of MANAGED_ENV) {
    const previous = savedEnv.get(name);
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
  savedEnv.clear();
  rmSync(configDir, { recursive: true, force: true });
});

test("env wins over the stored file, but a half-configured env falls through to it", () => {
  saveFoundryConfig({
    endpoint: "https://file.openai.azure.com",
    apiKey: "file-key",
    deployment: "file-model",
  });

  process.env.AZURE_OPENAI_ENDPOINT = "https://env.openai.azure.com";
  process.env.AZURE_OPENAI_API_KEY = "env-key";
  process.env.AZURE_OPENAI_DEPLOYMENT = "env-model";
  const fromEnv = loadFoundryConfig();
  assert.equal(fromEnv?.source, "env");
  assert.equal(fromEnv?.config.endpoint, "https://env.openai.azure.com");
  assert.equal(fromEnv?.config.apiKey, "env-key");
  assert.equal(fromEnv?.config.deployment, "env-model");

  // The FOUNDRY_* aliases resolve the same connection as the AZURE_OPENAI_* pair.
  delete process.env.AZURE_OPENAI_ENDPOINT;
  delete process.env.AZURE_OPENAI_API_KEY;
  process.env.FOUNDRY_ENDPOINT = "https://alias.openai.azure.com";
  process.env.FOUNDRY_API_KEY = "alias-key";
  assert.equal(loadFoundryConfig()?.config.endpoint, "https://alias.openai.azure.com");

  // Endpoint without a key is unusable, so env is skipped entirely rather than
  // shadowing the stored connection with something that cannot make a request.
  delete process.env.FOUNDRY_API_KEY;
  const fallthrough = loadFoundryConfig();
  assert.equal(fallthrough?.source, "file");
  assert.equal(fallthrough?.config.endpoint, "https://file.openai.azure.com");
  assert.equal(fallthrough?.config.apiKey, "file-key");
  assert.equal(fallthrough?.config.deployment, "file-model");
});

test("saveFoundryConfig round-trips through loadFoundryConfig", () => {
  const saved = saveFoundryConfig({
    endpoint: "https://res.openai.azure.com/",
    apiKey: "  round-trip-key  ",
    deployment: "gpt-5.3-codex-mini",
    transcriptionDeployment: "whisper-1",
    apiVersion: "2024-12-01-preview",
  });
  assert.deepEqual(saved, {
    endpoint: "https://res.openai.azure.com",
    apiKey: "round-trip-key",
    deployment: "gpt-5.3-codex-mini",
    transcriptionDeployment: "whisper-1",
    apiVersion: "2024-12-01-preview",
  });

  assert.equal(foundryConfigFile(), path.join(configDir, "foundry.json"));
  const loaded = loadFoundryConfig();
  assert.equal(loaded?.source, "file");
  assert.deepEqual(loaded?.config, saved);
});

test("SKILL_RECORDER_MODEL overrides the deployment from either source", () => {
  saveFoundryConfig({
    endpoint: "https://file.openai.azure.com",
    apiKey: "file-key",
    deployment: "file-model",
  });
  // Set after the save so the stored file still names its own deployment — the
  // override applies at load time, it is never persisted.
  process.env.SKILL_RECORDER_MODEL = "override-model";

  const fromFile = loadFoundryConfig();
  assert.equal(fromFile?.source, "file");
  assert.equal(fromFile?.config.deployment, "override-model");

  process.env.AZURE_OPENAI_ENDPOINT = "https://env.openai.azure.com";
  process.env.AZURE_OPENAI_API_KEY = "env-key";
  process.env.AZURE_OPENAI_DEPLOYMENT = "env-model";
  const fromEnv = loadFoundryConfig();
  assert.equal(fromEnv?.source, "env");
  assert.equal(fromEnv?.config.deployment, "override-model");
});

test("the transcription deployment resolves from env, from the file, or from the default", () => {
  // Nothing names one → the default is applied at read, from either source, so a
  // loaded config always carries a usable speech-to-text deployment.
  saveFoundryConfig({ endpoint: "https://file.openai.azure.com", apiKey: "file-key" });
  assert.equal(
    loadFoundryConfig()?.config.transcriptionDeployment,
    DEFAULT_FOUNDRY_TRANSCRIPTION_DEPLOYMENT,
  );
  assert.equal(DEFAULT_FOUNDRY_TRANSCRIPTION_DEPLOYMENT, "gpt-4o-transcribe");

  // The stored file field wins over the default…
  saveFoundryConfig({
    endpoint: "https://file.openai.azure.com",
    apiKey: "file-key",
    transcriptionDeployment: "file-stt",
  });
  assert.equal(loadFoundryConfig()?.config.transcriptionDeployment, "file-stt");
  // …and it is persisted as its own field, separate from the chat deployment.
  const stored = JSON.parse(readFileSync(foundryConfigFile(), "utf8")) as Record<string, unknown>;
  assert.equal(stored.transcriptionDeployment, "file-stt");
  assert.equal(stored.deployment, DEFAULT_FOUNDRY_DEPLOYMENT);

  // Env resolves its own connection, including its own transcription deployment.
  process.env.AZURE_OPENAI_ENDPOINT = "https://env.openai.azure.com";
  process.env.AZURE_OPENAI_API_KEY = "env-key";
  assert.equal(
    loadFoundryConfig()?.config.transcriptionDeployment,
    DEFAULT_FOUNDRY_TRANSCRIPTION_DEPLOYMENT,
  );
  process.env.AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT = "env-stt";
  assert.equal(loadFoundryConfig()?.config.transcriptionDeployment, "env-stt");

  // FOUNDRY_* is the accepted alias, exactly as for the endpoint and key.
  delete process.env.AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT;
  process.env.FOUNDRY_TRANSCRIPTION_DEPLOYMENT = "alias-stt";
  assert.equal(loadFoundryConfig()?.config.transcriptionDeployment, "alias-stt");

  // SKILL_RECORDER_MODEL retargets the chat deployment only — the evals' `--model`
  // must never silently point transcription at a model that cannot transcribe.
  process.env.SKILL_RECORDER_MODEL = "override-model";
  const overridden = loadFoundryConfig();
  assert.equal(overridden?.config.deployment, "override-model");
  assert.equal(overridden?.config.transcriptionDeployment, "alias-stt");
});

test("saveFoundryConfig validates its input, defaults the deployment, and normalizes the endpoint", () => {
  assert.throws(() => saveFoundryConfig({ endpoint: "http://res.openai.azure.com", apiKey: "k" }), {
    message: HTTPS_ERROR,
  });
  assert.throws(() => saveFoundryConfig({ endpoint: "res.openai.azure.com", apiKey: "k" }), {
    message: HTTPS_ERROR,
  });
  assert.throws(() => saveFoundryConfig({ endpoint: "https://res.openai.azure.com", apiKey: "   " }), {
    message: API_KEY_ERROR,
  });
  // A rejected save must not have written anything.
  assert.equal(loadFoundryConfig(), null);

  const config = saveFoundryConfig({
    endpoint:
      "  https://res.openai.azure.com/openai/deployments/gpt-5.3-codex/chat/completions?api-version=2024-12-01-preview  ",
    apiKey: "k",
    apiVersion: "  ",
  });
  assert.equal(config.endpoint, "https://res.openai.azure.com");
  assert.equal(config.deployment, DEFAULT_FOUNDRY_DEPLOYMENT);
  assert.equal(DEFAULT_FOUNDRY_DEPLOYMENT, "gpt-5.3-codex");
  // A blank apiVersion is dropped, not stored as "" — its presence is what selects
  // the legacy data-plane route.
  assert.deepEqual(JSON.parse(readFileSync(foundryConfigFile(), "utf8")), {
    endpoint: "https://res.openai.azure.com",
    apiKey: "k",
    deployment: "gpt-5.3-codex",
  });
});

test("a corrupt or incomplete foundry.json is ignored instead of throwing", () => {
  const file = foundryConfigFile();
  mkdirSync(path.dirname(file), { recursive: true });

  // Each of these logs a warning (tag FoundryConfig) and resolves to "not
  // configured" so a bad file can never wedge the app.
  writeFileSync(file, "{ not json at all");
  assert.equal(loadFoundryConfig(), null);
  assert.equal(foundryConnectionInfo().configured, false);

  writeFileSync(file, '"a bare string"');
  assert.equal(loadFoundryConfig(), null);

  writeFileSync(file, JSON.stringify({ endpoint: "https://res.openai.azure.com" }));
  assert.equal(loadFoundryConfig(), null);

  writeFileSync(file, JSON.stringify({ endpoint: "https://res.openai.azure.com", apiKey: "k" }));
  assert.equal(loadFoundryConfig()?.config.deployment, DEFAULT_FOUNDRY_DEPLOYMENT);
});

test("foundryConnectionInfo never exposes the key and the stored file is 0600", () => {
  const fileKey = "file-secret-key-0123456789";
  saveFoundryConfig({
    endpoint: "https://res.openai.azure.com",
    apiKey: fileKey,
    deployment: "gpt-5.3-codex",
  });

  const fileInfo = foundryConnectionInfo();
  assert.deepEqual(fileInfo, {
    configured: true,
    endpoint: "https://res.openai.azure.com",
    deployment: "gpt-5.3-codex",
    source: "file",
  });
  assert.ok(!JSON.stringify(fileInfo).includes(fileKey));

  const envKey = "env-secret-key-9876543210";
  process.env.AZURE_OPENAI_ENDPOINT = "https://env.openai.azure.com";
  process.env.AZURE_OPENAI_API_KEY = envKey;
  const envInfo = foundryConnectionInfo();
  assert.equal(envInfo.source, "env");
  assert.ok(!JSON.stringify(envInfo).includes(envKey));

  // Windows has no POSIX mode bits; the file sits in the user profile there.
  if (process.platform !== "win32") {
    assert.equal(statSync(foundryConfigFile()).mode & 0o777, 0o600);
  }
});

test("normalizeFoundryEndpoint reduces pasted portal URLs to the resource origin", () => {
  const table: [input: string, expected: string][] = [
    ["https://res.openai.azure.com/", "https://res.openai.azure.com"],
    [
      "https://res.openai.azure.com/openai/deployments/gpt-5.3-codex/chat/completions?api-version=2024-12-01-preview",
      "https://res.openai.azure.com",
    ],
    ["https://res.cognitiveservices.azure.com/", "https://res.cognitiveservices.azure.com"],
    [" https://res.services.ai.azure.com/api/projects/p ", "https://res.services.ai.azure.com"],
    // No scheme: normalization never throws, it just trims — rejecting this is
    // saveFoundryConfig's job.
    ["res.openai.azure.com", "res.openai.azure.com"],
  ];
  for (const [input, expected] of table) assert.equal(normalizeFoundryEndpoint(input), expected);

  assert.throws(() => saveFoundryConfig({ endpoint: "res.openai.azure.com", apiKey: "k" }), {
    message: HTTPS_ERROR,
  });
});
