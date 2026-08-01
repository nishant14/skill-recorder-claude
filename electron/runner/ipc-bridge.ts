import type {
  ConfirmDecision,
  RunAskRequest,
  RunConfirmRequest,
  RunRespondInput,
} from "../../common/ipc";
import type { AskGate, ConfirmGate } from "./tools";

/**
 * The half of the interactive gates that is *not* Electron: a call-id-keyed map of
 * questions the run is blocked on, and the answers coming back from the renderer.
 *
 * `electron/ipc.ts` owns nothing but the plumbing (broadcast the request, hand the
 * reply to {@link RunPrompts.respond}); the rules live here so they can be unit-tested
 * offline:
 *
 * - **Every waiter is resolved exactly once.** A stale `runId`/`callId` — the button
 *   of a run that already ended, a double-click, a second window answering the same
 *   card — is refused rather than resolving somebody else's promise.
 * - **No waiter outlives its run.** The runner has its own 3-minute in-band deadline,
 *   so a walked-away user is already handled; {@link RunPrompts.end} exists for the
 *   other direction — a run that finished, failed, or was canceled while a card was
 *   still on screen. Its waiters resolve with the same in-band "no response" values,
 *   so nothing is left holding a promise nobody will ever settle.
 * - **Always-allow is per run and never persisted.** It is also refused outright for
 *   an unrestricted skill (one with no `allowed-tools`), where the individual approvals
 *   are the only enforcement there is (H4).
 *
 * One run exists app-wide at a time — the runner refuses a second — so this holds one
 * run's state, cleared by {@link RunPrompts.arm} before each start.
 */

interface Waiter {
  runId: string;
  /** Resolves the gate's promise. Cleared from the map before it is called. */
  settle: (value: unknown) => void;
  /** What this waiter resolves with when the run ends before an answer arrives. */
  abandoned: unknown;
  /** Confirmations carry the tool kind, so an "always allow" can be remembered. */
  kind?: string;
}

/** The in-band answers a waiter degrades to; they match the runner's own timeouts. */
const ABANDONED_CONFIRM: ConfirmDecision = "timeout";
const ABANDONED_ASK: string | null = null;

export class RunPrompts {
  private seq = 0;
  private readonly waiters = new Map<string, Waiter>();
  /** Tool kinds the user approved for the rest of this run. */
  private readonly always = new Set<string>();
  private allowAlwaysOffered = false;
  private activeRun: string | null = null;

  /**
   * Prepare for a run that is about to start: nothing carries over from the last one,
   * and `allowAlways` decides whether its confirmation cards may offer the checkbox.
   */
  arm(opts: { allowAlways: boolean }): void {
    this.end();
    this.allowAlwaysOffered = opts.allowAlways;
  }

  /** True when confirmation cards for the armed run may offer "always allow". */
  get allowAlways(): boolean {
    return this.allowAlwaysOffered;
  }

  /**
   * The id the runner minted for the armed run, or null before it starts. Recorded by
   * {@link createRunGates}, which the runner calls while it assembles the run's tools —
   * i.e. before `run()` awaits anything — so the IPC handler can answer "it started,
   * here is the id" without waiting for a run that takes minutes.
   */
  get runId(): string | null {
    return this.activeRun;
  }

  /** Bind the bridge to the run whose gates are being built. */
  begin(runId: string): void {
    this.activeRun = runId;
  }

  /** How many questions are on screen unanswered. Tests assert nothing leaks. */
  get pending(): number {
    return this.waiters.size;
  }

  /** Ids are unique per bridge, so an answer can never land on the wrong question. */
  nextCallId(runId: string): string {
    this.seq += 1;
    return `${runId}#${this.seq}`;
  }

  /** True once the user has approved every call of this kind for the current run. */
  isAlwaysAllowed(kind: string): boolean {
    return this.always.has(kind);
  }

  /** Block until the user decides, or until the run ends without them. */
  waitConfirm(runId: string, callId: string, kind: string): Promise<ConfirmDecision> {
    return this.wait(runId, callId, ABANDONED_CONFIRM, kind);
  }

  /** Block until the user answers, or until the run ends without them (`null`). */
  waitAsk(runId: string, callId: string): Promise<string | null> {
    return this.wait(runId, callId, ABANDONED_ASK);
  }

  /**
   * Deliver the renderer's answer. Returns false — and changes nothing — when it names
   * a question that is not open, which is what a stale or duplicated reply looks like.
   */
  respond(input: RunRespondInput): boolean {
    const callId = input?.callId ?? "";
    const waiter = this.waiters.get(callId);
    if (!waiter || waiter.runId !== input?.runId) return false;
    this.waiters.delete(callId);
    if (waiter.kind === undefined) {
      // A question: whatever the user typed, or "no answer" when they sent nothing.
      waiter.settle(typeof input.text === "string" ? input.text : null);
      return true;
    }
    const approved = input.approved === true;
    // "Always allow" only sticks on an approval, only for a skill that declared its
    // tools, and only until this run ends — it is never written to disk.
    if (approved && input.alwaysAllow === true && this.allowAlwaysOffered) {
      this.always.add(waiter.kind);
    }
    waiter.settle(approved ? "approve" : "deny");
    return true;
  }

  /**
   * Resolve every question still open, with the in-band value it would have timed out
   * to. Called when a run finishes or is canceled, and on dispose.
   */
  end(): number {
    const open = [...this.waiters.values()];
    this.waiters.clear();
    this.always.clear();
    this.allowAlwaysOffered = false;
    this.activeRun = null;
    for (const waiter of open) waiter.settle(waiter.abandoned);
    return open.length;
  }

  private wait<T>(runId: string, callId: string, abandoned: T, kind?: string): Promise<T> {
    return new Promise<T>((resolve) => {
      this.waiters.set(callId, {
        runId,
        abandoned,
        ...(kind === undefined ? {} : { kind }),
        settle: (value) => resolve(value as T),
      });
    });
  }
}

/**
 * The interactive gates one run hands to its tools: emit the request to the renderer,
 * then wait on {@link RunPrompts}. Kept Electron-free — the two emitters are injected —
 * so the whole confirmation path can be exercised without a window.
 */
export function createRunGates(
  prompts: RunPrompts,
  ctx: { runId: string; skillName: string },
  emit: {
    emitConfirm: (request: RunConfirmRequest) => void;
    emitAsk: (request: RunAskRequest) => void;
  },
): { confirm: ConfirmGate; ask: AskGate } {
  prompts.begin(ctx.runId);
  return {
    confirm: {
      request: async (kind, summary, detail) => {
        // An earlier "always allow this run" answers this one without a card. The
        // runner still records the request and the decision in the transcript.
        if (prompts.isAlwaysAllowed(kind)) return "approve";
        const callId = prompts.nextCallId(ctx.runId);
        const waiting = prompts.waitConfirm(ctx.runId, callId, kind);
        emit.emitConfirm({
          runId: ctx.runId,
          callId,
          kind,
          summary,
          detail,
          allowAlways: prompts.allowAlways,
        });
        return waiting;
      },
    },
    ask: {
      ask: async (question) => {
        const callId = prompts.nextCallId(ctx.runId);
        const waiting = prompts.waitAsk(ctx.runId, callId);
        emit.emitAsk({ runId: ctx.runId, callId, question });
        return waiting;
      },
    },
  };
}
