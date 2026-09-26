import type { BannerKind, CharacterBannerConfig, Goal, WeaponBannerConfig } from './types';

/** A run of consecutive same-banner goals, in priority order, that share one banner-focus period (see buildPhases). */
export interface Phase {
  banner: BannerKind;
  goals: Goal[];
  /** Index of this phase's first goal within the original global goal list. */
  globalStartIndex: number;
}

/**
 * For a 4★ goal, the nearest same-kind 5★ goal on each side of it in priority order (walking past
 * everything else), when both exist and are linked to each other. Such a 4★ can't be disconnected
 * or anchored to just one side: the two run at the same time, leaving no gap for another phase.
 * Returns the pair's ids `[before, after]`, or undefined.
 */
export function findFlankingLinkedPair(goals: Goal[], fourStarGoalId: string): [string, string] | undefined {
  const idx = goals.findIndex((g) => g.id === fourStarGoalId);
  if (idx === -1) return undefined;
  const fourStar = goals[idx];
  if (fourStar.kind !== '4star_character' && fourStar.kind !== '4star_weapon') return undefined;
  const fiveStarKind = fourStar.kind === '4star_character' ? '5star_character' : '5star_weapon';
  const linkField = fiveStarKind === '5star_character' ? 'linkedCharacterGoalId' : 'linkedWeaponGoalId';

  let before: Goal | undefined;
  for (let i = idx - 1; i >= 0; i--) {
    if (goals[i].kind === fiveStarKind) {
      before = goals[i];
      break;
    }
  }
  let after: Goal | undefined;
  for (let i = idx + 1; i < goals.length; i++) {
    if (goals[i].kind === fiveStarKind) {
      after = goals[i];
      break;
    }
  }
  if (!before || !after) return undefined;
  if (before[linkField] !== after.id || after[linkField] !== before.id) return undefined;
  return [before.id, after.id];
}

/**
 * The 4★ goals with no anchor to any listed 5★ window: an explicit empty
 * `anchoredFiveStarGoalIds`, or `undefined` while 2+ distinct same-kind 5★ windows exist (nothing
 * unambiguous to attach to). A linked pair of 5★s is one window — the same signal buildPhases uses,
 * so the two stay consistent.
 *
 * Works on the raw goal list, not Phase objects: buildPhases needs this result to place its
 * boundaries, and counting Phase objects would also count disconnected 4★s' own isolated phases.
 */
export function computeDisconnectedFourStarGoalIds(goals: Goal[]): Set<string> {
  function countWindows(fiveStarKind: '5star_character' | '5star_weapon'): number {
    const sameKind = goals.filter((g) => g.kind === fiveStarKind);
    const seen = new Set<string>();
    let windows = 0;
    for (const g of sameKind) {
      if (seen.has(g.id)) continue;
      seen.add(g.id);
      const linkId = fiveStarKind === '5star_character' ? g.linkedCharacterGoalId : g.linkedWeaponGoalId;
      if (linkId) seen.add(linkId);
      windows++;
    }
    return windows;
  }
  const windowsByKind = { '5star_character': countWindows('5star_character'), '5star_weapon': countWindows('5star_weapon') } as const;

  const disconnected = new Set<string>();
  for (const goal of goals) {
    if (goal.kind !== '4star_character' && goal.kind !== '4star_weapon') continue;
    const anchors = goal.anchoredFiveStarGoalIds;
    if (anchors && anchors.length > 0) continue; // has real anchors — not disconnected
    if (anchors !== undefined) {
      disconnected.add(goal.id); // explicit empty — always disconnected
      continue;
    }
    const fiveStarKind = goal.kind === '4star_character' ? '5star_character' : '5star_weapon';
    if (windowsByKind[fiveStarKind] >= 2) disconnected.add(goal.id); // ambiguous — nothing to default-attach to
  }
  return disconnected;
}

/**
 * Groups a priority-ordered goal list into phases. Banner focus is "the banner of the
 * highest-priority incomplete goal", which depends only on the fixed priority order — so a run of
 * consecutive same-banner goals shares one contiguous focus period, and focus only switches at
 * phase boundaries. See FOCUS_RULES.md for worked examples.
 *
 * Two passes:
 * 1. Baseline: consecutive same-banner goals share a phase, except that two 5★ weapon goals (or
 *    two 5★ character goals) merge only when explicitly linked (Goal.linkedWeaponGoalId /
 *    linkedCharacterGoalId) — an unlinked pair is two separate windows even when adjacent. A
 *    linked character pair separated by a weapon goal stays two Phase objects: exactEngine.ts
 *    joins their FIFO window (computeCharacterWindowPartnerPhase), and pity carries over between
 *    same-banner phases regardless.
 * 2. Each disconnected 4★ (computeDisconnectedFourStarGoalIds) is split out into its own
 *    single-goal phase at its own priority position — "her real rerun is some unlisted phase,
 *    right here in priority order". Adjacent disconnected 4★s get separate phases. Splitting
 *    already-formed baseline phases (rather than doing this inside pass 1) can't create a new
 *    adjacency with a goal outside the baseline phase — doing it inline once merged the goal after
 *    an isolated phase into an unrelated later 5★'s phase.
 */
export function buildPhases(goals: Goal[]): Phase[] {
  const disconnectedIds = computeDisconnectedFourStarGoalIds(goals);
  const globalIndexById = new Map(goals.map((goal, i) => [goal.id, i]));
  const baselinePhases: Phase[] = [];
  for (let i = 0; i < goals.length; i++) {
    const goal = goals[i];
    const last = baselinePhases[baselinePhases.length - 1];
    const sameBanner = !!last && last.banner === goal.banner;
    const forceNewWindow =
      sameBanner &&
      ((goal.kind === '5star_weapon' && last!.goals.some((g) => g.kind === '5star_weapon' && g.id !== goal.linkedWeaponGoalId)) ||
        (goal.kind === '5star_character' && last!.goals.some((g) => g.kind === '5star_character' && g.id !== goal.linkedCharacterGoalId)));
    if (sameBanner && !forceNewWindow) {
      last!.goals.push(goal);
    } else {
      baselinePhases.push({ banner: goal.banner, goals: [goal], globalStartIndex: i });
    }
  }

  const phases: Phase[] = [];
  for (const baseline of baselinePhases) {
    let run: Goal[] = [];
    const flushRun = () => {
      if (run.length === 0) return;
      phases.push({ banner: baseline.banner, goals: run, globalStartIndex: globalIndexById.get(run[0].id)! });
      run = [];
    };
    for (const goal of baseline.goals) {
      if (disconnectedIds.has(goal.id)) {
        flushRun();
        phases.push({ banner: baseline.banner, goals: [goal], globalStartIndex: globalIndexById.get(goal.id)! });
      } else {
        run.push(goal);
      }
    }
    flushRun();
  }
  return phases;
}

interface PhaseListLookups {
  /** The raw goal list, reconstructed from the phases (every goal is in exactly one). */
  goals: Goal[];
  phaseIndexByGoalId: Map<string, number>;
  disconnectedIds: Set<string>;
}
const lookupsByPhaseList = new WeakMap<Phase[], PhaseListLookups>();

/** Lookups several functions below need, built once per `phases` array (never mutated after buildPhases). */
function lookupsFor(phases: Phase[]): PhaseListLookups {
  let lookups = lookupsByPhaseList.get(phases);
  if (!lookups) {
    const goals = phases.flatMap((ph) => ph.goals);
    lookups = { goals, phaseIndexByGoalId: buildPhaseIndexByGoalId(phases), disconnectedIds: computeDisconnectedFourStarGoalIds(goals) };
    lookupsByPhaseList.set(phases, lookups);
  }
  return lookups;
}

/** Maps every goal id in the list to the index of the phase it belongs to. */
export function buildPhaseIndexByGoalId(phases: Phase[]): Map<string, number> {
  const phaseIndexByGoalId = new Map<string, number>();
  phases.forEach((phase, i) => {
    for (const goal of phase.goals) phaseIndexByGoalId.set(goal.id, i);
  });
  return phaseIndexByGoalId;
}

/**
 * The ONE phase a 4★ goal blocks — it must be done before that phase graduates and focus moves on:
 * - no anchors (attached or disconnected): its own phase.
 * - its own (natal) phase is one of its anchors' phases: its own phase. A higher-priority 4★ whose
 *   window is open right here holds focus here rather than being abandoned for a lower-priority
 *   goal; a featured win landing while she holds the phase open rolls over onto a linked
 *   partner's still-open slot (exactEngine.ts's `effectivePhaseGoals`).
 * - otherwise: the later of its own phase and its latest anchor's. Anchored to a later phase, it
 *   must not hold up its textual one (`[Odette, Alyosha(→Miko), Miko]` would never let Miko be
 *   won); anchored to an earlier phase, its own trailing phase (`[Odette, Weapon,
 *   Alyosha(→Odette)]`) exists only to chase it.
 * A 4★ blocking a phase other than its natal one doesn't hold up its natal phase; exactEngine.ts's
 * side-track mechanism resolves its own series entry. History: CHANGELOG.md.
 */
function resolveFourStarBlockingPhase(goal: Goal, phaseIndexByGoalId: Map<string, number>): number | undefined {
  const anchors = goal.anchoredFiveStarGoalIds;
  const ownPhase = phaseIndexByGoalId.get(goal.id);
  if (!anchors || anchors.length === 0) return ownPhase;
  const anchorPhases = anchors.map((a) => phaseIndexByGoalId.get(a)).filter((x): x is number => x !== undefined);
  if (anchorPhases.length === 0) return ownPhase; // dangling anchor(s) — goalValidation.ts should have flagged this
  if (ownPhase === undefined) return Math.max(...anchorPhases);
  if (anchorPhases.includes(ownPhase)) return ownPhase;
  return Math.max(ownPhase, ...anchorPhases);
}

/** Every 4★ goal's blocking phase (resolveFourStarBlockingPhase), resolved once. */
export function computeFourStarBlockingPhaseByGoalId(phases: Phase[], fourStarGoals: Goal[]): Map<string, number | undefined> {
  const phaseIndexByGoalId = buildPhaseIndexByGoalId(phases);
  const result = new Map<string, number | undefined>();
  for (const goal of fourStarGoals) {
    if (goal.kind !== '4star_character' && goal.kind !== '4star_weapon') continue;
    result.set(goal.id, resolveFourStarBlockingPhase(goal, phaseIndexByGoalId));
  }
  return result;
}

/**
 * The 4★ goals whose blocking phase is `p` — what gates phase `p`'s graduation in both engines,
 * alongside `p`'s own 5★ goals, instead of raw `Phase.goals` membership.
 */
export function computeBlockingFourStarGoalIdsForPhase(p: number, fourStarGoals: Goal[], blockingPhaseByGoalId: Map<string, number | undefined>): Set<string> {
  const blocking = new Set<string>();
  for (const goal of fourStarGoals) {
    if (blockingPhaseByGoalId.get(goal.id) === p) blocking.add(goal.id);
  }
  return blocking;
}

/**
 * The 4★ goals (from a list spanning the whole banner) whose copies can't accrue during phase `p`
 * because they aren't on its rate-up roster:
 * - anchored: `p` is outside [earliest anchor's phase, latest anchor's phase] — before it, none of
 *   its banners have started; after it, they've all ended (a phase can't graduate without its own
 *   5★s). Exception: its own natal phase is never closed, even after every anchor —
 *   `[Odette, Homa, Alyosha(→Odette)]`'s last phase exists only to chase her.
 * - disconnected: open only in its own isolated phase.
 * - unanchored with one candidate window: open everywhere.
 * Focus within `p` is handled live instead (goalTracking.ts's isFourStarWindowOpenInPhase). This is
 * also the single source for each phase's 4★ pool (compute*BannerConfigForPhase below).
 */
export function computeClosedFourStarGoalIdsForPhase(phases: Phase[], p: number, persistentFourStarGoals: Goal[]): Set<string> {
  const { phaseIndexByGoalId, disconnectedIds } = lookupsFor(phases);

  const closed = new Set<string>();
  for (const goal of persistentFourStarGoals) {
    if (goal.kind !== '4star_character' && goal.kind !== '4star_weapon') continue;
    const anchors = goal.anchoredFiveStarGoalIds;
    if (!anchors || anchors.length === 0) {
      // Disconnected: open only in its own phase. Unambiguously attached: open everywhere.
      if (disconnectedIds.has(goal.id)) {
        if (phaseIndexByGoalId.get(goal.id) !== p) closed.add(goal.id);
      }
      continue;
    }
    const anchorPhases = anchors.map((a) => phaseIndexByGoalId.get(a)).filter((x): x is number => x !== undefined);
    if (anchorPhases.length === 0) continue; // no valid anchors resolved — leave open, goalValidation.ts should have already flagged this
    const minAnchorPhase = Math.min(...anchorPhases);
    const maxAnchorPhase = Math.max(...anchorPhases);
    if (p < minAnchorPhase) {
      closed.add(goal.id);
      continue;
    }
    if (p > maxAnchorPhase && phaseIndexByGoalId.get(goal.id) !== p) closed.add(goal.id);
  }
  return closed;
}

/**
 * For character phase `p` holding exactly one 5★ character goal that's linked to a goal in a
 * DIFFERENT phase (a simultaneous pair split apart in priority order by a detour), that other
 * phase's index; otherwise undefined. The pair is one real window, so a featured win landing while
 * the first phase is held open (past its own 5★, for a same-window 4★) must be able to claim the
 * second phase's slot. Weapon links never need this: a weapon pull's identity is observable, so
 * no FIFO is involved.
 */
export function computeCharacterWindowPartnerPhase(phases: Phase[], p: number): number | undefined {
  const own = phases[p].goals.filter((g) => g.kind === '5star_character');
  if (own.length !== 1) return undefined;
  const link = own[0].linkedCharacterGoalId;
  if (!link) return undefined;
  for (let q = 0; q < phases.length; q++) {
    if (q === p) continue;
    if (phases[q].goals.some((g) => g.id === link)) return q;
  }
  return undefined;
}

/**
 * Phase `p`'s goals plus its window partner's (computeCharacterWindowPartnerPhase), in original
 * priority order — the same list for both phases of a pair, so both build identical
 * `PhaseLocalSpec` shapes and the FIFO code can carry across. Returns `phases[p].goals` itself
 * (same reference) when there's no partner.
 */
export function computeCharacterWindowGoalsForPhase(phases: Phase[], p: number): Goal[] {
  const partner = computeCharacterWindowPartnerPhase(phases, p);
  if (partner === undefined) return phases[p].goals;
  const ids = new Set([...phases[p].goals, ...phases[partner].goals].map((g) => g.id));
  return lookupsFor(phases).goals.filter((g) => ids.has(g.id));
}

/**
 * The 5★ weapon goals on phase `p`'s real weapon banner: its own (0-2), plus a linked partner living
 * in another phase (split apart by a character detour). `own[0]` comes first — the phase's own
 * goal is always the "chosen" Epitomized Path target.
 */
function computeWeaponWindowGoalsForPhase(phases: Phase[], p: number): Goal[] {
  const own = phases[p].goals.filter((g) => g.kind === '5star_weapon');
  const result = [...own];
  for (const g of own) {
    if (g.linkedWeaponGoalId) {
      const partner = lookupsFor(phases).goals.find((x) => x.id === g.linkedWeaponGoalId);
      if (partner && !result.some((r) => r.id === partner.id)) result.push(partner);
    }
  }
  return result;
}

/**
 * Whether Fate Points reset to 0 on entering weapon phase `p`: Epitomized Path is a per-phase
 * selection, so a new weapon banner starts fresh. Not reset on the weapon banner's first use (the
 * input state stands), when `p` has no 5★ weapon goal (a disconnected 4★ weapon's isolated phase
 * selects nothing), or when `p`'s weapon goal is linked (the same banner continuing after a
 * detour). `guaranteed5` always carries over. Shared by both engines so the rule can't drift.
 */
export function isWeaponFatePointsResetOnEntry(phases: Phase[], p: number): boolean {
  const phase = phases[p];
  if (phase.banner !== 'weapon') return false;
  if (!phases.slice(0, p).some((earlier) => earlier.banner === 'weapon')) return false; // first use — nothing to reset
  const ownWeaponGoal = phase.goals.find((g) => g.kind === '5star_weapon');
  if (!ownWeaponGoal) return false; // no weapon goal here at all — nothing to (re)select
  return !ownWeaponGoal.linkedWeaponGoalId;
}

/**
 * The 5★ weapon target ids that can't be obtained in phase `p` because they aren't on its weapon
 * banner (computeWeaponWindowGoalsForPhase) — each phase runs its own weapon banner.
 */
export function computeClosedFiveStarWeaponTargetIdsForPhase(phases: Phase[], p: number, allFiveStarWeaponGoals: Goal[]): Set<string> {
  const windowGoalIds = new Set(computeWeaponWindowGoalsForPhase(phases, p).map((g) => g.id));
  const closed = new Set<string>();
  for (const goal of allFiveStarWeaponGoals) {
    if (goal.kind !== '5star_weapon') continue;
    if (!windowGoalIds.has(goal.id)) closed.add(goal.targetId);
  }
  return closed;
}

/**
 * Pads real ids up to `minCount` with placeholder ids for "some other rate-up item you don't care
 * about", so a named item's share of the pool stays right when some slots are unnamed.
 * Placeholders needn't be unique across phases: each runPhaseDp call has its own config.
 */
export function padIds(realIds: string[], minCount: number, placeholderPrefix: string): string[] {
  const total = Math.max(minCount, realIds.length);
  const ids = [...realIds];
  for (let i = realIds.length; i < total; i++) ids.push(`${placeholderPrefix}-${i}`);
  return ids;
}

/**
 * Phase `p`'s character banner config: its 4★ pool is exactly the 4★ goals open in `p`
 * (computeClosedFourStarGoalIdsForPhase), padded to the real roster size of 3. Per phase, so naming
 * 4★s across several phases never dilutes one phase's pool.
 */
export function computeCharacterBannerConfigForPhase(
  phases: Phase[],
  p: number,
  allCharacterFourStarGoals: Goal[],
  featured5StarId: string,
): CharacterBannerConfig {
  const closed = computeClosedFourStarGoalIdsForPhase(phases, p, allCharacterFourStarGoals);
  const openIds = allCharacterFourStarGoals.filter((g) => !closed.has(g.id)).map((g) => g.targetId);
  return { featured5StarId, featured4StarIds: padIds(openIds, 3, 'other-4star-char') };
}

/**
 * Phase `p`'s weapon banner config: chosen / other-featured are the phase's weapon window goals in
 * order (computeWeaponWindowGoalsForPhase; placeholders when absent), and the 4★ pool is the open
 * 4★ weapon goals padded to 5. Per phase, so each phase's own weapon gets the Fate Point guarantee.
 */
export function computeWeaponBannerConfigForPhase(phases: Phase[], p: number, allWeaponFourStarGoals: Goal[]): WeaponBannerConfig {
  const windowGoals = computeWeaponWindowGoalsForPhase(phases, p);
  const chosenWeaponId = windowGoals[0]?.targetId ?? 'chosen-weapon';
  const otherFeaturedWeaponId = windowGoals[1]?.targetId ?? 'other-featured-weapon';
  const closed = computeClosedFourStarGoalIdsForPhase(phases, p, allWeaponFourStarGoals);
  const openIds = allWeaponFourStarGoals.filter((g) => !closed.has(g.id)).map((g) => g.targetId);
  return { chosenWeaponId, otherFeaturedWeaponId, featured4WeaponIds: padIds(openIds, 5, 'other-4star-weapon') };
}

/**
 * The Epitomized Path retarget: once the first weapon of a two-weapon window is obtained, a
 * rational player switches their selection to the second, so a Fate Point then guarantees it.
 * computeWeaponBannerConfigForPhase's config with chosen/other swapped, or undefined when the
 * window doesn't hold exactly 2 weapons. phaseDp.ts picks between the two configs per slice.
 */
export function computeWeaponBannerConfigAfterFirstClaimedForPhase(
  phases: Phase[],
  p: number,
  allWeaponFourStarGoals: Goal[],
): WeaponBannerConfig | undefined {
  if (computeWeaponWindowGoalsForPhase(phases, p).length !== 2) return undefined;
  const base = computeWeaponBannerConfigForPhase(phases, p, allWeaponFourStarGoals);
  return { ...base, chosenWeaponId: base.otherFeaturedWeaponId, otherFeaturedWeaponId: base.chosenWeaponId };
}
