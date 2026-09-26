import { useMemo, useState } from 'react';
import { formatGoalRoster, formatTrace, traceOneRun } from '../../engine/trace';
import type { SimulationInput } from '../../engine/types';

/**
 * Devtools-style panel: one concrete, reproducible pull-by-pull playthrough of the current goal list
 * and state (trace.ts — the same machinery trace.survey.test.ts uses), so a player can check the
 * pulling order makes sense. Generated on request rather than on every change.
 */
export function TracePanel({ input, disabledReason }: { input: SimulationInput; disabledReason?: 'no-goals' | 'invalid-goals' }) {
  const disabled = disabledReason !== undefined;
  const [seed, setSeed] = useState<number | null>(null);

  function rollNewTrace() {
    setSeed(Math.floor(Math.random() * 2 ** 31));
  }

  // Only re-traced when the seed or the input's content changes, not on every render of the app.
  const inputKey = JSON.stringify(input);
  const { run, formatted } = useMemo(() => {
    const run = seed !== null && !disabled ? traceOneRun(input, seed) : null;
    return { run, formatted: run ? formatTrace(run, input.goals) : null };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed, disabled, inputKey]);

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
      {disabledReason === 'no-goals' && <p className="form-hint-full">Add a goal above to trace a run.</p>}
      {disabledReason === 'invalid-goals' && <p className="form-warning">Fix the goal list errors above first.</p>}
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
