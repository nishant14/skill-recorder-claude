import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import { DEFAULT_FOUNDRY_TRANSCRIPTION_DEPLOYMENT, type FoundryConfig } from "../../common/foundry";
import { encodeWav } from "../audio/wav";
import {
  resetTranscriptionFormatDowngrade,
  transcribeWavOnFoundry,
  transcriptionDeployment,
} from "./transcribe";

/**
 * Unit tests for the cloud transcription call. Every test swaps `globalThis.fetch`
 * for a scripted fake and restores it in a `finally`, so the file runs offline:
 * nothing here ever opens a socket.
 *
 * The assertions are about the **multipart request** we build and the taxonomy of
 * failures we map — those are the contract with the deployment. The `verbose_json`
 * → `json` downgrade gets its own tests because it is a tolerated surface drift
 * (the G1 precedent) that must happen exactly once and then be remembered.
 */

const API_KEY = "transcription-test-key";

const CONFIG: FoundryConfig = {
  endpoint: "https://unit.test.invalid",
  apiKey: API_KEY,
  deployment: "gpt-5.3-codex",
  transcriptionDeployment: "gpt-4o-transcribe",
};

const URL = "https://unit.test.invalid/openai/v1/audio/transcriptions";

/** One second of quiet 16 kHz mono audio — the bytes are irrelevant to the wire. */
const WAV = encodeWav(new Float32Array(16_000), 16_000);

interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  form: FormData;
}

type Responder = (request: RecordedRequest, index: number) => Response | Promise<Response>;

/** Install a scripted fetch for the duration of `run`, then always restore the real one. */
async function withFetch<T>(
  respond: Responder,
  run: (ctx: { requests: RecordedRequest[] }) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  const requests: RecordedRequest[] = [];
  globalThis.fetch = (async (input: unknown, init: Record<string, unknown> = {}) => {
    const body = init.body;
    assert.ok(body instanceof FormData, "the transcription body must be multipart FormData");
    const record: RecordedRequest = {
      url: String(input),
      headers: (init.headers ?? {}) as Record<string, string>,
      form: body,
    };
    requests.push(record);
    return respond(record, requests.length - 1);
  }) as unknown as typeof fetch;
  try {
    return await run({ requests });
  } finally {
    globalThis.fetch = original;
  }
}

/** Replay one reply per call, in order; an unscripted extra call is a test failure. */
function queue(...replies: Response[]): Responder {
  return (_request, index) => {
    const reply = replies[index];
    if (!reply) throw new Error(`unexpected fetch call #${index + 1}`);
    return reply;
  };
}

const okJson = (payload: unknown): Response =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const errorReply = (status: number, body = "", headers: Record<string, string> = {}): Response =>
  new Response(body, { status, headers });

const apiError = (status: number, message: string, headers?: Record<string, string>): Response =>
  errorReply(status, JSON.stringify({ error: { message } }), headers);

const field = (form: FormData, name: string): string => String(form.get(name));

beforeEach(() => {
  // The downgrade is remembered for the process lifetime by design; each test
  // starts from the un-downgraded state so the order of tests cannot matter.
  resetTranscriptionFormatDowngrade();
});

test("the request is multipart, timestamped, key-authenticated, and language-tagged", async () => {
  await withFetch(
    queue(okJson({ text: "hello", segments: [{ start: 0, end: 1.5, text: "hello" }] })),
    async ({ requests }) => {
      const result = await transcribeWavOnFoundry(CONFIG, WAV, { language: "fr" });

      assert.equal(requests.length, 1);
      const [request] = requests;
      assert.equal(request.url, URL);
      // Both auth headers, and no hand-written Content-Type: fetch must derive it
      // from the FormData so the multipart boundary matches the body.
      assert.equal(request.headers["api-key"], API_KEY);
      assert.equal(request.headers.Authorization, `Bearer ${API_KEY}`);
      assert.equal(request.headers["Content-Type"], undefined);

      assert.equal(field(request.form, "model"), "gpt-4o-transcribe");
      assert.equal(field(request.form, "language"), "fr");
      assert.equal(field(request.form, "response_format"), "verbose_json");

      const file = request.form.get("file");
      assert.ok(file instanceof Blob, "the audio must ride as a file part");
      assert.equal(file.type, "audio/wav");
      assert.equal(file.size, WAV.byteLength);
      assert.equal((file as File).name, "narration.wav");

      assert.deepEqual(result, {
        text: "hello",
        segments: [{ startMs: 0, endMs: 1500, text: "hello" }],
      });
    },
  );
});

test("no language is sent when none was selected, and apiVersion pins the surface", async () => {
  await withFetch(queue(okJson({ text: "hi", segments: [] })), async ({ requests }) => {
    await transcribeWavOnFoundry({ ...CONFIG, apiVersion: "2024-12-01-preview" }, WAV, {});
    assert.equal(requests[0].url, `${URL}?api-version=2024-12-01-preview`);
    assert.equal(requests[0].form.get("language"), null);
  });
});

test("the transcription deployment is separate from the chat deployment", async () => {
  assert.equal(transcriptionDeployment(CONFIG), "gpt-4o-transcribe");
  // An unset (or blank) field falls back to the default, never to `deployment` —
  // a codex chat deployment cannot transcribe audio.
  assert.equal(
    transcriptionDeployment({ ...CONFIG, transcriptionDeployment: "  " }),
    DEFAULT_FOUNDRY_TRANSCRIPTION_DEPLOYMENT,
  );
  await withFetch(queue(okJson({ text: "", segments: [] })), async ({ requests }) => {
    await transcribeWavOnFoundry({ ...CONFIG, transcriptionDeployment: "whisper-1" }, WAV, {});
    assert.equal(field(requests[0].form, "model"), "whisper-1");
  });
});

test("segments are converted to ms, and empty or malformed ones are dropped", async () => {
  const payload = {
    text: " full text ",
    segments: [
      { start: 0, end: 2.25, text: " first " },
      { start: 2.25, end: 4, text: "   " }, // no words — dropped
      { start: 4.5, text: "no end" }, // missing end — collapses to a point
      { start: "bad", end: "worse", text: "unparseable times" },
    ],
  };
  await withFetch(queue(okJson(payload)), async () => {
    const result = await transcribeWavOnFoundry(CONFIG, WAV, {});
    assert.equal(result.text, "full text");
    assert.deepEqual(result.segments, [
      { startMs: 0, endMs: 2250, text: "first" },
      { startMs: 4500, endMs: 4500, text: "no end" },
      { startMs: 0, endMs: 0, text: "unparseable times" },
    ]);
  });
});

test("a deployment that rejects verbose_json is retried once as json, then remembered", async () => {
  await withFetch(
    queue(
      apiError(400, "Unsupported value: 'response_format' does not support 'verbose_json'."),
      okJson({ text: "one long take" }),
      okJson({ text: "second call" }),
    ),
    async ({ requests }) => {
      const first = await transcribeWavOnFoundry(CONFIG, WAV, {});
      assert.equal(requests.length, 2);
      assert.equal(field(requests[0].form, "response_format"), "verbose_json");
      assert.equal(field(requests[1].form, "response_format"), "json");
      // No timestamps came back, so the whole (bounded) chunk becomes one segment
      // spanning the WAV's own duration — 1s of 16 kHz audio.
      assert.deepEqual(first.segments, [{ startMs: 0, endMs: 1000, text: "one long take" }]);

      // The downgrade is remembered: the next call does not pay the wasted 400.
      const second = await transcribeWavOnFoundry(CONFIG, WAV, {});
      assert.equal(requests.length, 3);
      assert.equal(field(requests[2].form, "response_format"), "json");
      assert.equal(second.segments.length, 1);
    },
  );
});

test("an unrelated 400 surfaces the server's own message without downgrading", async () => {
  await withFetch(
    queue(apiError(400, "The audio file is too large."), okJson({ text: "next", segments: [] })),
    async ({ requests }) => {
      await assert.rejects(transcribeWavOnFoundry(CONFIG, WAV, {}), {
        message: "Azure AI Foundry request failed (HTTP 400): The audio file is too large.",
      });
      assert.equal(requests.length, 1);

      // Still asking for timestamps — an unrelated failure must not degrade quality.
      await transcribeWavOnFoundry(CONFIG, WAV, {});
      assert.equal(field(requests[1].form, "response_format"), "verbose_json");
    },
  );
});

test("a 429 with Retry-After is retried and then succeeds", async () => {
  await withFetch(
    queue(
      apiError(429, "slow down", { "retry-after": "0" }),
      okJson({ text: "after the wait", segments: [] }),
    ),
    async ({ requests }) => {
      const result = await transcribeWavOnFoundry(CONFIG, WAV, {});
      assert.equal(result.text, "after the wait");
      assert.equal(requests.length, 2);
    },
  );
});

test("a 429 that never clears reports rate limiting after the attempt budget", async () => {
  const throttled = () => apiError(429, "still throttled", { "retry-after": "0" });
  await withFetch(queue(throttled(), throttled(), throttled()), async ({ requests }) => {
    await assert.rejects(transcribeWavOnFoundry(CONFIG, WAV, {}), {
      message: "Azure AI Foundry is rate-limiting requests (HTTP 429). Try again in a moment.",
    });
    assert.equal(requests.length, 3);
  });
});

test("auth and deployment failures name the fix, and never the key", async () => {
  await withFetch(queue(apiError(401, `bad key ${API_KEY}x`)), async () => {
    const error = await transcribeWavOnFoundry(CONFIG, WAV, {}).catch((err: unknown) => err);
    assert.ok(error instanceof Error);
    assert.match(error.message, /rejected the API key \(HTTP 401\)\. Check the connection settings/);
    // Only the server's own echo of the key could ever appear; ours never does.
    assert.ok(!error.message.includes(`Bearer ${API_KEY}`));
  });

  await withFetch(queue(apiError(404, "DeploymentNotFound")), async () => {
    await assert.rejects(transcribeWavOnFoundry(CONFIG, WAV, {}), {
      message:
        'Azure AI Foundry could not find the "gpt-4o-transcribe" deployment (HTTP 404). ' +
        "Check the endpoint and deployment name. DeploymentNotFound",
    });
  });
});

test("an unreachable endpoint and an unreadable body both fail with actionable copy", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
  try {
    await assert.rejects(transcribeWavOnFoundry(CONFIG, WAV, {}), {
      message:
        "Could not reach https://unit.test.invalid. Check your network and the endpoint URL.",
    });
  } finally {
    globalThis.fetch = original;
  }

  await withFetch(queue(new Response("<html>gateway</html>", { status: 200 })), async () => {
    await assert.rejects(transcribeWavOnFoundry(CONFIG, WAV, {}), {
      message: "Azure AI Foundry returned a transcription that could not be read as JSON.",
    });
  });
});

test("an aborted transcription rejects with the caller's own reason", async () => {
  const controller = new AbortController();
  const original = globalThis.fetch;
  globalThis.fetch = ((_url: unknown, init: Record<string, unknown> = {}) => {
    const signal = init.signal as AbortSignal;
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("fetch aborted by signal")), {
        once: true,
      });
    });
  }) as unknown as typeof fetch;
  try {
    const pending = transcribeWavOnFoundry(CONFIG, WAV, { signal: controller.signal });
    controller.abort(new Error("Transcription was canceled."));
    await assert.rejects(pending, { message: "fetch aborted by signal" });
  } finally {
    globalThis.fetch = original;
  }
});
