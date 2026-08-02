import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { BrowserA11yProbeResult } from "../../common/compatibility";
import type { DoctorReport } from "../../common/ipc";
import { LINUX_BROWSER_TOKENS } from "./linux-url-provider";

/**
 * One-shot "is a browser exposing its accessibility tree *right now*" probe, for the
 * compatibility check only.
 *
 * `linuxUrlSupport()` answers whether the pyatspi bindings import; that is a property
 * of the machine. Whether a browser actually publishes an AT-SPI tree is a property of
 * **this launch** of that browser — snap Firefox exposes nothing unless it was started
 * with `GNOME_ACCESSIBILITY=1`, and Chromium sometimes needs
 * `--force-renderer-accessibility`. That gap cost a real recording its URL trail, which
 * is why the check looks rather than assumes.
 *
 * Deliberately *not* the persistent host in `linux-url-provider.ts`: this runs once,
 * when the user clicks, and must never outlive the click. Every failure — no python3,
 * no bindings, no accessibility bus, a hung registry — resolves `{ checked: false }`,
 * which grades the report *down* rather than blocking it.
 */

/** One command run. Injected in tests so parsing is exercised without a display. */
export type LinuxProbeExec = (file: string, args: readonly string[]) => Promise<string>;

/**
 * Long enough for a cold `import pyatspi` plus a desktop enumeration, short enough that
 * a wedged accessibility bus can't hold the button in its busy state.
 */
const PROBE_TIMEOUT_MS = 2000;
const PROBE_MAX_BUFFER = 256 * 1024;

const execFileAsync = promisify(execFile);

const NOT_CHECKED: BrowserA11yProbeResult = { checked: false, accessibleBrowsers: [] };

/**
 * Prints one AT-SPI application name per line. Only the top level of the desktop is
 * walked — an application that registered at all is an application exposing a tree,
 * and descending further would put a page's whole accessibility graph on stdout.
 *
 * Exported so tests (and CI) can `python3 -m py_compile` it.
 */
export const A11Y_APPS_SCRIPT = `
import sys

try:
    import pyatspi
except Exception:
    sys.exit(1)

try:
    desktop = pyatspi.Registry.getDesktop(0)
    count = desktop.childCount
except Exception:
    sys.exit(2)

for i in range(count):
    try:
        app = desktop.getChildAtIndex(i)
        name = (app.name or "") if app is not None else ""
    except Exception:
        continue
    if name:
        sys.stdout.write(name.replace("\\n", " ").replace("\\r", " ") + "\\n")
`;

const defaultExec: LinuxProbeExec = async (file, args) => {
  const { stdout } = await execFileAsync(file, [...args], {
    timeout: PROBE_TIMEOUT_MS,
    maxBuffer: PROBE_MAX_BUFFER,
  });
  return stdout;
};

/** Application names that matched a known browser token, lowercased and deduped. */
export function matchBrowsers(stdout: string): string[] {
  const found: string[] = [];
  for (const line of stdout.split("\n")) {
    const name = line.trim().toLowerCase();
    if (!name || found.includes(name)) continue;
    if (LINUX_BROWSER_TOKENS.some((token) => name.includes(token))) found.push(name);
  }
  return found;
}

/**
 * Whether running the probe could tell us anything. The doctor already paid for both
 * answers — an X11 session with working window tracking, and importable pyatspi — so
 * this re-reads its report instead of re-probing the machine.
 *
 * Window tracking gates the probe because the URL provider is driven by the WM_CLASS
 * the X11 reader supplies: with no foreground window there is nothing to ask AT-SPI
 * about, however healthy the accessibility bus is.
 */
export function shouldProbeBrowserA11y(doctor: DoctorReport): boolean {
  return doctor.platform === "linux" && doctor.activeWindow.ok && doctor.browserUrl.supported;
}

/**
 * The browsers currently exposing an accessibility tree, or `{ checked: false }` when
 * the question could not be asked. Never throws.
 */
export async function probeAccessibleBrowsers(
  exec: LinuxProbeExec = defaultExec,
): Promise<BrowserA11yProbeResult> {
  if (process.platform !== "linux") return NOT_CHECKED;
  try {
    const stdout = await exec("python3", ["-c", A11Y_APPS_SCRIPT]);
    return { checked: true, accessibleBrowsers: matchBrowsers(stdout) };
  } catch {
    // Missing python3, missing bindings, no accessibility bus, timeout: all of it means
    // "we don't know", and claiming Full on a guess is exactly the bug this check exists
    // to prevent.
    return NOT_CHECKED;
  }
}
