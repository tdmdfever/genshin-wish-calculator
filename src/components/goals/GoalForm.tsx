import { useState } from 'react';
import { useAppState } from '../../state/useAppState';
import { MAX_TOTAL_FOUR_STAR_GOALS_PER_BANNER } from '../../engine/goalValidation';
import { bannerOfKind, defaultTargetLevel, isFourStarKind, KIND_LABELS, MAX_ANCHOR_PHASES } from '../../engine/goalKinds';
import type { GoalKind } from '../../engine/types';
import { computeCharacterAnchorGroups, countSelectedGroups, defaultAnchors } from './anchorOptions';
import { LevelSelect } from './LevelSelect';

export function GoalForm() {
  const { state, dispatch } = useAppState();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<GoalKind>('5star_character');
  const [targetLevel, setTargetLevel] = useState(0);
  const [anchors, setAnchors] = useState<string[]>([]);
  // Whether the user has actually interacted with the anchor checkboxes for
  // THIS in-progress goal — see effectiveAnchors below for why this matters.
  const [anchorsTouched, setAnchorsTouched] = useState(false);
  const [linkedWeaponGoalId, setLinkedWeaponGoalId] = useState<string | undefined>(undefined);
  const [linkedCharacterGoalId, setLinkedCharacterGoalId] = useState<string | undefined>(undefined);

  // The Add form only offers the nearest earlier 5★ weapon as a link (unless it's already linked —
  // a new goal shouldn't steal its partner); any other pairing is made from a row's "same banner
  // as". (No cap on 5★ weapon goals: each one's dimension collapses once its phase requires it, so
  // even 16 run well under 300ms.)
  const weaponLinkCandidate = (() => {
    if (kind !== '5star_weapon') return undefined;
    for (let i = state.goals.length - 1; i >= 0; i--) {
      const g = state.goals[i];
      if (g.kind === '5star_weapon') return g.linkedWeaponGoalId ? undefined : g;
    }
    return undefined;
  })();

  const isFourStar = isFourStarKind(kind);
  const fourStarCountOfKind = state.goals.filter((g) => g.kind === kind).length;
  const fourStarBannerKind = bannerOfKind(kind);
  const blockedByFourStarCap = isFourStar && fourStarCountOfKind >= MAX_TOTAL_FOUR_STAR_GOALS_PER_BANNER[fourStarBannerKind];
  const fiveStarWeaponGoals = state.goals.filter((g) => g.kind === '5star_weapon');
  const characterAnchorGroups = computeCharacterAnchorGroups(state.goals);
  const maxAnchors = isFourStarKind(kind) ? MAX_ANCHOR_PHASES[kind] : 0;

  // With exactly one candidate, it's pre-checked (zero clicks for the common case) until the user
  // touches the checkboxes; after that their choice stands — including unchecking it, which submits
  // an explicit [] ("not on the 5★ currently listed").
  const effectiveAnchors = anchorsTouched ? anchors : defaultAnchors(kind, characterAnchorGroups, fiveStarWeaponGoals);

  // A new 5★ character goes at the end, so its only possible link partner is the nearest earlier
  // 5★ character (4★ and weapon goals between are fine). Not offered if that one is already linked.
  const characterLinkCandidate = (() => {
    if (kind !== '5star_character') return undefined;
    for (let i = state.goals.length - 1; i >= 0; i--) {
      const g = state.goals[i];
      if (g.kind === '5star_character') return g.linkedCharacterGoalId ? undefined : g;
    }
    return undefined;
  })();

  function handleKindChange(next: GoalKind) {
    setKind(next);
    setTargetLevel(isFourStarKind(next) ? defaultTargetLevel(next) : 0);
    setAnchors([]);
    setAnchorsTouched(false);
    setLinkedWeaponGoalId(undefined);
    setLinkedCharacterGoalId(undefined);
  }

  function toggleCharacterAnchorGroup(ids: string[]) {
    setAnchorsTouched(true);
    const prev = effectiveAnchors;
    const isSelected = ids.every((id) => prev.includes(id));
    if (isSelected) {
      setAnchors(prev.filter((a) => !ids.includes(a)));
      return;
    }
    // maxAnchors counts PHASE-GROUPS, not raw ids — a linked simultaneous
    // pair (2 ids, 1 phase) shouldn't exhaust the whole budget by itself.
    if (countSelectedGroups(characterAnchorGroups, prev) + 1 > maxAnchors) return;
    setAnchors([...prev, ...ids]);
  }

  function toggleWeaponAnchor(id: string) {
    setAnchorsTouched(true);
    const prev = effectiveAnchors;
    if (prev.includes(id)) {
      setAnchors(prev.filter((a) => a !== id));
      return;
    }
    if (prev.length >= maxAnchors) return;
    setAnchors([...prev, id]);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || blockedByFourStarCap) return;
    // Only submit an EXPLICIT array (even an empty one, meaning "deliberately
    // disconnected") once there was actually at least one candidate to choose
    // from — with zero candidates there's nothing to disambiguate, so `undefined`
    // preserves the existing "attach to this goal's own natal phase" fallback.
    const hadAnyCandidates = kind === '4star_character' ? characterAnchorGroups.length > 0 : kind === '4star_weapon' ? fiveStarWeaponGoals.length > 0 : false;
    dispatch({
      type: 'ADD_GOAL',
      name: trimmed,
      kind,
      targetLevel: isFourStar ? targetLevel : undefined,
      anchoredFiveStarGoalIds: isFourStar && hadAnyCandidates ? effectiveAnchors : undefined,
      linkedWeaponGoalId: kind === '5star_weapon' ? linkedWeaponGoalId : undefined,
      linkedCharacterGoalId: kind === '5star_character' ? linkedCharacterGoalId : undefined,
    });
    setName('');
    setAnchors([]);
    setAnchorsTouched(false);
    setLinkedWeaponGoalId(undefined);
    setLinkedCharacterGoalId(undefined);
  }

  return (
    <form className="goal-form" data-tone={isFourStar ? '4star' : '5star'} onSubmit={handleSubmit}>
      <input type="text" placeholder="Name (e.g. Furina, Homa)" value={name} onChange={(e) => setName(e.target.value)} />
      {isFourStarKind(kind) && <LevelSelect kind={kind} value={targetLevel} onChange={setTargetLevel} />}
      <select className="kind-select" aria-label="Goal kind" value={kind} onChange={(e) => handleKindChange(e.target.value as GoalKind)}>
        {(Object.entries(KIND_LABELS) as [GoalKind, string][]).map(([value, label]) => (
          <option key={value} value={value} data-tone={value.startsWith('4star') ? '4star' : '5star'}>
            {label}
          </option>
        ))}
      </select>
      <button type="submit" disabled={!name.trim() || blockedByFourStarCap}>
        Add
      </button>
      {characterLinkCandidate && (
        <label className="weapon-link-field">
          <input
            type="checkbox"
            checked={!!linkedCharacterGoalId}
            onChange={(e) => setLinkedCharacterGoalId(e.target.checked ? characterLinkCandidate.id : undefined)}
          />
          Simultaneous with {characterLinkCandidate.name} (same real phase, two separate banners)?
        </label>
      )}
      {kind === '5star_character' && (
        <p className="form-hint-full">
          {characterLinkCandidate
            ? "Check this if these are the SAME real phase's two simultaneous character banners (shared pity/guarantee/CR, but still two separate 50/50s) — leave unchecked if this is a later, sequential phase."
            : 'A 5★ character goal is its own sequential phase by default — chase as many in a row as you like with no detour needed.'}
        </p>
      )}
      {weaponLinkCandidate && (
        <label className="weapon-link-field">
          <input
            type="checkbox"
            checked={!!linkedWeaponGoalId}
            onChange={(e) => setLinkedWeaponGoalId(e.target.checked ? weaponLinkCandidate.id : undefined)}
          />
          Same banner as {weaponLinkCandidate.name}?
        </label>
      )}
      {kind === '5star_weapon' && (
        <p className="form-hint-full">
          {weaponLinkCandidate
            ? 'Check this if both are on the SAME real weapon banner (shared Epitomized Path, opportunistic crediting either way) — leave unchecked if this is a later, separate banner.'
            : 'A 5★ weapon goal is its own banner by default — link it to another one from its row if they share the same real weapon banner.'}
        </p>
      )}
      {blockedByFourStarCap && (
        <p className="form-warning">
          Only {MAX_TOTAL_FOUR_STAR_GOALS_PER_BANNER[fourStarBannerKind]} {KIND_LABELS[kind]} goals are supported in total, however you spread them
          across phases — this keeps the calculation fast and memory-bounded.
        </p>
      )}
      {isFourStar && (
        <p className="form-hint-full">
          The level on the left is the one this goal waits for — priority moves on once you reach it — but the odds chart always shows every level from {kind === '4star_character' ? 'C0 to C6' : 'R1 to R5'}.
        </p>
      )}
      {kind === '4star_character' && characterAnchorGroups.length > 0 && (
        <div className="anchor-field">
          <span className="anchor-field-label">Available on</span>
          <div className="anchor-options">
            {characterAnchorGroups.map((group) => {
              const isSelected = group.ids.every((id) => effectiveAnchors.includes(id));
              const disabled = !isSelected && countSelectedGroups(characterAnchorGroups, effectiveAnchors) + 1 > maxAnchors;
              return (
                <label key={group.ids.join(',')} className="anchor-option">
                  <input type="checkbox" checked={isSelected} disabled={disabled} onChange={() => toggleCharacterAnchorGroup(group.ids)} />
                  {group.label}
                </label>
              );
            })}
          </div>
          <p className="form-hint-full">
            Pick the phase(s) this 4★ is featured in — a phase with two simultaneous banners is one option covering both automatically, since they
            always share the identical 4★ roster. Leave every box unchecked if this 4★ isn't featured on any phase in your list yet — it'll show 0%
            until you add the real phase it's actually on, instead of silently assuming it's featured here.
          </p>
        </div>
      )}
      {kind === '4star_weapon' && fiveStarWeaponGoals.length > 0 && (
        <div className="anchor-field">
          <span className="anchor-field-label">Available on</span>
          <div className="anchor-options">
            {fiveStarWeaponGoals.map((g) => (
              <label key={g.id} className="anchor-option">
                <input
                  type="checkbox"
                  checked={effectiveAnchors.includes(g.id)}
                  disabled={!effectiveAnchors.includes(g.id) && effectiveAnchors.length >= maxAnchors}
                  onChange={() => toggleWeaponAnchor(g.id)}
                />
                {g.name}
              </label>
            ))}
          </div>
          <p className="form-hint-full">
            Pick which weapon-banner run this 4★ is featured on — each phase runs its own single weapon banner with its own 4★ lineup. Leave
            unchecked if this 4★ isn't featured on any phase in your list yet — it'll show 0% until you add the real phase it's actually on.
          </p>
        </div>
      )}
    </form>
  );
}
