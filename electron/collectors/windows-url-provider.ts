import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createInterface, type Interface } from "node:readline";
import os from "node:os";
import path from "node:path";

import { normalizeUrl } from "./url-normalize";
import type { ActiveUrl, UrlProvider } from "./url-provider";

/**
 * Windows active-tab URL provider via **UI Automation** — the Windows parallel to
 * the macOS AppleScript provider. Windows exposes no scripting bridge for the
 * address bar, so we read the frontmost window's UIA tree and pull the omnibox
 * (address bar) Edit control's value.
 *
 * UIA lives in the .NET `UIAutomationClient` / `UIAutomationTypes` assemblies,
 * which are only reliably present in **Windows PowerShell 5.1** (`powershell.exe`,
 * shipped in-box on every Windows 10/11), not necessarily in PowerShell 7. So we
 * host the reader in `powershell.exe`. Loading those assemblies costs ~0.5–1s, so
 * spawning per URL read would blow any reasonable timeout — instead we keep a
 * **persistent host process** that loads UIA once and then answers one request
 * (frontmost window → url) per stdin line with one stdout line. The read walks a
 * bounded slice of the control tree and prunes `Document` subtrees so it never
 * descends into the (huge, lazily-realized) web-page accessibility tree.
 *
 * Strictly best-effort and isolated behind {@link UrlProvider}: any failure
 * (no host, timeout, no address bar, permission quirk) resolves `null`, never
 * throws, and never blocks the poll loop. Only ever invoked when a browser is
 * frontmost.
 */

const SEP = String.fromCharCode(30); // ASCII record separator; can't occur in a URL/title
const READY = "READY";
const REQUEST_TIMEOUT_MS = 2000;

// get-windows reports the browser's product name as the window owner on Windows
// (e.g. "Google Chrome", "Microsoft Edge", "Firefox"). Match loosely on the
// recognizable family token — unlike macOS we can read Firefox's address bar too.
const WINDOWS_BROWSER_TOKENS = [
  "chrome",
  "chromium",
  "edge",
  "brave",
  "opera",
  "vivaldi",
  "firefox",
  "arc",
];

/**
 * The persistent PowerShell reader. Emits `READY` once UIA is loaded, then for
 * each line on stdin writes one line: `<url><SEP><title>` (or empty on failure).
 * Uses plain string tests (no regex) to sidestep escaping surprises, prunes web
 * content, and is bounded in nodes + depth so it can never run away on a heavy
 * page tree.
 */
const UIA_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class SkrNative {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
"@
$SEP = [char]30
$AE = [System.Windows.Automation.AutomationElement]
$editType = [System.Windows.Automation.ControlType]::Edit
$docType  = [System.Windows.Automation.ControlType]::Document
$valuePattern = [System.Windows.Automation.ValuePattern]::Pattern
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker

function Read-Value($el) {
  try {
    $vp = $el.GetCurrentPattern($valuePattern)
    if ($vp -ne $null) { return $vp.Current.Value }
  } catch {}
  return ""
}

function Looks-Url($v) {
  if ([string]::IsNullOrWhiteSpace($v)) { return $false }
  if ($v.Contains('://')) { return $true }
  if ((-not $v.Contains(' ')) -and $v.Contains('.')) { return $true }
  return $false
}

function Read-Url {
  $h = [SkrNative]::GetForegroundWindow()
  if ($h -eq [IntPtr]::Zero) { return "" }
  $root = $AE::FromHandle($h)
  if ($root -eq $null) { return "" }
  $title = ""
  try { $title = $root.Current.Name } catch {}

  $queue = New-Object System.Collections.Generic.Queue[object]
  $queue.Enqueue(@($root, 0))
  $seen = 0
  $best = ""
  while ($queue.Count -gt 0 -and $seen -lt 600) {
    $item = $queue.Dequeue()
    $el = $item[0]; $depth = $item[1]
    $seen++
    $ct = $null
    try { $ct = $el.Current.ControlType } catch {}
    if ($ct -eq $docType) { continue }   # prune the web-page a11y tree
    if ($ct -eq $editType) {
      $v = Read-Value $el
      if (Looks-Url $v) {
        $n = ""; $id = ""
        try { $n = $el.Current.Name } catch {}
        try { $id = $el.Current.AutomationId } catch {}
        if ($id -eq 'omnibox' -or $id -eq 'addressEditBox' -or $id -eq 'urlbar-input' -or $n -like '*address*' -or $n -like '*enter address*' -or $n -like '*search or enter*') {
          return "$v$SEP$title"
        }
        if ($best -eq "") { $best = $v }
      }
    }
    if ($depth -lt 8) {
      $child = $walker.GetFirstChild($el)
      while ($child -ne $null) {
        $queue.Enqueue(@($child, $depth + 1))
        $child = $walker.GetNextSibling($child)
      }
    }
  }
  if ($best -ne "") { return "$best$SEP$title" }
  return ""
}

[Console]::Out.WriteLine('${READY}')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $out = ""
  try { $out = Read-Url } catch { $out = "" }
  [Console]::Out.WriteLine($out)
  [Console]::Out.Flush()
}
`;

function isWindowsBrowser(app: string): boolean {
  const a = app.toLowerCase();
  return WINDOWS_BROWSER_TOKENS.some((t) => a.includes(t));
}

export class WindowsUrlProvider implements UrlProvider {
  private proc: ChildProcess | null = null;
  private rl: Interface | null = null;
  private tmpDir: string | null = null;
  private ready = false;
  private busy = false;
  private disposed = false;
  private waiter: ((line: string) => void) | null = null;

  supports(app: string): boolean {
    return isWindowsBrowser(app);
  }

  async get(app: string): Promise<ActiveUrl | null> {
    if (this.disposed || !isWindowsBrowser(app)) return null;
    this.ensureHost();
    if (!this.proc || !this.ready || this.busy) return null;

    const line = await this.request();
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

  private request(): Promise<string | null> {
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
        proc.stdin.write("get\n");
      } catch {
        done(null);
      }
    });
  }

  private ensureHost(): void {
    if (this.disposed || this.proc) return;
    try {
      this.tmpDir = mkdtempSync(path.join(os.tmpdir(), "skr-uia-"));
      const scriptPath = path.join(this.tmpDir, "uia-url.ps1");
      writeFileSync(scriptPath, UIA_SCRIPT, "utf8");

      const proc = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
        { stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
      );
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
      // First line is the readiness sentinel emitted once UIA is loaded.
      this.ready = line.trim() === READY;
      return;
    }
    const w = this.waiter;
    this.waiter = null;
    if (w) w(line);
  }

  private killHost(): void {
    const w = this.waiter;
    this.waiter = null;
    if (w) w(""); // unblock any in-flight request (resolves to no-url)
    this.ready = false;
    this.busy = false;
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
  }
}
