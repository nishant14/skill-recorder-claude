import {
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from "electron";
import os from "node:os";
import path from "node:path";

import type {
  AnalysisEditInput,
  AnalysisFeedbackInput,
  AnalyzeResult,
  ApiReferenceAttachInput,
  ApiReferenceResult,
  AutomationBuildInput,
  AutomationCreateResult,
  AutomationPlanResult,
  DebugBundleResult,
  DeleteSessionResult,
  DeleteSkillResult,
  FoundryConnectionInput,
  FoundryConnectionResult,
  FoundryTestResult,
  MicrophoneSettingsResult,
  RunRespondInput,
  RunSkillInput,
  RunStartResult,
  SkillBuildInput,
  SkillCreateResult,
  SkillPlacement,
  SkillPlanResult,
} from "../common/ipc";
import { IPC } from "../common/ipc";
import type { AutomationPlan } from "../common/automation";
import type { CompatibilityReport } from "../common/compatibility";
import { gradeCompatibility } from "../common/compatibility";
import type { NarrationLanguage } from "../common/narration";
import type { SkillPlan } from "../common/skill";
import {
  attachFromFile,
  attachFromUrl,
  loadReference,
  removeSource,
} from "./builders/api-reference-store";
import { AutomationBuilder, loadPersistedAutomation } from "./automationbuilder/builder";
import {
  BROWSER_A11Y_NOT_CHECKED,
  probeAccessibleBrowsers,
  shouldProbeBrowserA11y,
} from "./collectors/linux-a11y-probe";
import { buildDebugInfo, writeDebugBundle } from "./debug-bundle";
import { Describer, loadPersistedAnalysis } from "./describer/describer";
import { runDoctor } from "./doctor";
import { FoundryClient } from "./foundry/agent";
import { foundryConnectionInfo, saveFoundryConfig } from "./foundry/config";
import { createLogger } from "./logger";
import type { AudioRecorder } from "./audio/recorder";
import type { NarrationManager } from "./narration/manager";
import type { RecorderController } from "./recorder/controller";
import { isValidSessionId, sessionDir } from "./recorder/session-store";
import type { RunPrompts } from "./runner/ipc-bridge";
import { deleteSkill, listInstalledSkills } from "./runner/library";
import type { SkillRunner } from "./runner/runner";
import { deleteSession, listSessions } from "./sessions";
import { loadPersistedSkill, SkillBuilder, type SkillTarget } from "./skillbuilder/builder";

const log = createLogger("IPC");

/**
 * Deadline for the connection test's single round-trip. Short on purpose: this is a
 * "does the key work" probe the user is watching, not an analysis run.
 */
const FOUNDRY_TEST_TIMEOUT_MS = 15_000;

/** Prompt for the test round-trip — the cheapest turn that still proves the deployment answers. */
const FOUNDRY_TEST_INSTRUCTIONS = "Reply with the single word: ok";

/** Wire the renderer-facing invoke channels to the recorder, describer, builders + doctor. */
export function registerIpc(
  recorder: RecorderController,
  describer: Describer,
  builder: SkillBuilder,
  automationBuilder: AutomationBuilder,
  narration: NarrationManager,
  microphones: AudioRecorder,
  runner: SkillRunner,
  /** The runner's confirmation/question waiters — created with it in `main.ts`. */
  runPrompts: RunPrompts,
): void {
  ipcMain.handle(IPC.stop, () => recorder.stop());
  ipcMain.handle(IPC.discard, () => recorder.discard());
  ipcMain.handle(IPC.microphone, (_event, enabled: boolean) =>
    recorder.setMicrophoneEnabled(enabled, microphones.effectiveDeviceId()),
  );
  ipcMain.handle(IPC.microphoneSettings, () => microphones.settings());
  ipcMain.handle(
    IPC.microphoneNarration,
    async (_event, enabled: boolean): Promise<MicrophoneSettingsResult> => {
      if (typeof enabled !== "boolean") {
        return {
          ok: false,
          status: microphones.settings(),
          error: "Invalid narration preference.",
        };
      }
      if (recorder.state === "recording") {
        return {
          ok: false,
          status: microphones.settings(),
          error: "Choose the next recording's narration state after this recording ends.",
        };
      }
      return microphones.setNarrationEnabled(enabled);
    },
  );
  ipcMain.handle(
    IPC.microphoneDevice,
    async (_event, deviceId: string): Promise<MicrophoneSettingsResult> => {
      if (typeof deviceId !== "string" || !deviceId) {
        return {
          ok: false,
          status: microphones.settings(),
          error: "Invalid microphone selection.",
        };
      }
      const previousDeviceId = microphones.effectiveDeviceId();
      const selected = await microphones.selectDevice(deviceId);
      if (
        !selected.ok ||
        recorder.status().microphone.state !== "on" ||
        microphones.effectiveDeviceId() === previousDeviceId
      ) {
        return selected;
      }
      const switched = await recorder.setMicrophoneDevice(
        microphones.effectiveDeviceId(),
      );
      if (!switched.ok) {
        return {
          ok: false,
          status: microphones.settings(),
          error: switched.error ?? "Could not switch microphones.",
        };
      }
      return { ok: true, status: microphones.settings() };
    },
  );
  ipcMain.handle(IPC.narrationLanguage, (_event, language: NarrationLanguage) =>
    recorder.setNarrationLanguage(language),
  );
  ipcMain.handle(IPC.status, () => recorder.status());
  ipcMain.handle(IPC.marker, (_event, note: string) => recorder.marker(note));
  ipcMain.handle(IPC.doctor, () => runDoctor());

  // The graded check: the doctor's static answers plus one live look at the machine.
  // The probe is best-effort by contract — a report that couldn't ask grades down. On
  // Linux it owns and disposes its own URL provider, so nothing here outlives the call.
  ipcMain.handle(IPC.compatibilityCheck, async (): Promise<CompatibilityReport> => {
    const doctor = runDoctor();
    const browserA11y = shouldProbeBrowserA11y(doctor)
      ? await probeAccessibleBrowsers()
      : BROWSER_A11Y_NOT_CHECKED;
    return gradeCompatibility(
      doctor,
      { browserA11y, microphonePermission: microphones.settings().permission },
      Date.now(),
    );
  });

  ipcMain.handle(IPC.foundryGetConnection, () => foundryConnectionInfo());

  ipcMain.handle(
    IPC.foundrySaveConnection,
    async (_event, input: FoundryConnectionInput): Promise<FoundryConnectionResult> => {
      try {
        saveFoundryConfig({
          endpoint: input?.endpoint ?? "",
          apiKey: input?.apiKey ?? "",
          deployment: input?.deployment,
          describerDeployment: input?.describerDeployment,
          transcriptionDeployment: input?.transcriptionDeployment,
        });
        return { ok: true, info: foundryConnectionInfo() };
      } catch (err) {
        // saveFoundryConfig's messages are written for the user; the form shows them
        // verbatim. Never log or echo the key.
        const error = err instanceof Error ? err.message : String(err);
        log.warn("save foundry connection failed:", error);
        return { ok: false, info: foundryConnectionInfo(), error };
      }
    },
  );

  // One test at a time: the button is a live network call, and stacking them would
  // bill for turns nobody is watching.
  let foundryTestRunning = false;
  ipcMain.handle(IPC.foundryTestConnection, async (): Promise<FoundryTestResult> => {
    if (foundryTestRunning) return { ok: false, message: "A test is already running." };
    foundryTestRunning = true;
    // A throwaway client so the test always reads the *just-saved* connection rather
    // than whatever the long-lived agent clients resolved at startup.
    const client = new FoundryClient();
    const startedAt = Date.now();
    try {
      const session = await client.createSession({ instructions: FOUNDRY_TEST_INSTRUCTIONS });
      try {
        await session.sendAndWait("ok", FOUNDRY_TEST_TIMEOUT_MS);
      } finally {
        await session.disconnect();
      }
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      return { ok: true, message: `Connected — ${client.deployment} answered in ${seconds}s` };
    } catch (err) {
      // The runtime's taxonomy messages ("rejected the API key…", "could not find the
      // … deployment…") are already user-facing and key-free — pass them through.
      const message = err instanceof Error ? err.message : String(err);
      log.warn("foundry connection test failed:", message);
      return { ok: false, message };
    } finally {
      await client.stop();
      foundryTestRunning = false;
    }
  });

  ipcMain.handle(IPC.narrationStatus, () => narration.status());
  ipcMain.handle(IPC.narrationDownload, () => narration.downloadModel());
  ipcMain.handle(IPC.narrationTranscribe, (_event, sessionId: string) =>
    narration.transcribeSession(sessionId),
  );

  const resolveSessionId = (sessionId?: string): string | null => {
    if (sessionId) return sessionId;
    const dir = recorder.lastSessionDir();
    return dir ? path.basename(dir) : null;
  };

  ipcMain.handle(IPC.analyze, async (_event, sessionId?: string): Promise<AnalyzeResult> => {
    const id = resolveSessionId(sessionId);
    if (!id) return { ok: false, error: "No completed session to analyze yet." };
    if (!isValidSessionId(id)) return { ok: false, error: "Unknown session." };
    // Transcribe any recorded voice first so analysis never silently runs without
    // the user's spoken intent. Best-effort: a failure here (including "no Foundry
    // connection yet") falls through to analyzing without voice — the error is
    // surfaced via the narration status affordance and the audio stays saved.
    await narration.ensureTranscribedForAnalysis(id);
    try {
      const analysis = await describer.analyze(id);
      return { ok: true, analysis };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn("analyze failed:", error);
      return { ok: false, error };
    }
  });

  ipcMain.handle(
    IPC.analyzeFeedback,
    async (_event, input: AnalysisFeedbackInput): Promise<AnalyzeResult> => {
      if (!isValidSessionId(input?.sessionId)) return { ok: false, error: "Unknown session." };
      try {
        const analysis = await describer.feedback(input.sessionId, {
          overall: input.overall,
          steps: input.steps ?? [],
        });
        return { ok: true, analysis };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log.warn("feedback failed:", error);
        return { ok: false, error };
      }
    },
  );

  ipcMain.handle(IPC.getAnalysis, (_event, sessionId: string) =>
    isValidSessionId(sessionId) ? loadPersistedAnalysis(sessionId) : null,
  );

  ipcMain.handle(IPC.updateAnalysis, async (_event, input: AnalysisEditInput): Promise<AnalyzeResult> => {
    if (!isValidSessionId(input?.sessionId)) return { ok: false, error: "Unknown session." };
    try {
      const analysis = await describer.edit(input.sessionId, {
        title: input.title,
        intent: input.intent,
        steps: input.steps,
      });
      return { ok: true, analysis };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn("update failed:", error);
      return { ok: false, error };
    }
  });

  ipcMain.handle(IPC.cancelAnalysis, async (_event, sessionId: string) => {
    if (isValidSessionId(sessionId)) await describer.cancel(sessionId);
    return { ok: true };
  });

  ipcMain.handle(IPC.listSessions, () => listSessions());

  ipcMain.handle(IPC.deleteSession, async (_event, sessionId: string): Promise<DeleteSessionResult> => {
    if (!isValidSessionId(sessionId)) return { ok: false, error: "Unknown session." };
    if (recorder.status().sessionId === sessionId) {
      return { ok: false, error: "You can't delete a recording while it's still in progress." };
    }
    if (describer.isAnalyzing(sessionId)) {
      return { ok: false, error: "This recording is being analyzed. Cancel that first, then delete." };
    }
    if (narration.isBusyWith(sessionId)) {
      return { ok: false, error: "This recording is being transcribed. Wait for that to finish before deleting it." };
    }
    if (builder.isBuilding(sessionId)) {
      return { ok: false, error: "This recording is being turned into a skill. Cancel that first, then delete." };
    }
    if (automationBuilder.isBuilding(sessionId)) {
      return {
        ok: false,
        error: "This recording is being turned into an automation. Cancel that first, then delete.",
      };
    }
    try {
      await describer.forget(sessionId); // release any idle agent holding the folder
      await builder.forget(sessionId);
      await automationBuilder.forget(sessionId);
      await deleteSession(sessionId);
      recorder.forgetSession(sessionId); // clear the "last completed" pointer if it was this one
      return { ok: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn("delete failed:", error);
      return { ok: false, error };
    }
  });

  ipcMain.handle(
    IPC.exportDebugBundle,
    async (event, sessionId: string): Promise<DebugBundleResult> => {
      if (!isValidSessionId(sessionId)) return { ok: false, error: "Unknown session." };
      // The session folder is still being written while it records; refuse to zip
      // a moving target. Analyzing/building are read-only, so those are allowed.
      if (recorder.status().sessionId === sessionId) {
        return {
          ok: false,
          error: "You can't download details while this recording is still in progress.",
        };
      }
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      const opts: SaveDialogOptions = {
        title: "Download session details",
        defaultPath: path.join(
          os.homedir(),
          "Downloads",
          `skill-recorder-debug-${sessionId}.zip`,
        ),
        filters: [{ name: "Zip archive", extensions: ["zip"] }],
      };
      const result = win
        ? await dialog.showSaveDialog(win, opts)
        : await dialog.showSaveDialog(opts);
      if (result.canceled || !result.filePath) return { ok: false, canceled: true };
      try {
        await writeDebugBundle(sessionId, result.filePath, buildDebugInfo(sessionId));
        shell.showItemInFolder(result.filePath); // hand the file to the user to attach
        return { ok: true, path: result.filePath };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log.warn("debug bundle failed:", error);
        return { ok: false, error };
      }
    },
  );

  /**
   * The reference is part of the builders' *tool set*, which is assembled once per
   * live agent session. Dropping the pooled agents makes the next `createLive` pick
   * up (or drop) the API tools and the reference prompt block, so attaching after a
   * plan already exists behaves the same as attaching before one.
   */
  const forgetBuilders = async (sessionId: string): Promise<void> => {
    await builder.forget(sessionId);
    await automationBuilder.forget(sessionId);
  };

  ipcMain.handle(
    IPC.attachApiReference,
    async (event, sessionId: string, input: ApiReferenceAttachInput): Promise<ApiReferenceResult> => {
      if (!isValidSessionId(sessionId)) return { ok: false, error: "Unknown session." };
      try {
        let reference;
        if (input?.kind === "url") {
          reference = await attachFromUrl(sessionId, input.url);
        } else {
          const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
          const opts: OpenDialogOptions = {
            title: "Attach an API reference",
            defaultPath: path.join(os.homedir(), "Downloads"),
            properties: ["openFile"],
            filters: [
              { name: "API reference", extensions: ["json", "md", "txt", "html"] },
              { name: "All files", extensions: ["*"] },
            ],
          };
          const picked = win
            ? await dialog.showOpenDialog(win, opts)
            : await dialog.showOpenDialog(opts);
          if (picked.canceled || picked.filePaths.length === 0) return { ok: false, canceled: true };
          reference = await attachFromFile(sessionId, picked.filePaths[0]);
        }
        await forgetBuilders(sessionId);
        return { ok: true, reference };
      } catch (err) {
        // The store's refusals ("…export the spec as JSON…") are written for the user.
        const error = err instanceof Error ? err.message : String(err);
        log.warn("attach api reference failed:", error);
        return { ok: false, error };
      }
    },
  );

  ipcMain.handle(IPC.getApiReference, (_event, sessionId: string) =>
    isValidSessionId(sessionId) ? loadReference(sessionDir(sessionId)) : null,
  );

  ipcMain.handle(
    IPC.removeApiReference,
    async (_event, sessionId: string, sourceId?: string): Promise<ApiReferenceResult> => {
      if (!isValidSessionId(sessionId)) return { ok: false, error: "Unknown session." };
      try {
        const reference = removeSource(sessionId, sourceId);
        await forgetBuilders(sessionId);
        return { ok: true, reference };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log.warn("remove api reference failed:", error);
        return { ok: false, error };
      }
    },
  );

  ipcMain.handle(IPC.buildSkill, async (_event, input: SkillBuildInput): Promise<SkillPlanResult> => {
    if (!isValidSessionId(input?.sessionId)) return { ok: false, error: "Unknown session." };
    try {
      const plan = await builder.build(input);
      return { ok: true, plan };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn("build skill failed:", error);
      return { ok: false, error };
    }
  });

  ipcMain.handle(
    IPC.createSkill,
    async (
      event,
      sessionId: string,
      plan?: SkillPlan,
      placement: SkillPlacement = "install",
    ): Promise<SkillCreateResult> => {
      if (!isValidSessionId(sessionId)) return { ok: false, error: "Unknown session." };
      try {
        let target: SkillTarget = { kind: "install" };
        if (placement === "export") {
          // Export == download: let the user pick a destination folder; we drop a
          // ready-to-use <name>/SKILL.md inside it. A dismissed dialog is a cancel, not an error.
          const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
          const opts: OpenDialogOptions = {
            title: "Export skill to folder",
            defaultPath: path.join(os.homedir(), "Downloads"),
            properties: ["openDirectory", "createDirectory"],
          };
          const result = win
            ? await dialog.showOpenDialog(win, opts)
            : await dialog.showOpenDialog(opts);
          if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true };
          target = { kind: "export", dir: result.filePaths[0] };
        }
        const { skill, path: file } = await builder.create(sessionId, plan, target);
        return { ok: true, skill, path: file, placement };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log.warn("create skill failed:", error);
        return { ok: false, error };
      }
    },
  );

  ipcMain.handle(IPC.getSkill, (_event, sessionId: string) =>
    isValidSessionId(sessionId) ? loadPersistedSkill(sessionId) : null,
  );

  ipcMain.handle(IPC.cancelSkill, async (_event, sessionId: string) => {
    if (isValidSessionId(sessionId)) await builder.cancel(sessionId);
    return { ok: true };
  });

  ipcMain.handle(IPC.revealSkill, (_event, sessionId: string) => {
    if (!isValidSessionId(sessionId)) return { ok: false };
    const skill = loadPersistedSkill(sessionId);
    if (skill?.exportedPath) shell.showItemInFolder(skill.exportedPath);
    return { ok: true };
  });

  ipcMain.handle(
    IPC.buildAutomation,
    async (_event, input: AutomationBuildInput): Promise<AutomationPlanResult> => {
      if (!isValidSessionId(input?.sessionId)) return { ok: false, error: "Unknown session." };
      try {
        const plan = await automationBuilder.build(input);
        return { ok: true, plan };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log.warn("build automation failed:", error);
        return { ok: false, error };
      }
    },
  );

  ipcMain.handle(IPC.createAutomation, async (_event, sessionId: string, plan?: AutomationPlan): Promise<AutomationCreateResult> => {
    if (!isValidSessionId(sessionId)) return { ok: false, error: "Unknown session." };
    try {
      const { automation, path: file } = await automationBuilder.create(sessionId, plan);
      return { ok: true, automation, path: file };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn("create automation failed:", error);
      return { ok: false, error };
    }
  });

  ipcMain.handle(IPC.getAutomation, (_event, sessionId: string) =>
    isValidSessionId(sessionId) ? loadPersistedAutomation(sessionId) : null,
  );

  ipcMain.handle(IPC.cancelAutomation, async (_event, sessionId: string) => {
    if (isValidSessionId(sessionId)) await automationBuilder.cancel(sessionId);
    return { ok: true };
  });

  ipcMain.handle(IPC.revealAutomation, (_event, sessionId: string) => {
    if (!isValidSessionId(sessionId)) return { ok: false };
    const automation = loadPersistedAutomation(sessionId);
    if (automation?.exportedPath) shell.showItemInFolder(automation.exportedPath);
    return { ok: true };
  });

  /* --- Skill runner ------------------------------------------------------- */

  ipcMain.handle(IPC.skillsList, () => listInstalledSkills());

  ipcMain.handle(IPC.skillsDelete, (_event, name: string): DeleteSkillResult => {
    const wanted = typeof name === "string" ? name.trim() : "";
    // Same discipline as `skillRun`: the renderer's list is a snapshot, so re-resolve
    // the name against the library on disk. The folder is what gets deleted, and it can
    // differ from the frontmatter name the UI shows.
    const entry = listInstalledSkills().find((s) => s.name === wanted);
    if (!entry) return { ok: false, error: `No installed skill named "${wanted}".` };

    const running = runner.activeRunSkill();
    if (running && running.dir === entry.dir) {
      return { ok: false, error: `${entry.name} is currently running — stop the run first.` };
    }

    try {
      deleteSkill(path.basename(entry.dir));
      return { ok: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn("skill delete failed:", error);
      return { ok: false, error };
    }
  });

  ipcMain.handle(IPC.skillRun, async (_event, input: RunSkillInput): Promise<RunStartResult> => {
    const name = typeof input?.name === "string" ? input.name.trim() : "";
    // The renderer's list is a snapshot; re-resolve the name against the library on
    // disk so a run can only ever name a skill that is installed right now.
    const entry = listInstalledSkills().find((s) => s.name === name);
    if (!entry) return { ok: false, error: `No installed skill named "${name}".` };
    if (runner.isRunning()) return { ok: false, error: "A skill is already running." };

    // A skill that declared no `allowed-tools` gets no "always allow" checkbox: the
    // individual approvals are the only enforcement it has (H4).
    runPrompts.arm({ allowAlways: !entry.unrestricted });
    const running = runner.run({
      name: entry.name,
      ...(typeof input?.input === "string" && input.input.trim() ? { input: input.input } : {}),
      // The UI is the only caller: every side effect is shown to the user. `auto-approve`
      // exists for the headless smoke and is never reachable from here.
      policy: "interactive",
    });
    // A run outlives this call — completion arrives as a progress event — but the panel
    // needs the id now, to match the events and to cancel.
    const runId = runPrompts.runId;
    // Whatever ends the run (report, failure, cancel), no confirmation card may be left
    // holding a promise nobody will settle.
    void running
      .catch((err) => log.warn("skill run failed:", err instanceof Error ? err.message : String(err)))
      .finally(() => runPrompts.end());
    if (!runId) {
      // The run never got as far as building its tools; its rejection carries the reason.
      const error = await running.then(
        () => "Could not start the skill run.",
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      );
      return { ok: false, error };
    }
    return { ok: true, runId };
  });

  ipcMain.handle(IPC.skillRunCancel, async (_event, runId: string) => {
    const id = typeof runId === "string" && runId ? runId : undefined;
    await runner.cancel(id);
    // Release the card the run may be sitting on rather than waiting for the abort to
    // travel back through the turn. A stale id (a button from a run that already ended)
    // cancels nothing, so it must not end the run that is live now.
    if (!id || id === runPrompts.runId) runPrompts.end();
    return { ok: true };
  });

  ipcMain.handle(IPC.skillRunRespond, (_event, input: RunRespondInput) => ({
    ok: runPrompts.respond(input),
  }));
}
