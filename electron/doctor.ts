import { existsSync } from "node:fs";
import { createRequire } from "node:module";

import { CAPTURE_SOURCES, FULL_CAPTURE } from "../common/config";
import {
  DEFAULT_FOUNDRY_DESCRIBER_DEPLOYMENT,
  DEFAULT_FOUNDRY_TRANSCRIPTION_DEPLOYMENT,
} from "../common/foundry";
import type {
  ActiveWindowInfo,
  BrowserUrlInfo,
  DoctorReport,
  DoctorSource,
  FoundryDoctorInfo,
} from "../common/ipc";
import { linuxCaptureSupport } from "./collectors/linux-active-window";
import { linuxUrlSupport } from "./collectors/linux-url-provider";
import { browserUrlProviderKind } from "./collectors/url-provider";
import { loadFoundryConfig } from "./foundry/config";
import { sessionsRoot } from "./recorder/session-store";

const require = createRequire(import.meta.url);

/**
 * Whether this computer has a Foundry connection, and which deployments it resolves to.
 * Deliberately **offline**: the doctor is read on every HUD paint, so it never touches
 * the network — the live probe is the connection form's Test button. The API key is
 * read but never reported.
 */
function checkFoundry(): FoundryDoctorInfo {
  const loaded = loadFoundryConfig();
  if (!loaded) {
    return {
      configured: false,
      endpoint: null,
      deployment: null,
      source: null,
      describerDeployment: null,
      transcriptionDeployment: null,
    };
  }
  const { config, source } = loaded;
  return {
    configured: true,
    endpoint: config.endpoint,
    deployment: config.deployment,
    source,
    // `loadFoundryConfig` already applies the defaults; the fallbacks keep this honest
    // if the field ever becomes genuinely optional again.
    describerDeployment: config.describerDeployment ?? DEFAULT_FOUNDRY_DESCRIBER_DEPLOYMENT,
    transcriptionDeployment:
      config.transcriptionDeployment ?? DEFAULT_FOUNDRY_TRANSCRIPTION_DEPLOYMENT,
  };
}

function checkActiveWindow(): ActiveWindowInfo {
  try {
    if (process.platform === "win32") {
      const modulePath = require.resolve("koffi");
      require("koffi");
      return { ok: true, provider: "koffi", path: modulePath };
    }
    if (process.platform === "linux") {
      // Nothing to resolve: the X11 reader ships in-repo, so what decides whether
      // window tracking works is the session and the `x11-utils` binaries.
      const support = linuxCaptureSupport();
      return {
        ok: support.ok,
        provider: "x11",
        path: null,
        ...(support.reason ? { note: support.reason } : {}),
      };
    }
    const modulePath = require.resolve("get-windows");
    return { ok: existsSync(modulePath), provider: "get-windows", path: modulePath };
  } catch (err) {
    return {
      ok: false,
      provider: "missing",
      path: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function checkBrowserUrl(): BrowserUrlInfo {
  const kind = browserUrlProviderKind();
  if (process.platform === "linux") {
    // The AT-SPI reader ships in-repo; what decides whether it works is the
    // `python3-pyatspi` binding it hosts. Probed once and cached.
    const support = linuxUrlSupport();
    return {
      kind,
      supported: support.ok,
      ...(support.reason ? { note: support.reason } : {}),
    };
  }
  return { kind, supported: kind !== "none" };
}

/**
 * Whether a capture source can work at all on this computer. Support is a property
 * of the environment, not just the platform: on Linux the same binary tracks windows
 * on X11 and cannot on Wayland, so the reason travels with the answer.
 */
function sourceSupport(
  key: string,
  browserUrl: BrowserUrlInfo,
  activeWindow: ActiveWindowInfo,
): { supported: boolean; note?: string } {
  if (key === "browserUrls" && !browserUrl.supported) {
    return { supported: false, note: browserUrl.note ?? "Not available on this platform" };
  }
  if ((key === "appActivity" || key === "windowTitles") && !activeWindow.ok) {
    return {
      supported: false,
      note: activeWindow.note ?? activeWindow.error ?? "Window tracking is unavailable",
    };
  }
  return { supported: true };
}

/** Environment readiness check surfaced in the UI and (later) a CLI `doctor` command. */
export function runDoctor(): DoctorReport {
  const config = FULL_CAPTURE;
  const browserUrl = checkBrowserUrl();
  const activeWindow = checkActiveWindow();

  const activeSources: DoctorSource[] = CAPTURE_SOURCES.filter((s) => config[s.key]).map((s) => {
    const support = sourceSupport(s.key, browserUrl, activeWindow);
    return { key: s.key, label: s.label, tier: s.tier, cost: s.cost, supported: support.supported, note: support.note };
  });

  return {
    platform: process.platform,
    foundry: checkFoundry(),
    activeWindow,
    browserUrl,
    sessionsDir: sessionsRoot(),
    activeSources,
  };
}
