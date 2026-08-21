import { useEffect, useRef, useState } from 'react';
import type { SimulationResult } from '../../engine/types';
import './ResultsChart.css';

const SERIES_VARS = ['--series-1', '--series-2', '--series-3', '--series-4', '--series-5', '--series-6', '--series-7', '--series-8'];
const GRID_LINES = [0, 0.25, 0.5, 0.75, 1];

interface Props {
  result: SimulationResult | null;
  isRunning: boolean;
  /** The pull index other panels (e.g. the constellation/refinement breakdown) stay
   * synced to — lifted up so it survives this component's own re-renders and can be
   * shared. Defaults to the last pull (the full budget) so odds are always visible,
   * not only on hover; hovering moves it, leaving the chart returns to the default. */
  activeIdx: number;
  onActiveIdxChange: (idx: number) => void;
}

export function ResultsChart({ result, isRunning, activeIdx, onActiveIdxChange }: Props) {
  const [showTable, setShowTable] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const lastIdx = result ? result.pullCounts.length - 1 : 0;

  useEffect(() => {
    onActiveIdxChange(lastIdx);
    // Only reset when the budget (series length) changes, not on every recompute,
    // so an active hover survives a settings-triggered recompute.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastIdx]);

  if (!result || result.series.length === 0) {
    return (
      <div className="results-chart empty-state">
        <p>Add at least one goal to see your odds over time.</p>
      </div>
    );
  }

  // Direct end-of-line labels aren't used here: series labels are priority-prefix
  // concatenations of goal names ("Furina + Furina's Weapon + Xiangling") with
  // unbounded length, unlike typical short series labels, so they'd clip against
  // the chart edge. The legend (full names) and hover tooltip carry identity instead.
  const width = 720;
  const height = 380;
  const margin = { top: 16, right: 20, bottom: 32, left: 46 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const maxPull = result.pullCounts[result.pullCounts.length - 1] || 1;

  const xScale = (pull: number) => margin.left + (pull / maxPull) * plotW;
  const yScale = (p: number) => margin.top + (1 - p) * plotH;

  const paths = result.series.map((s) => ({
    ...s,
    d: s.probabilities.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xScale(result.pullCounts[i]).toFixed(2)} ${yScale(p).toFixed(2)}`).join(' '),
  }));

  function handleMove(e: React.PointerEvent<SVGSVGElement>) {
    if (!result) return;
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const xInViewBox = ((e.clientX - rect.left) / rect.width) * width;
    const pull = Math.round(((xInViewBox - margin.left) / plotW) * maxPull);
    onActiveIdxChange(Math.min(result.pullCounts.length - 1, Math.max(0, pull)));
  }

  return (
    <div className="results-chart">
      <div className="results-chart-header">
        {result.series.length > 1 && (
          <div className="legend">
            {result.series.map((s, i) => (
              <span className="legend-item" key={s.goalIds.join('-')}>
                <svg width="16" height="8" aria-hidden="true">
                  <line x1="0" y1="4" x2="16" y2="4" stroke={`var(${SERIES_VARS[i % 8]})`} strokeWidth={2} />
                </svg>
                {s.label}
              </span>
            ))}
          </div>
        )}
        <button type="button" className="table-toggle" onClick={() => setShowTable((v) => !v)}>
          {showTable ? 'Show chart' : 'Show table'}
        </button>
      </div>

      {isRunning && <p className="running-hint">Recomputing…</p>}

      {!showTable ? (
        <>
          <svg
            ref={svgRef}
            viewBox={`0 0 ${width} ${height}`}
            className="chart-svg"
            onPointerMove={handleMove}
            onPointerLeave={() => onActiveIdxChange(lastIdx)}
            role="img"
            aria-label="Cumulative probability of completing your goals by pull count"
          >
            {GRID_LINES.map((g) => (
              <line key={g} x1={margin.left} x2={width - margin.right} y1={yScale(g)} y2={yScale(g)} className="gridline" />
            ))}
            {GRID_LINES.map((g) => (
              <text key={g} x={margin.left - 8} y={yScale(g)} className="axis-label" textAnchor="end" dominantBaseline="middle">
                {Math.round(g * 100)}%
              </text>
            ))}
            <text x={margin.left} y={height - 8} className="axis-label" textAnchor="start">
              0 pulls
            </text>
            <text x={width - margin.right} y={height - 8} className="axis-label" textAnchor="end">
              {maxPull} pulls
            </text>

            {paths.map((s, i) => (
              <path key={s.goalIds.join('-')} d={s.d} className="series-line" style={{ stroke: `var(${SERIES_VARS[i % 8]})` }} />
            ))}

            <line
              x1={xScale(result.pullCounts[activeIdx])}
              x2={xScale(result.pullCounts[activeIdx])}
              y1={margin.top}
              y2={height - margin.bottom}
              className="crosshair"
            />
            {paths.map((s, i) => (
              <circle
                key={s.goalIds.join('-')}
                cx={xScale(result.pullCounts[activeIdx])}
                cy={yScale(s.probabilities[activeIdx])}
                r={4}
                className="end-marker"
                style={{ fill: `var(${SERIES_VARS[i % 8]})` }}
              />
            ))}
          </svg>

          <div className="tooltip">
            <div className="tooltip-header">
              Pull {result.pullCounts[activeIdx]}
              {activeIdx === lastIdx && ' (your full pull budget)'}
            </div>
            {paths.map((s, i) => (
              <div className="tooltip-row" key={s.goalIds.join('-')}>
                <span className="tooltip-key" style={{ background: `var(${SERIES_VARS[i % 8]})` }} />
                <span className="tooltip-value">{(s.probabilities[activeIdx] * 100).toFixed(1)}%</span>
                <span className="tooltip-label">{s.label}</span>
              </div>
            ))}
          </div>
        </>
      ) : (
        <TableView result={result} />
      )}
    </div>
  );
}

function TableView({ result }: { result: SimulationResult }) {
  const step = Math.max(1, Math.floor(result.pullCounts.length / 40));
  const rows = result.pullCounts.filter((_, i) => i % step === 0 || i === result.pullCounts.length - 1);
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Pulls</th>
            {result.series.map((s) => (
              <th key={s.goalIds.join('-')}>{s.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((pull) => {
            const idx = result.pullCounts.indexOf(pull);
            return (
              <tr key={pull}>
                <td>{pull}</td>
                {result.series.map((s) => (
                  <td key={s.goalIds.join('-')}>{(s.probabilities[idx] * 100).toFixed(1)}%</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
