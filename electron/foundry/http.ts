import type { FoundryConfig } from "../../common/foundry";
import { createLogger } from "../logger";

/**
 * The shared Azure AI Foundry transport: one POST-with-retry, one status→message
 * taxonomy, and the small primitives both of them need.
 *
 * Extracted from `agent.ts` when the narration transcriber (`transcribe.ts`) became
 * the second caller. Both surfaces must fail the *same* way — the same 429/5xx retry
 * budget, the same "check the connection settings" copy on 401, the same
 * never-log-the-key rule — so the behavior lives here once instead of being copied.
 *
 * The logger tag stays `Foundry` so existing log lines read exactly as before.
 */

const log = createLogger("Foundry");

/** Statuses worth retrying — throttling and transient gateway failures. */
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

/** Total attempts per request (1 initial + 2 retries). */
const MAX_ATTEMPTS = 3;

/** Backoff before attempt n+1, indexed by the attempt that just failed. */
const BACKOFF_MS = [1_000, 2_000];

/** Never honor a `Retry-After` longer than this — the caller has its own deadline. */
const MAX_RETRY_AFTER_MS = 30_000;

export const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * Both auth headers: the Azure OpenAI data plane reads `api-key`, the newer Foundry
 * surface reads the bearer token, and the two are the same key. No `Content-Type` —
 * a JSON caller adds its own, a multipart caller must let `fetch` set the boundary.
 */
export function authHeaders(config: FoundryConfig): Record<string, string> {
  return { "api-key": config.apiKey, Authorization: `Bearer ${config.apiKey}` };
}

export interface PostOptions {
  url: string;
  /** Resource origin, for the unreachable-endpoint message. Never the key. */
  endpoint: string;
  /** Deployment name, for the 404 message. */
  model: string;
  signal: AbortSignal;
  /**
   * Rebuilt per attempt: a tolerated surface downgrade (see {@link onBadRequest})
   * must change the payload we resend.
   */
  init: () => RequestInit;
  /**
   * Surface-drift hook. Called with an HTTP 400's detail; return `true` to resend
   * once with whatever the handler changed, `false` to fail with that detail.
   */
  onBadRequest?: (detail: string) => boolean;
}

/**
 * One POST with the shared retry policy. Returns the `ok` response; every other
 * outcome throws a user-facing Error (the messages land in UI banners verbatim).
 */
export async function postWithRetry(options: PostOptions): Promise<Response> {
  let attempt = 1;
  for (;;) {
    let response: Response;
    try {
      response = await fetch(options.url, {
        method: "POST",
        signal: options.signal,
        ...options.init(),
      });
    } catch (err) {
      // An abort is not a network problem — let the caller map it to its reason.
      if (options.signal.aborted) throw err;
      log.warn(`request to ${options.endpoint} failed:`, msg(err));
      throw new Error(
        `Could not reach ${options.endpoint}. Check your network and the endpoint URL.`,
      );
    }
    if (response.ok) return response;

    if (response.status === 400 && options.onBadRequest) {
      const detail = await errorDetail(response);
      if (options.onBadRequest(detail)) continue;
      throw statusError(response.status, response.statusText, detail, options.model);
    }

    if (RETRYABLE_STATUS.has(response.status) && attempt < MAX_ATTEMPTS) {
      log.warn(
        `HTTP ${response.status} from Azure AI Foundry; retrying (attempt ${attempt + 1}/${MAX_ATTEMPTS}).`,
      );
      await delay(retryDelayMs(response, attempt), options.signal);
      attempt += 1;
      continue;
    }
    throw await httpError(response, options.model);
  }
}

/** The Error an aborted turn should surface (a timeout message, or the cancel one). */
export function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error("The agent turn was canceled.");
}

/** Sleep that rejects promptly when the caller aborts mid-backoff. */
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Honor a numeric `Retry-After` (capped), else the fixed 1s/2s backoff. */
export function retryDelayMs(response: Response, attempt: number): number {
  const header = response.headers?.get("retry-after");
  if (header) {
    const seconds = Number(header.trim());
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS);
    }
  }
  return BACKOFF_MS[attempt - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1];
}

/**
 * Map a failed response to a user-facing message — these land in UI banners
 * verbatim, so they name the fix, not the stack. The API key appears in none of
 * them (the detail comes from the server's own body).
 */
export async function httpError(response: Response, model: string): Promise<Error> {
  return statusError(response.status, response.statusText, await errorDetail(response), model);
}

export function statusError(
  status: number,
  statusText: string,
  detail: string,
  model: string,
): Error {
  const suffix = detail ? ` ${detail}` : "";
  if (status === 401 || status === 403) {
    return new Error(
      `Azure AI Foundry rejected the API key (HTTP ${status}). Check the connection settings.${suffix}`,
    );
  }
  if (status === 404) {
    return new Error(
      `Azure AI Foundry could not find the "${model}" deployment (HTTP 404). Check the endpoint and deployment name.${suffix}`,
    );
  }
  if (status === 429) {
    return new Error("Azure AI Foundry is rate-limiting requests (HTTP 429). Try again in a moment.");
  }
  return new Error(
    `Azure AI Foundry request failed (HTTP ${status}): ${detail || statusText || "no details"}`,
  );
}

/** `error.message` from a JSON body, else the first 300 characters of it. */
export async function errorDetail(response: Response): Promise<string> {
  let text = "";
  try {
    text = await response.text();
  } catch {
    return "";
  }
  if (!text.trim()) return "";
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } };
    const message = parsed?.error?.message;
    if (typeof message === "string" && message.trim()) return message.trim();
  } catch {
    // Not JSON — fall through to the raw prefix.
  }
  return text.slice(0, 300);
}
