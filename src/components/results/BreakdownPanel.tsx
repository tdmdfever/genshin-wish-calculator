import { isFourStarKind, levelLabel, targetLevelOf } from '../../engine/goalKinds';
import type { Goal, LevelBreakdownSeries } from '../../engine/types';
import './BreakdownPanel.css';

interface Props {
  breakdowns: LevelBreakdownSeries[];
  goals: Goal[];
  activeIdx: number;
  activePull: number;
}

/** The level a 4-star goal is waiting for, as it appears in `levelLabels` ("C2" / "R3"). */
function goalLevelLabel(goal: Goal): string | undefined {
  return isFourStarKind(goal.kind) ? levelLabel(goal.kind, targetLevelOf(goal)) : undefined;
}

/**
 * Shows the full constellation (C0-C6) or refinement (R1-R5) probability
 * distribution for every 4-star goal, at whatever pull count is currently active
 * on the main chart — always all levels, regardless of the goal's own chosen
 * target level (which only controls priority/banner-focus timing). So the heading
 * is the plain name (the "(C2)" in the goal list would contradict "all levels"), and
 * the level the goal is chasing is picked out instead: its bar is full strength,
 * the rest are muted, and "goal" sits under it. Same look as the site embed.
 */
export function BreakdownPanel({ breakdowns, goals, activeIdx, activePull }: Props) {
  if (breakdowns.length === 0) return null;

  return (
    <div className="breakdown-panel">
      <p className="breakdown-panel-title">Constellation / refinement odds at pull {activePull}</p>
      {breakdowns.map((b) => {
        const goal = goals.find((g) => g.id === b.goalId);
        const goalLabel = goal ? goalLevelLabel(goal) : undefined;
        return (
        <div className="breakdown-goal" key={b.goalId}>
          <div className="breakdown-goal-name">{goal?.name ?? b.goalName}</div>
          <div className="breakdown-levels">
            {b.levelLabels.map((label, i) => {
              const p = b.levelProbabilities[i][activeIdx] ?? 0;
              const isGoal = label === goalLabel;
              return (
                <div className="breakdown-level" key={label}>
                  <span className="breakdown-level-value">{(p * 100).toFixed(0)}%</span>
                  <div className="breakdown-level-bar-track">
                    <div
                      className={`breakdown-level-bar-fill${isGoal ? ' is-goal' : ''}`}
                      style={{ height: `${Math.max(0, Math.min(100, p * 100))}%` }}
                    />
                  </div>
                  <span className="breakdown-level-label">{label}</span>
                  {isGoal && <span className="breakdown-goal-tag">goal</span>}
                </div>
              );
            })}
          </div>
        </div>
        );
      })}
    </div>
  );
}
