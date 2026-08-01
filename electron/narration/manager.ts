import { existsSync, readFileSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  readAudioNarrationLanguage,
  readAudioSources,
  type AudioSource,
} from "../../common/audio";
import { FOUNDRY_NOT_CONFIGURED_ERROR, type FoundryConfig } from "../../common/foundry";
import type {
  NarrationActionResult,
  NarrationStatus,
} from "../../common/ipc";
import {
  DEFAULT_NARRATION_LANGUAGE,
  isNarrationLanguage,
  NARRATION_FILE,
  type NarrationLanguage,
  type NarrationTranscript,
} from "../../common/narration";
import type { SessionMeta } from "../../common/types";
import { loadFoundryConfig } from "../foundry/config";
import { createLogger } from "../logger";
import { isValidSessionId, sessionDir } from "../recorder/session-store";
import { shouldTranscribeBeforeAnalyze } from "./analyze-gate";
import { transcribeNarration } from "./transcribe";

/**
 * Owns narration transcription: one job at a time, the status the HUD and library
 * render, and the persisted `narration.json` per session.
 *
 * Transcription runs on the user's Azure AI Foundry deployment, so there is no model
 * to download or cache any more. The renderer's status shape is unchanged, and its
 * two model states are remapped onto the connection: **`ready` = Foundry configured**,
 * **`missing` = not configured** (carrying the standard not-configured error so the
 * connection form can offer itself), and `downloading` is unreachable.
 */

const log = createLogger("Narration");

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function readTranscript(file: string): NarrationTranscript | null {
  if (!existsSync(file)) return null;
  try {
    const transcript = readJson<NarrationTranscript>(file);
    const language = transcript.language ?? DEFAULT_NARRATION_LANGUAGE;
    return typeof transcript.model === "string" &&
      isNarrationLanguage(language) &&
      Array.isArray(transcript.segments)
      ? { ...transcript, language }
      : null;
  } catch {
    return null;
  }
}

function resolveSessionFile(dir: string, relativeFile: string): string {
  const resolved = path.resolve(dir, relativeFile);
  const prefix = `${path.resolve(dir)}${path.sep}`;
  if (!resolved.startsWith(prefix)) {
    throw new Error("Narration metadata points outside the recording folder.");
  }
  return resolved;
}

async function writeTranscript(file: string, transcript: NarrationTranscript): Promise<void> {
  const temp = `${file}.tmp.${process.pid}.${Date.now()}`;
  try {
    await writeFile(temp, JSON.stringify(transcript, null, 2));
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}

/** The connection transcription needs, or null when this computer has none yet. */
function transcriptionConfig(): FoundryConfig | null {
  return loadFoundryConfig()?.config ?? null;
}

export class NarrationManager {
  private current: NarrationStatus = {
    model: "missing",
    phase: "idle",
    progress: null,
    loadedBytes: null,
    totalBytes: null,
    activeSessionId: null,
    error: null,
  };
  private queue: Promise<void> = Promise.resolve();
  private readonly sessionTasks = new Map<string, Promise<NarrationActionResult>>();

  constructor(private readonly emitStatus: (status: NarrationStatus) => void) {}

  initialize(): void {
    this.update({
      model: transcriptionConfig() ? "ready" : "missing",
      phase: "idle",
      error: null,
    });
  }

  status(): NarrationStatus {
    return { ...this.current };
  }

  isBusyWith(sessionId: string): boolean {
    return this.sessionTasks.has(sessionId);
  }

  /**
   * Formerly "download the voice model". Now a connection probe: it re-reads the
   * saved connection and reports whether transcription is available, so the
   * renderer's existing affordance keeps working while Workstream C replaces it
   * with the connection form.
   */
  downloadModel(): Promise<NarrationActionResult> {
    const configured = transcriptionConfig() != null;
    this.update({
      model: configured ? "ready" : "missing",
      phase: "idle",
      activeSessionId: null,
      error: configured ? null : FOUNDRY_NOT_CONFIGURED_ERROR,
    });
    return Promise.resolve(
      configured
        ? { ok: true, outcome: "ready" }
        : { ok: false, outcome: "model-missing", error: FOUNDRY_NOT_CONFIGURED_ERROR },
    );
  }

  transcribeSession(sessionId: string): Promise<NarrationActionResult> {
    if (!isValidSessionId(sessionId)) {
      return Promise.resolve({ ok: false, error: "Unknown session." });
    }
    return this.startTranscription(sessionId);
  }

  /**
   * Ensure a session's voice narration is transcribed before an analysis runs, so
   * `describer.analyze` never silently proceeds without the user's own words.
   * Best-effort: on failure it resolves with the error (already surfaced via the
   * narration status) instead of throwing, so the caller can still analyze without
   * voice and the audio stays saved. A session with no audio, or one already
   * transcribed, is a fast no-op that never touches the transcription queue.
   */
  async ensureTranscribedForAnalysis(sessionId: string): Promise<NarrationActionResult> {
    if (!isValidSessionId(sessionId)) return { ok: false, error: "Unknown session." };
    const dir = sessionDir(sessionId);
    const hasAudio = existsSync(path.join(dir, "audio.json"));
    const hasTranscript = readTranscript(path.join(dir, NARRATION_FILE)) != null;
    if (!shouldTranscribeBeforeAnalyze(hasAudio, hasTranscript)) {
      return hasTranscript ? { ok: true, outcome: "already-transcribed" } : { ok: true };
    }
    const result = await this.startTranscription(sessionId);
    if (!result.ok) {
      log.warn(
        `pre-analysis transcription failed for ${sessionId}:`,
        result.error ?? result.outcome,
      );
    }
    return result;
  }

  /** Post-recording pass: transcribe right away when a connection is configured. */
  async transcribeIfConfigured(dir: string): Promise<void> {
    if (!transcriptionConfig()) return;
    const id = path.basename(dir);
    if (!isValidSessionId(id)) return;
    const result = await this.startTranscription(id);
    if (!result.ok && result.outcome !== "model-missing") {
      log.warn("post-recording narration transcription failed:", result.error);
    }
  }

  private startTranscription(sessionId: string): Promise<NarrationActionResult> {
    const existing = this.sessionTasks.get(sessionId);
    if (existing) return existing;
    const task = this.enqueue(() => this.runTranscription(sessionId));
    this.sessionTasks.set(sessionId, task);
    void task.finally(() => {
      if (this.sessionTasks.get(sessionId) === task) this.sessionTasks.delete(sessionId);
    });
    return task;
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const task = this.queue.then(work, work);
    this.queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private async runTranscription(sessionId: string): Promise<NarrationActionResult> {
    const dir = sessionDir(sessionId);
    const narrationFile = path.join(dir, NARRATION_FILE);
    if (readTranscript(narrationFile)) {
      return { ok: true, outcome: "already-transcribed" };
    }
    await rm(narrationFile, { force: true });

    const audioJson = path.join(dir, "audio.json");
    if (!existsSync(audioJson)) return { ok: false, error: "This recording has no saved narration." };

    let meta: SessionMeta;
    let audioSources: AudioSource[];
    let narrationLanguage: NarrationLanguage;
    try {
      meta = readJson<SessionMeta>(path.join(dir, "session.json"));
      const audioMetadata = readJson<unknown>(audioJson);
      audioSources = readAudioSources(audioMetadata);
      narrationLanguage = readAudioNarrationLanguage(audioMetadata);
    } catch (err) {
      return { ok: false, error: `Could not read narration metadata: ${message(err)}` };
    }

    if (audioSources.length === 0) {
      return { ok: false, error: "This recording has no saved narration." };
    }
    let sourceFiles: Array<AudioSource & { audioPath: string }>;
    try {
      sourceFiles = audioSources.map((source) => ({
        ...source,
        audioPath: resolveSessionFile(dir, source.file),
      }));
    } catch (err) {
      return { ok: false, error: message(err) };
    }
    if (sourceFiles.some((source) => !existsSync(source.audioPath))) {
      return { ok: false, error: "One or more saved narration segments are missing." };
    }

    // Voice leaves the machine from here on, so an unconfigured computer stops
    // before any audio is read — and says so in the words the connection form matches.
    const config = transcriptionConfig();
    if (!config) {
      this.update({
        model: "missing",
        phase: "idle",
        activeSessionId: null,
        error: FOUNDRY_NOT_CONFIGURED_ERROR,
      });
      return { ok: false, outcome: "model-missing", error: FOUNDRY_NOT_CONFIGURED_ERROR };
    }

    try {
      this.update({
        model: "ready",
        phase: "transcribing",
        progress: null,
        loadedBytes: null,
        totalBytes: null,
        activeSessionId: sessionId,
        error: null,
      });
      const transcript: NarrationTranscript = {
        model: "",
        language: narrationLanguage,
        segments: [],
      };
      for (const source of sourceFiles) {
        const segmentTranscript = await transcribeNarration(
          source.audioPath,
          source.startEpoch - meta.startedAt,
          source.durationMs,
          narrationLanguage,
          config,
        );
        transcript.model ||= segmentTranscript.model;
        transcript.segments.push(...segmentTranscript.segments);
      }
      transcript.segments.sort((a, b) => a.atMs - b.atMs);
      await writeTranscript(narrationFile, transcript);
      log.info(`transcribed ${sessionId}: ${transcript.segments.length} segment(s)`);
      this.update({
        model: "ready",
        phase: "idle",
        activeSessionId: null,
        error: null,
      });
      return {
        ok: true,
        outcome: transcript.segments.length > 0 ? "transcribed" : "no-speech",
      };
    } catch (err) {
      const error = message(err);
      this.update({
        model: transcriptionConfig() ? "ready" : "missing",
        phase: "idle",
        activeSessionId: sessionId,
        error,
      });
      log.warn(`transcription failed for ${sessionId}:`, error);
      return { ok: false, error };
    }
  }

  private update(patch: Partial<NarrationStatus>): void {
    this.current = { ...this.current, ...patch };
    this.emitStatus(this.status());
  }
}
