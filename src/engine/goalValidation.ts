import { buildPhaseIndexByGoalId, buildPhases, computeClosedFourStarGoalIdsForPhase, computeDisconnectedFourStarGoalIds, findFlankingLinkedPair } from './phases';
import type { BannerKind, Goal, GoalKind } from './types';

export interface GoalValidationError {
  goalId: string;
  message: string;
}

interface AnchorRules {
  fourStarKind: GoalKind;
  fiveStarKind: GoalKind;
  maxAnchors: number;
  /** Real per-phase roster size — 3 character, 5 weapon. See maxActivePerPhase's doc comment. */
  maxActivePerPhase: number;
  /** Bounds PersistentSpec's DP state-space cost — see maxTotalGoals' doc comment. */
  maxTotalGoals: number;
  /** Bounds how many 4-stars can be disconnected AT ONCE — see
   * MAX_DISCONNECTED_FOUR_STAR_GOALS_PER_BANNER's doc comment. */
  maxDisconnectedGoals: number;
  fourStarLabel: string;
  fiveStarLabel: string;
  bannerLabel: string;
}

const CHARACTER_RULES: AnchorRules = {
  fourStarKind: '4star_character',
  fiveStarKind: '5star_character',
  maxAnchors: 2,
  maxActivePerPhase: 3,
  maxTotalGoals: 3,
  maxDisconnectedGoals: 2,
  fourStarLabel: '4★ character',
  fiveStarLabel: '5★ character',
  bannerLabel: 'character banner(s) (only 2 run per phase)',
};

const WEAPON_RULES: AnchorRules = {
  fourStarKind: '4star_weapon',
  fiveStarKind: '5star_weapon',
  maxAnchors: 1,
  maxActivePerPhase: 5,
  maxTotalGoals: 4,
  maxDisconnectedGoals: 3,
  fourStarLabel: '4★ weapon',
  fiveStarLabel: '5★ weapon',
  bannerLabel: 'weapon banner (only 1 runs per phase)',
};

/**
 * Validates the anchoring rules for 4star_character/4star_weapon goals (see the
 * anchoredFiveStarGoalIds doc comment on Goal in types.ts, and the closing/blocking
 * logic in phases.ts's computeClosedFourStarGoalIdsForPhase/
 * resolveFourStarBlockingPhase):
 * - Leaving a goal unanchored is ALWAYS valid (2026-08-19, "4★ anchoring is
 *   phase-derived" fix — no more "needs to specify" required-anchor error): it
 *   means "attached to the one unambiguous phase" when 0 or 1 same-kind 5-star
 *   exists anywhere, or a deliberate "disconnected from everything currently
 *   listed" choice (issue 1.5.5) once real ambiguity exists (2+ 5star_character
 *   goals anywhere, or 2+ DISTINCT weapon-banner phases).
 * - At most `maxAnchors` DISTINCT PHASES may be represented among the anchor ids
 *   — 2 for 4star_character (2 simultaneous character banners run per phase; a
 *   linked simultaneous pair counts as ONE phase, not two, so it can be combined
 *   with a second, separate phase), 1 for 4star_weapon (only 1 weapon banner runs
 *   per phase).
 * - Every anchor must reference an existing same-kind 5-star goal.
 * - No *other* same-kind 5-star goal may sit between an item and its anchor(s) in
 *   priority order (protects the min/max accrual-range computation's own
 *   correctness — an unrelated 5-star's phase landing inside that range would
 *   otherwise be wrongly treated as part of the item's real-world availability).
 * - At most `maxActivePerPhase` 4-star goals may be active (not closed) in any ONE
 *   phase — see MAX_ACTIVE_FOUR_STAR_GOALS_PER_PHASE's doc comment.
 * - At most `maxTotalGoals` 4-star goals total per banner, across the WHOLE goal
 *   list — see MAX_TOTAL_FOUR_STAR_GOALS_PER_BANNER's doc comment.
 */
export function validateGoals(goals: Goal[]): GoalValidationError[] {
  return [
    ...validateForRules(goals, CHARACTER_RULES),
    ...validateForRules(goals, WEAPON_RULES),
    ...validateWeaponLinks(goals),
    ...validateCharacterLinks(goals),
  ];
}

/**
 * Validates Goal.linkedWeaponGoalId (fifteenth reported bug, 2026-08-19) — see its
 * own doc comment in types.ts for the mechanic this expresses ("same real
 * weapon-banner window," decoupled from priority-list adjacency).
 */
function validateWeaponLinks(goals: Goal[]): GoalValidationError[] {
  const errors: GoalValidationError[] = [];
  const byId = new Map(goals.map((g) => [g.id, g]));

  for (const g of goals) {
    if (!g.linkedWeaponGoalId) continue;
    if (g.kind !== '5star_weapon') {
      errors.push({ goalId: g.id, message: `${g.name} has a weapon-banner window link set, but only 5★ weapon goals can be linked.` });
      continue;
    }
    if (g.linkedWeaponGoalId === g.id) {
      errors.push({ goalId: g.id, message: `${g.name} can't be linked to itself.` });
      continue;
    }
    const partner = byId.get(g.linkedWeaponGoalId);
    if (!partner) {
      errors.push({ goalId: g.id, message: `${g.name} is linked to a 5★ weapon goal that no longer exists in the list.` });
      continue;
    }
    if (partner.linkedWeaponGoalId !== g.id) {
      errors.push({
        goalId: g.id,
        message: `${g.name} is linked to ${partner.name}, but ${partner.name} isn't linked back to it — the link must go both ways.`,
      });
      continue;
    }
  }

  // Only consider fully-valid, mutual links from here on — a partner already
  // flagged above (self-link, missing, asymmetric) shouldn't cascade into a
  // second, confusing error from the checks below.
  const validLinkedGoals = goals.filter(
    (g) => g.kind === '5star_weapon' && g.linkedWeaponGoalId && byId.get(g.linkedWeaponGoalId)?.linkedWeaponGoalId === g.id,
  );
  if (validLinkedGoals.length === 0) return errors;

  const phases = buildPhases(goals);
  const phaseIndexByGoalId = buildPhaseIndexByGoalId(phases);

  for (const g of validLinkedGoals) {
    const ownPhase = phaseIndexByGoalId.get(g.id)!;
    // A linked goal's own natal phase must contain no OTHER 5star_weapon goal —
    // a real window has at most 2 weapons, and this one slot is already spoken
    // for by the cross-phase link. (Mostly redundant with the symmetry check
    // above given the single-field/one-directional-buildPhases-merge
    // interaction, but gives a much clearer message than an indirect asymmetry
    // rejection for a hand-authored 3-member case.)
    const siblingsInOwnPhase = phases[ownPhase].goals.filter((s) => s.kind === '5star_weapon' && s.id !== g.id && s.id !== g.linkedWeaponGoalId);
    if (siblingsInOwnPhase.length > 0) {
      errors.push({
        goalId: g.id,
        message: `${g.name}'s own phase already has another 5★ weapon goal (${siblingsInOwnPhase.map((s) => s.name).join(', ')}) besides its linked partner — a real weapon banner only ever features 2 event weapons.`,
      });
      continue;
    }

    const partner = byId.get(g.linkedWeaponGoalId!)!;
    const partnerPhase = phaseIndexByGoalId.get(partner.id)!;
    const minPhase = Math.min(ownPhase, partnerPhase);
    const maxPhase = Math.max(ownPhase, partnerPhase);
    // No intervening weapon-banner phase of ANY composition (not just a
    // conflicting 5star_weapon goal) between the pair's two natal phases — this
    // is what lets exactEngine.ts's/simulate.ts's Fate-Points-reset-skip-when-
    // linked fix trust that "the immediately-preceding same-banner phase" IS
    // this goal's linked partner's own phase, with no phase-identity
    // bookkeeping needed.
    const interveningWeaponPhase = phases.slice(minPhase + 1, maxPhase).some((ph) => ph.banner === 'weapon');
    if (interveningWeaponPhase) {
      errors.push({
        goalId: g.id,
        message: `${g.name} and ${partner.name} are linked as the same weapon-banner window, but another weapon-banner phase sits between them in priority order — that isn't possible if they're really one continuous window.`,
      });
    }
  }

  return errors;
}

/**
 * Validates Goal.linkedCharacterGoalId (sixteenth reported bug, 2026-08-19) — see
 * its own doc comment in types.ts for the mechanic ("simultaneous banners,"
 * distinct from linkedWeaponGoalId's "same banner"). Mirrors validateWeaponLinks'
 * structure, but the adjacency requirement is checked differently.
 *
 * UPDATE, 2026-08-19 (same day, found reviewing a real Odette/Raiden scenario
 * where their shared weapon banner's two goals were naturally interleaved
 * between them in priority order — i.e. the EXACT real-phase shape this whole
 * feature exists to model): the original version of this check required
 * `buildPhases` to have literally merged the pair into one Phase object, which
 * — because a Phase is always one contiguous SAME-BANNER run — made it
 * IMPOSSIBLE to link two character goals with any weapon-banner goal
 * prioritized between them, even though a weapon-banner pull doesn't touch
 * character pity/CR/guaranteed5 at all and so doesn't break simultaneity in
 * any way that matters. That was stricter than the real mechanic requires.
 * The check now walks priority-list POSITION directly instead of going
 * through buildPhases: a link is valid as long as no OTHER 5★ character goal
 * sits between the pair — a 4★ character goal in between is fine (that's
 * exactly what same-phase anchoring models), and so is a weapon-banner goal. `buildPhases` itself is unchanged and still never merges a linked pair
 * separated by a weapon-banner goal into one Phase object — it doesn't need
 * to, since (per linkedCharacterGoalId's own doc comment) character pity
 * carries over unconditionally between ANY two same-banner phases regardless
 * of Phase-object merging, so nothing computational depends on the merge.
 * This is a real behavior relaxation, not a new restriction.
 */
function validateCharacterLinks(goals: Goal[]): GoalValidationError[] {
  const errors: GoalValidationError[] = [];
  const byId = new Map(goals.map((g) => [g.id, g]));

  for (const g of goals) {
    if (!g.linkedCharacterGoalId) continue;
    if (g.kind !== '5star_character') {
      errors.push({ goalId: g.id, message: `${g.name} has a "simultaneous phase" link set, but only 5★ character goals can be linked this way.` });
      continue;
    }
    if (g.linkedCharacterGoalId === g.id) {
      errors.push({ goalId: g.id, message: `${g.name} can't be linked to itself.` });
      continue;
    }
    const partner = byId.get(g.linkedCharacterGoalId);
    if (!partner) {
      errors.push({ goalId: g.id, message: `${g.name} is linked to a 5★ character goal that no longer exists in the list.` });
      continue;
    }
    if (partner.linkedCharacterGoalId !== g.id) {
      errors.push({
        goalId: g.id,
        message: `${g.name} is linked to ${partner.name}, but ${partner.name} isn't linked back to it — the link must go both ways.`,
      });
      continue;
    }
  }

  const validLinkedGoals = goals.filter(
    (g) => g.kind === '5star_character' && g.linkedCharacterGoalId && byId.get(g.linkedCharacterGoalId)?.linkedCharacterGoalId === g.id,
  );
  if (validLinkedGoals.length === 0) return errors;

  for (const g of validLinkedGoals) {
    const partner = byId.get(g.linkedCharacterGoalId!)!;
    const gIdx = goals.indexOf(g);
    const partnerIdx = goals.indexOf(partner);
    const [lo, hi] = gIdx < partnerIdx ? [gIdx, partnerIdx] : [partnerIdx, gIdx];
    // Two genuinely simultaneous banners share one continuous real-world
    // window — another 5★ CHARACTER goal sitting between them would mean a
    // different character banner had priority in between, which isn't
    // possible for two real simultaneous banners. A 4★ character goal
    // between them is fine and expected — that's exactly what same-phase
    // anchoring models (e.g. case A: [Odette, Alyosha(anchored to both),
    // Miko]), not a separate window. A WEAPON-banner goal between them is
    // also fine (a real phase's one shared weapon banner runs fully
    // concurrently with both character banners — see CLAUDE.md's confirmed
    // real-phase structure), which is why this checks priority-list position
    // directly rather than requiring buildPhases to have merged them into one
    // literal Phase object.
    const anotherFiveStarCharBetween = goals.slice(lo + 1, hi).some((x) => x.kind === '5star_character');
    if (anotherFiveStarCharBetween) {
      errors.push({
        goalId: g.id,
        message: `${g.name} and ${partner.name} are linked as simultaneous, but another 5★ character goal sits between them in priority order — two simultaneous character banners must have no other 5★ character goal between them (a 4★ or weapon-banner goal in between is fine).`,
      });
    }
  }

  return errors;
}

/**
 * The real per-phase roster size — 3 named 4-star characters share one phase (see
 * types.ts's Goal.anchoredFiveStarGoalIds doc comment), 5 named 4-star weapons
 * share one weapon-banner phase. Enforced PER PHASE (a goal is "active" in phase
 * `p` when phases.ts's computeClosedFourStarGoalIdsForPhase does NOT close it
 * there — i.e. it's actually part of that phase's real-world rate-up pool), not
 * globally across the whole goal list: `phases.ts`'s
 * computeCharacterBannerConfigForPhase/computeWeaponBannerConfigForPhase build
 * each phase's own pool from exactly the goals active in that phase, so naming 4+
 * four-stars split across 2+ DIFFERENT phases (each individually still ≤3/≤5
 * active at once) is legitimate and matches the real game exactly — only a
 * genuine same-phase overlap beyond the real roster size is actually impossible.
 */
export const MAX_ACTIVE_FOUR_STAR_GOALS_PER_PHASE: Record<BannerKind, number> = { character: 3, weapon: 5 };

/**
 * Bounds `PersistentSpec`'s DP state-space cost — NOT a correctness requirement
 * (unlike the per-phase cap above, and unlike this constant's own PRIOR
 * incarnation as `MAX_FOUR_STAR_GOALS_PER_BANNER`, which used to be load-bearing
 * for correctness too: before banner configs were computed per phase,
 * `buildSimulationInput.ts`'s shared, GLOBAL rate-up pool would silently dilute
 * past 3/5 real names, so the cap had to stay at exactly the real roster size to
 * prevent that. Now that `phases.ts`'s computeCharacterBannerConfigForPhase/
 * computeWeaponBannerConfigForPhase build each phase's own pool independently,
 * dilution is structurally impossible regardless of how many phases' worth of
 * 4-stars are named — this cap exists ONLY to bound performance/memory).
 *
 * `runPhaseDp`'s exact-DP state space multiplies by (maxCopies+1) for every
 * 4-star goal tracked on a banner — 8x per character 4-star (C0-C6), 6x per
 * weapon 4-star (R1-R5) — since `PersistentSpec` carries ALL of a banner's 4-star
 * goals together in one joint tracking vector, for the whole goal list, not just
 * one phase (see goalTracking.ts's PersistentSpec doc comment for why that's
 * necessary for correctness — 4-stars accrue opportunistically across phases, so
 * their copy counts can't be scoped to a single phase the way the pool above can).
 *
 * MEASURED, not guessed (2026-08-18): this cost is far worse than a naive "8x/6x
 * per goal" reading suggests once a banner is reused across 2+ phases. A goal
 * whose value is FROZEN after its own phase graduates still rides along as a live
 * dimension in every later phase's persistent vector, and since that frozen value
 * varies across the whole distribution reaching the later phase (not a point
 * mass), the later phase's own reachable-state count multiplies by that variety —
 * on top of its own newly-varying goals, not instead of them. Directly profiled
 * via `runExactSimulation` at pullBudget=90 (this app's default): 2 character
 * 4-stars split 2-then-1 across two phases (3 total, matching the character
 * per-phase cap) took ~39s; adding a 4th (2+2 split) took **12s at pullBudget=20
 * alone** and did not complete within several minutes at pullBudget=90. Weapon
 * (gentler dim=6) tolerated a 2+2 split (4 total) at ~44s, pullBudget=90, but was
 * not tested beyond that. These numbers are already far past the ~4.5s this app's
 * dedicated performance work targets — they're not new costs this fix introduces
 * (a single phase's own N=3 cost, ~29s at pullBudget=90, already existed under the
 * OLD global-pool cap and was simply never directly measured before) — but they
 * set a hard ceiling on how far "spread your named 4-stars across phases" can go
 * before it stops being a usable feature. Character is capped at exactly its
 * per-phase cap (3) — i.e. this fix's real benefit for character is letting an
 * existing budget of 3 be freely DISTRIBUTED across phases, not increased. Weapon
 * gets one additional total slot (4, still under its own per-phase cap of 5) since
 * it was directly measured safe. Raising either further needs its own profiling
 * pass first — see CLAUDE.md — and likely needs a deeper fix (making
 * `PersistentSpec`'s dimensionality itself phase-scoped, not banner-wide) rather
 * than just a bigger constant, given how steep this cost curve is.
 */
export const MAX_TOTAL_FOUR_STAR_GOALS_PER_BANNER: Record<BannerKind, number> = { character: 3, weapon: 4 };

/**
 * Bounds how many 4-star goals can be DISCONNECTED (see
 * computeDisconnectedFourStarGoalIds in phases.ts) at once on one banner —
 * one less than MAX_TOTAL_FOUR_STAR_GOALS_PER_BANNER's own cap for that
 * banner, deliberately not the same number.
 *
 * A SEPARATE, narrower cap than the total-goals one, added the same day as
 * the twentieth-reported-bug follow-up that made a disconnected 4-star get
 * her own isolated phase (phases.ts's buildPhases) rather than sharing one
 * synthesized trailing phase. That fix's own performance investigation found
 * this cap is necessary REGARDLESS of pull budget, unlike
 * MAX_CONTINUATION_HORIZON_PULLS (exactEngine.ts), which only bounds cost
 * for LARGE budgets: each disconnected 4-star now runs as its own ordinary
 * phase, and since `PersistentSpec` is banner-wide (not phase-scoped), EVERY
 * such phase pays the FULL state-space cost for every tracked 4-star on that
 * banner, not just its own — compounding once per sequential isolated phase.
 * Directly measured (not guessed) at this app's own DEFAULT 90-pull budget:
 * character — 2 disconnected 4-stars: ~4.4s (fine); 3 (the total cap): ~25-45s
 * (unacceptable, and NOT helped by capping the horizon, since 90 pulls is
 * already below that cap's own 400-pull threshold). Weapon — 3 disconnected:
 * ~4.5s (fine); 4 (the total cap): ~25s (unacceptable). In both cases the
 * bad case is exactly "as many disconnected 4-stars as the total cap allows"
 * — this cap trims exactly one off that ceiling, so the worst reachable
 * shape stays in the "fine" range measured above. Raising this needs its own
 * profiling pass, and likely the same deeper architectural fix already
 * flagged elsewhere in this file (phase-scoped PersistentSpec) rather than a
 * bigger constant, for the same reason MAX_TOTAL_FOUR_STAR_GOALS_PER_BANNER
 * itself can't simply be raised.
 */
export const MAX_DISCONNECTED_FOUR_STAR_GOALS_PER_BANNER: Record<BannerKind, number> = { character: 2, weapon: 3 };

function validateForRules(goals: Goal[], rules: AnchorRules): GoalValidationError[] {
  const errors: GoalValidationError[] = [];
  const fiveStarGoals = goals.filter((g) => g.kind === rules.fiveStarKind);
  const fourStarGoals = goals.filter((g) => g.kind === rules.fourStarKind);
  const bannerKind: BannerKind = rules.fourStarKind === '4star_character' ? 'character' : 'weapon';

  // Tracks goals already flagged by the total-cap check below, so the per-phase
  // overlap check (further down) doesn't double-flag the same goal with a second,
  // redundant message — this can genuinely happen for character, where the total
  // cap and the per-phase cap are numerically equal (3), so a goal that's the Nth
  // active-in-one-phase excess is *always* also the Nth total excess whenever
  // every tracked goal happens to share that one phase.
  const flaggedByTotalCap = new Set<string>();
  if (fourStarGoals.length > rules.maxTotalGoals) {
    for (const f of fourStarGoals.slice(rules.maxTotalGoals)) {
      flaggedByTotalCap.add(f.id);
      errors.push({
        goalId: f.id,
        message: `Too many ${rules.fourStarLabel} goals overall — at most ${rules.maxTotalGoals} are supported across your whole priority list (keeps the calculation fast and memory-bounded). Remove this one or drop your total count.`,
      });
    }
  }

  // Disconnected-count cap — see MAX_DISCONNECTED_FOUR_STAR_GOALS_PER_BANNER's
  // own doc comment for why this is separate from, and narrower than, the
  // total-goals cap above.
  const disconnectedIds = computeDisconnectedFourStarGoalIds(goals);
  const disconnectedFourStarGoals = fourStarGoals.filter((f) => disconnectedIds.has(f.id));
  if (disconnectedFourStarGoals.length > rules.maxDisconnectedGoals) {
    for (const f of disconnectedFourStarGoals.slice(rules.maxDisconnectedGoals)) {
      if (flaggedByTotalCap.has(f.id)) continue;
      errors.push({
        goalId: f.id,
        message: `Too many disconnected ${rules.fourStarLabel} goals at once — at most ${rules.maxDisconnectedGoals} can be unanchored/disconnected on this banner at the same time (each gets its own real phase, which gets expensive to compute past this many). Anchor this one to a specific ${rules.fiveStarLabel} goal, or remove it.`,
      });
    }
  }

  const positionOf = new Map<string, number>();
  goals.forEach((g, i) => positionOf.set(g.id, i));
  const phases = buildPhases(goals);
  const phaseIndexByGoalId = buildPhaseIndexByGoalId(phases);

  // Tracks goals handled by the flanking-pair check below, so the SEPARATE
  // "same-phase anchors must cover every 5-star" loop further down doesn't
  // double-flag the same goal with a second, redundant error — both checks
  // can fire on the exact same shape (a 4-star flanked by, and anchored to
  // only one side of, a linked pair), and the flanking check's message is
  // the more specific/accurate one to surface.
  const flaggedByFlankingCheck = new Set<string>();

  for (const f of fourStarGoals) {
    const anchors = f.anchoredFiveStarGoalIds ?? [];

    // A 4-star flanked by two mutually-linked (simultaneous) 5-stars has no
    // valid alternative — see findFlankingLinkedPair's own doc comment (if
    // the flanking pair runs at the same real-world time, there's no time
    // gap between them for disconnection, or a partial anchor covering only
    // one side, to occupy). Checked BEFORE the "blank is always valid"
    // fallback below, since that fallback does not apply here.
    const flankingPair = findFlankingLinkedPair(goals, f.id);
    if (flankingPair) {
      flaggedByFlankingCheck.add(f.id);
      const [before, after] = flankingPair;
      if (!anchors.includes(before) || !anchors.includes(after)) {
        const beforeName = goals.find((g) => g.id === before)?.name ?? before;
        const afterName = goals.find((g) => g.id === after)?.name ?? after;
        errors.push({
          goalId: f.id,
          message: `${f.name} sits between ${beforeName} and ${afterName}, which are simultaneous — there's no real-world time gap between them, so ${f.name} must be anchored to both, not disconnected or anchored to just one.`,
        });
      }
      continue;
    }

    // Blank is ALWAYS valid now (2026-08-19, "4★ anchoring is phase-derived"
    // fix) — no more "needs to specify" required-anchor error. It means either
    // "attached to the one unambiguous phase" (0 or 1 same-kind 5-star exists
    // anywhere) or a deliberate "disconnected from everything currently
    // listed" choice (issue 1.5.5) once real ambiguity exists — see
    // phases.ts's resolveFourStarBlockingPhase/hasFourStarAnchorAmbiguity.
    if (anchors.length === 0) continue;

    const missingAnchor = anchors.find((a) => !fiveStarGoals.some((g) => g.id === a));
    if (missingAnchor) {
      errors.push({ goalId: f.id, message: `${f.name} is anchored to a ${rules.fiveStarLabel} goal that no longer exists in the list.` });
      continue;
    }

    // maxAnchors now counts DISTINCT PHASES represented among the anchor ids,
    // not raw id count — a linked simultaneous pair (2 ids, 1 phase) no longer
    // silently exhausts the whole budget, so it can be combined with a SECOND,
    // separate phase (e.g. anchor to [Odette+Raiden] AND [Miko]) — matching
    // "keep spanning multiple phases" (D2's own capability) generalized to
    // include a same-phase-linked group as one of the spanned phases.
    const anchorPhaseCount = new Set(anchors.map((a) => phaseIndexByGoalId.get(a)!)).size;
    if (anchorPhaseCount > rules.maxAnchors) {
      errors.push({ goalId: f.id, message: `${f.name} can be anchored to at most ${rules.maxAnchors} phase(s) — ${rules.bannerLabel}.` });
      continue;
    }

    const spanPositions = [positionOf.get(f.id)!, ...anchors.map((a) => positionOf.get(a)!)];
    const minPos = Math.min(...spanPositions);
    const maxPos = Math.max(...spanPositions);
    const anchorSet = new Set(anchors);
    const between = fiveStarGoals.find((g) => {
      const pos = positionOf.get(g.id)!;
      return pos > minPos && pos < maxPos && !anchorSet.has(g.id);
    });
    if (between) {
      errors.push({
        goalId: f.id,
        message: `${f.name}'s anchors aren't adjacent — ${between.name} sits between them in priority order, which isn't possible if they're really the same phase pairing.`,
      });
      continue;
    }
    // NOTE: the old "item's own phase must not come strictly before every
    // anchor's phase" rejection is GONE (2026-08-19) — obsoleted by
    // construction, not just relaxed: phases.ts's resolveFourStarBlockingPhase
    // now resolves a 4★'s BLOCKING phase as MAX(its own textual phase, its
    // latest anchor's phase), so this configuration can no longer be
    // structurally broken (it just means the item doesn't block its own
    // earlier textual phase, correctly deferring to its anchor's phase
    // instead) — see that function's own doc comment for the full story
    // (this was the actual root cause of the "Miko can never be won" bug).
  }

  // Character only: a 4-star anchored to ANY 5-star sharing a given phase must be
  // anchored to EVERY 5-star sharing that same phase, not just some of them. Real
  // simultaneous same-phase character banners always feature the IDENTICAL 3-slot
  // 4-star roster (see types.ts's Goal.anchoredFiveStarGoalIds doc comment and its
  // cited Genshin 4.5 patch example) — there's no such thing as "rate-up on this
  // phase's first banner but not its second," so a partial anchor set here doesn't
  // correspond to any real configuration. Found 2026-08-18 reviewing trace output
  // for "does this make sense to an actual player": before this check, the engine
  // would silently compute a real (if not obviously wrong) number for an input that
  // can't actually happen in the game — see CLAUDE.md.
  //
  // Weapon has no equivalent: maxAnchors=1 there already means a weapon 4-star can
  // only ever reference ONE of a phase's (at most 2) 5star_weapon goals, and that's
  // fine, because unlike character, only ONE weapon banner ever runs per phase (the
  // two 5star_weapon goals are the chosen/other-featured split of that SAME banner,
  // not two different banners) — closedGoalIds' phase-level (not per-goal) closing
  // already captures the real window correctly regardless of which of the two the
  // anchor names.
  if (rules.fourStarKind === '4star_character') {
    // At most 2 simultaneous character banners can ever share one phase — this used
    // to be enforced by an explicit ">2 same-phase 5-stars" check here, but since the
    // sixteenth reported bug (explicit linkedCharacterGoalId, one partner per goal,
    // required for two 5-stars to share a Phase at all), buildPhases structurally
    // cannot produce 3+ same-phase 5-stars through any input — the check's own error
    // could never fire, so it was removed rather than left as unreachable dead code.
    // This cap is what keeps the "anchor must cover every same-phase 5-star" rule
    // below always satisfiable within maxAnchors (2).

    for (const f of fourStarGoals) {
      if (flaggedByFlankingCheck.has(f.id)) continue;
      const anchors = f.anchoredFiveStarGoalIds;
      if (!anchors || anchors.length === 0) continue;
      const anchorSet = new Set(anchors);
      const touchedPhases = new Set(anchors.map((a) => phaseIndexByGoalId.get(a)).filter((p): p is number => p !== undefined));
      for (const p of touchedPhases) {
        const fiveStarsInPhase = fiveStarGoals.filter((g) => phaseIndexByGoalId.get(g.id) === p);
        const missing = fiveStarsInPhase.filter((g) => !anchorSet.has(g.id));
        if (missing.length > 0) {
          errors.push({
            goalId: f.id,
            message: `${f.name} is anchored to only some of the ${rules.fiveStarLabel} goals sharing this phase (missing ${missing.map((g) => g.name).join(', ')}) — simultaneous same-phase banners always share the identical 4-star roster, so it must be anchored to all of them, not just some.`,
          });
        }
      }
    }
  }

  // Per-phase overlap cap: at most maxActivePerPhase named 4-star goals may be
  // ACTIVE (not closed — i.e. genuinely part of that phase's real-world rate-up
  // pool) in any single phase, matching the real per-phase roster size. Computed
  // per phase because the same set of named goals can overlap in one phase and
  // not another, depending on how their anchors are set up.
  for (let p = 0; p < phases.length; p++) {
    if (phases[p].banner !== bannerKind) continue;
    const closed = computeClosedFourStarGoalIdsForPhase(phases, p, fourStarGoals);
    const openInPhase = fourStarGoals.filter((g) => !closed.has(g.id));
    if (openInPhase.length > rules.maxActivePerPhase) {
      for (const f of openInPhase.slice(rules.maxActivePerPhase)) {
        if (flaggedByTotalCap.has(f.id)) continue; // already flagged, no need to say it twice
        errors.push({
          goalId: f.id,
          message: `Too many ${rules.fourStarLabel} goals are active at once in one phase — a real phase only ever features ${rules.maxActivePerPhase} at a time. Anchor this one to a different phase's ${rules.fiveStarLabel} goal(s), or remove it.`,
        });
      }
    }
  }

  return errors;
}
