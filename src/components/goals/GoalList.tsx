import { useAppState } from '../../state/useAppState';
import { MAX_TOTAL_FOUR_STAR_GOALS_PER_BANNER, validateGoals } from '../../engine/goalValidation';
import { bannerOfKind, isFourStarKind, KIND_LABELS, MAX_ANCHOR_PHASES, targetLevelOf } from '../../engine/goalKinds';
import { findFlankingLinkedPair } from '../../engine/phases';
import type { Goal, GoalKind } from '../../engine/types';
import { computeCharacterAnchorGroups, countSelectedGroups, defaultAnchors, type CharacterAnchorGroup } from './anchorOptions';
import { goalDisplayName } from '../../state/goalDisplay';
import { GoalIcon } from './GoalIcon';
import { GoalNameInput } from './GoalNameInput';
import { LevelSelect } from './LevelSelect';
import { useDragReorder } from './useDragReorder';

/** The anchors a 4★ goal's checkboxes show and act on: its own explicit list if it has one
 * (an explicit empty list means "not on any of these"), otherwise the default candidate. */
function effectiveAnchorsFor(goal: Goal, characterAnchorGroups: CharacterAnchorGroup[], fiveStarWeaponGoals: Goal[]): string[] {
  return goal.anchoredFiveStarGoalIds ?? defaultAnchors(goal.kind, characterAnchorGroups, fiveStarWeaponGoals);
}

function maxAnchorsFor(goal: Goal): number {
  return isFourStarKind(goal.kind) ? MAX_ANCHOR_PHASES[goal.kind] : 0;
}

/** The nearest other 5★ character goal in one direction from `idx`, walking past 4★ and
 * weapon-banner goals (they don't break a character link). Undefined if that goal is already linked
 * to a third goal — offering to steal its partner would be a surprising side effect. */
function findAdjacentCharacterLinkCandidate(goals: Goal[], idx: number, direction: 1 | -1): Goal | undefined {
  for (let i = idx + direction; i >= 0 && i < goals.length; i += direction) {
    const g = goals[i];
    if (g.kind === '5star_character') return g.linkedCharacterGoalId && g.linkedCharacterGoalId !== goals[idx].id ? undefined : g;
  }
  return undefined;
}

export function GoalList() {
  const { state, dispatch } = useAppState();
  const { dragId, rowRef, handleProps, rowStyle } = useDragReorder(
    state.goals.map((g) => g.id),
    (id, toIndex) => dispatch({ type: 'REORDER_GOAL', id, toIndex }),
  );

  if (state.goals.length === 0) {
    return <p className="empty-hint">No goals yet — add one below. Order matters: it's your priority list.</p>;
  }

  const fiveStarWeaponGoals = state.goals.filter((g) => g.kind === '5star_weapon');
  const characterAnchorGroups = computeCharacterAnchorGroups(state.goals);
  const errors = validateGoals(state.goals);
  const errorsByGoalId = new Map(errors.map((e) => [e.goalId, e.message]));

  // Like the Add form, a row's kind dropdown disables a 4★ kind the OTHER goals already fill to the
  // per-banner cap, so a kind change can't produce a list the validator would reject.
  function kindIsFull(kind: GoalKind, goalId: string): boolean {
    if (!isFourStarKind(kind)) return false;
    return state.goals.filter((g) => g.kind === kind && g.id !== goalId).length >= MAX_TOTAL_FOUR_STAR_GOALS_PER_BANNER[bannerOfKind(kind)];
  }

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
      next = countSelectedGroups(characterAnchorGroups, current) + 1 > maxAnchors ? current : [...current, ...ids];
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
    <ol className={`goal-list ${dragId ? 'is-reordering' : ''}`} role="list">
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
          <li
            key={goal.id}
            ref={rowRef(goal.id)}
            className={`goal-row ${error ? 'has-error' : ''} ${dragId === goal.id ? 'is-dragging' : ''}`}
            style={rowStyle(goal.id, idx)}
            data-tone={goal.kind.startsWith('4star') ? '4star' : '5star'}
          >
            <div className="goal-row-main">
              <GoalIcon kind={goal.kind} />
              <GoalNameInput name={goal.name} displayName={goalDisplayName(goal)} onCommit={(name) => dispatch({ type: 'EDIT_GOAL', id: goal.id, name })} />
              {isFourStarKind(goal.kind) && (
                <LevelSelect
                  kind={goal.kind}
                  value={targetLevelOf(goal)}
                  onChange={(targetLevel) => dispatch({ type: 'SET_GOAL_TARGET_LEVEL', id: goal.id, targetLevel })}
                />
              )}
              <select
                className="kind-select"
                aria-label="Goal kind"
                value={goal.kind}
                onChange={(e) => dispatch({ type: 'EDIT_GOAL', id: goal.id, kind: e.target.value as GoalKind })}
              >
                {(Object.entries(KIND_LABELS) as [GoalKind, string][]).map(([value, label]) => (
                  <option key={value} value={value} data-tone={value.startsWith('4star') ? '4star' : '5star'} disabled={kindIsFull(value, goal.id)}>
                    {label}
                  </option>
                ))}
              </select>
              <button type="button" className="goal-remove" onClick={() => dispatch({ type: 'REMOVE_GOAL', id: goal.id })} aria-label={`Remove ${goal.name}`} title="Remove">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                  <path d="M4 7h16M9 7V4.5h6V7M6.5 7l.9 12.2a1.8 1.8 0 0 0 1.8 1.6h5.6a1.8 1.8 0 0 0 1.8-1.6L17.5 7M10 11v6M14 11v6" />
                </svg>
              </button>
              <button
                type="button"
                className="goal-drag-handle"
                aria-label={`Reorder ${goal.name}: drag, or use the up and down arrow keys`}
                title="Drag to reorder"
                {...handleProps(goal.id, idx)}
              >
                <svg viewBox="0 0 10 16" width="10" height="16" fill="currentColor" aria-hidden="true" focusable="false">
                  {[2, 8, 14].flatMap((cy) => [2, 8].map((cx) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="1.5" />))}
                </svg>
              </button>
            </div>
            {goal.kind === '4star_character' && characterAnchorGroups.length > 0 && (
              <div className="goal-row-anchors">
                <span>available on:</span>
                {characterAnchorGroups.map((group) => {
                  const current = effectiveAnchorsFor(goal, characterAnchorGroups, fiveStarWeaponGoals);
                  const isSelected = group.ids.every((id) => current.includes(id));
                  // Structurally forced — see findFlankingLinkedPair's own doc
                  // comment (two simultaneous 5-stars flanking this goal leave
                  // no valid alternative). Locked checked, can't be unchecked.
                  const flanking = findFlankingLinkedPair(state.goals, goal.id);
                  const isForced = !!flanking && group.ids.includes(flanking[0]) && group.ids.includes(flanking[1]);
                  const disabled = isForced || (!isSelected && countSelectedGroups(characterAnchorGroups, current) + 1 > maxAnchorsFor(goal));
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
                    <span>same banner as:</span>
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
