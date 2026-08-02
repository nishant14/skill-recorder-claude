# Describer fix: form interactions invisible between page transitions

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
