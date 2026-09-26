import type { BannerKind, Goal, PullOutcome } from './types';
import { copiesNeeded } from './goalKinds';

/** Max total copies trackable: character C0-C6 = 7 copies, weapon R1-R5 = 5 copies. */
export const MAX_CHARACTER_COPIES = 7;
export const MAX_WEAPON_COPIES = 5;

/**
 * Resets every phase (except across a linked character window split by a detour — see
 * exactEngine.ts's effectivePhaseGoals): the shared FIFO counter (0..count) for this phase's own
 * 5star_character goals. Character matching is identity-agnostic (simulate.ts's
 * goalMatchesOutcome), so a second 5star_character goal is a separate, later win, and the
 * earliest pending one claims the next featured win.
 */
export interface PhaseLocalSpec {
  fiveStarCharGoalIds: string[]; // priority order within the phase
  fourStarCharGoalIdsInPhase: ReadonlySet<string>; // 4star_character goals that are members of THIS phase
  dims: number[]; // [] if this phase has no 5star_character goal, else [count + 1]
}

export function buildPhaseLocalSpec(phaseGoals: Goal[]): PhaseLocalSpec {
  const fiveStarCharGoalIds = phaseGoals.filter((g) => g.kind === '5star_character').map((g) => g.id);
  const fourStarCharGoalIdsInPhase = new Set(phaseGoals.filter((g) => g.kind === '4star_character').map((g) => g.id));
  return {
    fiveStarCharGoalIds,
    fourStarCharGoalIdsInPhase,
    dims: fiveStarCharGoalIds.length > 0 ? [fiveStarCharGoalIds.length + 1] : [],
  };
}

/**
 * Carries across EVERY phase that reuses this banner (seeded from the previous
 * same-banner phase's exit distribution — see exactEngine.ts), because everything
 * tracked here can be opportunistically obtained on ANY pull of this banner at ANY
 * point in the simulation, regardless of which phase a goal's own priority slot
 * happens to land in: multiple 4-star rate-ups (and, on the weapon banner, both
 * featured 5-stars) genuinely coexist, so a goal doesn't have to "wait its turn" in
 * priority order before it can start accruing — e.g. a 4-star goal listed AFTER a
 * weapon-banner detour can still pick up copies during the character-banner pulls
 * that happened BEFORE that detour.
 *
 * Built ONCE per banner from the WHOLE goal list (not just one phase's goals), so
 * the dimension layout — and therefore any vector encoded against it — stays valid
 * no matter which phase of this banner it's read back in.
 */
export interface PersistentSpec {
  banner: BannerKind;
  fiveStarWeaponTargetIds: string[]; // weapon banner only
  fourStarGoals: { goal: Goal; maxCopies: number }[];
  dims: number[];
  // targetId -> index lookups, precomputed so the hot path (once per matching outcome, per
  // active slice, per pull) doesn't scan.
  fiveStarWeaponIndexByTargetId: ReadonlyMap<string, number>;
  fourStarIndexByTargetId: ReadonlyMap<string, number>;
}

export function buildPersistentSpec(banner: BannerKind, allGoals: Goal[]): PersistentSpec {
  const fiveStarWeaponTargetIds =
    banner === 'weapon' ? [...new Set(allGoals.filter((g) => g.kind === '5star_weapon').map((g) => g.targetId))] : [];
  const fourStarKind = banner === 'character' ? '4star_character' : '4star_weapon';
  const maxCopies = banner === 'character' ? MAX_CHARACTER_COPIES : MAX_WEAPON_COPIES;
  const fourStarGoals = allGoals.filter((g) => g.kind === fourStarKind).map((goal) => ({ goal, maxCopies }));

  const dims: number[] = [];
  for (const _ of fiveStarWeaponTargetIds) dims.push(2);
  for (const fg of fourStarGoals) dims.push(fg.maxCopies + 1);

  const fiveStarWeaponIndexByTargetId = new Map(fiveStarWeaponTargetIds.map((id, i) => [id, i]));
  const base = fiveStarWeaponTargetIds.length;
  const fourStarIndexByTargetId = new Map(fourStarGoals.map((fg, i) => [fg.goal.targetId, base + i]));

  return { banner, fiveStarWeaponTargetIds, fourStarGoals, dims, fiveStarWeaponIndexByTargetId, fourStarIndexByTargetId };
}

export function zeroVector(dims: number[]): number[] {
  return dims.map(() => 0);
}

/** Encodes a vector into a single non-negative integer (mixed-radix), generic over any dims array. */
export function encodeVector(dims: number[], vector: number[]): number {
  let code = 0;
  for (let i = 0; i < dims.length; i++) code = code * dims[i] + vector[i];
  return code;
}

export function decodeVector(dims: number[], codeIn: number): number[] {
  const vector = new Array(dims.length).fill(0);
  let code = codeIn;
  for (let i = dims.length - 1; i >= 0; i--) {
    vector[i] = code % dims[i];
    code = Math.floor(code / dims[i]);
  }
  return vector;
}

function fiveStarWeaponIndex(spec: PersistentSpec, targetId: string): number {
  return spec.fiveStarWeaponIndexByTargetId.get(targetId) ?? -1;
}

// Indexed by targetId, not the goal's own id — see the comment on Goal.targetId in
// types.ts: that's the identity space pull outcomes actually live in.
function fourStarIndex(spec: PersistentSpec, targetId: string): number {
  return spec.fourStarIndexByTargetId.get(targetId) ?? -1;
}

export interface TrackingUpdateResult {
  phaseVector: number[];
  persistentVector: number[];
}

/**
 * Whether the NEXT pending 5star_character win in this phase (rank phaseVector[0]+1) is instead
 * a wasted/repeat win: true when some of this phase's 4star_character goals is anchored only to
 * already-claimed 5★(s) here (not to the upcoming one) and hasn't reached its target. Models
 * "keep pulling on the current patch's banner (a featured win is just another copy of the
 * current 5★) until that 4★ is done, and only then does a win count toward the next patch" —
 * without it, anchoring to one banner vs. both would be indistinguishable within a phase.
 */
function isNextFiveStarClaimBlocked(
  phaseSpec: PhaseLocalSpec,
  persistentSpec: PersistentSpec,
  phaseVector: number[],
  persistentVector: number[],
): boolean {
  const claimedRanks = phaseVector[0];
  if (claimedRanks >= phaseSpec.fiveStarCharGoalIds.length) return false;
  const nextGoalId = phaseSpec.fiveStarCharGoalIds[claimedRanks];

  for (const fg of persistentSpec.fourStarGoals) {
    if (fg.goal.kind !== '4star_character') continue;
    if (!phaseSpec.fourStarCharGoalIdsInPhase.has(fg.goal.id)) continue; // only this phase's own 4-stars gate a same-phase claim
    const anchors = fg.goal.anchoredFiveStarGoalIds;
    if (!anchors || anchors.length === 0) continue;
    if (anchors.includes(nextGoalId)) continue; // stays open through the upcoming win too

    // A 4★ can sit textually in this phase with every anchor in another phase (its blocking
    // phase is elsewhere — phases.ts's resolveFourStarBlockingPhase). It has no stake in this
    // phase's FIFO; without this early-out the check below would read "anchor not in this
    // phase" as "already settled" and block the claim forever.
    const anchorRanksInPhase = anchors.map((a) => phaseSpec.fiveStarCharGoalIds.indexOf(a) + 1).filter((rank) => rank > 0);
    if (anchorRanksInPhase.length === 0) continue;

    const allOtherAnchorsAlreadySettled = anchors.every((a) => {
      const rank = phaseSpec.fiveStarCharGoalIds.indexOf(a) + 1; // 0 if not in this phase
      return rank === 0 || rank <= claimedRanks; // not in this phase (resolved earlier) or already claimed here
    });
    if (!allOtherAnchorsAlreadySettled) continue;

    const idx = fourStarIndex(persistentSpec, fg.goal.targetId);
    if (idx !== -1 && persistentVector[idx] < copiesNeeded(fg.goal)) return true; // still waiting on this 4-star
  }
  return false;
}

/**
 * The 5star_character rank (1-indexed) whose "patch" this phase is CURRENTLY
 * pulling within — i.e. which anchor a same-phase 4-star must belong to for its
 * copy-accrual window to be open right now. Returns 0 if this phase has no
 * 5star_character goal at all (nothing to be "on the patch of" — a same-phase
 * anchor check is meaningless there; cross-phase closure is handled separately by
 * `closedGoalIds`).
 *
 * Normally this is "the next unclaimed rank" (phaseVector[0] + 1) — we're pulling
 * TOWARD it, even before winning it, since a same-patch 4-star is available the
 * whole time that patch is running, not just after its 5-star drops. But if some
 * OTHER same-phase 4-star (isNextFiveStarClaimBlocked) is still holding up that
 * next rank's claim, focus hasn't actually moved on yet — it's still on the LAST
 * claimed rank's patch (phaseVector[0]).
 */
function computeCurrentFocusRank(
  phaseSpec: PhaseLocalSpec,
  persistentSpec: PersistentSpec,
  phaseVector: number[],
  persistentVector: number[],
): number {
  if (phaseSpec.dims.length === 0) return 0;
  const claimedRanks = phaseVector[0];
  if (claimedRanks >= phaseSpec.fiveStarCharGoalIds.length) return claimedRanks;
  if (isNextFiveStarClaimBlocked(phaseSpec, persistentSpec, phaseVector, persistentVector)) return claimedRanks;
  return claimedRanks + 1;
}

/**
 * Whether a same-phase-anchored 4star_character goal's copy-accrual window is
 * OPEN right now — i.e. the current patch focus (see computeCurrentFocusRank) is
 * one of its anchors. This is the "opening" counterpart to `closedGoalIds`'s
 * "closing": a 4-star anchored to a 5-star LATER in this same phase (e.g. Miko,
 * when the phase is Odette → 41(anchored Odette) → Miko → 42(anchored Miko))
 * must NOT start accruing copies from pull 1 just because it shares a phase with
 * its anchor — it only becomes available once focus has actually moved onto that
 * patch. Without this, a 4-star anchored to the phase's FIRST 5-star and one
 * anchored to a LATER 5-star in the very same phase were indistinguishable — both
 * accrued unrestricted from the start — even though reaching the later one
 * requires first finishing the earlier 5-star (and whatever it's blocked on).
 *
 * Not applicable (returns true, i.e. no additional gating here) when: the 4-star
 * is unanchored; none of its anchors are in THIS phase at all (an all-earlier-phase
 * anchor is handled entirely by `closedGoalIds`); or this phase has no
 * 5star_character goal of its own (nothing to have "moved past" within it).
 */
function isFourStarWindowOpenInPhase(
  phaseSpec: PhaseLocalSpec,
  persistentSpec: PersistentSpec,
  phaseVector: number[],
  persistentVector: number[],
  fourStarGoal: Goal,
): boolean {
  const anchors = fourStarGoal.anchoredFiveStarGoalIds;
  if (!anchors || anchors.length === 0) return true;
  if (phaseSpec.dims.length === 0) return true;
  const anchorRanksInPhase = anchors
    .map((a) => phaseSpec.fiveStarCharGoalIds.indexOf(a) + 1)
    .filter((rank) => rank > 0);
  if (anchorRanksInPhase.length === 0) return true; // none of its anchors are in this phase — closedGoalIds' concern
  const focusRank = computeCurrentFocusRank(phaseSpec, persistentSpec, phaseVector, persistentVector);
  return anchorRanksInPhase.includes(focusRank);
}

/**
 * Applies a pull outcome to both tracking vectors, returning new vectors (or the same
 * references if nothing changed).
 *
 * - A featured 5★ character win advances the FIFO counter unless isNextFiveStarClaimBlocked.
 * - A featured 4★ copy counts unless the goal is in `closedGoalIds` (its window is closed for
 *   this whole phase — phases.ts's computeClosedFourStarGoalIdsForPhase, the cross-phase rule)
 *   or isFourStarWindowOpenInPhase says focus isn't on one of its anchors yet (the live,
 *   within-phase rule).
 * - A 5★ weapon marks its goal obtained unless its target is in `closedFiveStarWeaponTargetIds`
 *   (not this phase's weapon banner — phases.ts's computeClosedFiveStarWeaponTargetIdsForPhase).
 */
export function updateGoalTracking(
  phaseSpec: PhaseLocalSpec,
  persistentSpec: PersistentSpec,
  phaseVector: number[],
  persistentVector: number[],
  outcome: PullOutcome,
  closedGoalIds: ReadonlySet<string> = new Set(),
  closedFiveStarWeaponTargetIds: ReadonlySet<string> = new Set(),
): TrackingUpdateResult {
  if (outcome.rarity === 3) return { phaseVector, persistentVector };

  if (outcome.rarity === 5 && outcome.kind === 'featured' && phaseSpec.dims.length > 0) {
    const max = phaseSpec.dims[0] - 1;
    if (phaseVector[0] < max) {
      if (isNextFiveStarClaimBlocked(phaseSpec, persistentSpec, phaseVector, persistentVector)) {
        return { phaseVector, persistentVector }; // wasted/repeat win — still on the current patch
      }
      return { phaseVector: [phaseVector[0] + 1], persistentVector };
    }
    return { phaseVector, persistentVector };
  }

  if (outcome.rarity === 5 && (outcome.kind === 'featured' || outcome.kind === 'featured_other')) {
    // Weapon-banner identity tracking (chosen vs. other featured). A no-op on the character
    // banner, where fiveStarWeaponTargetIds is empty so idx is always -1.
    if (closedFiveStarWeaponTargetIds.has(outcome.itemId)) return { phaseVector, persistentVector };
    const idx = fiveStarWeaponIndex(persistentSpec, outcome.itemId);
    if (idx !== -1 && persistentVector[idx] === 0) {
      const next = persistentVector.slice();
      next[idx] = 1;
      return { phaseVector, persistentVector: next };
    }
    return { phaseVector, persistentVector };
  }

  if (outcome.rarity === 4 && outcome.kind === 'featured') {
    const idx = fourStarIndex(persistentSpec, outcome.itemId);
    if (idx !== -1) {
      // idx = fiveStarWeaponTargetIds.length + offset into fourStarGoals (buildPersistentSpec).
      const fourStarEntry = persistentSpec.fourStarGoals[idx - persistentSpec.fiveStarWeaponTargetIds.length];
      if (closedGoalIds.has(fourStarEntry.goal.id)) return { phaseVector, persistentVector };
      if (!isFourStarWindowOpenInPhase(phaseSpec, persistentSpec, phaseVector, persistentVector, fourStarEntry.goal)) {
        return { phaseVector, persistentVector };
      }

      const max = persistentSpec.dims[idx] - 1;
      if (persistentVector[idx] < max) {
        const next = persistentVector.slice();
        next[idx] += 1;
        return { phaseVector, persistentVector: next };
      }
    }
    return { phaseVector, persistentVector };
  }

  return { phaseVector, persistentVector };
}

/** Whether a specific goal within the phase is individually satisfied by these tracking vectors. */
export function isGoalDone(
  phaseSpec: PhaseLocalSpec,
  persistentSpec: PersistentSpec,
  phaseVector: number[],
  persistentVector: number[],
  goal: Goal,
): boolean {
  switch (goal.kind) {
    case '5star_character': {
      const rank = phaseSpec.fiveStarCharGoalIds.indexOf(goal.id) + 1; // 1-indexed; 0 if not in this phase
      return rank > 0 && phaseVector[0] >= rank;
    }
    case '5star_weapon': {
      const idx = fiveStarWeaponIndex(persistentSpec, goal.targetId);
      return idx !== -1 && persistentVector[idx] === 1;
    }
    case '4star_character':
    case '4star_weapon': {
      const idx = fourStarIndex(persistentSpec, goal.targetId);
      return idx !== -1 && persistentVector[idx] >= copiesNeeded(goal);
    }
    default:
      return false;
  }
}

export function isPhaseFullyDone(
  phaseSpec: PhaseLocalSpec,
  persistentSpec: PersistentSpec,
  phaseVector: number[],
  persistentVector: number[],
  phaseGoals: Goal[],
): boolean {
  return phaseGoals.every((g) => isGoalDone(phaseSpec, persistentSpec, phaseVector, persistentVector, g));
}

/** Reads a 4-star goal's current copy count (0..maxCopies) from a persistent vector, by targetId. */
export function copyCountOf(persistentSpec: PersistentSpec, persistentVector: number[], targetId: string): number {
  const idx = fourStarIndex(persistentSpec, targetId);
  return idx === -1 ? 0 : persistentVector[idx];
}
