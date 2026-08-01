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

/**
 * Speech-to-text deployment used when neither the env nor the config file names one.
 * Separate from {@link DEFAULT_FOUNDRY_DEPLOYMENT} because a codex-class chat
 * deployment cannot transcribe audio — voice narration needs its own deployment.
 */
export const DEFAULT_FOUNDRY_TRANSCRIPTION_DEPLOYMENT = "gpt-4o-transcribe";

/**
 * Deployment the **describer** runs on when neither the env nor the config file names
 * one — deliberately *not* {@link DEFAULT_FOUNDRY_DEPLOYMENT}.
 *
 * Chosen 2026-08-01 by a measured cost/quality A/B (see `docs/plans/progress.md`):
 * `gpt-5.2` scored 100.0% mean rubric score over 27 runs at **$0.049/analysis**, versus
 * `gpt-5.6-sol` at 99.6% and **$0.141/analysis** — 2.9× cheaper at equal-or-better
 * quality. The describer's job is evidence interpretation + vision, a general-model
 * task; the *builders* write code and stay on the codex deployment
 * ({@link DEFAULT_FOUNDRY_DEPLOYMENT}).
 */
export const DEFAULT_FOUNDRY_DESCRIBER_DEPLOYMENT = "gpt-5.2";

/** A complete connection to one Foundry/Azure OpenAI deployment. Contains the key. */
export interface FoundryConfig {
  /** Resource origin only, e.g. `https://<resource>.openai.azure.com` (no path). */
  endpoint: string;
  apiKey: string;
  /** Model deployment name. */
  deployment: string;
  /**
   * Speech-to-text deployment used for voice narration. Resolved to
   * {@link DEFAULT_FOUNDRY_TRANSCRIPTION_DEPLOYMENT} when nothing names one, so a
   * loaded config always carries it.
   */
  transcriptionDeployment?: string;
  /**
   * Deployment the describer (evidence interpretation + vision) runs on, separate from
   * the code-writing {@link deployment} the builders use. Resolved to
   * {@link DEFAULT_FOUNDRY_DESCRIBER_DEPLOYMENT} when nothing names one, so a loaded
   * config always carries it.
   */
  describerDeployment?: string;
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
