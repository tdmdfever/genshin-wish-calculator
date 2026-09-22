import { useEffect, useRef, useState } from 'react';
import type { Goal, SimulationResult } from '../../engine/types';
import './ResultsChart.css';

const GRID_LINES = [0, 0.25, 0.5, 0.75, 1];

// How each line is drawn. COLOUR says what the line ends in: a prefix of the goal list whose last
// goal is a 5-star is gold, one whose last goal is a 4-star is lavender (--color-5star /
// --color-4star in styles/tokens.css). DASH PATTERN tells apart lines of the same colour, and counts back from the
// end of the list: the full plan (last line) is solid and bold, the prefix before it is dashed, then
// dotted, then dash-dot, repeating. Same scheme as the chart on the personal site. Pattern as well as
// colour, so nothing relies on colour alone.
const DASH_PATTERNS = ['none', '7 4', '0.1 4.5', '10 4 1.5 4'];

interface SeriesStyle {
  color: string;
  dash: string;
  width: number;
  /** The last series: the whole goal list. Drawn solid and bold, with a filled end marker. */
  isWhole: boolean;
}

function styleSeries(result: SimulationResult, goals: Goal[]): SeriesStyle[] {
  const lastIndex = result.series.length - 1;
  return result.series.map((s, i) => {
    const lastGoalId = s.goalIds[s.goalIds.length - 1];
    const is4Star = goals.find((g) => g.id === lastGoalId)?.kind.startsWith('4star') ?? false;
    const fromEnd = lastIndex - i;
    return {
      color: is4Star ? 'var(--color-4star)' : 'var(--color-5star)',
      dash: DASH_PATTERNS[fromEnd % DASH_PATTERNS.length],
      width: fromEnd === 0 ? 2.5 : 1.75,
      isWhole: fromEnd === 0,
    };
  });
}

/** A short sample of a line, for the legend and the hover readout. */
function SeriesKey({ style }: { style: SeriesStyle }) {
  return (
    <svg className="series-key" width="22" height="8" aria-hidden="true">
      <line x1="0" x2="22" y1="4" y2="4" stroke={style.color} strokeWidth={style.width} strokeDasharray={style.dash} strokeLinecap="round" />
    </svg>
  );
}

interface Props {
  result: SimulationResult | null;
  /** The goal list the result was computed for; a line's colour depends on its last goal's star rating. */
  goals: Goal[];
  isRunning: boolean;
  /** The pull index other panels (e.g. the constellation/refinement breakdown) stay
   * synced to — lifted up so it survives this component's own re-renders and can be
   * shared. Defaults to the last pull (the full budget) so odds are always visible,
   * not only on hover; hovering moves it, leaving the chart returns to the default. */
  activeIdx: number;
  onActiveIdxChange: (idx: number) => void;
}

export function ResultsChart({ result, goals, isRunning, activeIdx, onActiveIdxChange }: Props) {
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

  const styles = styleSeries(result, goals);
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
                <SeriesKey style={styles[i]} />
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
              <path
                key={s.goalIds.join('-')}
                d={s.d}
                className="series-line"
                style={{ stroke: styles[i].color, strokeWidth: styles[i].width, strokeDasharray: styles[i].dash }}
              />
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
                r={styles[i].isWhole ? 4.5 : 3.5}
                className={styles[i].isWhole ? 'end-marker' : 'end-marker end-marker--hollow'}
                style={styles[i].isWhole ? { fill: styles[i].color } : { stroke: styles[i].color }}
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
                <SeriesKey style={styles[i]} />
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
