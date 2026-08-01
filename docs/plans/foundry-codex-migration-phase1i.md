# Phase 1i in detail — Workstream I: cloud transcription on Foundry

Parent plan: [`foundry-codex-migration.md`](./foundry-codex-migration.md) (Workstream I) · Tracker: [`progress.md`](./progress.md)
Status: **approved — implementing**

## Scope and definition of done

Voice-narration transcription moves from local Whisper
(`Xenova/whisper-small` via `@huggingface/transformers`/onnxruntime) to the user's
Foundry transcription deployment. The `NarrationTranscript` contract
(`common/narration.ts` — timestamped segments, `atMs` relative to recording start) is
**preserved exactly**, so the describer's `get_narration` tool, `analyze-gate`, and the
persisted `narration.json` format never notice. Dependencies stay in `package.json`
until Workstream E (only the imports go). Done = typecheck + tests green, disclosures
updated, gate **G6** (live known-phrase transcription smoke) passes.

## I1. New module `electron/foundry/transcribe.ts`

```ts
export interface CloudTranscriptionSegment { startMs: number; endMs: number; text: string }
export interface CloudTranscription { text: string; segments: CloudTranscriptionSegment[] }
export async function transcribeWavOnFoundry(
  config: FoundryConfig,
  wav: Uint8Array,
  opts: { language?: string; signal?: AbortSignal },
): Promise<CloudTranscription>
```
- ~~`POST {endpoint}/openai/v1/audio/transcriptions`~~ **Superseded at G6 (2026-08-01):**
  the v1 audio route 404s on this resource class while chat/responses serves v1 — audio
  still lives on the legacy data plane. The route of record is
  `POST {endpoint}/openai/deployments/{deployment}/audio/transcriptions?api-version=…`
  (pin `AUDIO_API_VERSION = "2024-10-21"`, `config.apiVersion` overrides); the code and
  its tests are the contract.
  Multipart via global `FormData`/`Blob` (Node ≥22 — zero new deps): `file`
  (`narration.wav`, `audio/wav`), `model` = transcription deployment, `language` when
  set, `response_format: "verbose_json"` (segment timestamps).
- **Tolerance rule (G1 precedent):** on HTTP 400 whose detail mentions
  `response_format`/`verbose`, retry once with `response_format: "json"` and, when the
  response has no `segments`, synthesize one segment `[0, durationMs]` from `text` —
  chunking (I3) still yields useful coarse timestamps. Remember the downgrade for the
  process lifetime.
- Reuse the error taxonomy + retry policy from `agent.ts` — extract its `post`/status
  mapping helpers into shared module-level functions rather than duplicating (same
  429/5xx retries, same 401/404 user-facing messages, key never logged).

## I2. Config: transcription deployment
- `common/foundry.ts`: `DEFAULT_FOUNDRY_TRANSCRIPTION_DEPLOYMENT = "gpt-4o-transcribe"`;
  `FoundryConfig.transcriptionDeployment?: string`.
- `electron/foundry/config.ts`: env `AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT ||
  FOUNDRY_TRANSCRIPTION_DEPLOYMENT`, file field `transcriptionDeployment`, default
  applied at read; `saveFoundryConfig` passes it through. Both config tests extended.

## I3. Rework `electron/narration/`
- **`whisper.ts` deleted** (with `whisper.test.ts`; both leave the `package.json` test
  list). The audio **decode path is kept**: whatever currently turns saved narration
  audio into PCM samples for the whisper pipeline now feeds a small pure
  `encodeWav(samples, sampleRate)` (16-bit PCM mono WAV writer, new, unit-tested).
- **Chunking**: target ≤ ~8 min / ≤ ~15 MB per upload; split at silence boundaries via
  the existing pure-DSP `audio-analysis.ts`, fall back to hard time splits; per-chunk
  results merge with the chunk's start offset so segment `atMs` stays
  recording-relative, exactly as today.
- **`transcribe.ts`**: swap the pipeline call for `transcribeWavOnFoundry`; keep the
  language plumbing and the `narrationModelId()` tag (now the deployment name).
- **`manager.ts`**: the model download/cache flow goes away. Minimal-churn state
  mapping (renderer IPC types unchanged): `model: "ready"` ⇔ Foundry configured,
  `"missing"` ⇔ not configured (error copy = the Foundry not-configured contract);
  `"downloading"` becomes unreachable; `downloadNarrationModel` IPC returns
  `ready`/`model-missing` accordingly. `ensureTranscribedForAnalysis` flow unchanged.
- Existing narration unit tests (`transcribe.test.ts`, `analyze-gate.test.ts`,
  `audio-analysis.test.ts`) reworked where they stubbed the pipeline: fake
  `globalThis.fetch` (multipart body assertions) instead. New tests: WAV encoder,
  chunk-offset merge, response_format downgrade path.

## I4. UI + disclosures (mandatory — voice now leaves the machine)
- `src/WhatsRecorded.tsx` (~:98-100) and `src/RecordingPrivacyWarning.tsx`: replace the
  on-device-processing promise — narration audio is sent to **your Azure AI Foundry
  deployment** for transcription.
- Remove the model-download affordances/copy: `src/Recorder.tsx` (~:229, :579-608 voice
  model rows), `src/Library.tsx` (~:713-735, :849-853), and
  `NARRATION_MODEL_DOWNLOAD_LABEL` in `common/narration.ts`. "Not configured" copy
  points at the Foundry connection (form arrives in Workstream C).

## Gate G6 (exit of I — live, credentialed)
`scripts/foundry-smoke.ts` gains check 4 (`transcription round-trip`): load a spoken
fixture WAV from `evals/fixtures/narration-smoke.wav` if present, else generate via
`espeak-ng`/`espeak`/`say` when on PATH, else print
`SKIP transcription (no fixture; see docs/plans/foundry-codex-migration-phase1i.md)` and
exit per the other three checks only. Assert the transcript contains the known phrase
(e.g. "skill recorder test phrase") case-insensitively and at least one segment has
`endMs > startMs`. Non-zero exit on FAIL, not on SKIP.

## Acceptance checklist
- [ ] typecheck + typecheck:evals 0; full `npm test` green (list updated: whisper tests
      out, transcribe/wav/chunk tests in)
- [ ] `rg "@huggingface|onnxruntime|whisper" electron/ common/ src/ -il` → only
      comments/plan references; no live imports (deps removal itself waits for E)
- [ ] Disclosure + download-UI copy updated (I4)
- [ ] G6 passes (or SKIPs only for missing fixture, with checks 1–3 green)
