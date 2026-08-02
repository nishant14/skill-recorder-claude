import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

import type { BrowserA11yProbeResult } from "../../common/compatibility";
import type { DoctorReport } from "../../common/ipc";
import { LINUX_BROWSER_TOKENS, LinuxUrlProvider } from "./linux-url-provider";

/**
 * One-shot "can we actually read a browser's address bar *right now*" probe, for the
 * compatibility check only.
 *
 * `linuxUrlSupport()` answers whether the pyatspi bindings import; that is a property
 * of the machine. Whether a browser's URL can be read is a property of **this launch**
 * of that browser — snap Firefox exposes nothing unless it was started with
 * `GNOME_ACCESSIBILITY=1`, and Chromium sometimes needs
 * `--force-renderer-accessibility`. That gap cost a real recording its URL trail, which
 * is why the check looks rather than assumes.
 *
 * **Presence is not readability.** The first version of this probe stopped at the
 * registry: it listed the AT-SPI desktop's application names and called any browser it
 * found "accessible". On Ubuntu that is wrong in the exact case it exists to catch —
 * snap Firefox (`snap.firefox.firefox (enforce)`) is allowed to publish its *name* on
 * the registry while AppArmor denies the deep tree reads ("An AppArmor policy prevents
 * this sender from sending this message…" on `org.a11y.atspi.Cache GetItems`). The
 * check reported "Firefox is exposing accessibility ✓" and graded **Full** while the
 * real provider returned `null` and the recording captured zero `browser.url` events.
 *
 * So the probe is end-to-end: enumerate the registry (step 1), then for every browser
 * found ask the **real** {@link LinuxUrlProvider} for a URL (step 2). Only a browser
 * whose URL actually came back counts as readable; one that enumerates but doesn't read
 * lands in `presentButUnreadable`, which grades to Good with a fix that names the
 * confinement instead of a flag that can't help.
 *
 * The provider instance is owned by the probe and disposed before it returns: this runs
 * once, when the user clicks, and must never outlive the click. Every failure — no
 * python3, no bindings, no accessibility bus, a hung registry — resolves
 * `{ checked: false }`, which grades the report *down* rather than blocking it.
 */

/** One command run. Injected in tests so parsing is exercised without a display. */
export type LinuxProbeExec = (file: string, args: readonly string[]) => Promise<string>;

/**
 * The slice of {@link LinuxUrlProvider} the probe drives. A seam, not an abstraction:
 * unit tests inject a fake so they never spawn python3 or need a display, while the
 * real check reads through the very provider the recorder uses — a probe that read
 * through a *different* path could pass while recordings still came back empty.
 */
export interface LinuxProbeUrlReader {
  get(app: string): Promise<{ url: string } | null>;
  dispose(): void;
}

export type LinuxProbeReaderFactory = () => LinuxProbeUrlReader;

/**
 * Long enough for a cold `import pyatspi` plus a desktop enumeration, short enough that
 * a wedged accessibility bus can't hold the button in its busy state.
 */
const PROBE_TIMEOUT_MS = 2000;
/**
 * Whole-phase budget for step 2, covering the host handshake and every read. The reads
 * are sequential because the provider answers one request at a time; a browser we never
 * got to inside the budget is reported as unreadable, which is also what the recorder
 * would have seen — its own per-read timeout is the same order.
 */
const READ_BUDGET_MS = 3000;
const PROBE_MAX_BUFFER = 256 * 1024;

const execFileAsync = promisify(execFile);

const NOT_CHECKED: BrowserA11yProbeResult = {
  checked: false,
  accessibleBrowsers: [],
  presentButUnreadable: [],
};

/**
 * Prints one `<pid>\\t<name>` line per AT-SPI application. Only the top level of the
 * desktop is walked — descending further would put a page's whole accessibility graph
 * on stdout.
 *
 * The pid is not a nicety. A confined snap browser can be denied even its *name*: on
 * Ubuntu, `app.name` for snap Firefox comes back empty because the cache fetch behind
 * it is refused, so a name-only listing misses the very browser the user is looking at.
 * `get_process_id()` is answered by the registry rather than by the confined app, so it
 * survives, and `/proc/<pid>/comm` turns it back into `firefox`.
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
    except Exception:
        continue
    if app is None:
        continue
    try:
        name = app.name or ""
    except Exception:
        name = ""
    try:
        pid = int(app.get_process_id() or 0)
    except Exception:
        pid = 0
    if not name and pid <= 0:
        continue
    sys.stdout.write("%s\\t%s\\n" % (pid if pid > 0 else "", name.replace("\\n", " ").replace("\\r", " ")))
`;

const defaultExec: LinuxProbeExec = async (file, args) => {
  const { stdout } = await execFileAsync(file, [...args], {
    timeout: PROBE_TIMEOUT_MS,
    maxBuffer: PROBE_MAX_BUFFER,
  });
  return stdout;
};

const defaultReaderFactory: LinuxProbeReaderFactory = () => new LinuxUrlProvider();

/** `/proc/<pid>/comm` for a registered application. Injected in tests. */
export type LinuxProcessName = (pid: number) => string | null;

const defaultProcessName: LinuxProcessName = (pid) => {
  try {
    return readFileSync(`/proc/${pid}/comm`, "utf8").trim() || null;
  } catch {
    return null;
  }
};

function browserToken(value: string | null): string | null {
  const name = (value ?? "").trim().toLowerCase();
  if (!name) return null;
  return LINUX_BROWSER_TOKENS.some((token) => name.includes(token)) ? name : null;
}

/**
 * The browsers on the AT-SPI desktop, lowercased and deduped. Each line is
 * `<pid>\t<name>`; a bare name (no tab) is accepted too, so the parser doesn't depend
 * on a pid the registry might not have.
 *
 * When the name says nothing — the confined-snap case, where it is empty — the process
 * behind the pid gets the second look. Without that fallback the probe would report "no
 * browser is running" at a user who is staring at one.
 */
export function matchBrowsers(
  stdout: string,
  processName: LinuxProcessName = defaultProcessName,
): string[] {
  const found: string[] = [];
  for (const line of stdout.split("\n")) {
    const tab = line.indexOf("\t");
    const rawPid = tab === -1 ? "" : line.slice(0, tab).trim();
    const rawName = tab === -1 ? line : line.slice(tab + 1);
    let name = browserToken(rawName);
    // The pid is interpolated into a path, so only ever accept plain digits.
    if (!name && /^\d+$/.test(rawPid)) name = browserToken(processName(Number(rawPid)));
    if (name && !found.includes(name)) found.push(name);
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
 * The browsers whose URL could actually be read, those that are running but wouldn't
 * answer, or `{ checked: false }` when the question could not be asked. Never throws.
 */
export async function probeAccessibleBrowsers(
  exec: LinuxProbeExec = defaultExec,
  createReader: LinuxProbeReaderFactory = defaultReaderFactory,
): Promise<BrowserA11yProbeResult> {
  if (process.platform !== "linux") return NOT_CHECKED;
  let running: string[];
  try {
    running = matchBrowsers(await exec("python3", ["-c", A11Y_APPS_SCRIPT]));
  } catch {
    // Missing python3, missing bindings, no accessibility bus, timeout: all of it means
    // "we don't know", and claiming Full on a guess is exactly the bug this check exists
    // to prevent.
    return NOT_CHECKED;
  }
  if (running.length === 0) {
    return { checked: true, accessibleBrowsers: [], presentButUnreadable: [] };
  }
  return readBrowserUrls(running, createReader);
}

/**
 * Step 2: one probe-owned provider, one sequential read per running browser, disposed
 * before we return. A read that fails, times out, or never gets its turn is *not*
 * evidence of readability, so it grades down — the whole point of the fix.
 */
async function readBrowserUrls(
  running: readonly string[],
  createReader: LinuxProbeReaderFactory,
): Promise<BrowserA11yProbeResult> {
  const readable: string[] = [];
  const unreadable: string[] = [];
  let reader: LinuxProbeUrlReader | null = null;
  try {
    reader = createReader();
  } catch {
    // No host at all: everything the registry listed is present and unread.
    return { checked: true, accessibleBrowsers: [], presentButUnreadable: [...running] };
  }
  const deadline = Date.now() + READ_BUDGET_MS;
  try {
    for (const name of running) {
      const found = await withDeadline(reader, name, deadline);
      (found ? readable : unreadable).push(name);
    }
  } finally {
    try {
      reader.dispose();
    } catch {
      // best-effort: the host is a child process, and it is going away either way
    }
  }
  return { checked: true, accessibleBrowsers: readable, presentButUnreadable: unreadable };
}

/** One read, capped by whatever is left of the phase budget. Resolves, never rejects. */
function withDeadline(
  reader: LinuxProbeUrlReader,
  app: string,
  deadline: number,
): Promise<boolean> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), remaining);
    timer.unref?.();
    const settle = (ok: boolean) => {
      clearTimeout(timer);
      resolve(ok);
    };
    try {
      reader.get(app).then(
        (found) => settle(Boolean(found?.url)),
        () => settle(false),
      );
    } catch {
      settle(false);
    }
  });
}
