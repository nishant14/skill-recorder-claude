import { useCallback, useEffect, useRef, useState } from "react";

import type { Analysis, AnalysisStep } from "../common/analysis";
import { collectApiRefs } from "../common/api-reference";
import type { ApiReferenceSummary } from "../common/api-reference";
import type { FoundryConnectionInfo } from "../common/foundry";
import {
  DEFAULT_FOUNDRY_DEPLOYMENT,
  DEFAULT_FOUNDRY_DESCRIBER_DEPLOYMENT,
  DEFAULT_FOUNDRY_TRANSCRIPTION_DEPLOYMENT,
  isFoundryNotConfiguredError,
} from "../common/foundry";
import type {
  AnalyzeProgress,
  ApiReferenceAttachInput,
  AutomationBuildProgress,
  NarrationStatus,
  RunAskRequest,
  RunConfirmRequest,
  RunProgress,
  SessionSummary,
  SkillBuildProgress,
  SkillListEntry,
  SkillPlacement,
  TranscriptEntry,
} from "../common/ipc";
import type {
  BuildKind,
  BuildTarget,
  BuiltSkill,
  SkillArchitecture,
  SkillPlan,
} from "../common/skill";
import { TARGETS } from "../common/skill";
import type { AutomationPlan, BuiltAutomation } from "../common/automation";
import {
  DEFAULT_NARRATION_LANGUAGE,
  narrationLanguageLabel,
} from "../common/narration";
import {
  AnalysisStepTiles,
  AutomationStepTiles,
  EditableText,
  ScheduleEditor,
  SkillStepTiles,
} from "./plan-edit";
import { formatBytes, formatDur, formatWhen, shortLabel } from "./format";

/** The two things the library window holds: past recordings, and installed skills. */
type LibrarySection = "sessions" | "skills";

export function Library() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [narrationStatus, setNarrationStatus] = useState<NarrationStatus | null>(null);
  const [section, setSection] = useState<LibrarySection>("sessions");
  const [skills, setSkills] = useState<SkillListEntry[]>([]);
  const [skillsLoaded, setSkillsLoaded] = useState(false);
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null);

  const loadSkills = useCallback(async () => {
    const list = await window.skillRecorder.listInstalledSkills();
    setSkills(list);
    setSkillsLoaded(true);
  }, []);

  // Re-read the library on mount and every time the section changes: it is a cheap
  // directory scan, and skills appear there from outside this window (a build installs
  // one; the user drops a folder in by hand).
  useEffect(() => {
    void loadSkills();
  }, [section, loadSkills]);

  const loadSessions = useCallback(async () => {
    const list = await window.skillRecorder.listSessions();
    setSessions(list);
    setLoaded(true);
    setSelectedId((prev) => prev ?? list[0]?.id ?? null);
  }, []);

  useEffect(() => {
    void loadSessions();
    return window.skillRecorder.onStatusChanged((s) => {
      if (s.state !== "recording") void loadSessions();
    });
  }, [loadSessions]);

  useEffect(() => {
    void window.skillRecorder.narrationStatus().then(setNarrationStatus);
    return window.skillRecorder.onNarrationStatusChanged((next) => {
      setNarrationStatus(next);
      if (next.phase === "idle") void loadSessions();
    });
  }, [loadSessions]);

  const deleteSession = useCallback(async (id: string) => {
    setNotice(null);
    const res = await window.skillRecorder.deleteSession(id);
    if (!res.ok) {
      setNotice(res.error ?? "Could not delete this recording.");
      return;
    }
    setSessions((prev) => {
      const idx = prev.findIndex((s) => s.id === id);
      const next = prev.filter((s) => s.id !== id);
      setSelectedId((cur) => {
        if (cur !== id) return cur;
        if (next.length === 0) return null;
        return (next[idx] ?? next[next.length - 1]).id;
      });
      return next;
    });
  }, []);

  const selected = sessions.find((s) => s.id === selectedId) ?? null;
  const skill = skills.find((s) => s.name === selectedSkill) ?? null;

  return (
    <div className="lib">
      <aside className="lib-list">
        <div className="lib-list-head lib-tabs">
          <button
            className={`lib-tab${section === "sessions" ? " on" : ""}`}
            onClick={() => setSection("sessions")}
          >
            <span className="eyebrow">Sessions</span>
            <span className="pill">{sessions.length}</span>
          </button>
          <button
            className={`lib-tab${section === "skills" ? " on" : ""}`}
            onClick={() => setSection("skills")}
          >
            <span className="eyebrow">Skills</span>
            <span className="pill">{skills.length}</span>
          </button>
        </div>
        {notice && (
          <button className="sess-notice" onClick={() => setNotice(null)} title="Dismiss">
            {notice}
          </button>
        )}
        <div className="lib-list-scroll">
          {section === "sessions" ? (
            <SessionsList
              sessions={sessions}
              loaded={loaded}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onDelete={deleteSession}
            />
          ) : (
            <SkillsList
              skills={skills}
              loaded={skillsLoaded}
              selectedName={selectedSkill}
              onSelect={setSelectedSkill}
            />
          )}
        </div>
      </aside>
      <main className="lib-detail">
        {section === "skills" ? (
          skill ? (
            <SkillRunView key={skill.name} skill={skill} />
          ) : (
            <div className="detail-empty">
              <span className="eyebrow">No skill selected</span>
              <p>
                Pick an installed skill on the left to run it here. Anything it does to
                your machine is shown for approval first.
              </p>
            </div>
          )
        ) : selected ? (
          <AnalysisWorkspace
            key={selected.id}
            summary={selected}
            narrationStatus={narrationStatus}
            onChanged={loadSessions}
          />
        ) : (
          <div className="detail-empty">
            <span className="eyebrow">No session selected</span>
            <p>Pick a recording on the left to review its reconstructed intent and steps.</p>
          </div>
        )}
      </main>
    </div>
  );
}

/* --- Sessions list -------------------------------------------------------- */

function SessionsList({
  sessions,
  loaded,
  selectedId,
  onSelect,
  onDelete,
}: {
  sessions: SessionSummary[];
  loaded: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void | Promise<void>;
}) {
  const [confirmId, setConfirmId] = useState<string | null>(null);

  if (sessions.length === 0) {
    return <p className="sessions-empty">{loaded ? "No recordings yet." : "Loading…"}</p>;
  }
  return (
    <ul className="sess-list">
      {sessions.map((s) =>
        confirmId === s.id ? (
          <li key={s.id}>
            <div className="sess-confirm" role="alertdialog" aria-label="Confirm delete">
              <div className="sess-confirm-text">
                <span className="sess-confirm-title">Delete this recording?</span>
                <span className="sess-confirm-sub">
                  This cannot be undone.
                  {s.sizeBytes != null && ` Frees ${formatBytes(s.sizeBytes)} from this device.`}
                </span>
              </div>
              <div className="sess-confirm-actions">
                <button className="linky" onClick={() => setConfirmId(null)}>
                  Cancel
                </button>
                <button
                  className="danger"
                  onClick={() => {
                    setConfirmId(null);
                    void onDelete(s.id);
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          </li>
        ) : (
          <li key={s.id}>
            <div className="sess-row">
              <button
                className={`sess ${s.id === selectedId ? "on" : ""}`}
                onClick={() => onSelect(s.id)}
              >
                <div className="sess-top">
                  <span className="sess-when">{formatWhen(s.startedAt)}</span>
                  <span className="sess-tags">
                    {s.hasSkill && <span className="tag ok">skill</span>}
                    {s.hasAutomation && <span className="tag auto">automation</span>}
                    {!s.hasSkill && !s.hasAutomation && s.analysis && (
                      <span className="tag an">analyzed</span>
                    )}
                    {!s.hasSkill && !s.hasAutomation && !s.analysis && !s.processed && (
                      <span className="tag warn">processing</span>
                    )}
                    {!s.hasSkill && !s.hasAutomation && !s.analysis && s.processed && (
                      <span className="tag recorded">recorded</span>
                    )}
                  </span>
                </div>
                <div className="sess-intent">
                  {s.analysis
                    ? s.analysis.title?.trim() || shortLabel(s.analysis.intent)
                    : "Not analyzed yet"}
                </div>
                <div className="sess-sub">
                  {s.durationMs != null && <span>{formatDur(s.durationMs)}</span>}
                  {s.sizeBytes != null && (
                    <span
                      className="sess-size"
                      title={`${s.sizeBytes.toLocaleString()} bytes used by this recording`}
                    >
                      {formatBytes(s.sizeBytes)}
                    </span>
                  )}
                  {s.analysis && <span>{s.analysis.stepCount} steps</span>}
                  {s.hasVideo && <span>video</span>}
                  {s.hasAudio && !s.hasNarration && <span>voice pending</span>}
                  {s.hasNarration && <span>voice</span>}
                </div>
              </button>
              <button
                className="sess-del"
                aria-label={`Delete recording from ${formatWhen(s.startedAt)}`}
                title="Delete recording"
                onClick={() => setConfirmId(s.id)}
              >
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
                  <path
                    d="M3 4.5h10M6.4 4.5V3.3c0-.44.36-.8.8-.8h1.6c.44 0 .8.36.8.8v1.2M4.7 4.5l.5 8.2c.02.42.37.75.8.75h4c.42 0 .77-.33.8-.75l.5-8.2"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </div>
          </li>
        ),
      )}
    </ul>
  );
}

/* --- Analysis workspace --------------------------------------------------- */

const DownloadGlyph = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
    <path
      d="M8 2.6v6.2m0 0 2.3-2.3M8 8.8 5.7 6.5"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M3.2 10.4v1.2c0 .6.5 1.1 1.1 1.1h7.4c.6 0 1.1-.5 1.1-1.1v-1.2"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const SavedGlyph = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
    <path
      d="M3.4 8.4 6.3 11.3 12.6 4.8"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/**
 * Subtle, per-recording "download a debug bundle" affordance shown in the session
 * header. A quiet download icon packages the whole session (private capture data)
 * into a `.zip` the user can hand to us; a privacy-warning modal gates the actual
 * download. It says nothing about where to send the file — that's shared separately.
 */
function DebugDownload({ sessionId }: { sessionId: string }) {
  const [phase, setPhase] = useState<"idle" | "confirm" | "saving" | "saved" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);

  const download = useCallback(async () => {
    setPhase("saving");
    setErrorMsg("");
    const res = await window.skillRecorder.exportDebugBundle(sessionId);
    if (res.ok) setPhase("saved");
    else if (res.canceled) setPhase("idle");
    else {
      setErrorMsg(res.error ?? "Couldn't create the debug bundle.");
      setPhase("error");
    }
  }, [sessionId]);

  // Let the "Saved" acknowledgement fade back to the quiet icon on its own.
  useEffect(() => {
    if (phase !== "saved") return;
    const t = setTimeout(() => setPhase("idle"), 3200);
    return () => clearTimeout(t);
  }, [phase]);

  // While the warning is up, focus it and close on Escape — matching the app's sheets.
  useEffect(() => {
    if (phase !== "confirm") return;
    dialogRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPhase("idle");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase]);

  const label =
    phase === "saving"
      ? "Preparing debug bundle…"
      : phase === "saved"
        ? "Debug bundle saved"
        : "Download details for debugging";

  return (
    <div className="debug-dl">
      {phase === "error" && (
        <span className="debug-dl-note" title={errorMsg}>
          Couldn't save
        </span>
      )}
      <button
        className={`debug-dl-icon${phase === "saved" ? " is-saved" : ""}`}
        onClick={() => setPhase("confirm")}
        disabled={phase === "saving"}
        aria-label={label}
        title={label}
      >
        {phase === "saving" ? (
          <span className="spinner" aria-hidden />
        ) : phase === "saved" ? (
          <SavedGlyph />
        ) : (
          <DownloadGlyph />
        )}
      </button>

      {phase === "confirm" && (
        <div className="sheet-backdrop" onClick={() => setPhase("idle")}>
          <div
            ref={dialogRef}
            className="sheet debug-sheet"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="debug-dl-title"
            aria-describedby="debug-dl-desc"
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
          >
            <header className="sheet-head">
              <span className="sheet-icon" aria-hidden>
                <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
                  <rect
                    x="4.4"
                    y="8.7"
                    width="11.2"
                    height="7.9"
                    rx="1.9"
                    stroke="currentColor"
                    strokeWidth="1.4"
                  />
                  <path
                    d="M6.9 8.7V6.7a3.1 3.1 0 0 1 6.2 0v2"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                  />
                  <circle cx="10" cy="12.4" r="1.1" fill="currentColor" />
                </svg>
              </span>
              <h2 id="debug-dl-title">Includes private information</h2>
            </header>

            <p className="sheet-lead" id="debug-dl-desc">
              This bundle is everything captured in this recording — screen video, screenshots,
              visited URLs, clipboard contents, and any voice narration and transcript. Share it
              only with people you trust.
            </p>

            <div className="sheet-actions">
              <button className="linky" onClick={() => setPhase("idle")}>
                Cancel
              </button>
              <button className="record-cta" onClick={() => void download()}>
                Download .zip
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Error banner for the Foundry-backed panels. When this computer has no connection
 * stored yet, the banner *becomes* the connection form — the renderer affordance the
 * "isn't configured" contract points at — so first run is "paste endpoint + key, Save,
 * Analyze again" instead of hand-editing JSON. Every other error renders verbatim.
 *
 * The API key is write-only: it is typed here, sent main-ward, and never read back
 * (`getFoundryConnection` is key-free by construction), so the field starts blank even
 * when an endpoint is already stored.
 */
function FoundryConnectionError({ error }: { error: string }) {
  const needsConnection = isFoundryNotConfiguredError(error);
  const [info, setInfo] = useState<FoundryConnectionInfo | null>(null);
  const [endpoint, setEndpoint] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [deployment, setDeployment] = useState(DEFAULT_FOUNDRY_DEPLOYMENT);
  const [describerDeployment, setDescriberDeployment] = useState(
    DEFAULT_FOUNDRY_DESCRIBER_DEPLOYMENT,
  );
  const [transcriptionDeployment, setTranscriptionDeployment] = useState(
    DEFAULT_FOUNDRY_TRANSCRIPTION_DEPLOYMENT,
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testMessage, setTestMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!needsConnection) return;
    let live = true;
    void window.skillRecorder.getFoundryConnection().then((next) => {
      if (!live) return;
      setInfo(next);
      if (next.endpoint) setEndpoint(next.endpoint);
      if (next.deployment) setDeployment(next.deployment);
    });
    return () => {
      live = false;
    };
  }, [needsConnection]);

  if (!needsConnection) return <div className="analysis-error">{error}</div>;

  const save = async () => {
    setSaving(true);
    setSaved(false);
    setSaveError(null);
    setTestMessage(null);
    const result = await window.skillRecorder.saveFoundryConnection({
      endpoint,
      apiKey,
      deployment,
      describerDeployment,
      transcriptionDeployment,
    });
    setInfo(result.info);
    setSaved(result.ok);
    // Validation messages come from main written for the user — show them as they are.
    setSaveError(result.ok ? null : (result.error ?? "Could not save the connection."));
    setSaving(false);
  };

  const test = async () => {
    setTesting(true);
    setTestMessage(null);
    const result = await window.skillRecorder.testFoundryConnection();
    setTestMessage(result.message);
    setTesting(false);
  };

  const busy = saving || testing;

  return (
    <div className="analysis-error">
      <p>{error}</p>
      <div className="foundry-form">
        <label className="foundry-field">
          <span className="edit-label">Endpoint</span>
          <input
            value={endpoint}
            placeholder="https://<resource>.services.ai.azure.com"
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setEndpoint(e.target.value)}
          />
        </label>
        <label className="foundry-field">
          <span className="edit-label">API key</span>
          <input
            type="password"
            value={apiKey}
            placeholder="Paste the resource key"
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setApiKey(e.target.value)}
          />
        </label>
        <details className="analyze-disclosure">
          <summary>Deployments</summary>
          <div className="foundry-form">
            <label className="foundry-field">
              <span className="edit-label">Skills and automations</span>
              <input
                value={deployment}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => setDeployment(e.target.value)}
              />
            </label>
            <label className="foundry-field">
              <span className="edit-label">Recording analysis</span>
              <input
                value={describerDeployment}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => setDescriberDeployment(e.target.value)}
              />
            </label>
            <label className="foundry-field">
              <span className="edit-label">Voice transcription</span>
              <input
                value={transcriptionDeployment}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => setTranscriptionDeployment(e.target.value)}
              />
            </label>
            <span className="edit-hint">
              Leave these as they are unless your resource names its deployments differently.
            </span>
          </div>
        </details>
      </div>

      <div className="signin-row">
        <button className="row-action" onClick={() => void save()} disabled={busy}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          className="row-action"
          onClick={() => void test()}
          disabled={busy || !info?.configured}
        >
          {testing ? "Testing…" : "Test connection"}
        </button>
        {saved && <span>Saved — try Analyze again.</span>}
        {saveError && <span>{saveError}</span>}
        {testMessage && <span>{testMessage}</span>}
      </div>

      <p className="signin-manual">Or write the same values yourself into:</p>
      <code className="signin-command">~/.skill-recorder/foundry.json</code>
    </div>
  );
}

function AnalysisWorkspace({
  summary,
  narrationStatus,
  onChanged,
}: {
  summary: SessionSummary;
  narrationStatus: NarrationStatus | null;
  onChanged: () => void | Promise<void>;
}) {
  const sessionId = summary.id;
  const voicePending = summary.hasAudio && !summary.hasNarration;
  const voiceLanguage = narrationLanguageLabel(
    summary.narrationLanguage ?? DEFAULT_NARRATION_LANGUAGE,
  );
  const voiceBusy =
    narrationStatus?.activeSessionId === sessionId && narrationStatus.phase !== "idle";
  const voiceError =
    narrationStatus?.activeSessionId == null || narrationStatus.activeSessionId === sessionId
      ? narrationStatus?.error
      : null;
  const voiceStale =
    summary.analysis != null &&
    (summary.narrationSegmentCount ?? 0) > 0 &&
    summary.narrationUpdatedAt != null &&
    (summary.analysis.narrationSourceUpdatedAt == null ||
      summary.narrationUpdatedAt > summary.analysis.narrationSourceUpdatedAt);

  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [statusLine, setStatusLine] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftIntent, setDraftIntent] = useState("");
  const [confirmReanalysis, setConfirmReanalysis] = useState(false);
  // Directly-editable steps (the source of truth downstream); persisted on a short
  // debounce so typing stays instant. `stepsDirty` gates the persist so seeding from
  // a freshly loaded analysis never writes back.
  const [steps, setSteps] = useState<AnalysisStep[]>([]);
  const stepsDirty = useRef(false);
  const stepsRef = useRef<AnalysisStep[]>([]);
  stepsRef.current = steps;
  // The final stage: pick a target, then build a skill or an automation. A recording
  // that is already exactly one kind opens straight to it; otherwise it opens to the
  // analysis, where "Create…" starts the target picker.
  const initialLaunch: LaunchTarget =
    summary.hasSkill && !summary.hasAutomation
      ? "skill"
      : summary.hasAutomation && !summary.hasSkill
        ? "automation"
        : "none";
  const [launch, setLaunch] = useState<LaunchTarget>(initialLaunch);
  const [chosenArch, setChosenArch] = useState<SkillArchitecture>("app");
  // Set while the user is deliberately canceling, so the aborted run's rejection
  // doesn't surface as an error toast.
  const canceled = useRef(false);

  useEffect(() => {
    let live = true;
    void window.skillRecorder.getAnalysis(sessionId).then((a) => {
      if (!live) return;
      setAnalysis(a);
      setSteps(a?.steps ?? []);
      stepsDirty.current = false;
    });
    return () => {
      live = false;
    };
  }, [sessionId]);

  // Persist directly-edited steps on a short debounce (no agent, no re-analysis).
  useEffect(() => {
    if (!stepsDirty.current) return;
    const t = setTimeout(() => {
      stepsDirty.current = false;
      void window.skillRecorder.updateAnalysis({ sessionId, steps: stepsRef.current }).then((res) => {
        if (res.ok && res.analysis) setAnalysis(res.analysis);
        void onChanged();
      });
    }, 500);
    return () => clearTimeout(t);
  }, [steps, sessionId, onChanged]);

  // Flush any pending step edits when leaving this session, so nothing is lost.
  useEffect(() => {
    return () => {
      if (stepsDirty.current) {
        void window.skillRecorder.updateAnalysis({ sessionId, steps: stepsRef.current });
        stepsDirty.current = false;
      }
    };
  }, [sessionId]);

  const onStepsChange = useCallback((next: AnalysisStep[]) => {
    stepsDirty.current = true;
    setSteps(next);
  }, []);

  // Single latest status line (no growing log).
  useEffect(() => {
    return window.skillRecorder.onAnalyzeProgress((p: AnalyzeProgress) => {
      if (p.sessionId !== sessionId) return;
      setStatusLine(p.message);
      if (p.phase === "done" || p.phase === "error") setAnalyzing(false);
    });
  }, [sessionId]);

  const run = useCallback(async () => {
    canceled.current = false;
    setEditing(false);
    setDraftTitle("");
    setDraftIntent("");
    setAnalyzing(true);
    setError(null);
    setStatusLine("Starting…");
    const res = await window.skillRecorder.analyze(sessionId);
    if (res.ok && res.analysis) {
      setAnalysis(res.analysis);
      setSteps(res.analysis.steps);
      stepsDirty.current = false;
    } else if (!canceled.current) setError(res.error ?? "Analysis failed");
    setAnalyzing(false);
    void onChanged();
  }, [sessionId, onChanged]);

  const cancel = useCallback(async () => {
    canceled.current = true;
    setStatusLine("Stopping…");
    await window.skillRecorder.cancelAnalysis(sessionId);
    setAnalyzing(false);
  }, [sessionId]);

  const startEdit = useCallback(() => {
    if (!analysis) return;
    setDraftTitle(analysis.title ?? "");
    setDraftIntent(analysis.intent);
    setError(null);
    setEditing(true);
  }, [analysis]);

  const saveEdit = useCallback(async () => {
    const res = await window.skillRecorder.updateAnalysis({
      sessionId,
      title: draftTitle.trim(),
      intent: draftIntent.trim() || undefined,
    });
    if (res.ok && res.analysis) {
      setAnalysis(res.analysis);
      setEditing(false);
    } else {
      setError(res.error ?? "Could not save your changes");
    }
    void onChanged();
  }, [sessionId, draftTitle, draftIntent, onChanged]);

  if (launch === "picker") {
    return (
      <TargetPicker
        sessionId={sessionId}
        startedAt={summary.startedAt}
        onPick={(t) => {
          setChosenArch(t.architecture);
          setLaunch(t.kind);
        }}
        onClose={() => setLaunch("none")}
      />
    );
  }

  if (launch === "skill") {
    return (
      <SkillBuilderView
        sessionId={sessionId}
        architecture={chosenArch}
        startedAt={summary.startedAt}
        hasSkill={summary.hasSkill}
        onClose={() => {
          setLaunch("none");
          void onChanged();
        }}
      />
    );
  }

  if (launch === "automation") {
    return (
      <AutomationBuilderView
        sessionId={sessionId}
        architecture={chosenArch}
        startedAt={summary.startedAt}
        hasAutomation={summary.hasAutomation}
        onClose={() => {
          setLaunch("none");
          void onChanged();
        }}
      />
    );
  }

  return (
    <section className="ws">
      <div className="ws-head">
        <div className="ws-titles">
          <span className="eyebrow">Analysis</span>
          <span className="ws-when">{formatWhen(summary.startedAt)}</span>
        </div>
        <DebugDownload sessionId={sessionId} />
      </div>

      <div className="ws-body">
        {voicePending && voiceError && !analyzing && (
          <p className="voice-analysis-note">
            Couldn't transcribe your {voiceLanguage} voice, so this analysis doesn't include it.
            Your audio is saved — analyzing again will retry.
          </p>
        )}

        {voiceStale && !analyzing && (
          <div className="voice-card">
            <div className="voice-card-copy">
              <strong>Voice transcript added after this analysis</strong>
              <span>Re-analyze to include it. This replaces the current summary and any edits.</span>
            </div>
            {confirmReanalysis ? (
              <div className="voice-card-actions">
                <button className="linky" onClick={() => setConfirmReanalysis(false)}>
                  Cancel
                </button>
                <button
                  className="secondary"
                  onClick={() => {
                    setConfirmReanalysis(false);
                    void run();
                  }}
                >
                  Replace analysis
                </button>
              </div>
            ) : (
              <button className="secondary" onClick={() => setConfirmReanalysis(true)}>
                Re-analyze with voice
              </button>
            )}
          </div>
        )}

        {!summary.processed && (
          <p className="ws-note">Still processing this recording… try again in a moment.</p>
        )}

        {summary.processed && !analysis && !analyzing && (
          <div className="ws-empty">
            <p className="ws-empty-lead">See what you did in this recording, step by step.</p>
            <button className="record-cta" onClick={run}>
              Analyze recording
            </button>
            <details className="analyze-disclosure">
              <summary>What gets sent for analysis</summary>
              <p>
                Analyze sends the event timeline—including window and document titles, URLs,
                and clipboard previews—plus extracted screen images, narration text, and other
                content you provide to your Azure AI Foundry deployment for analysis.{" "}
                <span className="cloud-analysis-caution">
                  Do not analyze a recording that may contain passwords, access tokens, API keys,
                  credentials, secrets, or other sensitive or confidential information.
                </span>
              </p>
            </details>
            {voicePending && (
              <p className="voice-analysis-note">
                {`Your ${voiceLanguage} voice recording is sent to your Azure AI Foundry deployment and transcribed in the same language first, then analyzed.`}
              </p>
            )}
          </div>
        )}

        {analyzing && (
          <div className="status-line">
            <span className="spinner" />
            <span className="status-text">
              {voiceBusy ? narrationWorkLabel(narrationStatus) : statusLine || "Working…"}
            </span>
            <button className="linky status-cancel" onClick={cancel}>
              Cancel
            </button>
          </div>
        )}

        {error && <FoundryConnectionError error={error} />}

        {analysis && !analyzing && (
          <div className="ws-read">
            <div className="summary">
              <div className="summary-head">
                <span className="eyebrow">What you did</span>
                {!editing && (
                  <button className="linky" onClick={startEdit}>
                    Edit
                  </button>
                )}
              </div>

              {editing ? (
                <div className="summary-edit">
                  <label className="edit-field">
                    <span className="edit-label">Name</span>
                    <input
                      className="edit-title"
                      value={draftTitle}
                      placeholder="Short name, e.g. Research habit articles"
                      autoFocus
                      onChange={(e) => setDraftTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void saveEdit();
                        } else if (e.key === "Escape") setEditing(false);
                      }}
                    />
                    <span className="edit-hint">Appears in your sessions list</span>
                  </label>
                  <label className="edit-field">
                    <span className="edit-label">Goal</span>
                    <textarea
                      className="edit-intent"
                      value={draftIntent}
                      placeholder="One sentence: what were you trying to do?"
                      onChange={(e) => setDraftIntent(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setEditing(false);
                      }}
                    />
                  </label>
                  <div className="edit-actions">
                    <button className="linky" onClick={() => setEditing(false)}>
                      Cancel
                    </button>
                    <button className="secondary" onClick={() => void saveEdit()}>
                      Save
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <h2 className="summary-text">{analysis.intent}</h2>
                  {analysis.intentRationale && (
                    <p className="summary-why">{analysis.intentRationale}</p>
                  )}
                </>
              )}
            </div>

            <div className="story-edit">
              <div className="summary-head">
                <span className="eyebrow">Steps</span>
                <span className="edit-hint">Click any step to edit · reorder, add or remove — saved automatically</span>
              </div>
              <AnalysisStepTiles steps={steps} onChange={onStepsChange} />
            </div>
          </div>
        )}
      </div>

      {analysis && !analyzing && (
        <div className="ws-foot">
          <span className="foot-status">{launchFootStatus(summary)}</span>
          <div className="ws-foot-actions">
            {summary.hasSkill && (
              <button className="secondary" onClick={() => setLaunch("skill")} title="Open the skill built from this recording">
                Open skill →
              </button>
            )}
            {summary.hasAutomation && (
              <button
                className="secondary"
                onClick={() => setLaunch("automation")}
                title="Open the automation built from this recording"
              >
                Open automation →
              </button>
            )}
            <button
              className="record-cta"
              onClick={() => setLaunch("picker")}
              title="Turn this recording into a skill or an automation"
            >
              {summary.hasSkill || summary.hasAutomation ? "Create another →" : "Create…"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function narrationWorkLabel(status: NarrationStatus | null): string {
  if (status?.phase === "transcribing") return "Transcribing voice…";
  return "Working…";
}

/* --- Final stage: target picker + builders -------------------------------- */

/** Which final-stage surface the analysis workspace is showing. */
type LaunchTarget = "none" | "picker" | "skill" | "automation";

function launchFootStatus(summary: SessionSummary): string {
  if (summary.hasSkill && summary.hasAutomation) return "Skill & automation created";
  if (summary.hasSkill) return "Skill created";
  if (summary.hasAutomation) return "Automation created";
  return "";
}

/** "What do you want to build?" — picks both kind and architecture up front. */
function TargetPicker({
  sessionId,
  startedAt,
  onPick,
  onClose,
}: {
  sessionId: string;
  startedAt: number | null;
  onPick: (target: BuildTarget) => void;
  onClose: () => void;
}) {
  const [reference, setReference] = useApiReference(sessionId);
  return (
    <section className="ws">
      <div className="ws-head">
        <div className="ws-titles">
          <span className="eyebrow">Create</span>
          <span className="ws-when">{formatWhen(startedAt)}</span>
        </div>
        <button className="ghost" onClick={onClose} title="Back to the analysis">
          Cancel
        </button>
      </div>
      <div className="ws-body">
        <div className="sb-arch">
          <p className="sb-lead">What do you want to build from this recording?</p>
          <div className="arch-grid">
            {TARGETS.map((t) => (
              <button
                key={`${t.kind}:${t.architecture}`}
                className="arch-card"
                disabled={!t.enabled}
                onClick={() => t.enabled && onPick(t)}
              >
                <span className="arch-name">{t.label}</span>
                <span className="arch-note">{t.enabled ? t.note : "Coming soon"}</span>
              </button>
            ))}
          </div>
          <ApiReferenceAttach
            sessionId={sessionId}
            reference={reference}
            onChange={setReference}
          />
        </div>
      </div>
    </section>
  );
}

/* --- API reference -------------------------------------------------------- */

/**
 * The API reference attached to a recording. It is chosen on the picker sheet — before
 * any builder conversation exists — because attaching decides which tools the builder
 * agent is given, and the builder panels open straight into planning.
 */
function useApiReference(sessionId: string) {
  const [reference, setReference] = useState<ApiReferenceSummary | null>(null);
  useEffect(() => {
    let live = true;
    void window.skillRecorder.getApiReference(sessionId).then((r) => {
      if (live) setReference(r);
    });
    return () => {
      live = false;
    };
  }, [sessionId]);
  return [reference, setReference] as const;
}

/** "Sales API · 42 operations" — how a builder panel says a reference is in play. */
function ApiReferenceChip({ reference }: { reference: ApiReferenceSummary | null }) {
  if (!reference) return null;
  const count =
    reference.operationCount > 0
      ? `${reference.operationCount} operation${reference.operationCount === 1 ? "" : "s"}`
      : `${reference.chunkCount} doc section${reference.chunkCount === 1 ? "" : "s"}`;
  return (
    <span className="pill api-chip" title="This recording has an API reference attached">
      {reference.name} · {count}
    </span>
  );
}

function ApiReferenceAttach({
  sessionId,
  reference,
  onChange,
}: {
  sessionId: string;
  reference: ApiReferenceSummary | null;
  onChange: (next: ApiReferenceSummary | null) => void;
}) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const attach = useCallback(
    async (input: ApiReferenceAttachInput) => {
      setBusy(true);
      setError(null);
      const res = await window.skillRecorder.attachApiReference(sessionId, input);
      setBusy(false);
      if (res.ok) {
        onChange(res.reference ?? null);
        setUrl("");
      } else if (!res.canceled) {
        // Main writes these for the user (they name the fix); show them as-is.
        setError(res.error ?? "Could not attach that reference.");
      }
    },
    [sessionId, onChange],
  );

  const remove = useCallback(
    async (sourceId: string) => {
      setBusy(true);
      setError(null);
      const res = await window.skillRecorder.removeApiReference(sessionId, sourceId);
      setBusy(false);
      if (res.ok) onChange(res.reference ?? null);
      else setError(res.error ?? "Could not remove that source.");
    },
    [sessionId, onChange],
  );

  return (
    <div className="sb-sec api-ref">
      <span className="eyebrow">API reference (optional)</span>
      <p className="sb-refine-hint">
        Attach the target application's OpenAPI spec (JSON) or its documentation, and the plan can
        call API operations instead of replaying the UI. It's stored with this recording and used
        only while planning.
      </p>

      {reference && reference.sources.length > 0 && (
        <ul className="api-ref-list">
          {reference.sources.map((s) => (
            <li key={s.id} className="row">
              <span className="row-label">{s.name}</span>
              <span className="row-note">
                {s.kind === "openapi"
                  ? `spec · ${s.operationCount} operations`
                  : `docs · ${s.chunkCount} sections`}
              </span>
              <button
                className="linky"
                disabled={busy}
                onClick={() => void remove(s.id)}
                title="Remove this source"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="api-ref-actions">
        <button className="ghost" disabled={busy} onClick={() => void attach({ kind: "file" })}>
          Attach file…
        </button>
        <input
          className="fb-input api-ref-url"
          value={url}
          placeholder="…or paste a spec / docs URL"
          aria-label="API reference URL"
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && url.trim() && !busy) void attach({ kind: "url", url: url.trim() });
          }}
        />
        <button
          className="ghost"
          disabled={busy || !url.trim()}
          onClick={() => void attach({ kind: "url", url: url.trim() })}
        >
          Attach URL
        </button>
      </div>

      {busy && <span className="sb-muted">Working…</span>}
      {error && (
        <div className="analysis-error">
          <p>{error}</p>
        </div>
      )}
    </div>
  );
}

/* --- Skill builder ------------------------------------------------------- */

type BuildPhase = "loading" | "ready" | "planning" | "plan" | "creating" | "done";

function SkillBuilderView({
  sessionId,
  architecture: initialArch,
  startedAt,
  hasSkill,
  onClose,
}: {
  sessionId: string;
  architecture: SkillArchitecture;
  startedAt: number | null;
  hasSkill: boolean;
  onClose: () => void;
}) {
  // If this recording is already a skill, hold on a spinner until we've loaded it,
  // so we never flash the planning state before jumping to the skill.
  const [phase, setPhase] = useState<BuildPhase>(hasSkill ? "loading" : "ready");
  const [architecture, setArchitecture] = useState<SkillArchitecture>(initialArch);
  const [plan, setPlan] = useState<SkillPlan | null>(null);
  const [statusLine, setStatusLine] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [exportedPath, setExportedPath] = useState("");
  const [builtName, setBuiltName] = useState("");
  const canceled = useRef(false);
  const inFlight = useRef(false);
  const [placement, setPlacement] = useState<SkillPlacement>("install");
  // Engine-owned: the operations the built skill was actually grounded on (empty unless
  // the plan named `api:` operations AND a spec was attached to copy into the folder).
  const [apiOperations, setApiOperations] = useState<string[]>([]);
  // Read-only here: the reference is attached on the picker, before this panel opens.
  const [reference] = useApiReference(sessionId);

  const updatePlan = useCallback((part: Partial<SkillPlan>) => {
    setPlan((prev) => (prev ? { ...prev, ...part } : prev));
  }, []);

  // Leaving the builder (session switch or Close) discards an in-progress plan —
  // we don't save drafts — so stop any run that's still going in the background.
  useEffect(() => {
    return () => {
      if (inFlight.current) void window.skillRecorder.cancelSkill(sessionId);
    };
  }, [sessionId]);

  // Reopen straight to the exported state if this recording already has a skill.
  useEffect(() => {
    let live = true;
    void window.skillRecorder.getSkill(sessionId).then((s: BuiltSkill | null) => {
      if (!live) return;
      if (s?.exportedPath) {
        setBuiltName(s.name);
        setExportedPath(s.exportedPath);
        setArchitecture(s.architecture);
        // We don't persist how it was placed; copilot-studio can only export, and an app
        // skill defaults to install (its primary action), so infer it from the architecture.
        setPlacement(s.architecture === "copilot-studio" ? "export" : "install");
        setApiOperations(s.apiReference?.operations ?? []);
        if (s.plan) setPlan(s.plan);
        setPhase("done");
      } else if (hasSkill) {
        // We expected a skill but couldn't load it; fall back to the ready screen.
        setPhase("ready");
      }
    });
    return () => {
      live = false;
    };
  }, [sessionId, hasSkill]);

  useEffect(() => {
    return window.skillRecorder.onSkillProgress((p: SkillBuildProgress) => {
      if (p.sessionId === sessionId) setStatusLine(p.message);
    });
  }, [sessionId]);

  const runPlan = useCallback(async () => {
    canceled.current = false;
    inFlight.current = true;
    setError(null);
    setStatusLine("Planning the skill…");
    setPhase("planning");
    const res = await window.skillRecorder.buildSkill({ sessionId, architecture });
    inFlight.current = false;
    if (res.ok && res.plan) {
      setPlan(res.plan);
      setPhase("plan");
    } else if (!canceled.current) {
      setError(res.error ?? "Planning failed");
      setPhase("ready");
    }
  }, [sessionId, architecture]);

  const place = useCallback(
    async (which: SkillPlacement) => {
      if (!plan) return;
      canceled.current = false;
      inFlight.current = true;
      setError(null);
      setStatusLine(which === "export" ? "Exporting the skill…" : "Writing the skill…");
      setPhase("creating");
      const res = await window.skillRecorder.createSkill(sessionId, plan, which);
      inFlight.current = false;
      if (res.ok && res.skill) {
        setBuiltName(res.skill.name);
        setExportedPath(res.path ?? res.skill.exportedPath ?? "");
        setPlacement(res.placement ?? which);
        setApiOperations(res.skill.apiReference?.operations ?? []);
        setPhase("done");
      } else if (res.canceled) {
        // User dismissed the export folder picker — quietly return to the plan.
        setPhase("plan");
      } else if (!canceled.current) {
        setError(res.error ?? "Could not create the skill");
        setPhase("plan");
      }
    },
    [sessionId, plan],
  );

  const cancelRun = useCallback(async () => {
    canceled.current = true;
    inFlight.current = false;
    setStatusLine("Stopping…");
    await window.skillRecorder.cancelSkill(sessionId);
    setPhase(plan ? "plan" : "ready");
  }, [sessionId, plan]);

  const busy = phase === "planning" || phase === "creating";
  // Only an app skill has a library to install into; a Copilot Studio skill is an
  // export-only bundle the user adds to their agent themselves.
  const canInstall = architecture === "app";

  return (
    <section className="ws">
      <div className="ws-head">
        <div className="ws-titles">
          <span className="eyebrow">{phase === "done" ? "Skill" : "Create skill"}</span>
          <span className="ws-when">{formatWhen(startedAt)}</span>
          <ApiReferenceChip reference={reference} />
        </div>
        <button
          className="ghost"
          onClick={onClose}
          disabled={busy}
          title={phase === "done" ? "View this recording's analysis" : "Back to the analysis"}
        >
          {phase === "done" ? "Analysis" : "Close"}
        </button>
      </div>

      <div className="ws-body">
        {error && <FoundryConnectionError error={error} />}

        {phase === "loading" && (
          <div className="status-line">
            <span className="spinner" />
            <span className="status-text">Opening the skill…</span>
          </div>
        )}

        {phase === "ready" && (
          <div className="sb-arch">
            <p className="sb-lead">Build {targetPhrase("skill", architecture)} from this recording.</p>
            <button className="record-cta" onClick={() => void runPlan()}>
              Plan the skill →
            </button>
          </div>
        )}

        {busy && (
          <div className="status-line">
            <span className="spinner" />
            <span className="status-text">{statusLine || "Working…"}</span>
            <button className="linky status-cancel" onClick={cancelRun}>
              Cancel
            </button>
          </div>
        )}

        {phase === "plan" && plan && (
          <div className="sb-plan">
            <div className="sb-planhead">
              <EditableText
                as="div"
                className="sb-title ed-title"
                value={plan.title}
                placeholder="Skill title"
                ariaLabel="Skill title"
                onChange={(v) => updatePlan({ title: v })}
              />
              <code className="sb-slug">{plan.name}</code>
            </div>
            <EditableText
              as="p"
              multiline
              className="sb-desc ed-desc"
              value={plan.description}
              placeholder="One-line description of what this skill does"
              ariaLabel="Skill description"
              onChange={(v) => updatePlan({ description: v })}
            />

            <div className="sb-sec">
              <span className="eyebrow">What the skill will do</span>
              <p className="sb-refine-hint">
                Click any step to edit, or a highlighted value to change it. Reorder, add or remove as needed.
              </p>
              <SkillStepTiles
                steps={plan.steps}
                onChange={(steps) => updatePlan({ steps })}
                values={plan.values}
                onChangeValues={(values) => updatePlan({ values })}
              />
            </div>
          </div>
        )}

        {phase === "done" && (
          <div className="sb-done">
            <div className="sb-check" aria-hidden>
              ✓
            </div>
            <h2 className="sb-title">
              {placement === "install" ? "Added to your skill library" : "Skill exported"}
            </h2>
            <p>
              <code className="sb-slug">{builtName}</code>{" "}
              {placement === "install"
                ? "is now in this app's skill library."
                : architecture === "copilot-studio"
                  ? "is ready to add to your Copilot Studio agent: paste the body into the agent's Instructions and configure the listed connectors."
                  : "is exported. Drop the folder into this app's skill library when you want it installed."}
            </p>
            {exportedPath && <p className="sb-path">{exportedPath}</p>}
            {apiOperations.length > 0 && (
              <p className="sb-import-hint">
                {architecture === "copilot-studio"
                  ? `Import api/openapi.json from this folder as a custom connector, then configure these actions: ${apiOperations.join(", ")}.`
                  : `Its API operations (${apiOperations.join(", ")}) will run against the spec stored in api/openapi.json once the runner ships.`}
              </p>
            )}
          </div>
        )}
      </div>

      {phase === "plan" && plan && (
        <div className="ws-foot">
          <span className="foot-status" />
          <div className="ws-foot-actions">
            {canInstall && (
              <button
                className="ghost"
                onClick={() => void place("export")}
                title="Download the skill to a folder you choose"
              >
                Export…
              </button>
            )}
            <button
              className="record-cta"
              onClick={() => void place(canInstall ? "install" : "export")}
              title={
                canInstall
                  ? "Add the skill to this app's library"
                  : "Download the skill to a folder you choose"
              }
            >
              {canInstall ? "Add to library" : "Export skill"}
            </button>
          </div>
        </div>
      )}

      {phase === "done" && (
        <div className="ws-foot">
          <span className="foot-status">Skill created</span>
          <div className="ws-foot-actions">
            {exportedPath && (
              <button className="record-cta" onClick={() => void window.skillRecorder.revealSkill(sessionId)}>
                Reveal file
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/** "an App skill" / "a Copilot Studio automation" — the picker's own label, kept in
 *  sync by reading it back out of TARGETS rather than restating it here. */
function targetPhrase(kind: BuildKind, architecture: SkillArchitecture): string {
  const label = TARGETS.find((t) => t.kind === kind && t.architecture === architecture)?.label ?? kind;
  return `${/^[aeiou]/i.test(label) ? "an" : "a"} ${label}`;
}

/* --- Automation builder --------------------------------------------------- */

function AutomationBuilderView({
  sessionId,
  architecture: initialArch,
  startedAt,
  hasAutomation,
  onClose,
}: {
  sessionId: string;
  architecture: SkillArchitecture;
  startedAt: number | null;
  hasAutomation: boolean;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<BuildPhase>(hasAutomation ? "loading" : "ready");
  const [architecture, setArchitecture] = useState<SkillArchitecture>(initialArch);
  const [plan, setPlan] = useState<AutomationPlan | null>(null);
  const [statusLine, setStatusLine] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [exportedPath, setExportedPath] = useState("");
  const [builtName, setBuiltName] = useState("");
  const canceled = useRef(false);
  const inFlight = useRef(false);
  // Read-only here: the reference is attached on the picker, before this panel opens.
  const [reference] = useApiReference(sessionId);

  const updatePlan = useCallback((part: Partial<AutomationPlan>) => {
    setPlan((prev) => (prev ? { ...prev, ...part } : prev));
  }, []);

  useEffect(() => {
    return () => {
      if (inFlight.current) void window.skillRecorder.cancelAutomation(sessionId);
    };
  }, [sessionId]);

  // Reopen straight to the exported state if this recording already has one.
  useEffect(() => {
    let live = true;
    void window.skillRecorder.getAutomation(sessionId).then((a: BuiltAutomation | null) => {
      if (!live) return;
      if (a?.exportedPath) {
        setBuiltName(a.name);
        setExportedPath(a.exportedPath);
        setArchitecture(a.architecture);
        if (a.plan) setPlan(a.plan);
        setPhase("done");
      } else if (hasAutomation) {
        setPhase("ready");
      }
    });
    return () => {
      live = false;
    };
  }, [sessionId, hasAutomation]);

  useEffect(() => {
    return window.skillRecorder.onAutomationProgress((p: AutomationBuildProgress) => {
      if (p.sessionId === sessionId) setStatusLine(p.message);
    });
  }, [sessionId]);

  const runPlan = useCallback(async () => {
    canceled.current = false;
    inFlight.current = true;
    setError(null);
    setStatusLine("Planning the automation…");
    setPhase("planning");
    const res = await window.skillRecorder.buildAutomation({ sessionId, architecture });
    inFlight.current = false;
    if (res.ok && res.plan) {
      setPlan(res.plan);
      setPhase("plan");
    } else if (!canceled.current) {
      setError(res.error ?? "Planning failed");
      setPhase("ready");
    }
  }, [sessionId, architecture]);

  const create = useCallback(async () => {
    if (!plan) return;
    canceled.current = false;
    inFlight.current = true;
    setError(null);
    setStatusLine("Writing the automation…");
    setPhase("creating");
    const res = await window.skillRecorder.createAutomation(sessionId, plan);
    inFlight.current = false;
    if (res.ok && res.automation) {
      setBuiltName(res.automation.name);
      setExportedPath(res.path ?? res.automation.exportedPath ?? "");
      setPhase("done");
    } else if (!canceled.current) {
      setError(res.error ?? "Could not create the automation");
      setPhase("plan");
    }
  }, [sessionId, plan]);

  const cancelRun = useCallback(async () => {
    canceled.current = true;
    inFlight.current = false;
    setStatusLine("Stopping…");
    await window.skillRecorder.cancelAutomation(sessionId);
    setPhase(plan ? "plan" : "ready");
  }, [sessionId, plan]);

  const busy = phase === "planning" || phase === "creating";
  // API-grounded only when the reviewed steps name `api:` operations AND a spec is
  // attached (docs alone index no operations) — that pair is also what puts
  // api/openapi.json in a copilot-studio bundle, so the copy below can promise it.
  const apiOperations =
    plan && (reference?.operationCount ?? 0) > 0
      ? collectApiRefs(plan.steps).map((ref) => ref.replace(/^api:/i, ""))
      : [];

  return (
    <section className="ws">
      <div className="ws-head">
        <div className="ws-titles">
          <span className="eyebrow">{phase === "done" ? "Automation" : "Create automation"}</span>
          <span className="ws-when">{formatWhen(startedAt)}</span>
          <ApiReferenceChip reference={reference} />
        </div>
        <button
          className="ghost"
          onClick={onClose}
          disabled={busy}
          title={phase === "done" ? "View this recording's analysis" : "Back to the analysis"}
        >
          {phase === "done" ? "Analysis" : "Close"}
        </button>
      </div>

      <div className="ws-body">
        {error && <FoundryConnectionError error={error} />}

        {phase === "loading" && (
          <div className="status-line">
            <span className="spinner" />
            <span className="status-text">Opening the automation…</span>
          </div>
        )}

        {phase === "ready" && (
          <div className="sb-arch">
            <p className="sb-lead">Build {targetPhrase("automation", architecture)} from this recording.</p>
            <button className="record-cta" onClick={() => void runPlan()}>
              Plan the automation →
            </button>
          </div>
        )}

        {busy && (
          <div className="status-line">
            <span className="spinner" />
            <span className="status-text">{statusLine || "Working…"}</span>
            <button className="linky status-cancel" onClick={cancelRun}>
              Cancel
            </button>
          </div>
        )}

        {phase === "plan" && plan && (
          <div className="sb-plan">
            <div className="sb-planhead">
              <EditableText
                as="div"
                className="sb-title ed-title"
                value={plan.title}
                placeholder="Automation title"
                ariaLabel="Automation title"
                onChange={(v) => updatePlan({ title: v })}
              />
              <code className="sb-slug">{plan.name}</code>
            </div>
            <EditableText
              as="p"
              multiline
              className="sb-desc ed-desc"
              value={plan.description}
              placeholder="One-line description of what this automation does"
              ariaLabel="Automation description"
              onChange={(v) => updatePlan({ description: v })}
            />

            <div className="sb-sec">
              <span className="eyebrow">When it runs</span>
              <p className="sb-refine-hint">
                A recording has no schedule of its own — set when this automation should run.
              </p>
              <ScheduleEditor
                schedule={plan.trigger.schedule}
                onChange={(schedule) => updatePlan({ trigger: { ...plan.trigger, schedule } })}
              />
              {plan.trigger.type === "condition" && plan.trigger.condition && (
                <span className="trigger-cond">Only when: {plan.trigger.condition}</span>
              )}
            </div>

            <div className="sb-sec">
              <span className="eyebrow">What the automation will do</span>
              <p className="sb-refine-hint">
                Click any step to edit, or a highlighted value to change it. Reorder, add or remove as needed.
              </p>
              <AutomationStepTiles
                steps={plan.steps}
                onChange={(steps) => updatePlan({ steps })}
                values={plan.values}
                onChangeValues={(values) => updatePlan({ values })}
              />
            </div>
          </div>
        )}

        {phase === "done" && (
          <div className="sb-done">
            <div className="sb-check" aria-hidden>
              ✓
            </div>
            <h2 className="sb-title">Automation ready</h2>
            <p>
              <code className="sb-slug">{builtName}</code> is built as {targetPhrase("automation", architecture)}.
            </p>
            {exportedPath && <p className="sb-path">{exportedPath}</p>}
            <p className="sb-import-hint">
              {architecture === "copilot-studio"
                ? "Recreate this as a scheduled trigger in Copilot Studio using the steps in automation.json."
                : "Saved to your automation library."}
            </p>
            {apiOperations.length > 0 && (
              <p className="sb-import-hint">
                {architecture === "copilot-studio"
                  ? `Import api/openapi.json from this folder as a custom connector, then configure these actions: ${apiOperations.join(", ")}.`
                  : `Its API operations (${apiOperations.join(", ")}) will run against the attached spec once the runner ships.`}
              </p>
            )}
          </div>
        )}
      </div>

      {phase === "plan" && plan && (
        <div className="ws-foot">
          <span className="foot-status" />
          <div className="ws-foot-actions">
            <button
              className="record-cta"
              onClick={() => void create()}
              title={
                architecture === "copilot-studio"
                  ? "Create the bundle you recreate in Copilot Studio"
                  : "Create the automation and save it to this app's library"
              }
            >
              {architecture === "copilot-studio" ? "Create & export bundle" : "Create automation"}
            </button>
          </div>
        </div>
      )}

      {phase === "done" && (
        <div className="ws-foot">
          <span className="foot-status">Automation created</span>
          <div className="ws-foot-actions">
            {exportedPath && (
              <button
                className="record-cta"
                onClick={() => void window.skillRecorder.revealAutomation(sessionId)}
              >
                Reveal bundle
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/* --- Skills panel --------------------------------------------------------- */

function SkillsList({
  skills,
  loaded,
  selectedName,
  onSelect,
}: {
  skills: SkillListEntry[];
  loaded: boolean;
  selectedName: string | null;
  onSelect: (name: string) => void;
}) {
  if (skills.length === 0) {
    return (
      <p className="sessions-empty">
        {loaded ? "No skills installed yet. Build one from a recording." : "Loading…"}
      </p>
    );
  }
  return (
    <ul className="sess-list">
      {skills.map((s) => (
        <li key={s.dir}>
          <button
            className={`sess${s.name === selectedName ? " on" : ""}`}
            onClick={() => onSelect(s.name)}
            title={s.dir}
          >
            <div className="sess-top">
              <span className="skill-name">{s.name}</span>
              <span className="sess-tags">
                {s.hasApi && <span className="tag ok">API</span>}
                {s.unrestricted && <span className="tag risk">unrestricted</span>}
              </span>
            </div>
            {s.description && <div className="sess-intent">{s.description}</div>}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Whether the run is over, and how — the panel's own state machine. */
type RunPhase = "idle" | "starting" | "running" | "done" | "error";

/**
 * One skill's run: kick it off, watch what it does, answer what it asks.
 *
 * The main process owns the run — this panel only watches the event stream. Leaving it
 * therefore never kills a run (it keeps going, and its unanswered confirmations degrade
 * in band after the runner's own 3-minute deadline), but nothing replays what the panel
 * missed: coming back mid-run shows the start screen, and starting a second run is
 * refused with "A skill is already running." until the first one ends. Every entry
 * arriving here has already been redacted by the runner.
 */
function SkillRunView({ skill }: { skill: SkillListEntry }) {
  const [phase, setPhase] = useState<RunPhase>("idle");
  const [input, setInput] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [statusLine, setStatusLine] = useState("");
  const [summary, setSummary] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [transcriptFile, setTranscriptFile] = useState("");
  const [confirm, setConfirm] = useState<RunConfirmRequest | null>(null);
  const [alwaysAllow, setAlwaysAllow] = useState(false);
  const [ask, setAsk] = useState<RunAskRequest | null>(null);
  const [answer, setAnswer] = useState("");
  // The live run id, for the event handlers — they are registered once and must not
  // close over a stale value.
  const activeRun = useRef<string | null>(null);
  const tail = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    return window.skillRecorder.onRunProgress((p: RunProgress) => {
      if (activeRun.current && p.runId !== activeRun.current) return;
      if (p.transcriptFile) setTranscriptFile(p.transcriptFile);
      setStatusLine(p.message);
      const entry = p.entry;
      if (!entry) return;
      // The closing report and the run-level failure are the two terminal entries: a
      // `done`, or an `error` that names no tool (a tool's own error is in-band and the
      // run keeps going).
      if (entry.type === "done") {
        setSummary(entry.text ?? "");
        setPhase("done");
        return;
      }
      if (entry.type === "error" && !entry.name) {
        setError(entry.text ?? "The skill run failed.");
        setPhase("error");
        return;
      }
      setEntries((prev) => [...prev, entry]);
    });
  }, []);

  useEffect(() => {
    return window.skillRecorder.onRunConfirm((request: RunConfirmRequest) => {
      if (activeRun.current && request.runId !== activeRun.current) return;
      setAlwaysAllow(false);
      setConfirm(request);
    });
  }, []);

  useEffect(() => {
    return window.skillRecorder.onRunAsk((request: RunAskRequest) => {
      if (activeRun.current && request.runId !== activeRun.current) return;
      setAnswer("");
      setAsk(request);
    });
  }, []);

  // Keep the newest entry in view while the run works.
  useEffect(() => {
    tail.current?.scrollIntoView({ block: "end" });
  }, [entries.length, confirm, ask]);

  const start = useCallback(async () => {
    setPhase("starting");
    setEntries([]);
    setSummary("");
    setError(null);
    setConfirm(null);
    setAsk(null);
    setStatusLine(`Running ${skill.name}…`);
    const res = await window.skillRecorder.runSkill({
      name: skill.name,
      ...(input.trim() ? { input: input.trim() } : {}),
    });
    if (!res.ok || !res.runId) {
      activeRun.current = null;
      setError(res.error ?? "Could not start this skill.");
      setPhase("error");
      return;
    }
    activeRun.current = res.runId;
    setRunId(res.runId);
    setPhase("running");
  }, [skill.name, input]);

  const cancel = useCallback(async () => {
    setStatusLine("Stopping…");
    setConfirm(null);
    setAsk(null);
    await window.skillRecorder.cancelRun(runId ?? "");
  }, [runId]);

  const decide = useCallback(
    async (approved: boolean) => {
      if (!confirm) return;
      setConfirm(null);
      await window.skillRecorder.respondToRun({
        runId: confirm.runId,
        callId: confirm.callId,
        approved,
        ...(approved && alwaysAllow ? { alwaysAllow: true } : {}),
      });
    },
    [confirm, alwaysAllow],
  );

  const sendAnswer = useCallback(async () => {
    if (!ask) return;
    const text = answer;
    setAsk(null);
    setAnswer("");
    await window.skillRecorder.respondToRun({ runId: ask.runId, callId: ask.callId, text });
  }, [ask, answer]);

  const busy = phase === "starting" || phase === "running";

  return (
    <section className="ws">
      <div className="ws-head">
        <div className="ws-titles">
          <span className="eyebrow">Run skill</span>
          <span className="skill-name">{skill.name}</span>
          {skill.hasApi && <span className="tag ok">API</span>}
          {skill.unrestricted && <span className="tag risk">unrestricted</span>}
        </div>
      </div>

      <div className="ws-body">
        {error && <FoundryConnectionError error={error} />}

        {phase === "idle" && (
          <div className="run-start">
            {skill.description && <p className="sb-lead">{skill.description}</p>}
            <p className="run-note">
              This runs on your computer. Every command it wants to run, file it wants to
              write, and API call that changes something is shown here for your approval
              first.
              {skill.unrestricted &&
                " This skill lists no allowed tools, so nothing is refused outright — and every single action needs its own approval."}
            </p>
            <label className="run-input-label">
              <span className="edit-label">Anything it should know (optional)</span>
              <textarea
                className="ed-input ed-input-multi"
                rows={3}
                value={input}
                placeholder="e.g. the customer and the items to order"
                onChange={(e) => setInput(e.target.value)}
              />
            </label>
            <button className="record-cta" onClick={() => void start()}>
              Run skill →
            </button>
          </div>
        )}

        {phase !== "idle" && (
          <div className="run-log">
            {entries.map((entry, i) => (
              <TranscriptLine key={`${entry.at}-${i}`} entry={entry} />
            ))}

            {confirm && (
              <div className="run-card" role="alertdialog" aria-label="Approve this action">
                <div className="run-card-head">
                  <span className="tag risk">{confirm.kind}</span>
                  <span className="run-card-title">{confirm.summary}</span>
                </div>
                {confirm.detail && (
                  <details className="analyze-disclosure">
                    <summary>Show what it will do</summary>
                    <pre className="run-detail">{confirm.detail}</pre>
                  </details>
                )}
                {confirm.allowAlways && (
                  <label className="run-always">
                    <input
                      type="checkbox"
                      checked={alwaysAllow}
                      onChange={(e) => setAlwaysAllow(e.target.checked)}
                    />
                    <span>Always allow {confirm.kind} for this run</span>
                  </label>
                )}
                <div className="run-card-actions">
                  <button className="ghost" onClick={() => void decide(false)}>
                    Deny
                  </button>
                  <button className="record-cta" onClick={() => void decide(true)}>
                    Approve
                  </button>
                </div>
              </div>
            )}

            {ask && (
              <div className="run-card" role="alertdialog" aria-label="The skill has a question">
                <div className="run-card-head">
                  <span className="tag">question</span>
                  <span className="run-card-title">{ask.question}</span>
                </div>
                <input
                  className="ed-input"
                  autoFocus
                  value={answer}
                  placeholder="Your answer"
                  onChange={(e) => setAnswer(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void sendAnswer();
                  }}
                />
                <div className="run-card-actions">
                  <button className="record-cta" onClick={() => void sendAnswer()}>
                    Send
                  </button>
                </div>
              </div>
            )}

            {busy && !confirm && !ask && (
              <div className="status-line">
                <span className="spinner" />
                <span className="status-text">{statusLine || "Working…"}</span>
              </div>
            )}

            {phase === "done" && (
              <div className="run-summary">
                <span className="eyebrow">Result</span>
                <p>{summary || "The skill finished."}</p>
              </div>
            )}

            <div ref={tail} />
          </div>
        )}
      </div>

      {phase !== "idle" && (
        <div className="ws-foot">
          <span className="foot-status run-foot-path" title={transcriptFile}>
            {transcriptFile ? `Transcript: ${transcriptFile}` : ""}
          </span>
          <div className="ws-foot-actions">
            {busy ? (
              <button className="ghost" onClick={() => void cancel()}>
                Cancel run
              </button>
            ) : (
              <button className="record-cta" onClick={() => setPhase("idle")}>
                Run again
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/** One transcript entry. Each type reads differently, so each type looks different. */
function TranscriptLine({ entry }: { entry: TranscriptEntry }) {
  if (entry.type === "model") {
    return <p className="run-model">{entry.text}</p>;
  }
  if (entry.type === "tool-call") {
    return (
      <div className="run-line run-call">
        <span className="run-kind">{entry.name}</span>
        <code className="run-args">{oneLine(entry.args)}</code>
      </div>
    );
  }
  if (entry.type === "tool-result") {
    return (
      <div className={`run-line run-result${entry.failed ? " failed" : ""}`}>
        <span className="run-kind">{entry.failed ? "failed" : "result"}</span>
        <span className="run-text">{entry.text}</span>
      </div>
    );
  }
  if (entry.type === "confirm-request") {
    return (
      <div className="run-line run-asked">
        <span className="run-kind">asked</span>
        <span className="run-text">{entry.text}</span>
      </div>
    );
  }
  if (entry.type === "confirm-decision") {
    return (
      <div className={`run-line run-decision ${entry.decision ?? ""}`}>
        <span className="run-kind">{decisionLabel(entry.decision)}</span>
        <span className="run-text">{entry.name}</span>
      </div>
    );
  }
  if (entry.type === "user-input") {
    return (
      <div className="run-line run-user">
        <span className="run-kind">{entry.name === "answer" ? "you" : "asked you"}</span>
        <span className="run-text">{entry.text}</span>
      </div>
    );
  }
  // An in-band tool failure: the run carries on, but the record shows it went wrong.
  return (
    <div className="run-line run-error">
      <span className="run-kind">{entry.name ?? "error"}</span>
      <span className="run-text">{entry.text}</span>
    </div>
  );
}

function decisionLabel(decision: TranscriptEntry["decision"]): string {
  if (decision === "approve") return "approved";
  if (decision === "deny") return "denied";
  return "no answer";
}

/** A tool call's arguments, flattened to something that fits on one line. */
function oneLine(args: unknown): string {
  if (args === undefined || args === null) return "";
  const text = typeof args === "string" ? args : JSON.stringify(args);
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 220 ? `${flat.slice(0, 220)}…` : flat;
}
