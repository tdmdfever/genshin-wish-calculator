import { useEffect, useState } from 'react';
import type { LevelBreakdownSeries } from '../../engine/types';
import './BreakdownPanel.css';

interface Props {
  breakdowns: LevelBreakdownSeries[];
  activeIdx: number;
  activePull: number;
}

// Mirrors the light/dark --ramp-100/--ramp-700 stops in BreakdownPanel.css. Kept in
// sync manually since the bar fill needs a JS-interpolated color, not a fixed var.
const RAMP_LIGHT: [string, string] = ['#cde2fb', '#0d366b'];
const RAMP_DARK: [string, string] = ['#184f95', '#cde2fb'];

function useIsDarkMode(): boolean {
  const [isDark, setIsDark] = useState(() => typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setIsDark(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);
  return isDark;
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function lerpColor(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bch = Math.round(ab + (bb - ab) * t);
  return `rgb(${r}, ${g}, ${bch})`;
}

/**
 * Shows the full constellation (C0-C6) or refinement (R1-R5) probability
 * distribution for every 4-star goal, at whatever pull count is currently active
 * on the main chart — always all levels, regardless of the goal's own chosen
 * target level (which only controls priority/banner-focus timing, not what's shown
 * here). Color encodes level (an ordinal ramp — one hue, monotone lightness), bar
 * height encodes probability.
 */
export function BreakdownPanel({ breakdowns, activeIdx, activePull }: Props) {
  const isDark = useIsDarkMode();
  const [rampStart, rampEnd] = isDark ? RAMP_DARK : RAMP_LIGHT;

  if (breakdowns.length === 0) return null;

  return (
    <div className="breakdown-panel">
      <p className="breakdown-panel-title">Constellation / refinement odds at pull {activePull}</p>
      {breakdowns.map((b) => (
        <div className="breakdown-goal" key={b.goalId}>
          <div className="breakdown-goal-name">{b.goalName}</div>
          <div className="breakdown-levels">
            {b.levelLabels.map((label, i) => {
              const p = b.levelProbabilities[i][activeIdx] ?? 0;
              const t = b.levelLabels.length > 1 ? i / (b.levelLabels.length - 1) : 0;
              const color = lerpColor(rampStart, rampEnd, t);
              return (
                <div className="breakdown-level" key={label}>
                  <span className="breakdown-level-value">{(p * 100).toFixed(0)}%</span>
                  <div className="breakdown-level-bar-track">
                    <div
                      className="breakdown-level-bar-fill"
                      style={{ height: `${Math.max(0, Math.min(100, p * 100))}%`, background: color }}
                    />
                  </div>
                  <span className="breakdown-level-label">{label}</span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
