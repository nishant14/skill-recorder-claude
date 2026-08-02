import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createInterface, type Interface } from "node:readline";
import os from "node:os";
import path from "node:path";

import { createLogger } from "../logger";
import { normalizeUrl } from "./url-normalize";
import type { ActiveUrl, UrlProvider } from "./url-provider";

/**
 * Linux active-tab URL provider via **AT-SPI2** — the Linux parallel to the macOS
 * AppleScript and Windows UI Automation providers. X11 gives us the window title
 * and nothing else, so the address bar has to come from the accessibility tree.
 *
 * AT-SPI has no usable command-line client, and its Python bindings
 * (`python3-pyatspi`, an Ubuntu stock package — no npm dependency) take a
 * noticeable moment to import and connect to the accessibility bus. Spawning per
 * read would blow any sane timeout, so this is a **persistent host process**
 * exactly like the Windows provider: `python3 -u <script>` prints `READY` once the
 * bindings are loaded, then answers one request line (`get <wmClassToken>`) with
 * one response line (`<url><SEP><title>`, or empty). The request carries the app
 * hint because AT-SPI hands us the whole desktop, not the focused window.
 *
 * This is deliberately a *structural copy* of `windows-url-provider.ts` rather
 * than a shared base class: the Windows host is validated on real hardware and
 * refactoring it to fit a second platform would risk it for no user-visible gain.
 * If a third host provider ever appears, extract `host-provider.ts` then.
 *
 * Strictly best-effort and isolated behind {@link UrlProvider}: no pyatspi, no
 * accessibility bus, a browser that hasn't enabled a11y (Chromium without
 * `--force-renderer-accessibility` sometimes exposes no address bar), a timeout —
 * all of it resolves `null`, never throws, and never blocks the poll loop.
 */

const SEP = String.fromCharCode(30); // ASCII record separator; can't occur in a URL/title
const READY = "READY";
const REQUEST_TIMEOUT_MS = 2000;
/** Long enough for a cold `import pyatspi`, short enough not to stall the doctor. */
const PROBE_TIMEOUT_MS = 2000;

/**
 * The Linux "app name" is a WM_CLASS string from the X11 reader — `firefox`,
 * `Navigator`, `Google-chrome`, `Chromium-browser`, `Microsoft-edge` — not a
 * product name. Match loosely on the recognizable family token; the host does the
 * second, fuzzier match against the AT-SPI application names.
 */
export const LINUX_BROWSER_TOKENS = [
  "firefox",
  "navigator",
  "chrome",
  "chromium",
  "edge",
  "brave",
  "opera",
  "vivaldi",
];

/**
 * The persistent pyatspi reader. Emits `READY` once the bindings are loaded, then
 * for each `get <token>` line writes one line: `<url><SEP><title>` (or empty).
 *
 * A missing `python3-pyatspi` exits *before* `READY`, which the host below turns
 * into one honest warning naming the apt package. Every per-request failure is
 * caught and answered with an empty line so a single odd window can't wedge the
 * protocol. The walk is bounded in nodes and depth and prunes the web-document
 * subtree, so it can never descend into a heavy page's accessibility tree.
 *
 * Exported so tests (and CI) can `python3 -m py_compile` it.
 */
export const ATSPI_SCRIPT = `
import sys

SEP = chr(30)
MAX_NODES = 600
MAX_DEPTH = 8

try:
    import pyatspi
except Exception:
    # No AT-SPI bindings: exit before READY. The Node side says so once.
    sys.exit(1)


def const(name):
    return getattr(pyatspi, name, None)


ROLE_FRAME = const("ROLE_FRAME")
ROLE_ENTRY = const("ROLE_ENTRY")
STATE_ACTIVE = const("STATE_ACTIVE")
PRUNED_ROLES = tuple(r for r in (const("ROLE_DOCUMENT_WEB"), const("ROLE_EMBEDDED")) if r is not None)

# WM_CLASS token -> the AT-SPI application names that token can mean. Firefox
# registers as "Firefox" but its window class is "Navigator"; Chrome's class is
# "Google-chrome" while the app announces itself as "Chromium" on some builds.
APP_HINTS = (
    ("firefox", ("firefox",)),
    ("navigator", ("firefox",)),
    ("chromium", ("chromium", "chrome")),
    ("chrome", ("chrome", "chromium")),
    ("edge", ("edge",)),
    ("brave", ("brave",)),
    ("opera", ("opera",)),
    ("vivaldi", ("vivaldi",)),
)

# The address bar's accessible name. Every locale we can check spells it with
# "address"; the two exact strings are the en-US Firefox and Chromium names, kept
# explicit so a future locale fix has an obvious place to land.
ADDRESS_BAR_NAMES = (
    "search with google or enter address",
    "address and search bar",
)


def name_of(node):
    try:
        return node.name or ""
    except Exception:
        return ""


def role_of(node):
    try:
        return node.getRole()
    except Exception:
        return None


def children(node):
    out = []
    try:
        count = node.childCount
    except Exception:
        return out
    for i in range(count):
        try:
            child = node.getChildAtIndex(i)
        except Exception:
            continue
        if child is not None:
            out.append(child)
    return out


def read_text(node):
    try:
        return node.queryText().getText(0, -1) or ""
    except Exception:
        pass
    try:
        return node.get_text(0, -1) or ""
    except Exception:
        pass
    return name_of(node)


def looks_url(value):
    if not value or not value.strip():
        return False
    if "://" in value:
        return True
    return " " not in value and "." in value


def is_address_bar(name):
    n = (name or "").strip().lower()
    if not n:
        return False
    if "address" in n:
        return True
    return any(known in n for known in ADDRESS_BAR_NAMES)


def wanted_names(token):
    t = (token or "").lower()
    for key, names in APP_HINTS:
        if key in t:
            return names
    return (t,) if t else ()


def app_matches(app_name, names):
    n = (app_name or "").lower()
    if not n:
        return False
    return any(w and (w in n or n in w) for w in names)


def pick_frame(app):
    frames = [c for c in children(app) if role_of(c) == ROLE_FRAME]
    for frame in frames:
        try:
            if STATE_ACTIVE is not None and frame.getState().contains(STATE_ACTIVE):
                return frame
        except Exception:
            pass
    return frames[0] if frames else None


def scan_frame(frame):
    title = name_of(frame)
    queue = [(frame, 0)]
    seen = 0
    best = ""
    while queue and seen < MAX_NODES:
        node, depth = queue.pop(0)
        seen += 1
        role = role_of(node)
        if role in PRUNED_ROLES:
            continue  # prune the web-page a11y tree
        if role == ROLE_ENTRY:
            value = read_text(node)
            if looks_url(value):
                if is_address_bar(name_of(node)):
                    return value.strip() + SEP + title
                if not best:
                    best = value.strip()
        if depth < MAX_DEPTH:
            for child in children(node):
                queue.append((child, depth + 1))
    if best:
        return best + SEP + title
    return ""


def read_url(token):
    names = wanted_names(token)
    if not names:
        return ""
    desktop = pyatspi.Registry.getDesktop(0)
    for app in children(desktop):
        if not app_matches(name_of(app), names):
            continue
        frame = pick_frame(app)
        if frame is None:
            continue
        found = scan_frame(frame)
        if found:
            return found
    return ""


def serve():
    sys.stdout.write("${READY}\\n")
    sys.stdout.flush()
    while True:
        line = sys.stdin.readline()
        if not line:
            break
        request = line.strip()
        token = request[4:].strip() if request.startswith("get ") else ""
        try:
            out = read_url(token)
        except Exception:
            out = ""
        # One response per request, always: a newline inside a title would desync it.
        sys.stdout.write(out.replace("\\n", " ").replace("\\r", " ") + "\\n")
        sys.stdout.flush()


# Guarded so the helpers above can be imported and exercised against fake nodes.
if __name__ == "__main__":
    serve()
`;

function isLinuxBrowser(app: string): boolean {
  const a = app.toLowerCase();
  return LINUX_BROWSER_TOKENS.some((t) => a.includes(t));
}

const log = createLogger("linux-url");

/** How the helper process is started. Overridden in tests with a fake host. */
export interface LinuxUrlHostCommand {
  command: string;
  args: readonly string[];
}

export interface LinuxUrlSupport {
  ok: boolean;
  /** User-facing explanation when `ok` is false. Safe to render verbatim. */
  reason?: string;
}

const MISSING_PYATSPI =
  "Browser URL capture needs python3-pyatspi (sudo apt install python3-pyatspi).";

/** Resolves whether this computer can `import pyatspi`. Injected in tests. */
export type PyatspiProbe = () => boolean;

const probePyatspi: PyatspiProbe = () => {
  try {
    execFileSync("python3", ["-c", "import pyatspi"], {
      timeout: PROBE_TIMEOUT_MS,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
};

/** Cached across calls: the doctor is re-read on every HUD paint. */
let pyatspiPresent: boolean | undefined;

/**
 * Test-only. Clears the cached pyatspi probe, or primes it with `present` so a test
 * gets a deterministic answer without depending on the host's Python installation.
 */
export function resetLinuxUrlProbe(present?: boolean): void {
  pyatspiPresent = present;
}

/**
 * Whether AT-SPI URL reads can work here, and — when they can't — the one sentence
 * the doctor shows the user. Only the bindings are probed: whether a *browser*
 * exposes its address bar is per-browser and per-launch, so claiming to know it
 * from an offline check would be a lie.
 */
export function linuxUrlSupport(probe: PyatspiProbe = probePyatspi): LinuxUrlSupport {
  if (pyatspiPresent === undefined) pyatspiPresent = probe();
  return pyatspiPresent ? { ok: true } : { ok: false, reason: MISSING_PYATSPI };
}

export class LinuxUrlProvider implements UrlProvider {
  private proc: ChildProcess | null = null;
  private rl: Interface | null = null;
  private tmpDir: string | null = null;
  private ready = false;
  private busy = false;
  private disposed = false;
  /** Latched once the host dies before READY: pyatspi isn't going to appear mid-session. */
  private unavailable = false;
  private warned = false;
  private waiter: ((line: string) => void) | null = null;
  private readyWaiters = new Set<(ok: boolean) => void>();
  private readonly host: LinuxUrlHostCommand | null;

  constructor(host?: LinuxUrlHostCommand) {
    this.host = host ?? null;
  }

  supports(app: string): boolean {
    return isLinuxBrowser(app);
  }

  async get(app: string): Promise<ActiveUrl | null> {
    if (this.disposed || this.unavailable || !isLinuxBrowser(app)) return null;
    this.ensureHost();
    if (!this.proc || this.busy) return null;
    // Unlike the Windows host, the first read waits for the handshake instead of
    // throwing the call away: on Linux a browser can be frontmost for a while
    // before the poll loop asks again, and a wasted first read shows up as a
    // missing `browser.url` for the step the user just performed.
    if (!this.ready && !(await this.awaitReady())) return null;
    if (!this.proc || !this.ready || this.busy) return null;

    const line = await this.request(app);
    if (line == null) return null;
    const [rawUrl, title] = line.split(SEP);
    const url = normalizeUrl(rawUrl ?? "");
    if (!url) return null;
    return { url, title: title?.trim() || undefined };
  }

  dispose(): void {
    this.disposed = true;
    this.killHost();
  }

  private awaitReady(): Promise<boolean> {
    if (this.ready) return Promise.resolve(true);
    if (!this.proc) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.readyWaiters.delete(done);
        resolve(ok);
      };
      // A slow handshake costs this read only; the host stays alive for the next one.
      const timer = setTimeout(() => done(false), REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.readyWaiters.add(done);
    });
  }

  private request(app: string): Promise<string | null> {
    return new Promise((resolve) => {
      const proc = this.proc;
      if (!proc?.stdin?.writable) return resolve(null);
      this.busy = true;
      let settled = false;
      const done = (line: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waiter = null;
        this.busy = false;
        resolve(line);
      };
      const timer = setTimeout(() => {
        // Resolve first, then recycle the host: a late/desynced response would
        // otherwise corrupt the next read.
        done(null);
        this.killHost();
      }, REQUEST_TIMEOUT_MS);
      this.waiter = (line) => done(line);
      try {
        // The token is a WM_CLASS string, and the newline is the framing — strip
        // any whitespace so a hostile title can never inject a second request.
        proc.stdin.write(`get ${app.replace(/\s+/g, " ").trim()}\n`);
      } catch {
        done(null);
      }
    });
  }

  private ensureHost(): void {
    if (this.disposed || this.proc) return;
    try {
      this.tmpDir = mkdtempSync(path.join(os.tmpdir(), "skr-atspi-"));
      const scriptPath = path.join(this.tmpDir, "atspi-url.py");
      writeFileSync(scriptPath, ATSPI_SCRIPT, "utf8");

      const command = this.host?.command ?? "python3";
      const args = this.host ? [...this.host.args] : ["-u", scriptPath];
      const proc = spawn(command, args, { stdio: ["pipe", "pipe", "ignore"] });
      this.proc = proc;
      this.ready = false;

      if (proc.stdout) {
        this.rl = createInterface({ input: proc.stdout });
        this.rl.on("line", (line) => this.onLine(line));
      }
      proc.on("error", () => this.killHost());
      proc.on("exit", () => this.killHost());
    } catch {
      this.killHost();
    }
  }

  private onLine(line: string): void {
    if (!this.ready) {
      // First line is the readiness sentinel emitted once pyatspi is loaded.
      this.ready = line.trim() === READY;
      if (this.ready) this.settleReady(true);
      return;
    }
    const w = this.waiter;
    this.waiter = null;
    if (w) w(line);
  }

  private settleReady(ok: boolean): void {
    const waiters = [...this.readyWaiters];
    this.readyWaiters.clear();
    for (const w of waiters) w(ok);
  }

  private killHost(): void {
    // A host that dies without ever saying READY means `import pyatspi` failed
    // (or python3 is absent). Respawning it every poll would just churn processes.
    const neverReady = this.proc !== null && !this.ready;
    const w = this.waiter;
    this.waiter = null;
    if (w) w(""); // unblock any in-flight request (resolves to no-url)
    this.ready = false;
    this.busy = false;
    this.settleReady(false);
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    if (this.proc) {
      this.proc.removeAllListeners();
      try {
        this.proc.kill();
      } catch {
        // already gone
      }
      this.proc = null;
    }
    if (this.tmpDir) {
      try {
        rmSync(this.tmpDir, { recursive: true, force: true });
      } catch {
        // best-effort temp cleanup
      }
      this.tmpDir = null;
    }
    if (neverReady) this.noteUnavailable();
  }

  private noteUnavailable(): void {
    this.unavailable = true;
    if (this.warned) return;
    this.warned = true;
    log.warn(MISSING_PYATSPI);
  }
}
