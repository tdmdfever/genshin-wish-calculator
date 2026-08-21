import { useAppState } from '../../state/AppStateContext';
import { validateGoals } from '../../engine/goalValidation';
import { buildPhases, findFlankingLinkedPair } from '../../engine/phases';
import type { Goal, GoalKind } from '../../engine/types';

function maxAnchorsFor(goal: Goal): number {
  return goal.kind === '4star_character' ? 2 : 1;
}

/** The anchors a 4★ goal's checkboxes should actually SHOW/act on: its own
 * explicit value if it has one (including an explicit empty array — a
 * deliberate "not on any of these," see phases.ts's resolveFourStarBlockingPhase),
 * otherwise the single-candidate default when exactly one phase is available
 * (matching GoalForm.tsx's identically-motivated pre-check-by-default, so a
 * never-touched goal's checkbox visually matches what the engine actually
 * computes for it instead of always showing unchecked). Falls back to `[]`
 * only when there's genuinely nothing to default to (0 or 2+ candidates). */
function effectiveAnchorsFor(goal: Goal, characterAnchorGroups: { ids: string[]; label: string }[], fiveStarWeaponGoals: Goal[]): string[] {
  if (goal.anchoredFiveStarGoalIds !== undefined) return goal.anchoredFiveStarGoalIds;
  if (goal.kind === '4star_character') return characterAnchorGroups.length === 1 ? characterAnchorGroups[0].ids : [];
  if (goal.kind === '4star_weapon') return fiveStarWeaponGoals.length === 1 ? [fiveStarWeaponGoals[0].id] : [];
  return [];
}

const KIND_LABELS: Record<GoalKind, string> = {
  '5star_character': '5★ character',
  '4star_character': '4★ character',
  '5star_weapon': '5★ weapon',
  '4star_weapon': '4★ weapon',
};

const CHARACTER_LEVEL_OPTIONS = Array.from({ length: 7 }, (_, i) => i); // C0-C6
const WEAPON_LEVEL_OPTIONS = Array.from({ length: 5 }, (_, i) => i + 1); // R1-R5

function isFourStar(goal: Goal): boolean {
  return goal.kind === '4star_character' || goal.kind === '4star_weapon';
}

/** Groups this list's 5star_character goals by phase — see GoalForm.tsx's
 * identically-named helper (kept separate, matching this file's existing
 * pattern of duplicating small UI constants rather than cross-importing). */
function computeCharacterAnchorGroups(goals: Goal[]): { ids: string[]; label: string }[] {
  return buildPhases(goals)
    .filter((p) => p.banner === 'character')
    .map((p) => p.goals.filter((g) => g.kind === '5star_character'))
    .filter((fiveStars) => fiveStars.length > 0)
    .map((fiveStars) => ({ ids: fiveStars.map((g) => g.id), label: fiveStars.map((g) => g.name).join(' + ') }));
}

/** The nearest OTHER 5star_character goal in one direction from `idx`, walking
 * past any 4star_character/weapon-kind goals in between (they don't break
 * character-link adjacency — see types.ts's linkedCharacterGoalId doc
 * comment, relaxed 2026-08-19). Stops at the first 5star_character goal found
 * regardless of its own link state, excluding it only if it's already linked
 * to a THIRD goal (not `goals[idx]` itself) — offering to steal a partner from
 * a brand-new toggle would be a surprising side effect. */
function findAdjacentCharacterLinkCandidate(goals: Goal[], idx: number, direction: 1 | -1): Goal | undefined {
  for (let i = idx + direction; i >= 0 && i < goals.length; i += direction) {
    const g = goals[i];
    if (g.kind === '5star_character') return g.linkedCharacterGoalId && g.linkedCharacterGoalId !== goals[idx].id ? undefined : g;
  }
  return undefined;
}

export function GoalList() {
  const { state, dispatch } = useAppState();

  if (state.goals.length === 0) {
    return <p className="empty-hint">No goals yet — add one below. Order matters: it's your priority list.</p>;
  }

  const fiveStarWeaponGoals = state.goals.filter((g) => g.kind === '5star_weapon');
  const characterAnchorGroups = computeCharacterAnchorGroups(state.goals);
  const errors = validateGoals(state.goals);
  const errorsByGoalId = new Map(errors.map((e) => [e.goalId, e.message]));

  function toggleCharacterAnchorGroup(goal: Goal, ids: string[]) {
    const current = effectiveAnchorsFor(goal, characterAnchorGroups, fiveStarWeaponGoals);
    const isSelected = ids.every((id) => current.includes(id));
    const maxAnchors = maxAnchorsFor(goal);
    let next: string[];
    if (isSelected) {
      next = current.filter((a) => !ids.includes(a));
    } else {
      // maxAnchors counts PHASE-GROUPS, not raw ids — see GoalForm.tsx's
      // identically-motivated fix.
      const selectedGroupCount = characterAnchorGroups.filter((g) => g.ids.every((id) => current.includes(id))).length;
      next = selectedGroupCount + 1 > maxAnchors ? current : [...current, ...ids];
    }
    dispatch({ type: 'SET_GOAL_ANCHORS', id: goal.id, anchoredFiveStarGoalIds: next });
  }

  function toggleWeaponAnchor(goal: Goal, id: string) {
    const current = effectiveAnchorsFor(goal, characterAnchorGroups, fiveStarWeaponGoals);
    let next: string[];
    if (current.includes(id)) next = current.filter((a) => a !== id);
    else if (current.length >= maxAnchorsFor(goal)) next = current;
    else next = [...current, id];
    dispatch({ type: 'SET_GOAL_ANCHORS', id: goal.id, anchoredFiveStarGoalIds: next });
  }

  function toggleWeaponLink(goal: Goal, candidateId: string) {
    const next = goal.linkedWeaponGoalId === candidateId ? undefined : candidateId;
    dispatch({ type: 'SET_GOAL_WEAPON_LINK', id: goal.id, linkedWeaponGoalId: next });
  }

  function toggleCharacterLink(goal: Goal, candidateId: string) {
    const next = goal.linkedCharacterGoalId === candidateId ? undefined : candidateId;
    dispatch({ type: 'SET_GOAL_CHARACTER_LINK', id: goal.id, linkedCharacterGoalId: next });
  }

  return (
    <ol className="goal-list">
      {state.goals.map((goal, idx) => {
        const error = errorsByGoalId.get(goal.id);
        // Linking only requires no OTHER 5star_character goal between the
        // pair (types.ts's linkedCharacterGoalId doc comment) — a
        // 4star_character or weapon-banner goal in between is fine, so the
        // nearest valid candidate in each direction has to walk past those
        // instead of only ever checking the literal previous/next goal.
        const characterLinkCandidates = [
          findAdjacentCharacterLinkCandidate(state.goals, idx, -1),
          findAdjacentCharacterLinkCandidate(state.goals, idx, 1),
        ].filter((g): g is Goal => !!g);
        return (
          <li key={goal.id} className={`goal-row ${error ? 'has-error' : ''}`}>
            <div className="goal-row-main">
              <span className="goal-rank">{idx + 1}</span>
              <span className="goal-name">{goal.name}</span>
              <span className="goal-kind">{KIND_LABELS[goal.kind]}</span>
              {isFourStar(goal) && (
                <label className="goal-target-level">
                  <span>wait for</span>
                  <select
                    value={goal.targetLevel ?? (goal.kind === '4star_weapon' ? 1 : 0)}
                    onChange={(e) => dispatch({ type: 'SET_GOAL_TARGET_LEVEL', id: goal.id, targetLevel: Number(e.target.value) })}
                  >
                    {(goal.kind === '4star_character' ? CHARACTER_LEVEL_OPTIONS : WEAPON_LEVEL_OPTIONS).map((lvl) => (
                      <option key={lvl} value={lvl}>
                        {goal.kind === '4star_character' ? `C${lvl}` : `R${lvl}`}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <span className="goal-actions">
                <button type="button" disabled={idx === 0} onClick={() => dispatch({ type: 'MOVE_GOAL', id: goal.id, direction: 'up' })} aria-label="Move up">
                  ↑
                </button>
                <button
                  type="button"
                  disabled={idx === state.goals.length - 1}
                  onClick={() => dispatch({ type: 'MOVE_GOAL', id: goal.id, direction: 'down' })}
                  aria-label="Move down"
                >
                  ↓
                </button>
                <button type="button" onClick={() => dispatch({ type: 'REMOVE_GOAL', id: goal.id })} aria-label="Remove">
                  ✕
                </button>
              </span>
            </div>
            {goal.kind === '4star_character' && characterAnchorGroups.length > 0 && (
              <div className="goal-row-anchors">
                <span>available on:</span>
                {characterAnchorGroups.map((group) => {
                  const current = effectiveAnchorsFor(goal, characterAnchorGroups, fiveStarWeaponGoals);
                  const isSelected = group.ids.every((id) => current.includes(id));
                  const selectedGroupCount = characterAnchorGroups.filter((g) => g.ids.every((id) => current.includes(id))).length;
                  // Structurally forced — see findFlankingLinkedPair's own doc
                  // comment (two simultaneous 5-stars flanking this goal leave
                  // no valid alternative). Locked checked, can't be unchecked.
                  const flanking = findFlankingLinkedPair(state.goals, goal.id);
                  const isForced = !!flanking && group.ids.includes(flanking[0]) && group.ids.includes(flanking[1]);
                  const disabled = isForced || (!isSelected && selectedGroupCount + 1 > maxAnchorsFor(goal));
                  return (
                    <label key={group.ids.join(',')} className="anchor-option">
                      <input
                        type="checkbox"
                        checked={isForced || isSelected}
                        disabled={disabled}
                        onChange={() => toggleCharacterAnchorGroup(goal, group.ids)}
                      />
                      {group.label}
                      {isForced && ' (required — simultaneous)'}
                    </label>
                  );
                })}
              </div>
            )}
            {goal.kind === '4star_weapon' && fiveStarWeaponGoals.length > 0 && (
              <div className="goal-row-anchors">
                <span>available on:</span>
                {fiveStarWeaponGoals.map((g) => {
                  const current = effectiveAnchorsFor(goal, characterAnchorGroups, fiveStarWeaponGoals);
                  // Structurally forced — see findFlankingLinkedPair's own doc
                  // comment. Locked checked, can't be unchecked.
                  const flanking = findFlankingLinkedPair(state.goals, goal.id);
                  const isForced = !!flanking && flanking.includes(g.id);
                  const disabled = isForced || (!current.includes(g.id) && current.length >= maxAnchorsFor(goal));
                  return (
                    <label key={g.id} className="anchor-option">
                      <input type="checkbox" checked={isForced || current.includes(g.id)} disabled={disabled} onChange={() => toggleWeaponAnchor(goal, g.id)} />
                      {g.name}
                      {isForced && ' (required — simultaneous)'}
                    </label>
                  );
                })}
              </div>
            )}
            {goal.kind === '5star_weapon' &&
              (() => {
                const otherWeaponGoals = fiveStarWeaponGoals.filter((g) => g.id !== goal.id);
                if (otherWeaponGoals.length === 0) return null;
                return (
                  <div className="goal-row-anchors">
                    <span>same window as:</span>
                    {otherWeaponGoals.map((g) => (
                      <label key={g.id} className="anchor-option">
                        <input type="checkbox" checked={goal.linkedWeaponGoalId === g.id} onChange={() => toggleWeaponLink(goal, g.id)} />
                        {g.name}
                      </label>
                    ))}
                  </div>
                );
              })()}
            {goal.kind === '5star_character' && characterLinkCandidates.length > 0 && (
              <div className="goal-row-anchors">
                <span>simultaneous with:</span>
                {characterLinkCandidates.map((g) => (
                  <label key={g.id} className="anchor-option">
                    <input type="checkbox" checked={goal.linkedCharacterGoalId === g.id} onChange={() => toggleCharacterLink(goal, g.id)} />
                    {g.name}
                  </label>
                ))}
              </div>
            )}
            {error && <p className="goal-row-error">{error}</p>}
          </li>
        );
      })}
    </ol>
  );
}
