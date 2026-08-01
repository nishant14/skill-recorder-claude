import { execFile } from "node:child_process";
import { existsSync, readlinkSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import type { ActiveWindowResult } from "./window-info";

/**
 * Foreground-window lookup for X11, built on the `x11-utils` command-line tools
 * (`xprop`, `xwininfo`) that every desktop Ubuntu already ships.
 *
 * This replaces `get-windows` on Linux. That package's Linux path is itself pure
 * JavaScript shelling out to `xprop`, but the package compiles a native macOS
 * binding at install time — so on Linux it fails to install for a binary Linux
 * never uses, and app/window capture silently produces nothing. Doing the same
 * two commands ourselves removes an optional native dependency from the platform
 * that needs it least.
 *
 * Wayland is deliberately *not* supported: a Wayland compositor exposes no
 * equivalent of `_NET_ACTIVE_WINDOW` to unprivileged clients. {@link linuxCaptureSupport}
 * reports that honestly rather than emitting the partial truth XWayland would give.
 *
 * Every read is best-effort: any failure resolves `undefined` and never throws,
 * because the poll loop treats an exception as a capture error worth warning about.
 */

/** One command run. Injected in tests so parsing is exercised without a display. */
export type LinuxExec = (file: string, args: readonly string[]) => Promise<string>;

/** Resolves whether a command exists on PATH. Injected in tests. */
export type ToolLookup = (tool: string) => boolean;

export interface LinuxCaptureSupport {
  ok: boolean;
  /** User-facing explanation when `ok` is false. Safe to render verbatim. */
  reason?: string;
}

/** Long enough for a loaded X server, short enough never to stall a 1 s poll. */
const EXEC_TIMEOUT_MS = 800;
const EXEC_MAX_BUFFER = 1024 * 1024;

const execFileAsync = promisify(execFile);

const REQUIRED_TOOLS = ["xprop", "xwininfo"] as const;

const defaultExec: LinuxExec = async (file, args) => {
  const { stdout } = await execFileAsync(file, [...args], {
    timeout: EXEC_TIMEOUT_MS,
    maxBuffer: EXEC_MAX_BUFFER,
  });
  return stdout;
};

function toolOnPath(tool: string): boolean {
  const dirs = (process.env.PATH || "/usr/local/bin:/usr/bin:/bin").split(path.delimiter);
  return dirs.some((dir) => dir && existsSync(path.join(dir, tool)));
}

/**
 * True when this process is talking to a Wayland compositor. `XDG_SESSION_TYPE` is
 * authoritative when set; `WAYLAND_DISPLAY` catches sessions that don't set it. A
 * Wayland session usually *also* has `DISPLAY` (XWayland), which is exactly why
 * checking `DISPLAY` alone would be wrong.
 */
export function isWaylandSession(): boolean {
  const type = (process.env.XDG_SESSION_TYPE || "").toLowerCase();
  if (type === "wayland") return true;
  if (type === "x11") return false;
  return Boolean(process.env.WAYLAND_DISPLAY);
}

/** Cached across calls: PATH doesn't change under a running app, but env does. */
let toolsPresent: boolean | undefined;

/**
 * Test-only. Clears the cached tool probe, or primes it with `present` so a test
 * gets a deterministic answer without depending on the host's PATH.
 */
export function resetLinuxCaptureProbe(present?: boolean): void {
  toolsPresent = present;
}

/**
 * Whether X11 window tracking can work here, and — when it can't — the one sentence
 * the doctor and the collector show the user. Session checks come first because a
 * Wayland user installing `x11-utils` would still get nothing.
 */
export function linuxCaptureSupport(lookup: ToolLookup = toolOnPath): LinuxCaptureSupport {
  if (isWaylandSession()) {
    return {
      ok: false,
      reason:
        "Wayland session — app and window tracking needs X11. Log out and pick “Ubuntu on Xorg” at the login screen.",
    };
  }
  if (!process.env.DISPLAY) {
    return { ok: false, reason: "No X11 display found (DISPLAY is not set)." };
  }
  if (toolsPresent === undefined) {
    toolsPresent = REQUIRED_TOOLS.every((tool) => lookup(tool));
  }
  if (!toolsPresent) {
    return {
      ok: false,
      reason: "Missing X11 tools — install them with: sudo apt install x11-utils",
    };
  }
  return { ok: true };
}

/**
 * The frontmost window per the EWMH `_NET_ACTIVE_WINDOW` hint, or `undefined` when
 * there is none (empty desktop, override-redirect window, unsupported WM) or when
 * anything at all goes wrong.
 */
export async function readLinuxActiveWindow(
  exec: LinuxExec = defaultExec,
): Promise<ActiveWindowResult | undefined> {
  try {
    const rootOut = await exec("xprop", ["-root", "_NET_ACTIVE_WINDOW"]);
    const windowId = parseActiveWindowId(rootOut);
    if (!windowId) return undefined;

    // Both reads describe the same window; running them together halves the
    // wall-clock cost of a poll on a busy X server.
    const [propsOut, geometryOut] = await Promise.all([
      exec("xprop", ["-id", windowId, "_NET_WM_NAME", "WM_NAME", "WM_CLASS", "_NET_WM_PID"]),
      exec("xwininfo", ["-id", windowId]).catch(() => ""),
    ]);

    const props = parseProperties(propsOut);
    const title =
      firstQuotedString(props.get("_NET_WM_NAME")) ?? firstQuotedString(props.get("WM_NAME")) ?? "";
    // WM_CLASS is `instance, class` — e.g. `"Navigator", "firefox"`. The last entry
    // is the class, which is the closest thing X11 has to an application name.
    const classes = quotedStrings(props.get("WM_CLASS") ?? "");
    const name = classes.length > 0 ? classes[classes.length - 1] : "";
    const processId = parsePid(props.get("_NET_WM_PID"));
    const executable = processId ? exePath(processId) : undefined;
    const bounds = parseBounds(geometryOut);

    return {
      title,
      id: Number.parseInt(windowId, 16),
      ...(bounds ? { bounds } : {}),
      owner: {
        name: name || "unknown",
        ...(processId ? { processId } : {}),
        ...(executable ? { path: executable } : {}),
      },
    };
  } catch {
    // No display, tools absent, X server busy past the timeout, killed window —
    // all of it is "nothing to report this tick", not an error worth surfacing.
    return undefined;
  }
}

function parseActiveWindowId(out: string): string | null {
  const match = /window id #\s*(0x[0-9a-fA-F]+)/.exec(out);
  if (!match) return null;
  // A rootless desktop reports 0x0; there is no active window to describe.
  return Number.parseInt(match[1], 16) === 0 ? null : match[1];
}

/** `NAME(TYPE) = value` lines → `NAME` → raw right-hand side. */
function parseProperties(out: string): Map<string, string> {
  const props = new Map<string, string>();
  for (const line of out.split("\n")) {
    const match = /^([A-Za-z0-9_]+)(?:\([^)]*\))?\s*=\s*(.*)$/.exec(line.trimEnd());
    if (match) props.set(match[1], match[2]);
  }
  return props;
}

function parsePid(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const pid = Number.parseInt(value.trim(), 10);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function firstQuotedString(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const strings = quotedStrings(value);
  return strings.length > 0 ? strings[0] : undefined;
}

/**
 * Splits an xprop right-hand side into its decoded quoted strings.
 *
 * xprop emits *bytes*, escaping anything non-printable as a 3-digit octal sequence:
 * an em dash arrives as `\342\200\224`. Decoding per-character would produce mojibake,
 * so escapes are accumulated as raw bytes and the whole run is decoded as UTF-8 once.
 */
function quotedStrings(value: string): string[] {
  const strings: string[] = [];
  let index = 0;
  while (index < value.length) {
    if (value[index] !== '"') {
      index++;
      continue;
    }
    index++;
    const bytes: number[] = [];
    while (index < value.length && value[index] !== '"') {
      const char = value[index];
      if (char !== "\\") {
        bytes.push(...Buffer.from(char, "utf8"));
        index++;
        continue;
      }
      const octal = /^[0-7]{1,3}/.exec(value.slice(index + 1, index + 4));
      if (octal) {
        bytes.push(Number.parseInt(octal[0], 8) & 0xff);
        index += 1 + octal[0].length;
        continue;
      }
      const escaped = value[index + 1];
      bytes.push(...Buffer.from(unescapeChar(escaped), "utf8"));
      index += 2;
    }
    index++;
    strings.push(Buffer.from(bytes).toString("utf8"));
  }
  return strings;
}

function unescapeChar(char: string | undefined): string {
  if (char === undefined) return "";
  if (char === "n") return "\n";
  if (char === "t") return "\t";
  if (char === "r") return "\r";
  return char;
}

function parseBounds(out: string): ActiveWindowResult["bounds"] {
  if (!out) return undefined;
  const x = matchNumber(out, /Absolute upper-left X:\s*(-?\d+)/);
  const y = matchNumber(out, /Absolute upper-left Y:\s*(-?\d+)/);
  const width = matchNumber(out, /^\s*Width:\s*(\d+)/m);
  const height = matchNumber(out, /^\s*Height:\s*(\d+)/m);
  if (x === null || y === null || width === null || height === null) return undefined;
  return { x, y, width, height };
}

function matchNumber(out: string, pattern: RegExp): number | null {
  const match = pattern.exec(out);
  if (!match) return null;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : null;
}

/** `/proc/<pid>/exe` is a symlink to the binary; unreadable for other users' processes. */
function exePath(pid: number): string | undefined {
  try {
    return readlinkSync(`/proc/${pid}/exe`);
  } catch {
    return undefined;
  }
}
