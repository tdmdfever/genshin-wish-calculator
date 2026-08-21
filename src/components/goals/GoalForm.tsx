import { useState } from 'react';
import { useAppState } from '../../state/AppStateContext';
import { buildPhases } from '../../engine/phases';
import { MAX_TOTAL_FOUR_STAR_GOALS_PER_BANNER } from '../../engine/goalValidation';
import type { BannerKind, Goal, GoalKind } from '../../engine/types';

const KIND_LABELS: Record<GoalKind, string> = {
  '5star_character': '5★ character',
  '4star_character': '4★ character',
  '5star_weapon': '5★ weapon',
  '4star_weapon': '4★ weapon',
};

const CHARACTER_LEVEL_OPTIONS = Array.from({ length: 7 }, (_, i) => i); // C0-C6
const WEAPON_LEVEL_OPTIONS = Array.from({ length: 5 }, (_, i) => i + 1); // R1-R5

/** For the character 4-star anchor picker: groups this list's 5star_character
 * goals by phase (a "same simultaneous phase" group has 1 or 2 members —
 * Goal.linkedCharacterGoalId — see its doc comment) and returns one option
 * per phase, so a user can anchor to an entire phase in one click instead of
 * picking individual 5-stars and risking a partial (invalid) selection. */
function computeCharacterAnchorGroups(goals: Goal[]): { ids: string[]; label: string }[] {
  return buildPhases(goals)
    .filter((p) => p.banner === 'character')
    .map((p) => p.goals.filter((g) => g.kind === '5star_character'))
    .filter((fiveStars) => fiveStars.length > 0)
    .map((fiveStars) => ({ ids: fiveStars.map((g) => g.id), label: fiveStars.map((g) => g.name).join(' + ') }));
}

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

  const existingWeapon5Goals = state.goals.filter((g) => g.kind === '5star_weapon');
  // No cap on total 5star_weapon goals (removed 2026-08-19 — directly profiled:
  // even 16 total, or several linked pairs, run in well under 300ms at the
  // default pull budget, since each goal's own persistent dimension collapses
  // to a point mass once its own phase requires it — nothing like the 4-star
  // cross-phase compounding cost. The old "2 total" cap was a stale artifact
  // that predated explicit linking, never backed by goalValidation.ts).
  // A new goal can link to ANY existing 5star_weapon goal not already claimed
  // by another link — weapon linking has no adjacency requirement (unlike
  // character linking below).
  const weaponLinkCandidates = kind === '5star_weapon' ? existingWeapon5Goals.filter((g) => !g.linkedWeaponGoalId) : [];

  const isFourStar = kind === '4star_character' || kind === '4star_weapon';
  const fourStarCountOfKind = state.goals.filter((g) => g.kind === kind).length;
  const fourStarBannerKind: BannerKind = kind === '4star_character' ? 'character' : 'weapon';
  const blockedByFourStarCap = isFourStar && fourStarCountOfKind >= MAX_TOTAL_FOUR_STAR_GOALS_PER_BANNER[fourStarBannerKind];
  const fiveStarWeaponGoals = state.goals.filter((g) => g.kind === '5star_weapon');
  const characterAnchorGroups = computeCharacterAnchorGroups(state.goals);
  const maxAnchors = kind === '4star_character' ? 2 : 1;

  // When exactly ONE candidate phase exists, pre-check it automatically (the
  // overwhelmingly common case — a single 5★ plus its own 4★ — still works
  // with zero clicks) but ONLY as long as the user hasn't actually touched
  // the checkboxes. The moment they do (even to uncheck this single default
  // back to nothing), `anchors`/`anchorsTouched` take over completely — this
  // is what makes "this 4★ is NOT on the one 5★ currently listed" expressible
  // at all (eighteenth-reported-bug follow-up, 2026-08-20): before this, an
  // unchecked single-candidate box and a never-touched one were the same
  // underlying state (`undefined` after submit), so unchecking had no effect.
  const singleCandidateDefault =
    kind === '4star_character'
      ? characterAnchorGroups.length === 1
        ? characterAnchorGroups[0].ids
        : undefined
      : kind === '4star_weapon'
        ? fiveStarWeaponGoals.length === 1
          ? [fiveStarWeaponGoals[0].id]
          : undefined
        : undefined;
  const effectiveAnchors = anchorsTouched ? anchors : (singleCandidateDefault ?? []);

  // A NEW 5star_character goal is appended to the END of the list, so the only
  // possible link partner is the nearest EXISTING 5star_character goal walking
  // backward from the end — but linking only requires no OTHER 5star_character
  // goal between them (see types.ts's linkedCharacterGoalId doc comment,
  // relaxed 2026-08-19 to tolerate 4star_character/weapon-banner goals in
  // between), so this has to walk past those instead of only ever checking the
  // literal last goal. If the nearest 5-star found is already linked to
  // someone else, don't offer to steal its partner from a brand-new goal —
  // too surprising a side effect.
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
    setTargetLevel(next === '4star_weapon' ? 1 : 0);
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
    const selectedGroupCount = characterAnchorGroups.filter((g) => g.ids.every((id) => prev.includes(id))).length;
    if (selectedGroupCount + 1 > maxAnchors) return;
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
    <form className="goal-form" onSubmit={handleSubmit}>
      <input type="text" placeholder="Name (e.g. Furina, Homa)" value={name} onChange={(e) => setName(e.target.value)} />
      <select value={kind} onChange={(e) => handleKindChange(e.target.value as GoalKind)}>
        {(Object.entries(KIND_LABELS) as [GoalKind, string][]).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      {isFourStar && (
        <label className="target-level-field">
          <span>Wait for</span>
          <select value={targetLevel} onChange={(e) => setTargetLevel(Number(e.target.value))}>
            {kind === '4star_character'
              ? CHARACTER_LEVEL_OPTIONS.map((c) => (
                  <option key={c} value={c}>
                    C{c}
                  </option>
                ))
              : WEAPON_LEVEL_OPTIONS.map((r) => (
                  <option key={r} value={r}>
                    R{r}
                  </option>
                ))}
          </select>
        </label>
      )}
      <button type="submit" disabled={!name.trim() || blockedByFourStarCap}>
        Add goal
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
      {kind === '5star_weapon' && weaponLinkCandidates.length > 0 && (
        <label className="weapon-link-field">
          <span>Same weapon-banner window as:</span>
          <select value={linkedWeaponGoalId ?? ''} onChange={(e) => setLinkedWeaponGoalId(e.target.value || undefined)}>
            <option value="">— none (its own window) —</option>
            {weaponLinkCandidates.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {kind === '5star_weapon' && (
        <p className="form-hint-full">
          {weaponLinkCandidates.length > 0
            ? "Pick the OTHER weapon goal here if both are on the SAME real weapon banner (shared Epitomized Path, opportunistic crediting either way) — leave as \"none\" if they're on two different real phases."
            : 'A 5★ weapon goal is its own window by default — link it to another one later if they share the same real weapon banner.'}
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
          Priority moves on once you reach this level — but the odds chart always shows every level from {kind === '4star_character' ? 'C0 to C6' : 'R1 to R5'}.
        </p>
      )}
      {kind === '4star_character' && characterAnchorGroups.length > 0 && (
        <div className="anchor-field">
          <span className="anchor-field-label">Available on</span>
          <div className="anchor-options">
            {characterAnchorGroups.map((group) => {
              const isSelected = group.ids.every((id) => effectiveAnchors.includes(id));
              const selectedGroupCount = characterAnchorGroups.filter((g) => g.ids.every((id) => effectiveAnchors.includes(id))).length;
              const disabled = !isSelected && selectedGroupCount + 1 > maxAnchors;
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
