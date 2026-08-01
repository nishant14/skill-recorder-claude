import assert from "node:assert/strict";
import test from "node:test";

import {
  isWaylandSession,
  linuxCaptureSupport,
  readLinuxActiveWindow,
  resetLinuxCaptureProbe,
  type LinuxExec,
} from "./linux-active-window";

const ACTIVE = "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x3c00007\n";

const XWININFO = `xwininfo: Window id: 0x3c00007 "Mozilla Firefox"

  Absolute upper-left X:  120
  Absolute upper-left Y:  64
  Relative upper-left X:  0
  Relative upper-left Y:  0
  Width: 1280
  Height: 800
  Depth: 24
`;

/** Canned exec: keyed by the command plus its first meaningful argument. */
function fakeExec(responses: Record<string, string | Error>): {
  exec: LinuxExec;
  calls: string[][];
} {
  const calls: string[][] = [];
  const exec: LinuxExec = async (file, args) => {
    calls.push([file, ...args]);
    const key = file === "xprop" && args[0] === "-root" ? "xprop-root" : file;
    const response = responses[key];
    if (response === undefined) throw new Error(`unexpected command: ${file}`);
    if (response instanceof Error) throw response;
    return response;
  };
  return { exec, calls };
}

test("readLinuxActiveWindow reads title, WM_CLASS, pid and bounds", async () => {
  const { exec, calls } = fakeExec({
    "xprop-root": ACTIVE,
    xprop:
      '_NET_WM_NAME(UTF8_STRING) = "Skill Recorder — Mozilla Firefox"\n' +
      'WM_NAME(STRING) = "Skill Recorder"\n' +
      'WM_CLASS(STRING) = "Navigator", "firefox"\n' +
      "_NET_WM_PID(CARDINAL) = 4242\n",
    xwininfo: XWININFO,
  });

  const result = await readLinuxActiveWindow(exec);
  assert.ok(result);
  // _NET_WM_NAME wins over the legacy Latin-1 WM_NAME.
  assert.equal(result.title, "Skill Recorder — Mozilla Firefox");
  assert.equal(result.id, 0x3c00007);
  assert.equal(result.owner?.name, "firefox");
  assert.equal(result.owner?.processId, 4242);
  assert.deepEqual(result.bounds, { x: 120, y: 64, width: 1280, height: 800 });
  assert.deepEqual(calls[0], ["xprop", "-root", "_NET_ACTIVE_WINDOW"]);
  assert.equal(calls[1][0], "xprop");
  assert.equal(calls[1][1], "-id");
  assert.equal(calls[1][2], "0x3c00007");
});

test("readLinuxActiveWindow decodes octal byte escapes as UTF-8, not per character", async () => {
  const { exec } = fakeExec({
    "xprop-root": ACTIVE,
    // xprop escapes every non-ASCII *byte*: \342\200\224 is one em dash, and
    // \303\251 is one é. Decoding them individually would give mojibake.
    xprop:
      '_NET_WM_NAME(UTF8_STRING) = "Caf\\303\\251 \\342\\200\\224 r\\303\\251sum\\303\\251 \\\\ \\"quoted\\""\n' +
      'WM_CLASS(STRING) = "gnome-terminal-server", "Gnome-terminal"\n',
    xwininfo: XWININFO,
  });

  const result = await readLinuxActiveWindow(exec);
  assert.equal(result?.title, 'Café — résumé \\ "quoted"');
  assert.equal(result?.owner?.name, "Gnome-terminal");
});

test("readLinuxActiveWindow takes the last WM_CLASS string when there are more than two", async () => {
  const { exec } = fakeExec({
    "xprop-root": ACTIVE,
    xprop:
      'WM_NAME(STRING) = "code"\n' +
      'WM_CLASS(STRING) = "code", "instance", "Code"\n',
    xwininfo: XWININFO,
  });

  const result = await readLinuxActiveWindow(exec);
  assert.equal(result?.owner?.name, "Code");
});

test("readLinuxActiveWindow falls back to WM_NAME and omits an absent pid", async () => {
  const { exec } = fakeExec({
    "xprop-root": ACTIVE,
    xprop:
      "_NET_WM_NAME:  not found.\n" +
      'WM_NAME(STRING) = "xterm"\n' +
      'WM_CLASS(STRING) = "xterm", "XTerm"\n' +
      "_NET_WM_PID:  not found.\n",
    xwininfo: XWININFO,
  });

  const result = await readLinuxActiveWindow(exec);
  assert.equal(result?.title, "xterm");
  assert.equal(result?.owner?.name, "XTerm");
  assert.equal(result?.owner?.processId, undefined);
  assert.equal(result?.owner?.path, undefined);
});

test("readLinuxActiveWindow still reports the window when xwininfo fails", async () => {
  const { exec } = fakeExec({
    "xprop-root": ACTIVE,
    xprop: 'WM_NAME(STRING) = "Files"\nWM_CLASS(STRING) = "nautilus", "Nautilus"\n',
    xwininfo: new Error("xwininfo: error: window id 0x3c00007 does not exist"),
  });

  const result = await readLinuxActiveWindow(exec);
  assert.equal(result?.owner?.name, "Nautilus");
  assert.equal(result?.bounds, undefined);
});

test("readLinuxActiveWindow resolves undefined for an empty desktop", async () => {
  const { exec } = fakeExec({
    "xprop-root": "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x0\n",
  });
  assert.equal(await readLinuxActiveWindow(exec), undefined);
});

test("readLinuxActiveWindow resolves undefined without _NET_ACTIVE_WINDOW support", async () => {
  const { exec } = fakeExec({ "xprop-root": "_NET_ACTIVE_WINDOW:  not found.\n" });
  assert.equal(await readLinuxActiveWindow(exec), undefined);
});

test("readLinuxActiveWindow never throws when the tools are missing or time out", async () => {
  const missing = Object.assign(new Error("spawn xprop ENOENT"), { code: "ENOENT" });
  const { exec } = fakeExec({ "xprop-root": missing });
  assert.equal(await readLinuxActiveWindow(exec), undefined);

  const timedOut = fakeExec({ "xprop-root": ACTIVE, xprop: new Error("ETIMEDOUT") });
  assert.equal(await readLinuxActiveWindow(timedOut.exec), undefined);
});

test("readLinuxActiveWindow tolerates a window with no name at all", async () => {
  const { exec } = fakeExec({
    "xprop-root": ACTIVE,
    xprop: "_NET_WM_NAME:  not found.\nWM_NAME:  not found.\nWM_CLASS:  not found.\n",
    xwininfo: XWININFO,
  });
  const result = await readLinuxActiveWindow(exec);
  assert.equal(result?.title, "");
  assert.equal(result?.owner?.name, "unknown");
});

/** Session detection reads the environment, so every case restores what it changed. */
function withSession(
  env: { XDG_SESSION_TYPE?: string; WAYLAND_DISPLAY?: string; DISPLAY?: string },
  body: () => void,
): void {
  const keys = ["XDG_SESSION_TYPE", "WAYLAND_DISPLAY", "DISPLAY"] as const;
  const saved = keys.map((key) => [key, process.env[key]] as const);
  try {
    for (const key of keys) delete process.env[key];
    for (const [key, value] of Object.entries(env)) process.env[key] = value;
    body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetLinuxCaptureProbe();
  }
}

test("linuxCaptureSupport reports Wayland as unsupported, XWayland included", () => {
  withSession({ XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" }, () => {
    resetLinuxCaptureProbe(true);
    const support = linuxCaptureSupport();
    assert.equal(support.ok, false);
    assert.match(support.reason ?? "", /Wayland/);
    assert.match(support.reason ?? "", /Xorg/);
    assert.equal(isWaylandSession(), true);
  });

  // No XDG_SESSION_TYPE, but a compositor socket is still a Wayland session.
  withSession({ WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" }, () => {
    resetLinuxCaptureProbe(true);
    assert.equal(isWaylandSession(), true);
    assert.equal(linuxCaptureSupport().ok, false);
  });
});

test("linuxCaptureSupport is ok on an X11 session with the tools installed", () => {
  withSession({ XDG_SESSION_TYPE: "x11", DISPLAY: ":0" }, () => {
    resetLinuxCaptureProbe(true);
    assert.deepEqual(linuxCaptureSupport(), { ok: true });
    assert.equal(isWaylandSession(), false);
  });

  // XDG_SESSION_TYPE=x11 wins over a stale WAYLAND_DISPLAY.
  withSession({ XDG_SESSION_TYPE: "x11", WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" }, () => {
    resetLinuxCaptureProbe(true);
    assert.equal(linuxCaptureSupport().ok, true);
  });
});

test("linuxCaptureSupport names the apt package when x11-utils is missing", () => {
  withSession({ XDG_SESSION_TYPE: "x11", DISPLAY: ":0" }, () => {
    resetLinuxCaptureProbe();
    const looked: string[] = [];
    const support = linuxCaptureSupport((tool) => {
      looked.push(tool);
      return tool === "xprop"; // xwininfo absent
    });
    assert.equal(support.ok, false);
    assert.match(support.reason ?? "", /x11-utils/);
    assert.deepEqual(looked, ["xprop", "xwininfo"]);

    // The probe is cached: a second call does not re-scan PATH.
    const again = linuxCaptureSupport(() => {
      throw new Error("probe should have been cached");
    });
    assert.equal(again.ok, false);
  });
});

test("linuxCaptureSupport reports a headless session with no DISPLAY", () => {
  withSession({ XDG_SESSION_TYPE: "tty" }, () => {
    resetLinuxCaptureProbe(true);
    const support = linuxCaptureSupport();
    assert.equal(support.ok, false);
    assert.match(support.reason ?? "", /DISPLAY/);
  });
});
