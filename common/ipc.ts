import type { Analysis, AnalysisFeedback, AnalysisStep, Confidence } from "./analysis";
import type { ApiReferenceSummary } from "./api-reference";
import type { AutomationPlan, BuiltAutomation } from "./automation";
import type { CompatibilityReport } from "./compatibility";
import type { FoundryConnectionInfo } from "./foundry";
import type { MicrophoneDevice } from "./microphone";
import type { NarrationLanguage } from "./narration";
import type { BuiltSkill, SkillArchitecture, SkillPlan } from "./skill";
import type { RecorderState } from "./types";

/** The last completed session — the one that can be analyzed. */
export interface LastSession {
  id: string;
  /** True once post-processing (bundle/description/frames) has finished. */
  processed: boolean;
}

/** A saved recording as shown in the sessions library. */
export interface SessionSummary {
  id: string;
  startedAt: number | null;
  stoppedAt: number | null;
  durationMs: number | null;
  /** Total bytes occupied by all files under this session's directory. */
  sizeBytes: number | null;
  /** True once post-processing produced a bundle. */
  processed: boolean;
  hasVideo: boolean;
  /** True when the user opted into narration and usable audio was saved. */
  hasAudio: boolean;
  /** Selected source language for saved audio, or null when no audio exists. */
  narrationLanguage: NarrationLanguage | null;
  /** True once transcription completed, including recordings with no detected speech. */
  hasNarration: boolean;
  narrationSegmentCount: number | null;
  narrationUpdatedAt: number | null;
  /** True once a skill has been built and persisted for this session. */
  hasSkill: boolean;
  /** True once an automation has been built and persisted for this session. */
  hasAutomation: boolean;
  /** Present once the describer has produced an analysis for this session. */
  analysis: {
    revision: number;
    createdAt: number;
    narrationSourceUpdatedAt: number | null;
    title: string;
    intent: string;
    intentConfidence: Confidence;
    stepCount: number;
  } | null;
}

export type NarrationModelState = "missing" | "downloading" | "ready" | "error";
export type NarrationPhase = "idle" | "loading" | "downloading" | "transcribing";

/** Shared model/job state shown in the HUD and Sessions library. */
export interface NarrationStatus {
  model: NarrationModelState;
  phase: NarrationPhase;
  progress: number | null;
  loadedBytes: number | null;
  totalBytes: number | null;
  activeSessionId: string | null;
  error: string | null;
}

export interface NarrationActionResult {
  ok: boolean;
  outcome?: "ready" | "transcribed" | "no-speech" | "already-transcribed" | "model-missing";
  error?: string;
}

export interface RecorderStatus {
  state: RecorderState;
  sessionId: string | null;
  startedAt: number | null;
  /** Source language fixed for the active recording's narration. */
  narrationLanguage: NarrationLanguage;
  eventCount: number;
  transition: "none" | "starting" | "stopping" | "discarding";
  microphone: {
    state: "off" | "starting" | "on" | "stopping" | "error";
    error: string | null;
    activeDevice: MicrophoneDevice | null;
  };
  lastFinish: {
    sessionId: string;
    outcome: "saved" | "discarded";
  } | null;
  /** Set after a recording stops; drives the "Analyze" affordance. */
  lastSession: LastSession | null;
}

/** Streamed to the renderer while the describer agent works. */
export interface AnalyzeProgress {
  sessionId: string;
  phase: "start" | "working" | "drafting" | "done" | "error";
  message: string;
}

/** Result of an analyze / feedback round. */
export interface AnalyzeResult {
  ok: boolean;
  analysis?: Analysis;
  error?: string;
}

/** Feedback payload sent from the renderer for a re-analysis round. */
export interface AnalysisFeedbackInput extends AnalysisFeedback {
  sessionId: string;
}

/** A direct edit to the analysis, applied without re-running the agent. Any subset
 *  of fields may be sent; the rest are left untouched. */
export interface AnalysisEditInput {
  sessionId: string;
  /** New short label; empty string clears it (list falls back to the intent). */
  title?: string;
  /** New one-sentence goal; blank/whitespace is ignored (intent can't be emptied). */
  intent?: string;
  /** The full, user-edited ordered steps; replaces the current steps when present. */
  steps?: AnalysisStep[];
}

/* --- Skill Builder -------------------------------------------------------- */

/** Streamed to the renderer while the skill-builder agent works. */
export interface SkillBuildProgress {
  sessionId: string;
  phase: "start" | "working" | "drafting" | "done" | "error";
  message: string;
}

/** Start a build (or refine one) for a session's analysis. */
export interface SkillBuildInput {
  sessionId: string;
  /** Target architecture (the app's own library or Copilot Studio). */
  architecture: SkillArchitecture;
  /** Natural-language refinement for the current plan; omit for the first pass. */
  feedback?: string;
}

/** Result of a propose/refine round: the plan to show the user. */
export interface SkillPlanResult {
  ok: boolean;
  plan?: SkillPlan;
  error?: string;
}

/**
 * Where a built skill lands:
 * - **install** — write it into this app's own skill library (the `app` architecture only).
 * - **export** — download it to a folder the user picks (the only option for copilot-studio).
 */
export type SkillPlacement = "install" | "export";

/** Result of finalizing + placing a skill. */
export interface SkillCreateResult {
  ok: boolean;
  skill?: BuiltSkill;
  /** Absolute path of the placed SKILL.md. */
  path?: string;
  /** How the skill was placed (echoed back for the done screen). */
  placement?: SkillPlacement;
  /** True when the user dismissed the export destination dialog — a cancel, not an error. */
  canceled?: boolean;
  error?: string;
}

/* --- API reference -------------------------------------------------------- */

/**
 * How a reference is attached: a file the user picks in the main-process open dialog,
 * or a URL main downloads. The renderer never reads the file itself — the bytes are
 * indexed and stored beside the recording, not shipped through the bridge.
 */
export type ApiReferenceAttachInput = { kind: "file" } | { kind: "url"; url: string };

/** Result of attaching or removing a reference source. */
export interface ApiReferenceResult {
  ok: boolean;
  /** The reference *after* the call — null once nothing is attached. */
  reference?: ApiReferenceSummary | null;
  /** True when the user dismissed the file picker — a cancel, not an error. */
  canceled?: boolean;
  /** Why the attach was refused, phrased for the user; safe to render verbatim. */
  error?: string;
}

/* --- Automation Builder --------------------------------------------------- */

/** Streamed to the renderer while the automation-builder agent works. */
export interface AutomationBuildProgress {
  sessionId: string;
  phase: "start" | "working" | "drafting" | "done" | "error";
  message: string;
}

/** Start an automation build (or refine one) for a session's analysis. */
export interface AutomationBuildInput {
  sessionId: string;
  /** Target architecture (the app's own library or Copilot Studio). */
  architecture: SkillArchitecture;
  /** Natural-language refinement for the current plan; omit for the first pass. */
  feedback?: string;
}

/** Result of a propose/refine round: the automation plan to show the user. */
export interface AutomationPlanResult {
  ok: boolean;
  plan?: AutomationPlan;
  error?: string;
}

/** Result of finalizing + exporting an automation bundle. */
export interface AutomationCreateResult {
  ok: boolean;
  automation?: BuiltAutomation;
  /** Absolute path of the exported automation.json. */
  path?: string;
  error?: string;
}

/* --- Skill runner --------------------------------------------------------- */

/** One installed skill, as the Skills panel lists it. */
export interface SkillListEntry {
  /** Frontmatter `name`, or the folder name when the frontmatter has none. */
  name: string;
  description: string;
  /** Absolute path of the skill folder. */
  dir: string;
  /** The skill carries a usable API reference (`api/openapi.json` **and** `api/index.json`). */
  hasApi: boolean;
  /** A `runner.json` sits beside the SKILL.md (its contents may still be unusable). */
  hasRunnerConfig: boolean;
  /** No `allowed-tools` at all — nothing is refused, but always-allow is disabled. */
  unrestricted: boolean;
  /** SKILL.md mtime, so the UI can sort by "recently installed". */
  mtimeMs: number;
}

/** Result of uninstalling a skill. `error` is written for the user; render it verbatim. */
export interface DeleteSkillResult {
  ok: boolean;
  error?: string;
}

/** What the user answered when a side effect asked. `timeout` is the in-band no-answer. */
export type ConfirmDecision = "approve" | "deny" | "timeout";

export type TranscriptEntryType =
  | "model"
  | "tool-call"
  | "tool-result"
  | "confirm-request"
  | "confirm-decision"
  | "user-input"
  | "error"
  | "done";

/** One line of the run record. Deliberately flat — the UI renders it as a list. */
export interface TranscriptEntry {
  type: TranscriptEntryType;
  /** Epoch ms. */
  at: number;
  /** Tool or confirmation kind, when the entry is about one. */
  name?: string;
  /** The human-readable half: model text, tool output, question, error message. */
  text?: string;
  /** Full detail behind a confirmation (the command, the path + preview). */
  detail?: string;
  /** A tool call's parsed arguments. */
  args?: unknown;
  decision?: ConfirmDecision;
  /** True when the tool reported failure (the model still sees the text). */
  failed?: boolean;
}

/** Streamed to the renderer as a skill run happens. `entry` is already redacted. */
export interface RunProgress {
  runId: string;
  skillName: string;
  phase: "start" | "working" | "confirm" | "done" | "error";
  message: string;
  entry?: TranscriptEntry;
  /** Absolute path of this run's transcript, so the panel can point the user at it. */
  transcriptFile: string;
}

/** A side effect asking permission. The run is blocked until the user answers. */
export interface RunConfirmRequest {
  runId: string;
  /** Identifies this one question; echoed back in {@link RunRespondInput}. */
  callId: string;
  /** Tool name, so the UI can group "always allow" by capability. */
  kind: string;
  /** One line, safe to show as the card's title. */
  summary: string;
  /** The full thing being approved (the command, the path + preview, the request). */
  detail: string;
  /** False for an unrestricted skill: every side effect needs its own approval. */
  allowAlways: boolean;
}

/** `ask_user` reaching the person watching the run. */
export interface RunAskRequest {
  runId: string;
  callId: string;
  question: string;
}

/** The user's answer to a confirmation or a question. */
export interface RunRespondInput {
  runId: string;
  callId: string;
  /** Confirmation only: approve or decline this side effect. */
  approved?: boolean;
  /** Confirmation only: approve every later call of this kind, for this run only. */
  alwaysAllow?: boolean;
  /** Question only: what the user typed. */
  text?: string;
}

/** Start a run of an installed skill. */
export interface RunSkillInput {
  /** Frontmatter name of an installed skill. */
  name: string;
  /** Optional free text appended to the kickoff prompt. */
  input?: string;
}

/**
 * The answer to "did the run start". A run outlives this call: everything after the
 * start — transcript entries, the final report, failures — arrives as {@link RunProgress}.
 */
export interface RunStartResult {
  ok: boolean;
  runId?: string;
  error?: string;
}

export interface StartResult {
  ok: boolean;
  sessionId?: string;
  /** The recording has not started; the renderer must show the pre-recording warning. */
  privacyWarningRequired?: boolean;
  error?: string;
}

/** Per-session capture choices the user makes in the HUD before recording. */
export interface StartOptions {
  /** Capture microphone narration for this session (opt-in, off by default). */
  narration?: boolean;
  /** Source language to preserve in the transcript. Defaults to English. */
  narrationLanguage?: NarrationLanguage;
  /** Device selected for the initial narration segment; defaults to the OS input. */
  microphoneDeviceId?: string;
}

export interface StopResult {
  ok: boolean;
  sessionId?: string;
  sessionDir?: string;
  error?: string;
}

export interface DiscardResult {
  ok: boolean;
  sessionId?: string;
  error?: string;
}

export interface MicrophoneResult {
  ok: boolean;
  state?: RecorderStatus["microphone"]["state"];
  error?: string;
}

export interface NarrationLanguageResult {
  ok: boolean;
  language?: NarrationLanguage;
  error?: string;
}

export type MicrophonePermissionState = "unknown" | "granted" | "denied";

/** Shared pre-recording microphone preference and current device catalog. */
export interface MicrophoneSettingsStatus {
  narrationEnabled: boolean;
  permission: MicrophonePermissionState;
  devices: MicrophoneDevice[];
  /** The preferred device, retained even while it is disconnected. */
  preferredDeviceId: string;
  preferredDeviceLabel: string;
  /** The device that will actually be requested for the next microphone segment. */
  selectedDeviceId: string;
  selectedDeviceLabel: string;
  preferredDeviceUnavailable: boolean;
  fallback: string | null;
  error: string | null;
}

export interface MicrophoneSettingsResult {
  ok: boolean;
  status: MicrophoneSettingsStatus;
  error?: string;
}

export interface MarkerResult {
  ok: boolean;
  error?: string;
}

export interface DeleteSessionResult {
  ok: boolean;
  error?: string;
}

/** Result of packaging a recording into a downloadable debug bundle (.zip). */
export interface DebugBundleResult {
  ok: boolean;
  /** Absolute path of the written .zip on success. */
  path?: string;
  /** True when the user dismissed the save dialog — a cancel, not an error. */
  canceled?: boolean;
  error?: string;
}

/* --- Azure AI Foundry connection ------------------------------------------ */

/**
 * Input from the in-app connection form. The API key is **write-only**: it travels
 * main-ward in this payload and never comes back in any renderer-facing shape (the
 * renderer only ever reads {@link FoundryConnectionInfo}).
 */
export interface FoundryConnectionInput {
  endpoint: string;
  apiKey: string;
  /** Builders' deployment; blank keeps the release default. */
  deployment?: string;
  /** Describer's deployment; blank keeps the release default. */
  describerDeployment?: string;
  /** Narration transcription deployment; blank keeps the release default. */
  transcriptionDeployment?: string;
}

/** Result of saving a connection: the post-save state, plus why a save was refused. */
export interface FoundryConnectionResult {
  ok: boolean;
  /** Key-free connection state after the attempt — always present. */
  info: FoundryConnectionInfo;
  /** Validation/write failure, verbatim from main; safe to render as-is. */
  error?: string;
}

/** Result of a live "test connection" round-trip against the main deployment. */
export interface FoundryTestResult {
  ok: boolean;
  /** e.g. `Connected — gpt-5.3-codex answered in 1.2s`, or the failure's own message. */
  message: string;
}

/** The doctor's view: the connection plus the two other resolved deployments. */
export interface FoundryDoctorInfo extends FoundryConnectionInfo {
  /** Resolved describer deployment (release default applied), or null when unconfigured. */
  describerDeployment: string | null;
  /** Resolved transcription deployment (release default applied), or null when unconfigured. */
  transcriptionDeployment: string | null;
}

/** Which foreground-window provider is available on this platform. */
export interface ActiveWindowInfo {
  ok: boolean;
  provider: "koffi" | "get-windows" | "x11" | "missing";
  path: string | null;
  error?: string;
  /** Why tracking is degraded, phrased for the user (e.g. the fix to apply). */
  note?: string;
}

/** How, and whether, active-tab URLs can be read on this platform. */
export interface BrowserUrlInfo {
  kind: "applescript" | "uia" | "atspi" | "none";
  supported: boolean;
  /** Why URLs are unavailable, phrased for the user. */
  note?: string;
}

/** One capture source in the doctor report, annotated with platform support. */
export interface DoctorSource {
  key: string;
  label: string;
  tier: number;
  cost: string;
  /** False when this source can't work on the current platform. */
  supported: boolean;
  /** Short reason shown when unsupported, or a setup nudge. */
  note?: string;
}

export interface DoctorReport {
  platform: NodeJS.Platform;
  foundry: FoundryDoctorInfo;
  activeWindow: ActiveWindowInfo;
  browserUrl: BrowserUrlInfo;
  sessionsDir: string;
  activeSources: DoctorSource[];
}

/** IPC channel names — the single source of truth shared by main + preload. */
export const IPC = {
  start: "recorder:start",
  startConfirmed: "recorder:start-confirmed",
  stop: "recorder:stop",
  discard: "recorder:discard",
  microphone: "recorder:microphone",
  narrationLanguage: "recorder:narration-language",
  microphoneSettings: "microphone:settings",
  microphoneNarration: "microphone:narration",
  microphoneDevice: "microphone:device",
  microphoneSettingsChanged: "microphone:settings-changed",
  status: "recorder:status",
  marker: "recorder:marker",
  doctor: "doctor:check",
  compatibilityCheck: "compatibility:check",
  foundryGetConnection: "foundry:get-connection",
  foundrySaveConnection: "foundry:save-connection",
  foundryTestConnection: "foundry:test-connection",
  statusChanged: "recorder:status-changed",
  recordingPrivacyReviewed: "recorder:privacy-reviewed",
  recordingPrivacyWarningRequested: "recorder:privacy-warning-requested",
  narrationStatus: "narration:status",
  narrationDownload: "narration:download",
  narrationTranscribe: "narration:transcribe",
  narrationStatusChanged: "narration:status-changed",
  analyze: "analyze:start",
  analyzeFeedback: "analyze:feedback",
  getAnalysis: "analyze:get",
  updateAnalysis: "analyze:update",
  cancelAnalysis: "analyze:cancel",
  analyzeProgress: "analyze:progress",
  listSessions: "sessions:list",
  deleteSession: "sessions:delete",
  exportDebugBundle: "sessions:export-debug",
  attachApiReference: "api-reference:attach",
  getApiReference: "api-reference:get",
  removeApiReference: "api-reference:remove",
  buildSkill: "skill:build",
  createSkill: "skill:create",
  getSkill: "skill:get",
  cancelSkill: "skill:cancel",
  revealSkill: "skill:reveal",
  skillProgress: "skill:progress",
  buildAutomation: "automation:build",
  createAutomation: "automation:create",
  getAutomation: "automation:get",
  cancelAutomation: "automation:cancel",
  revealAutomation: "automation:reveal",
  automationProgress: "automation:progress",
  skillsList: "skills:list",
  skillsDelete: "skills:delete",
  skillRun: "skill:run",
  skillRunCancel: "skill:run-cancel",
  skillRunRespond: "skill:run-respond",
  skillRunProgress: "skill:run-progress",
  skillRunConfirm: "skill:run-confirm",
  skillRunAsk: "skill:run-ask",
  openLibrary: "ui:open-library",
  closeLibrary: "ui:close-library",
  recordingControlsExpanded: "ui:recording-controls-expanded",
} as const;

/** Shape exposed on `window.skillRecorder` by the preload bridge. */
export interface SkillRecorderApi {
  /** Request a start; may require the pre-recording privacy warning first. */
  start(): Promise<StartResult>;
  /** Start once after the user explicitly proceeds through the privacy warning. */
  confirmStart(): Promise<StartResult>;
  markRecordingPrivacyReviewed(): Promise<void>;
  onRecordingPrivacyWarningRequested(cb: () => void): () => void;
  stop(): Promise<StopResult>;
  discard(): Promise<DiscardResult>;
  setMicrophoneEnabled(enabled: boolean): Promise<MicrophoneResult>;
  setNarrationLanguage(language: NarrationLanguage): Promise<NarrationLanguageResult>;
  microphoneSettings(): Promise<MicrophoneSettingsStatus>;
  setNarrationEnabled(enabled: boolean): Promise<MicrophoneSettingsResult>;
  selectMicrophone(deviceId: string): Promise<MicrophoneSettingsResult>;
  onMicrophoneSettingsChanged(
    cb: (status: MicrophoneSettingsStatus) => void,
  ): () => void;
  status(): Promise<RecorderStatus>;
  marker(note: string): Promise<MarkerResult>;
  doctor(): Promise<DoctorReport>;
  /**
   * The graded "what to expect from recordings here" report, on demand. Unlike
   * {@link doctor} this runs live local probes (which browsers currently expose
   * accessibility), so it is user-initiated rather than read on every HUD paint. It
   * still never touches the network.
   */
  checkCompatibility(): Promise<CompatibilityReport>;
  /** The stored Azure AI Foundry connection, minus the key (which never comes back). */
  getFoundryConnection(): Promise<FoundryConnectionInfo>;
  /** Validate + persist a connection from the in-app form. */
  saveFoundryConnection(input: FoundryConnectionInput): Promise<FoundryConnectionResult>;
  /** One live round-trip against the configured deployment, to prove it works. */
  testFoundryConnection(): Promise<FoundryTestResult>;
  onStatusChanged(cb: (status: RecorderStatus) => void): () => void;
  narrationStatus(): Promise<NarrationStatus>;
  downloadNarrationModel(): Promise<NarrationActionResult>;
  transcribeNarration(sessionId: string): Promise<NarrationActionResult>;
  onNarrationStatusChanged(cb: (status: NarrationStatus) => void): () => void;
  /** Run the describer on a session (defaults to the last completed one). */
  analyze(sessionId?: string): Promise<AnalyzeResult>;
  /** Send NL feedback and re-analyze in the same multi-turn session. */
  analyzeFeedback(input: AnalysisFeedbackInput): Promise<AnalyzeResult>;
  /** Load the persisted analysis for a session, if any. */
  getAnalysis(sessionId: string): Promise<Analysis | null>;
  /** Edit the title/intent text directly (no re-analysis). */
  updateAnalysis(input: AnalysisEditInput): Promise<AnalyzeResult>;
  /** Abort an in-flight analysis. */
  cancelAnalysis(sessionId: string): Promise<{ ok: boolean }>;
  onAnalyzeProgress(cb: (progress: AnalyzeProgress) => void): () => void;
  /** All saved recordings, newest first, for the sessions library. */
  listSessions(): Promise<SessionSummary[]>;
  /** Permanently delete a saved recording and all its artifacts from disk. */
  deleteSession(sessionId: string): Promise<DeleteSessionResult>;
  /**
   * Package a single recording (its whole session folder plus a generated
   * diagnostics file) into a .zip the user picks a location for. The bundle
   * contains private capture data; the renderer warns before calling this.
   */
  exportDebugBundle(sessionId: string): Promise<DebugBundleResult>;
  /**
   * Attach an API reference (an OpenAPI JSON spec, or documentation) to a recording,
   * so the builders can map action steps onto real API operations. `{kind:"file"}`
   * opens the main-process file picker; `{kind:"url"}` downloads the address given.
   */
  attachApiReference(
    sessionId: string,
    input: ApiReferenceAttachInput,
  ): Promise<ApiReferenceResult>;
  /** What is attached to this recording, or null when nothing is. */
  getApiReference(sessionId: string): Promise<ApiReferenceSummary | null>;
  /** Detach one source, or the whole reference when `sourceId` is omitted. */
  removeApiReference(sessionId: string, sourceId?: string): Promise<ApiReferenceResult>;
  /**
   * Propose (or refine) a skill from a recording's analysis. Pass `feedback` to
   * revise the current plan in the same multi-turn conversation.
   */
  buildSkill(input: SkillBuildInput): Promise<SkillPlanResult>;
  /**
   * Finalize the (user-edited) skill plan and place its SKILL.md. The edited plan the
   * user sees is authoritative — the body is written from exactly these values and steps.
   * `placement` picks the destination: `"install"` writes into this app's own
   * skill library (the `app` architecture); `"export"` prompts for a folder and downloads
   * it there (the only option for copilot-studio). Defaults to `"install"`.
   */
  createSkill(sessionId: string, plan: SkillPlan, placement?: SkillPlacement): Promise<SkillCreateResult>;
  /** Load a previously built skill for a session, if any. */
  getSkill(sessionId: string): Promise<BuiltSkill | null>;
  /** Abort an in-flight build. */
  cancelSkill(sessionId: string): Promise<{ ok: boolean }>;
  /** Reveal an exported SKILL.md in the OS file manager. */
  /** Reveal a session's exported SKILL.md in the OS file manager. */
  revealSkill(sessionId: string): Promise<{ ok: boolean }>;
  onSkillProgress(cb: (progress: SkillBuildProgress) => void): () => void;
  /**
   * Propose (or refine) an automation from a recording's analysis. Pass `feedback`
   * to revise the current plan in the same multi-turn conversation.
   */
  buildAutomation(input: AutomationBuildInput): Promise<AutomationPlanResult>;
  /** Finalize the (user-edited) automation plan and export its importable bundle.
   *  The edited plan is authoritative — the bundle is built from it verbatim. */
  createAutomation(sessionId: string, plan: AutomationPlan): Promise<AutomationCreateResult>;
  /** Load a previously built automation for a session, if any. */
  getAutomation(sessionId: string): Promise<BuiltAutomation | null>;
  /** Abort an in-flight automation build. */
  cancelAutomation(sessionId: string): Promise<{ ok: boolean }>;
  /** Reveal a session's exported automation bundle in the OS file manager. */
  revealAutomation(sessionId: string): Promise<{ ok: boolean }>;
  onAutomationProgress(cb: (progress: AutomationBuildProgress) => void): () => void;
  /** Every skill installed in this app's own library, by name. */
  listInstalledSkills(): Promise<SkillListEntry[]>;
  /**
   * Uninstall a skill: delete its folder from this app's own library. Refused while
   * that skill is running. Past run transcripts are kept — they are the record of what
   * the skill did on this machine. Destructive: the renderer confirms first.
   */
  deleteSkill(name: string): Promise<DeleteSkillResult>;
  /**
   * Start running an installed skill. Resolves as soon as the run has *started* —
   * the transcript, the confirmations and the final report all arrive on the three
   * `onRun*` subscriptions. One run at a time, app-wide.
   */
  runSkill(input: RunSkillInput): Promise<RunStartResult>;
  /** Abort the active run (a stale `runId` is a no-op). */
  cancelRun(runId: string): Promise<{ ok: boolean }>;
  /** Answer the confirmation or question the run is blocked on. */
  respondToRun(input: RunRespondInput): Promise<{ ok: boolean }>;
  onRunProgress(cb: (progress: RunProgress) => void): () => void;
  onRunConfirm(cb: (request: RunConfirmRequest) => void): () => void;
  onRunAsk(cb: (request: RunAskRequest) => void): () => void;
  /** Open (and focus) the Sessions library window, docked to the recorder. */
  openLibrary(): Promise<void>;
  /** Close the Sessions library window from within it. */
  closeLibrary(): Promise<void>;
  /** Resize the recording-controls window while an overlay panel is visible. */
  setRecordingControlsExpanded(expanded: boolean): Promise<void>;
}
