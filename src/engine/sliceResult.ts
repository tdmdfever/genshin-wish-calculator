import type { SimulationResult } from './types';

/**
 * Truncates a `SimulationResult` computed for a LARGER pull budget down to a
 * smaller one, for `useSimulation.ts`'s cache-and-slice optimization (skip the
 * worker entirely — and its full DP recompute — when the user only shrinks the
 * pull budget from one already computed).
 *
 * MOSTLY exact, not always byte-identical — this was verified directly, not
 * assumed, before shipping (see `sliceResult.test.ts`, including a case that
 * disproved the FIRST, too-broad version of this claim). `runExactSimulation`'s
 * own DP (`phaseDp.ts`'s per-phase loop, `exactEngine.ts`'s phase-stitching
 * convolutions) is strictly causal — a pull-indexed array's value at index `n`
 * only ever depends on indices `<= n` of its own inputs, never on the
 * configured `pullBudget` as a VALUE (only as a loop bound) — but that alone
 * does NOT make slicing exact for every goal list, because `exitSubstateDist`
 * (`phaseDp.ts`) — the state distribution handed off to seed a LATER phase
 * reusing the SAME banner — is accumulated only from mass that graduates
 * within that phase's own local horizon, which for an ordinary (non-capped)
 * phase equals the WHOLE requested `pullBudget`; normalizing it therefore
 * implicitly conditions on "graduated within this many pulls," and that
 * conditioning genuinely shifts (very slightly) depending on how large the
 * budget was when it was computed. Exact, byte-identical slicing only holds
 * when NO phase ever hands off to a later same-banner phase at all — which
 * turns out to be a narrower case than "no banner reuse in the goal list"
 * sounds like: `exactEngine.ts`'s "trailing continuation" (Phase C) mechanism
 * means ANY goal list with a 4-star goal on its tail banner triggers exactly
 * this same handoff, even for an otherwise single-phase goal list (found by a
 * test for that exact shape failing, not predicted in advance). So a sliced
 * value can differ from a fresh small-budget computation by a small, nonzero
 * amount whenever ANY 4-star goal exists, or a banner is genuinely reused
 * across real phases (a disconnected 4★'s own isolated phase, 3+ sequential
 * same-banner 5★s split by a detour, etc.) — this is a NEW, DIFFERENT source
 * of approximation from the already-documented crCounter/persistent-vector
 * time-marginalization residual elsewhere in this engine (CLAUDE.md's
 * twelfth-reported-bug follow-up), not a rediscovery of it.
 *
 * Directly measured (not guessed) via an adversarial construction — a
 * disconnected 4★ plus a same-phase 4★ with a deep C6 target, sliced from a
 * 900-pull cached result: worst case 0.0007 percentage points at a 90-pull
 * request, decaying to ~0.00001pp by 600 pulls — about three orders of
 * magnitude below this app's own 1-decimal display precision, and far smaller
 * than the already-accepted crCounter residual (which reaches multiple
 * percentage points in comparably adversarial shapes). Explicitly reviewed and
 * accepted (via `AskUserQuestion`, 2026-08-21) despite the app's own text
 * promising odds are "computed exactly (no simulation sampling)" — the
 * decision was that a residual this many orders of magnitude below what's ever
 * actually displayed doesn't meaningfully break that promise, and restricting
 * the optimization to only non-reusing goal lists would have excluded exactly
 * the slowest, most-in-need-of-caching scenarios (multi-phase chases,
 * disconnected 4★s) from any benefit at all.
 */
export function sliceSimulationResult(result: SimulationResult, maxPulls: number): SimulationResult {
  const length = maxPulls + 1;
  return {
    pullCounts: result.pullCounts.slice(0, length),
    series: result.series.map((s) => ({ ...s, probabilities: s.probabilities.slice(0, length) })),
    breakdowns: result.breakdowns.map((b) => ({ ...b, levelProbabilities: b.levelProbabilities.map((arr) => arr.slice(0, length)) })),
    meta: { ...result.meta, elapsedMs: 0 },
  };
}
