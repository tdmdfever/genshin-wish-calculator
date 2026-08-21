import { useState } from 'react';
import { formatGoalRoster, formatTrace, traceOneRun } from '../../engine/trace';
import type { SimulationInput } from '../../engine/types';

/**
 * Devtools-style "sanity check" panel — reuses the exact same `traceOneRun`/
 * `formatTrace`/`formatGoalRoster` machinery `trace.survey.test.ts` uses to
 * narrate one concrete, reproducible pull-by-pull playthrough of the CURRENT
 * goal list and starting state, so a real player can eyeball "does this pulling
 * sequence make sense" without needing to run the test suite. Added at the
 * user's explicit request (2026-08-19) — this reverses an earlier, deliberate
 * decision (see CLAUDE.md's testing-methodology section) to keep the trace tool
 * script/test-only; the user decided they want it live after using the
 * test-only version extensively to verify the 5star_weapon window-linking fix.
 *
 * Deliberately NOT auto-computed on every state change (unlike the exact-engine
 * results, which run debounced in a Web Worker) — one trace is cheap (a single
 * Monte Carlo walkthrough, not the exact DP engine), but there's no reason to
 * spend it until the user actually wants to look at one.
 */
export function TracePanel({ input, disabled }: { input: SimulationInput; disabled: boolean }) {
  const [seed, setSeed] = useState<number | null>(null);

  function rollNewTrace() {
    setSeed(Math.floor(Math.random() * 2 ** 31));
  }

  const run = seed !== null && !disabled ? traceOneRun(input, seed) : null;
  const formatted = run ? formatTrace(run, input.goals) : null;

  return (
    <details className="trace-panel">
      <summary>Debug: trace one pull-by-pull run</summary>
      <p className="form-hint-full">
        Simulates ONE concrete, randomly-seeded playthrough of your current goal list and pity/state above — pull by
        pull, narrating which banner is in focus, every 4★/5★ that lands, and why. Useful for sanity-checking the
        priority/focus logic does what you expect — not the odds themselves (see the chart below for those), just one
        possible story. If this seed doesn't show what you're looking for, re-roll for another.
      </p>
      <button type="button" onClick={rollNewTrace} disabled={disabled}>
        {run ? 'Re-roll (new seed)' : 'Generate trace'}
      </button>
      {disabled && <p className="form-warning">Fix the goal list errors above first.</p>}
      {run && formatted && (
        <>
          <p className="trace-seed">seed {seed}</p>
          <pre className="trace-output">
            {formatGoalRoster(input.goals)}
            {'\n\n'}
            {formatted.summary}
          </pre>
          <details className="trace-log-details">
            <summary>Full pull-by-pull log</summary>
            <pre className="trace-output">{formatted.log}</pre>
          </details>
        </>
      )}
    </details>
  );
}
