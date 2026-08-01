import assert from "node:assert/strict";
import test from "node:test";

import type { RunAskRequest, RunConfirmRequest } from "../../common/ipc";
import { createRunGates, RunPrompts } from "./ipc-bridge";

/** The gates plus the requests they broadcast — the whole renderer-facing surface. */
function harness(opts: { allowAlways?: boolean } = {}) {
  const prompts = new RunPrompts();
  prompts.arm({ allowAlways: opts.allowAlways ?? true });
  const confirms: RunConfirmRequest[] = [];
  const asks: RunAskRequest[] = [];
  const gates = createRunGates(prompts, { runId: "run-1", skillName: "demo" }, {
    emitConfirm: (r) => confirms.push(r),
    emitAsk: (r) => asks.push(r),
  });
  return { prompts, gates, confirms, asks };
}

test("a confirmation waits for the matching response", async () => {
  const { prompts, gates, confirms } = harness();
  const decision = gates.confirm.request("run_shell", "Run: ls", "ls -la");
  assert.equal(confirms.length, 1);
  assert.equal(confirms[0].runId, "run-1");
  assert.equal(confirms[0].kind, "run_shell");
  assert.equal(confirms[0].detail, "ls -la");
  assert.equal(confirms[0].allowAlways, true);
  assert.equal(prompts.pending, 1);

  assert.equal(prompts.respond({ runId: "run-1", callId: confirms[0].callId, approved: true }), true);
  assert.equal(await decision, "approve");
  assert.equal(prompts.pending, 0);
});

test("a denial resolves as deny, and an absent `approved` is a denial", async () => {
  const { prompts, gates, confirms } = harness();
  const denied = gates.confirm.request("write_file", "Write a.txt", "…");
  prompts.respond({ runId: "run-1", callId: confirms[0].callId, approved: false });
  assert.equal(await denied, "deny");

  const empty = gates.confirm.request("write_file", "Write b.txt", "…");
  prompts.respond({ runId: "run-1", callId: confirms[1].callId });
  assert.equal(await empty, "deny");
});

test("stale or duplicated responses are refused, not misrouted", async () => {
  const { prompts, gates, confirms } = harness();
  const decision = gates.confirm.request("run_shell", "Run: ls", "ls");
  const { callId } = confirms[0];

  assert.equal(prompts.respond({ runId: "other-run", callId, approved: true }), false);
  assert.equal(prompts.respond({ runId: "run-1", callId: "nope", approved: true }), false);
  assert.equal(prompts.pending, 1);

  assert.equal(prompts.respond({ runId: "run-1", callId, approved: true }), true);
  assert.equal(prompts.respond({ runId: "run-1", callId, approved: false }), false);
  assert.equal(await decision, "approve");
});

test("call ids are unique across questions", async () => {
  const { prompts, gates, confirms, asks } = harness();
  void gates.confirm.request("run_shell", "one", "one");
  void gates.confirm.request("run_shell", "two", "two");
  void gates.ask.ask("Which customer?");
  const ids = new Set([confirms[0].callId, confirms[1].callId, asks[0].callId]);
  assert.equal(ids.size, 3);
  assert.equal(prompts.pending, 3);
  prompts.end();
});

test("always-allow approves later calls of the same kind without a card", async () => {
  const { prompts, gates, confirms } = harness();
  const first = gates.confirm.request("run_shell", "Run: ls", "ls");
  prompts.respond({
    runId: "run-1",
    callId: confirms[0].callId,
    approved: true,
    alwaysAllow: true,
  });
  assert.equal(await first, "approve");

  assert.equal(await gates.confirm.request("run_shell", "Run: pwd", "pwd"), "approve");
  assert.equal(confirms.length, 1, "no second card was shown");

  // Another capability is still gated individually.
  void gates.confirm.request("write_file", "Write a.txt", "…");
  assert.equal(confirms.length, 2);
  assert.equal(prompts.pending, 1);
  prompts.end();
});

test("an unrestricted skill never gets always-allow", async () => {
  const { prompts, gates, confirms } = harness({ allowAlways: false });
  const first = gates.confirm.request("run_shell", "Run: ls", "ls");
  assert.equal(confirms[0].allowAlways, false, "the card must not offer the checkbox");
  prompts.respond({
    runId: "run-1",
    callId: confirms[0].callId,
    approved: true,
    alwaysAllow: true,
  });
  assert.equal(await first, "approve");

  // The next call of the same kind is asked about again.
  void gates.confirm.request("run_shell", "Run: pwd", "pwd");
  assert.equal(confirms.length, 2);
  prompts.end();
});

test("a question resolves with the user's text, and with null when they sent none", async () => {
  const { prompts, gates, asks } = harness();
  const answered = gates.ask.ask("Which customer?");
  assert.equal(asks[0].question, "Which customer?");
  prompts.respond({ runId: "run-1", callId: asks[0].callId, text: "Contoso" });
  assert.equal(await answered, "Contoso");

  const skipped = gates.ask.ask("Which item?");
  prompts.respond({ runId: "run-1", callId: asks[1].callId });
  assert.equal(await skipped, null);
});

test("ending a run resolves every leftover waiter in band", async () => {
  const { prompts, gates } = harness();
  const decision = gates.confirm.request("run_shell", "Run: ls", "ls");
  const answer = gates.ask.ask("Which customer?");
  assert.equal(prompts.pending, 2);

  assert.equal(prompts.end(), 2);
  assert.equal(prompts.pending, 0);
  assert.equal(await decision, "timeout");
  assert.equal(await answer, null);
  // Nothing is left to answer, so a late reply is a no-op rather than a throw.
  assert.equal(prompts.respond({ runId: "run-1", callId: "run-1#1", approved: true }), false);
});

test("arming a run clears the previous run's always-allow and waiters", async () => {
  const { prompts, gates, confirms } = harness();
  const stale = gates.confirm.request("run_shell", "Run: ls", "ls");
  prompts.respond({ runId: "run-1", callId: confirms[0].callId, approved: true, alwaysAllow: true });
  assert.equal(await stale, "approve");
  const orphan = gates.ask.ask("Still there?");

  prompts.arm({ allowAlways: true });
  assert.equal(await orphan, null);
  assert.equal(prompts.isAlwaysAllowed("run_shell"), false);
  assert.equal(prompts.pending, 0);
});
