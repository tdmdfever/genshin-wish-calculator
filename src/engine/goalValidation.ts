import { buildPhaseIndexByGoalId, buildPhases, computeClosedFourStarGoalIdsForPhase, computeDisconnectedFourStarGoalIds, findFlankingLinkedPair } from './phases';
import type { BannerKind, Goal, GoalKind } from './types';
import { KIND_LABELS, MAX_ANCHOR_PHASES } from './goalKinds';

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
  maxAnchors: MAX_ANCHOR_PHASES['4star_character'],
  maxActivePerPhase: 3,
  maxTotalGoals: 3,
  maxDisconnectedGoals: 2,
  fourStarLabel: KIND_LABELS['4star_character'],
  fiveStarLabel: KIND_LABELS['5star_character'],
  bannerLabel: 'character banner(s) (only 2 run per phase)',
};

const WEAPON_RULES: AnchorRules = {
  fourStarKind: '4star_weapon',
  fiveStarKind: '5star_weapon',
  maxAnchors: MAX_ANCHOR_PHASES['4star_weapon'],
  maxActivePerPhase: 5,
  maxTotalGoals: 4,
  maxDisconnectedGoals: 3,
  fourStarLabel: KIND_LABELS['4star_weapon'],
  fiveStarLabel: KIND_LABELS['5star_weapon'],
  bannerLabel: 'weapon banner (only 1 runs per phase)',
};

/**
 * Rejects goal lists that don't match any real Genshin patch structure, or would make the DP too
 * expensive. For 4★ anchoring (Goal.anchoredFiveStarGoalIds):
 * - Leaving a 4★ unanchored is always valid — attached to the one candidate window, or
 *   disconnected when there are several (phases.ts's computeDisconnectedFourStarGoalIds) — except
 *   between two linked 5★s, where it must be anchored to both (findFlankingLinkedPair).
 * - Anchors must exist, span at most `maxAnchors` distinct phases (a linked pair counts once), have
 *   no other same-kind 5★ between the item and them, and (character) cover every 5★ of a phase
 *   they touch.
 * - Per-phase active and banner-wide total 4★ caps (see the constants below).
 * Plus the 5★ link rules (validateWeaponLinks, validateCharacterLinks).
 */
export function validateGoals(goals: Goal[]): GoalValidationError[] {
  return [
    ...validateForRules(goals, CHARACTER_RULES),
    ...validateForRules(goals, WEAPON_RULES),
    ...validateWeaponLinks(goals),
    ...validateCharacterLinks(goals),
  ];
}

/** Validates Goal.linkedWeaponGoalId: 5★ weapons only, not self, partner exists and links back; the
 * natal phase has no third weapon; no other weapon-banner phase sits between the pair. */
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
    // A real weapon banner features 2 event weapons, and this goal's second slot is its link.
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
    // No other weapon-banner phase between the pair: that's what lets the Fate Point reset be skipped
    // for a linked phase without tracking which phase a carried Fate Point came from.
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
 * Validates Goal.linkedCharacterGoalId: 5★ characters only, not self, partner exists and links back,
 * and no other 5★ character goal between the pair in priority order. Checked by list position, not
 * Phase membership: 4★ or weapon-banner goals may sit between them (a phase's weapon banner runs
 * concurrently), which leaves the pair as two Phase objects that still share one window.
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
    // Two simultaneous banners share one continuous window, so a different character banner can't
    // have priority in between.
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
 * The real per-phase roster size — 3 rate-up 4★ characters, 5 rate-up 4★ weapons. Enforced per
 * phase (a goal is active in `p` when computeClosedFourStarGoalIdsForPhase doesn't close it there),
 * since each phase builds its own pool: 4+ named 4★s spread across different phases is fine.
 * A correctness cap — don't move it for performance reasons.
 */
export const MAX_ACTIVE_FOUR_STAR_GOALS_PER_PHASE: Record<BannerKind, number> = { character: 3, weapon: 5 };

/**
 * Bounds PersistentSpec's DP state space — a performance cap, not a correctness one (pools are per
 * phase, so there's no dilution). Each 4★ goal multiplies the state space by 8 (character, C0-C6)
 * or 6 (weapon, R1-R5), and it compounds once a banner is reused across phases: a goal frozen after
 * its own phase still varies across the distribution entering later phases, so it rides along as a
 * live dimension there too.
 *
 * Measured at pullBudget=90: 2+1 character 4★s across two phases ~39s; 2+2 took 12s at
 * pullBudget=20 and didn't finish in minutes at 90. Weapon (6x) handled 2+2 at ~44s. Raising either
 * needs a profiling pass and probably phase-scoped PersistentSpec dims rather than a bigger
 * constant (ARCHITECTURE.md, "Known limitations").
 */
export const MAX_TOTAL_FOUR_STAR_GOALS_PER_BANNER: Record<BannerKind, number> = { character: 3, weapon: 4 };

/**
 * How many 4★ goals can be disconnected at once per banner — one fewer than the total cap. Each
 * disconnected 4★ runs its own phase at full banner-wide state-space cost, so this compounds per
 * isolated phase regardless of pull budget. Measured at pullBudget=90: character — 2 disconnected
 * ~4.4s, 3 ~25-45s; weapon — 3 ~4.5s, 4 ~25s. Same caveats as MAX_TOTAL_FOUR_STAR_GOALS_PER_BANNER.
 */
export const MAX_DISCONNECTED_FOUR_STAR_GOALS_PER_BANNER: Record<BannerKind, number> = { character: 2, weapon: 3 };

function validateForRules(goals: Goal[], rules: AnchorRules): GoalValidationError[] {
  const errors: GoalValidationError[] = [];
  const fiveStarGoals = goals.filter((g) => g.kind === rules.fiveStarKind);
  const fourStarGoals = goals.filter((g) => g.kind === rules.fourStarKind);
  const bannerKind: BannerKind = rules.fourStarKind === '4star_character' ? 'character' : 'weapon';

  // Goals already flagged by the total cap, so the per-phase check below doesn't flag them again
  // (the two caps are equal for character).
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

  // Goals handled by the flanking-pair check, so the "cover every 5★ of the phase" check below
  // doesn't flag them again with a less specific message.
  const flaggedByFlankingCheck = new Set<string>();

  for (const f of fourStarGoals) {
    const anchors = f.anchoredFiveStarGoalIds ?? [];

    // Between two linked 5★s there's no valid alternative to anchoring to both (findFlankingLinkedPair).
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

    // Unanchored is always valid: attached to the one candidate, or disconnected.
    if (anchors.length === 0) continue;

    const missingAnchor = anchors.find((a) => !fiveStarGoals.some((g) => g.id === a));
    if (missingAnchor) {
      errors.push({ goalId: f.id, message: `${f.name} is anchored to a ${rules.fiveStarLabel} goal that no longer exists in the list.` });
      continue;
    }

    // Counted in distinct phases, so a linked pair (2 ids, 1 phase) can be combined with a second phase.
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
    // An item listed before all of its anchors is fine: it blocks its anchor's phase instead of its
    // own (phases.ts's resolveFourStarBlockingPhase).
  }

  // Character only: anchored to one 5★ of a phase means anchored to all of them — simultaneous
  // banners share the identical 4★ roster, so a partial set matches nothing in the game. Weapon has
  // no equivalent: one weapon banner per phase, and closing is per phase, so either of its two
  // 5★ weapons identifies it.
  if (rules.fourStarKind === '4star_character') {
    // A phase holds at most 2 character 5★s (one link partner each), so this is always satisfiable
    // within maxAnchors (2).

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

  // Per-phase roster cap (MAX_ACTIVE_FOUR_STAR_GOALS_PER_PHASE).
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
