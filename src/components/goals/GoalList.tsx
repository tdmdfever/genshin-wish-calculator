import { useAppState } from '../../state/AppStateContext';
import { MAX_TOTAL_FOUR_STAR_GOALS_PER_BANNER, validateGoals } from '../../engine/goalValidation';
import { buildPhases, computeCharacterWindowGoalsForPhase, computeCharacterWindowPartnerPhase, findFlankingLinkedPair } from '../../engine/phases';
import type { Goal, GoalKind } from '../../engine/types';
import { goalDisplayName } from '../../state/goalDisplay';
import { GoalIcon } from './GoalIcon';
import { GoalNameInput } from './GoalNameInput';
import { useDragReorder } from './useDragReorder';

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
 * pattern of duplicating small UI constants rather than cross-importing).
 *
 * Twenty-first reported bug (2026-08-30): a linked-simultaneous pair that
 * ISN'T literally adjacent (an interleaved weapon detour, or another 4-star,
 * splits them into two separate `Phase` objects — see phases.ts's own
 * buildPhases doc comment) used to show as two SEPARATE checkbox options
 * ("Odette" and "Miko") instead of one combined "Odette + Miko" the way a
 * literally-adjacent linked pair already does — even though the engine now
 * treats them as one real, shared window (computeCharacterWindowPartnerPhase)
 * and `applySymmetricLink` already auto-reconciles a 4-star's own anchors to
 * include both the instant they're linked. The checkboxes just weren't
 * reflecting that combined reality. Each phase index is only ever folded
 * into one group (via `seen`), so a window pair contributes a single
 * combined option, not two overlapping ones.
 */
function computeCharacterAnchorGroups(goals: Goal[]): { ids: string[]; label: string }[] {
  const phases = buildPhases(goals);
  const groups: { ids: string[]; label: string }[] = [];
  const seen = new Set<number>();
  phases.forEach((phase, p) => {
    if (phase.banner !== 'character' || seen.has(p)) return;
    seen.add(p);
    const partner = computeCharacterWindowPartnerPhase(phases, p);
    const fiveStars =
      partner !== undefined
        ? computeCharacterWindowGoalsForPhase(phases, p).filter((g) => g.kind === '5star_character')
        : phase.goals.filter((g) => g.kind === '5star_character');
    if (partner !== undefined) seen.add(partner);
    if (fiveStars.length === 0) return;
    groups.push({ ids: fiveStars.map((g) => g.id), label: fiveStars.map((g) => g.name).join(' + ') });
  });
  return groups;
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

  // The 4★ per-banner cap is enforced by the Add form, not the validator, so a row's kind
  // dropdown holds to it too: a kind is unavailable when the OTHER goals already fill it.
  function kindIsFull(kind: GoalKind, goalId: string): boolean {
    if (kind !== '4star_character' && kind !== '4star_weapon') return false;
    const banner = kind === '4star_character' ? 'character' : 'weapon';
    return state.goals.filter((g) => g.kind === kind && g.id !== goalId).length >= MAX_TOTAL_FOUR_STAR_GOALS_PER_BANNER[banner];
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
              {isFourStar(goal) && (
                <select
                  className="level-select"
                  aria-label={goal.kind === '4star_character' ? 'Constellation to wait for' : 'Refinement to wait for'}
                  value={goal.targetLevel ?? (goal.kind === '4star_weapon' ? 1 : 0)}
                  onChange={(e) => dispatch({ type: 'SET_GOAL_TARGET_LEVEL', id: goal.id, targetLevel: Number(e.target.value) })}
                >
                  {(goal.kind === '4star_character' ? CHARACTER_LEVEL_OPTIONS : WEAPON_LEVEL_OPTIONS).map((lvl) => (
                    <option key={lvl} value={lvl}>
                      {goal.kind === '4star_character' ? `C${lvl}` : `R${lvl}`}
                    </option>
                  ))}
                </select>
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
