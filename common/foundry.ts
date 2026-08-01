/**
 * Shared Azure AI Foundry vocabulary: the connection shape, the key-free view the
 * renderer is allowed to see, and the "not configured yet" error contract.
 *
 * Renderer-safe by construction — this module imports **nothing** (no `node:*`, no
 * `electron`, no sibling modules), so it can be pulled into the preload/renderer
 * bundle and into Electron-free test harnesses alike. Anything that needs the
 * filesystem lives in `electron/foundry/config.ts`.
 */

/** Deployment used when neither the env nor the config file names one. */
export const DEFAULT_FOUNDRY_DEPLOYMENT = "gpt-5.3-codex";

/** A complete connection to one Foundry/Azure OpenAI deployment. Contains the key. */
export interface FoundryConfig {
  /** Resource origin only, e.g. `https://<resource>.openai.azure.com` (no path). */
  endpoint: string;
  apiKey: string;
  /** Model deployment name. */
  deployment: string;
  /**
   * Escape hatch: when set, requests use the legacy data-plane route
   * (`/openai/deployments/<name>/chat/completions?api-version=…`) instead of the
   * modern `/openai/v1` route. Left unset for normal use.
   */
  apiVersion?: string;
}

/** Where a resolved config came from — env wins over the on-disk file. */
export type FoundryConfigSource = "env" | "file";

/** Key-free view — the only shape the renderer ever sees. */
export interface FoundryConnectionInfo {
  configured: boolean;
  endpoint: string | null;
  deployment: string | null;
  source: FoundryConfigSource | null;
}

/**
 * Message every Foundry-backed feature throws when this computer has no endpoint +
 * key yet. The renderer substring-matches it (see {@link isFoundryNotConfiguredError})
 * to swap the generic error banner for the connection form.
 */
export const FOUNDRY_NOT_CONFIGURED_ERROR =
  "Azure AI Foundry isn't configured on this computer yet. Add your endpoint and API key below, then try again.";

/** Whether an error from a Foundry-backed feature means "no connection stored yet". */
export function isFoundryNotConfiguredError(error?: string | null): boolean {
  return typeof error === "string" && error.includes("isn't configured on this computer");
}

/**
 * Reduce whatever the user pasted to the resource origin. People copy the full
 * *target URI* out of the portal (`…/openai/deployments/<name>/chat/completions?api-version=…`),
 * and we build our own paths from the origin, so the path and query must go.
 * A string without an `https://` scheme is returned trimmed and left for
 * `saveFoundryConfig` to reject with the https error — normalization never throws.
 */
export function normalizeFoundryEndpoint(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  const origin = /^(https:\/\/[^/]+)/.exec(trimmed);
  return origin ? origin[1] : trimmed;
}
