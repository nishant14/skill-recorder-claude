# Describer fix: form interactions invisible between page transitions

## Iteration 2 (2026-08-02) — root cause moved from the prompt to the extractor

The user reproduced the miss a THIRD time after Fix 1 landed (recording
`20260802-132458-cd74061c`, titles-only, 12 frames). Two measurements re-aimed
the fix:

1. **Fixture upgraded to reality and the current prompt PASSED it at 100%**
   (baseline `2026-08-02T13-40-30`, single run). The scenario now mirrors the
   failing recording — 12 frames at the real 5s-heartbeat offsets, a decoy order
   (`SO-4401 Contoso Ltd 2 lines $282.00`, same profile as the created
   `SO-4471`, exactly like the seeded SO-10001 vs SO-10003), two dropdown-open
   mid-pick frames, incremental untidy form states, a 38s event-silent gap. The
   model probed the middle of the gap, was served the mid-fill frames, and
   correctly produced "Create and submit a new order". **The prompt is adequate
   when the frames are actually served.** The two extra prompt rules drafted for
   this iteration ("identity is in the id", "interaction frames are the action")
   are ON HOLD — unmeasured additions.

2. **The extractor deletes the evidence in the real recording.** Running the
   extractor's exact 9x8 dHash over the real session's 12 frames: only 6
   survive the Hamming ≤8 dedupe. Deleted: the dropdown-open mid-pick frame
   (d=6 — the single decisive screen) and two frames at **d=0** (a form gaining
   one filled field is invisible at 9x8 grayscale). `keepOrDrop` applies this
   dedupe to **probe frames the describer explicitly requested** via
   `get_frames`, so the model looks in exactly the right place and the pipeline
   silently withholds what the camera saw. No prompt rule recovers a deleted
   frame; no threshold recovers d=0.

**Fix 3 (the real one): probe-path frames are never perceptually deduped.** An
explicit `get_frames` window returns the captured source frames, deduped only by
source-file identity (no duplicate records on repeated probes). Event-anchored
opportunistic seeding keeps its perceptual dedupe. Measured by: (a) an extractor
unit test with a near-identical frame pair, (b) re-running the real session's
frames through the fixed probe path, (c) the eval fixture re-hardened so its
incremental form states collide under dHash like the real ones do — old
extractor FAILs the scenario, fixed extractor PASSes, full sweep green.

Sibling findings tracked separately: zero `browser.url` events despite
"accessibility ✓" is snap Firefox's AppArmor confinement blocking AT-SPI tree
reads (presence enumerable, `GetItems` denied) — the compatibility probe is
being upgraded to attempt a real end-to-end URL read so Full is never
overclaimed (see the compatibility-check plan).

## Context

Reproduced twice by the user on the testbed, once at **Good** capture and now at **Full**
(URLs flowing, "Firefox is exposing accessibility ✓"): the analysis renders the
order-creation recording as pure browsing — "Opened the Orders page → *Selected* order
SO-10003 to open its detail page" — missing the filled form and submission entirely.
Root cause is structural, not capture: the URL trail `/orders` → `/orders/SO-10003` is
**identical** for "clicked an existing row" and "submitted the new-order form" (PRG
redirect), form-filling emits **zero events** (no title/url/clipboard change while
typing), and the only distinguishing evidence — the 1-fps frames showing the form being
filled — was never consulted. The kickoff prompt says "look at frames only where events
are ambiguous", and the model doesn't treat a sparse-event page transition *as*
ambiguous. Fix = a targeted describer-prompt rule + a scored eval scenario that makes
this exact miss a permanent regression test — which also exercises the vision path in
the eval suite for the first time (today all describer scenarios are event-rich; none
force frame reliance).

## Fix 1 — describer prompt rule (`electron/describer/instructions.ts`, and the
kickoff in `electron/describer/describer.ts` if wording lives there)

Add one precise rule (meaning-preserving, no rewrite of the instruction set):

> **Page transitions hide actions.** Interacting with a page — filling a form, picking
> from a dropdown, clicking a button — usually produces NO events; only the resulting
> navigation does. Before you describe how the user got from one page to the next
> (especially list → detail, or any transition that lands on a new/changed entity),
> view the frames between the two page events with `get_frames`. Never conclude the
> user merely "opened" or "selected" something across a sparse-event transition
> without checking the frames for form interaction — creating and selecting look
> identical in the event stream and are distinguished only on screen.

Sharpen the kickoff's "only where events are ambiguous" to name sparse-event
transitions as ambiguous by definition. No tool changes (`list_frames` already
advertises the captured inventory since the L1 fix).

## Fix 2 — eval scenario that pins it: `evals/scenarios/form-submit-frames.ts`

- **Events (deliberately sparse):** titles+URLs only — Home → Orders (`/orders`) →
  Order detail (`/orders/SO-4471`), with a realistic dwell gap (~40s) between the last
  two and **no events inside it**.
- **Frames fixture:** extend the eval harness so a scenario can seed **captured
  frames** — `video.json` (framesVersion 1, framesFile) + `video-frames/` JPEGs +
  manifest — the exact artifacts `FrameExtractor` consumes. JPEGs are rendered at
  materialize time with **sharp** (already a dependency; SVG-text composite): 3–4
  frames depicting the Orders page, the form with "Customer: Contoso Ltd" and rows
  "NW-1140 × 12", "NW-2207 × 3", and a cursor-on-Submit frame. Rendering helper in
  `evals/lib/frame-fixtures.ts`; `materialize()` in `evals/run.ts`/`evals/scenario.ts`
  gains an optional `frames` field (additive — existing scenarios unchanged).
- **Rubric:** must-mention any of [create/submit/placed/filled + "order"]-family tokens
  for the transition step; forbidden: framing SO-4471 as pre-existing ("selected an
  existing", "opened an existing"). Register in `evals/scenarios/index.ts`.
- The scenario cannot pass without calling `get_frames` — the events alone are
  designed to reproduce today's wrong reading.

## Verification (measured, house style)

1. Offline: typecheck + full suite green (frame-fixture helper unit test for the
   manifest shape it writes; rendering itself exercised by the eval).
2. **Baseline first:** run `npm run eval -- --only=form-submit-frames` on the CURRENT
   prompt — expect FAIL reproducing the user's miss (this validates the scenario
   actually captures the bug).
3. Apply the prompt rule; re-run — expect PASS with the creation step present.
4. Regression: full describer sweep (`npm run eval`) — all 11 scenarios green, so the
   new rule doesn't distort event-rich analyses.
5. User's confirmation: re-run testbed guide Part A/B on this machine — the analysis
   should now include "filled the new-order form (Contoso, NW-1140 ×12, NW-2207 ×3)
   and submitted it" without any feedback round. Tracker updated with before/after.

## Files

`electron/describer/instructions.ts` (+ `describer.ts` kickoff wording),
`evals/lib/frame-fixtures.ts` (new), `evals/scenario.ts` + `evals/run.ts` (additive
frames seeding), `evals/scenarios/form-submit-frames.ts` (new) + `index.ts`,
`package.json` test list (helper test), `docs/plans/progress.md` (finding + result).
