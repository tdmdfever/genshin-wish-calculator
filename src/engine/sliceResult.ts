import type { SimulationResult } from './types';

/**
 * Truncates a result computed for a larger pull budget down to a smaller one — useSimulation.ts's
 * cache for pull-budget decreases, served without a worker round-trip.
 *
 * Exact unless a banner is reused across phases (sliceResult.test.ts pins both). The DP and the
 * stitching are causal — index n depends only on indices <= n — but exitSubstateDist, the state
 * handed to a banner's next phase, only collects mass that graduated within the budget, so
 * normalizing it conditions slightly on the budget. Measured worst case: 0.0007 percentage points at
 * 90 pulls sliced from 900 (adversarial construction), ~0.00001pp by 600 — three orders of
 * magnitude below the 1-decimal display. Accepted by explicit user decision; excluding
 * banner-reusing lists would have excluded exactly the slow cases that benefit most.
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
