import { CR_MODELS } from './capturingRadiance';
import { transitionCharacterBanner } from './characterBanner';
import { transitionWeaponBanner } from './weaponBanner';
import { MAX_CHARACTER_COPIES, MAX_WEAPON_COPIES } from './goalTracking';
import {
  buildPhases,
  computeBlockingFourStarGoalIdsForPhase,
  computeCharacterBannerConfigForPhase,
  computeCharacterWindowGoalsForPhase,
  computeCharacterWindowPartnerPhase,
  computeClosedFiveStarWeaponTargetIdsForPhase,
  computeClosedFourStarGoalIdsForPhase,
  computeFourStarBlockingPhaseByGoalId,
  computeWeaponBannerConfigAfterFirstClaimedForPhase,
  computeWeaponBannerConfigForPhase,
  isWeaponFatePointsResetOnEntry,
} from './phases';
import { createRng, sampleFromDistribution } from './rng';
import type {
  BannerKind,
  CharacterBannerConfig,
  CharacterBannerState,
  CRModel,
  Goal,
  PullOutcome,
  SimulationInput,
  SimulationResult,
  SimulationSeries,
  WeaponBannerConfig,
  WeaponBannerState,
} from './types';

/** Copies needed to satisfy a 4-star goal at its target level (see goalTracking.ts's isGoalDone, which this mirrors). */
function goalCopyThreshold(goal: Goal): number {
  if (goal.kind === '4star_character') return (goal.targetLevel ?? 0) + 1;
  if (goal.kind === '4star_weapon') return goal.targetLevel ?? 1;
  return 1;
}

function goalMaxCopies(goal: Goal): number {
  return goal.kind === '4star_character' ? MAX_CHARACTER_COPIES : MAX_WEAPON_COPIES;
}

function goalMatchesOutcome(goal: Goal, outcome: PullOutcome): boolean {
  if (outcome.rarity === 3) return false;
  switch (goal.kind) {
    // The character banner config only tracks one currently-featured 5-star; a
    // second 5star_character goal represents "whoever's featured after that" on a
    // future rerun, so identity is intentionally not checked here (unlike 4-star
    // and weapon goals, where multiple named options genuinely coexist right now).
    case '5star_character':
      return outcome.rarity === 5 && outcome.kind === 'featured';
    case '4star_character':
      return outcome.rarity === 4 && outcome.kind === 'featured' && outcome.itemId === goal.targetId;
    case '5star_weapon':
      return (
        outcome.rarity === 5 &&
        (outcome.kind === 'featured' || outcome.kind === 'featured_other') &&
        outcome.itemId === goal.targetId
      );
    case '4star_weapon':
      return outcome.rarity === 4 && outcome.kind === 'featured' && outcome.itemId === goal.targetId;
    default:
      return false;
  }
}

/**
 * How many of a phase's own 5star_character goals (in FIFO/rank order) have
 * been claimed so far, per the current bitmask — a plain "scan a rank-ordered
 * list until the next unclaimed one" reused by both `isFourStarWindowOpen`
 * below and trace.ts's `computeFocusDisplayName` (previously duplicated
 * verbatim in both places).
 */
export function countClaimedRanks(fiveStarCharGoalIdsInPhase: string[], goalIndexById: Map<string, number>, bitmask: number): number {
  let claimedRanks = 0;
  while (claimedRanks < fiveStarCharGoalIdsInPhase.length) {
    const idx = goalIndexById.get(fiveStarCharGoalIdsInPhase[claimedRanks])!;
    if ((bitmask & (1 << idx)) !== 0) claimedRanks++;
    else break;
  }
  return claimedRanks;
}

/**
 * Mirrors goalTracking.ts's isNextFiveStarClaimBlocked: whether claiming
 * `nextGoalId` (the next unclaimed 5star_character rank in this phase) must
 * instead be treated as a wasted/repeat win — true when some same-phase 4-star is
 * anchored ONLY to already-claimed 5-star(s) (not also to `nextGoalId`) and hasn't
 * reached its own target yet.
 *
 * Returns the specific blocking `Goal` (or `undefined` if not blocked) rather
 * than a bare boolean, so callers — specifically trace.ts's narration, via the
 * `wasted-blocked` note below — can NAME which 4-star is actually responsible
 * instead of a generic "a same-phase anchored 4-star". Found worth doing
 * 2026-08-18 while reviewing trace output from "would this make sense to an
 * actual player" — the old generic wording was accurate but unhelpful; existing
 * boolean callers (`isFourStarWindowOpen`) just treat the return value as
 * truthy/falsy, unaffected by this change.
 *
 * `characterWindowPartnerByPhase` (twenty-first reported bug, 2026-08-30):
 * widens the "is this 4-star native to the SAME phase" check to also accept
 * `phaseIndex`'s own linked-simultaneous window partner (see phases.ts's
 * computeCharacterWindowPartnerPhase) — a 4-star anchored to a shared
 * character window can legitimately be textually native to EITHER phase of
 * the pair, and must be able to block a claim happening on either side of an
 * interleaved detour, not just the literal phase index passed in.
 */
export function isFiveStarClaimBlocked(
  goals: Goal[],
  phaseIndexByGoalId: Map<string, number>,
  goalIndexById: Map<string, number>,
  bitmask: number,
  copyCounts: Int32Array,
  phaseIndex: number,
  nextGoalId: string,
  characterWindowPartnerByPhase: (number | undefined)[],
): Goal | undefined {
  return goals.find((g2, i2) => {
    if (g2.kind !== '4star_character') return false;
    const g2Phase = phaseIndexByGoalId.get(g2.id);
    if (g2Phase !== phaseIndex && characterWindowPartnerByPhase[phaseIndex] !== g2Phase) return false;
    const anchors = g2.anchoredFiveStarGoalIds;
    if (!anchors || anchors.length === 0) return false;
    if (anchors.includes(nextGoalId)) return false;
    const allOtherAnchorsAlreadySettled = anchors.every((a) => {
      const aIdx = goalIndexById.get(a);
      return aIdx === undefined || (bitmask & (1 << aIdx)) !== 0;
    });
    if (!allOtherAnchorsAlreadySettled) return false;
    return copyCounts[i2] < goalCopyThreshold(g2);
  });
}

/**
 * Mirrors goalTracking.ts's isFourStarWindowOpenInPhase: whether a same-phase-
 * anchored 4-star's copy-accrual window is open right now — the current patch
 * focus (the next unclaimed rank, unless something else is still blocking it —
 * see isFiveStarClaimBlocked) must be one of this 4-star's own anchors. This is
 * the "opening" counterpart to closedGoalIds' "closing": a 4-star anchored to a
 * LATER same-phase 5-star must not accrue copies from pull 1 just because it
 * shares a phase with its anchor — only once focus has actually reached it.
 */
function isFourStarWindowOpen(
  goal: Goal,
  goals: Goal[],
  phaseIndexByGoalId: Map<string, number>,
  goalIndexById: Map<string, number>,
  fiveStarCharGoalIdsByPhase: string[][],
  bitmask: number,
  copyCounts: Int32Array,
  characterWindowPartnerByPhase: (number | undefined)[],
): boolean {
  const anchors = goal.anchoredFiveStarGoalIds;
  if (!anchors || anchors.length === 0) return true;
  const phaseIndex = phaseIndexByGoalId.get(goal.id)!;
  const phaseFiveStarCharGoalIds = fiveStarCharGoalIdsByPhase[phaseIndex];
  if (phaseFiveStarCharGoalIds.length === 0) return true;
  const anchorRanksInPhase = anchors.map((a) => phaseFiveStarCharGoalIds.indexOf(a) + 1).filter((rank) => rank > 0);
  if (anchorRanksInPhase.length === 0) return true;

  const claimedRanks = countClaimedRanks(phaseFiveStarCharGoalIds, goalIndexById, bitmask);
  let focusRank: number;
  if (claimedRanks >= phaseFiveStarCharGoalIds.length) {
    focusRank = claimedRanks;
  } else {
    const nextGoalId = phaseFiveStarCharGoalIds[claimedRanks];
    const blocked = isFiveStarClaimBlocked(goals, phaseIndexByGoalId, goalIndexById, bitmask, copyCounts, phaseIndex, nextGoalId, characterWindowPartnerByPhase);
    focusRank = blocked ? claimedRanks : claimedRanks + 1;
  }
  return anchorRanksInPhase.includes(focusRank);
}

/**
 * One human-readable note about what a single pull did or didn't do to one goal —
 * pushed by applyOutcome as a strictly additive side channel (only when `notes` is
 * passed in) alongside its normal bitmask/copyCounts computation. This never
 * changes what applyOutcome COMPUTES, only whether it also narrates why — see
 * trace.ts, which is the only caller that passes `notes`.
 */
export interface TraceNote {
  goalName: string;
  kind: 'done' | 'copy-gained' | 'wasted-blocked' | 'wasted-closed';
  detail: string;
}

function applyOutcome(
  bitmask: number,
  copyCounts: Int32Array,
  goals: Goal[],
  goalIndexById: Map<string, number>,
  phaseIndexByGoalId: Map<string, number>,
  fiveStarCharGoalIdsByPhase: string[][],
  closedGoalIds: ReadonlySet<string>,
  closedFiveStarWeaponTargetIds: ReadonlySet<string>,
  currentPhaseIndex: number,
  banner: BannerKind,
  outcome: PullOutcome,
  characterWindowPartnerByPhase: (number | undefined)[],
  notes?: TraceNote[],
): number {
  let next = bitmask;
  // 5star_character matching is identity-agnostic (see goalMatchesOutcome), so a
  // single featured win would otherwise satisfy every pending 5star_character goal
  // at once. Only the earliest pending one in priority order may claim a given win —
  // later ones represent a *subsequent* featured win, not the same one.
  let claimedGenericFiveStar = false;
  for (let idx = 0; idx < goals.length; idx++) {
    if (next & (1 << idx)) continue; // already completed
    const goal = goals[idx];
    if (goal.banner !== banner) continue;

    if (goal.kind === '5star_character') {
      if (claimedGenericFiveStar) continue;
      const goalPhase = phaseIndexByGoalId.get(goal.id)!;
      // A 5star_character goal can only be claimed by a pull that's actually
      // happening in ITS OWN phase — a same-phase 4-star extending how long we
      // keep pulling on this banner past an EARLIER phase's own 5-star win (see
      // isFourStarWindowOpen) must not let a featured win during that extended
      // stretch leak credit to a goal in a phase we haven't structurally reached
      // yet (its own real patch hasn't started; an intervening weapon-banner
      // detour, if any, hasn't even happened). Found 2026-08-18 reviewing the
      // trace survey: a D4-shaped list (Odette+Alyosha(anchor Odette) one
      // phase, weapon detour, Miko+Bennett/Chongyun(anchor Miko) a later phase)
      // let a featured win landing during the Alyosha-farming stretch — BEFORE
      // the weapon detour even started — get credited to Miko. Confirmed via
      // exact-vs-Monte-Carlo comparison this was a real ~30% overstatement in
      // simulate.ts, not just a display quirk — the exact engine's PhaseLocalSpec
      // is naturally immune (each phase's own DP only ever knows about its own
      // phase's 5star_character goals), so this bug was confined to `simulate.ts`
      // (and therefore trace.ts, which reuses it) and never affected the live app.
      //
      // Twenty-first reported bug (2026-08-30): this restriction is too
      // strict for a goal sharing a LINKED-simultaneous character window with
      // `currentPhaseIndex` (see phases.ts's computeCharacterWindowPartnerPhase)
      // — that pair genuinely IS the same real-time window, just split apart
      // by an interleaved detour, so a featured win landing while we're still
      // extending the FIRST phase's own pulls (past its own claim, chasing a
      // same-window 4-star) must be allowed to claim the SECOND phase's own
      // still-open slot instead of being dropped as "not reached yet."
      if (goalPhase !== currentPhaseIndex && characterWindowPartnerByPhase[currentPhaseIndex] !== goalPhase) continue;
      if (goalMatchesOutcome(goal, outcome)) {
        const blockingGoal = isFiveStarClaimBlocked(goals, phaseIndexByGoalId, goalIndexById, bitmask, copyCounts, goalPhase, goal.id, characterWindowPartnerByPhase);
        if (!blockingGoal) {
          next |= 1 << idx;
          claimedGenericFiveStar = true;
          notes?.push({ goalName: goal.name, kind: 'done', detail: 'featured win claimed' });
        } else {
          notes?.push({
            goalName: goal.name,
            kind: 'wasted-blocked',
            detail: `featured win, but ${blockingGoal.name} (same-phase anchored 4★, ahead of it in priority) hasn't reached its own target yet — counted as another copy of the CURRENT 5★ instead`,
          });
        }
      }
      continue;
    }

    if (goal.kind === '5star_weapon') {
      // Mirrors goalTracking.ts's closedFiveStarWeaponTargetIds gating: a
      // 5star_weapon goal is unambiguously tied to whichever single phase it's
      // positioned in (each phase has exactly one weapon banner with its own
      // distinct pair of featured weapons), so it can only ever be matched during
      // that phase — not during some other, unrelated weapon-banner phase later
      // or earlier in the same goal list.
      if (goalMatchesOutcome(goal, outcome)) {
        if (!closedFiveStarWeaponTargetIds.has(goal.targetId)) {
          next |= 1 << idx;
          notes?.push({ goalName: goal.name, kind: 'done', detail: 'this weapon dropped' });
        } else {
          notes?.push({ goalName: goal.name, kind: 'wasted-closed', detail: "this weapon dropped, but it's not this weapon-banner phase's own window" });
        }
      }
      continue;
    }

    if (goal.kind === '4star_character' || goal.kind === '4star_weapon') {
      if (goalMatchesOutcome(goal, outcome)) {
        // closedGoalIds handles the CROSS-phase case (an anchor in an earlier
        // phase); isFourStarWindowOpen handles the SAME-phase case (an anchor
        // later in this same phase that focus hasn't reached yet, or one earlier
        // in this phase that focus has already moved past). This loop already
        // checks EVERY not-yet-done goal on this pull's banner regardless of
        // priority position, so a 4-star listed after some other-banner goal
        // still opportunistically accrues copies during an EARLIER run on its
        // own banner, not just once its own priority slot comes up.
        if (closedGoalIds.has(goal.id)) {
          notes?.push({ goalName: goal.name, kind: 'wasted-closed', detail: 'featured 4★ hit, but its anchor window is closed this phase' });
        } else if (!isFourStarWindowOpen(goal, goals, phaseIndexByGoalId, goalIndexById, fiveStarCharGoalIdsByPhase, bitmask, copyCounts, characterWindowPartnerByPhase)) {
          notes?.push({ goalName: goal.name, kind: 'wasted-closed', detail: "featured 4★ hit, but focus hasn't reached its anchored patch yet this phase" });
        } else {
          if (copyCounts[idx] < goalMaxCopies(goal)) copyCounts[idx] += 1;
          const done = copyCounts[idx] >= goalCopyThreshold(goal);
          if (done) next |= 1 << idx;
          notes?.push({ goalName: goal.name, kind: 'copy-gained', detail: `copies now ${copyCounts[idx]}${done ? ' — target reached, DONE' : ''}` });
        }
      }
      continue;
    }

    if (goalMatchesOutcome(goal, outcome)) {
      next |= 1 << idx;
      notes?.push({ goalName: goal.name, kind: 'done', detail: 'matched' });
    }
  }
  return next;
}

function buildLabel(prefix: Goal[]): string {
  return prefix.map((g) => g.name).join(' + ');
}

/**
 * Everything about a goal list that's derived purely from the list itself, not
 * from any single trial's randomness — computed ONCE and reused across every
 * trial (by `runSimulation`) or the single walkthrough (by `trace.ts`'s
 * `traceOneRun`), so both share the exact same phase/anchor-gating derivation
 * with no risk of the two drifting apart.
 */
export interface TrialInfo {
  goals: Goal[];
  goalIndexById: Map<string, number>;
  phaseIndexByGoalId: Map<string, number>;
  closedGoalIdsByPhase: ReadonlySet<string>[];
  closedFiveStarWeaponTargetIdsByPhase: ReadonlySet<string>[];
  /**
   * Twenty-first reported bug (2026-08-30): for a phase sharing a
   * linked-simultaneous character window with another, non-adjacent phase
   * (see phases.ts's computeCharacterWindowPartnerPhase), this is the
   * COMBINED, priority-ordered 5star_character id list spanning BOTH phases
   * — not just this phase's own native members — so the shared FIFO/anchor
   * logic (countClaimedRanks, isFourStarWindowOpen, isFiveStarClaimBlocked)
   * sees the true rank order regardless of which literal phase is currently
   * being processed. Both phases of such a pair get the identical list here.
   */
  fiveStarCharGoalIdsByPhase: string[][];
  /** See phases.ts's computeCharacterWindowPartnerPhase — undefined for the
   * overwhelming majority of (non-window) phases. */
  characterWindowPartnerByPhase: (number | undefined)[];
  /**
   * Computed fresh per phase (not one static config reused everywhere) — mirrors
   * exactEngine.ts's per-phase computeCharacterBannerConfigForPhase/
   * computeWeaponBannerConfigForPhase exactly, fixing the same two bugs on the
   * Monte Carlo side: the weapon Epitomized Path bug (chosen/other identity used
   * to be global-by-priority-position, so a later phase's own weapon could never
   * benefit from a Fate Point guarantee) and the 4-star pool dilution bug (a
   * global pool past 3/5 real names silently diluted every phase's split
   * fraction). See phases.ts's doc comments on both functions.
   */
  characterConfigByPhase: CharacterBannerConfig[];
  weaponConfigByPhase: WeaponBannerConfig[];
  /**
   * True for a weapon-banner phase iff some EARLIER phase already used the
   * weapon banner too, AND this phase represents a genuinely NEW Epitomized
   * Path selection rather than a continuation of a still-live one. `stepOnePull`
   * uses this to reset `fatePoints` to 0 exactly once, on the first weapon pull
   * of such a phase (mirrors exactEngine.ts's `resetWeaponFatePoints`) — always
   * false for character-banner phases (character's guaranteed5/CR carry over
   * unchanged, no reset needed there).
   *
   * Fifteenth reported bug (2026-08-19): also false when this phase's own
   * weapon goal is explicitly LINKED (Goal.linkedWeaponGoalId) to the goal
   * whose phase immediately precedes it — a linked pair represents ONE
   * continuous real EP window split apart in priority order, not a new
   * selection, so any Fate Point progress earned toward the (already-claimed)
   * first weapon AFTER it was claimed (via the existing retarget mechanism —
   * see `weaponConfigAfterFirstClaimedByPhase` below — while chasing some
   * OTHER goal still sharing that first phase) genuinely belongs to the second
   * weapon and must survive into its own phase. Named for what it actually
   * controls (mirrors exactEngine.ts's identically-motivated fix at its
   * `resetWeaponFatePoints` call site) rather than "is this a reoccurrence,"
   * since not every reoccurrence resets anymore.
   */
  resetFatePointsOnEntry: boolean[];
  /**
   * Fourteenth reported bug: the Epitomized Path retarget, mirroring
   * exactEngine.ts's `weaponConfigAfterFirstClaimed` / `computeWeaponBannerConfigAfterFirstClaimedForPhase`.
   * `undefined` for any phase without exactly 2 `5star_weapon` goals (no
   * retarget applicable — every phase before this fix). Where defined,
   * `stepOnePull` uses this config instead of `weaponConfigByPhase[p]` once
   * `firstWeaponGoalIndexByPhase[p]`'s bit is set in `bitmask`.
   */
  weaponConfigAfterFirstClaimedByPhase: (WeaponBannerConfig | undefined)[];
  /** Index (into `goals`) of the phase's own first-listed `5star_weapon` goal,
   * only where `weaponConfigAfterFirstClaimedByPhase[p]` is defined — this is
   * the bit `stepOnePull` checks in `bitmask` to decide whether the retarget
   * has happened yet. */
  firstWeaponGoalIndexByPhase: (number | undefined)[];
  fullMask: number;
  /** The banner each phase (by index) is on — mirrors `phases[p].banner`. */
  bannerByPhase: BannerKind[];
  /**
   * The goal ids that actually GATE phase p's own graduation — mirrors
   * exactEngine.ts's `blockingGoals` construction exactly (phases.ts's
   * computeBlockingFourStarGoalIdsForPhase): this phase's own native 5★ goals,
   * plus any 4★ goal (from ANYWHERE in the list) whose resolved blocking phase
   * is p. A 4★ can legally appear here for a phase it ISN'T a raw member of —
   * see resolveFourStarBlockingPhase's doc comment for why (isGoalDone for a
   * 4★ only ever reads the banner-wide copyCounts array, never phase-local
   * state). Drives `stepOnePull`'s phase-scan (replacing the old
   * `targetIdx`-only focus selection, which had no way to skip a 4★ that
   * shouldn't be gating the current point — see the "4★ anchoring is
   * phase-derived" fix). */
  blockingGoalIdsByPhase: string[][];
}

export function buildTrialInfo(goals: Goal[], featured5StarId: string): TrialInfo {
  const goalIndexById = new Map<string, number>();
  goals.forEach((g, idx) => goalIndexById.set(g.id, idx));

  // Precompute, ONCE (not per trial — this is purely goal-list-derived, not
  // random), which phase each goal belongs to, which 4-star goals are closed for
  // each phase, and each phase's own ordered 5star_character goal ids — mirrors
  // exactEngine.ts's phase-scoped anchor gating exactly, so this stays a valid
  // ground truth for cross-checking it.
  const phases = buildPhases(goals);
  const phaseIndexByGoalId = new Map<string, number>();
  phases.forEach((phase, p) => {
    for (const phaseGoal of phase.goals) phaseIndexByGoalId.set(phaseGoal.id, p);
  });
  const closedGoalIdsByPhase = phases.map((_, p) => computeClosedFourStarGoalIdsForPhase(phases, p, goals));
  const fiveStarWeaponGoals = goals.filter((g) => g.kind === '5star_weapon');
  const closedFiveStarWeaponTargetIdsByPhase = phases.map((_, p) => computeClosedFiveStarWeaponTargetIdsForPhase(phases, p, fiveStarWeaponGoals));
  // Twenty-first reported bug (2026-08-30): widened to the combined,
  // priority-ordered set for a phase sharing a linked-simultaneous character
  // window with another (non-adjacent) phase — see TrialInfo's own doc
  // comment on this field, and phases.ts's computeCharacterWindowPartnerPhase.
  const characterWindowPartnerByPhase: (number | undefined)[] = phases.map((_, p) =>
    phases[p].banner === 'character' ? computeCharacterWindowPartnerPhase(phases, p) : undefined,
  );
  const fiveStarCharGoalIdsByPhase = phases.map((phase, p) =>
    characterWindowPartnerByPhase[p] !== undefined
      ? computeCharacterWindowGoalsForPhase(phases, p)
          .filter((g) => g.kind === '5star_character')
          .map((g) => g.id)
      : phase.goals.filter((g) => g.kind === '5star_character').map((g) => g.id),
  );
  const characterFourStarGoals = goals.filter((g) => g.kind === '4star_character');
  const weaponFourStarGoals = goals.filter((g) => g.kind === '4star_weapon');
  const characterConfigByPhase = phases.map((_, p) => computeCharacterBannerConfigForPhase(phases, p, characterFourStarGoals, featured5StarId));
  const weaponConfigByPhase = phases.map((_, p) => computeWeaponBannerConfigForPhase(phases, p, weaponFourStarGoals));
  const resetFatePointsOnEntry = phases.map((_, p) => isWeaponFatePointsResetOnEntry(phases, p));
  // Fourteenth reported bug: Epitomized Path retarget, mirroring
  // exactEngine.ts's computeWeaponBannerConfigAfterFirstClaimedForPhase.
  const weaponConfigAfterFirstClaimedByPhase = phases.map((_, p) => computeWeaponBannerConfigAfterFirstClaimedForPhase(phases, p, weaponFourStarGoals));
  const firstWeaponGoalIndexByPhase = phases.map((phase, p) =>
    weaponConfigAfterFirstClaimedByPhase[p] ? goalIndexById.get(phase.goals.find((g) => g.kind === '5star_weapon')!.id) : undefined,
  );
  const fullMask = goals.length === 0 ? 0 : (1 << goals.length) - 1;

  const bannerByPhase = phases.map((phase) => phase.banner);
  // Every persistent 4★ goal's resolved blocking phase, computed ONCE (a
  // goal's own blocking phase never depends on which phase it's being
  // checked against) — see computeFourStarBlockingPhaseByGoalId's doc comment.
  const blockingPhaseByGoalId = computeFourStarBlockingPhaseByGoalId(phases, [...characterFourStarGoals, ...weaponFourStarGoals]);
  // Mirrors exactEngine.ts's `blockingGoals` construction exactly — see this
  // function's own doc comment on blockingGoalIdsByPhase.
  const blockingGoalIdsByPhase = phases.map((phase, p) => {
    const fourStarGoalsForBanner = phase.banner === 'character' ? characterFourStarGoals : weaponFourStarGoals;
    const blockingFourStarIds = computeBlockingFourStarGoalIdsForPhase(p, fourStarGoalsForBanner, blockingPhaseByGoalId);
    const nativeFiveStarIds = phase.goals.filter((g) => g.kind === '5star_character' || g.kind === '5star_weapon').map((g) => g.id);
    const blockingFourStarGoalIds = fourStarGoalsForBanner.filter((g) => blockingFourStarIds.has(g.id)).map((g) => g.id);
    return [...nativeFiveStarIds, ...blockingFourStarGoalIds];
  });

  return {
    goals,
    goalIndexById,
    phaseIndexByGoalId,
    bannerByPhase,
    blockingGoalIdsByPhase,
    closedGoalIdsByPhase,
    closedFiveStarWeaponTargetIdsByPhase,
    fiveStarCharGoalIdsByPhase,
    characterWindowPartnerByPhase,
    characterConfigByPhase,
    weaponConfigByPhase,
    resetFatePointsOnEntry,
    weaponConfigAfterFirstClaimedByPhase,
    firstWeaponGoalIndexByPhase,
    fullMask,
  };
}

/**
 * One pull's worth of work: if `bitmask` isn't already complete, figures out
 * which banner the highest-priority incomplete goal is on, samples a real pull
 * outcome from that banner's own transition function, and applies it. Shared by
 * `runSimulation`'s statistics loop (called `trialCount * pullBudget` times, no
 * `notes`) and `trace.ts`'s `traceOneRun` (called once per pull, with `notes`) —
 * this is what guarantees a trace is a faithful walkthrough of the exact same
 * logic the statistics engine runs, not a second, potentially-drifted copy of it.
 */
export function stepOnePull(
  info: TrialInfo,
  input: SimulationInput,
  crModel: CRModel,
  charState: CharacterBannerState,
  weaponState: WeaponBannerState,
  bitmask: number,
  copyCounts: Int32Array,
  rng: () => number,
  /** Highest phaseIndex reached so far this trial (-1 before any pull) — used
   * ONLY to detect the first pull of a NEW weapon-banner phase, so its
   * `fatePoints` can be reset exactly once (Epitomized Path is a per-phase
   * selection; see TrialInfo's resetFatePointsOnEntry doc comment). A
   * trial's phaseIndex sequence is monotonically non-decreasing (bitmask only
   * ever gains bits), so "phaseIndex > maxPhaseIndexSeen" is exactly "this is
   * the first pull of this phase". */
  maxPhaseIndexSeen: number,
  notes?: TraceNote[],
): {
  charState: CharacterBannerState;
  weaponState: WeaponBannerState;
  /** The weapon state actually fed into transitionWeaponBanner for THIS pull
   * (post phase-entry fatePoints reset, pre-transition) — equals the input
   * `weaponState` unchanged for a character-banner pull. Exposed so callers
   * (trace.ts) can read the real pre-pull fatePoints/guaranteed5 without
   * duplicating the phase-entry reset check. */
  weaponStateUsed: WeaponBannerState;
  bitmask: number;
  banner: BannerKind | null;
  outcome: PullOutcome | null;
  maxPhaseIndexSeen: number;
} {
  if (bitmask === info.fullMask) return { charState, weaponState, weaponStateUsed: weaponState, bitmask, banner: null, outcome: null, maxPhaseIndexSeen };
  const { goals } = info;
  // The first phase whose OWN blocking condition isn't yet satisfied — replaces
  // the old `targetIdx = goals.findIndex(...)` (earliest incomplete goal by RAW
  // ARRAY POSITION), which had no way to skip a 4★ goal that's trackable but not
  // actually gating this point (its resolved blocking phase differs from its own
  // textual position — see phases.ts's resolveFourStarBlockingPhase). Mirrors
  // exactEngine.ts's `isPhaseFullyDone(..., blockingGoals)` check exactly.
  //
  // `phaseIndex === -1` (every phase's blocking condition already met, but
  // bitmask isn't full) is now believed UNREACHABLE for any real, validated
  // goal list — twentieth-reported-bug follow-up (2026-08-21): a disconnected
  // 4★ used to have no phase of her own at all (this WAS her live path, "issue
  // 1.5.5"), but `buildPhases` now gives her a real, isolated phase directly,
  // at her own priority position (phases.ts) — she's just an ordinary blocking
  // phase member like any other goal now, so the scan above always finds her
  // own phase until she's done. Kept as a defensive fallback, not a live path.
  //
  // This also closes a gap this comment used to document: previously,
  // exactEngine.ts's "Phase R" mechanism gave a disconnected 4★ a real chance
  // that this Monte Carlo engine deliberately did NOT mirror, making the exact
  // engine "ahead of" Monte Carlo for that shape — the only place in this
  // codebase where that was true. Since disconnected goals now resolve via
  // ordinary phase-loop processing in BOTH engines (neither ever needed
  // special-casing beyond the shared phases.ts functions), that gap no longer
  // exists — a disconnected goal's odds should now cross-validate normally,
  // same as any other goal.
  const phaseIndex = info.blockingGoalIdsByPhase.findIndex((ids) => !ids.every((id) => (bitmask & (1 << info.goalIndexById.get(id)!)) !== 0));
  if (phaseIndex === -1) return { charState, weaponState, weaponStateUsed: weaponState, bitmask, banner: null, outcome: null, maxPhaseIndexSeen };
  const banner = info.bannerByPhase[phaseIndex];
  const closedGoalIds = info.closedGoalIdsByPhase[phaseIndex];
  const closedFiveStarWeaponTargetIds = info.closedFiveStarWeaponTargetIdsByPhase[phaseIndex];
  const enteringNewPhase = phaseIndex > maxPhaseIndexSeen;
  const nextMaxPhaseIndexSeen = enteringNewPhase ? phaseIndex : maxPhaseIndexSeen;
  if (banner === 'character') {
    const transitions = transitionCharacterBanner(charState, info.characterConfigByPhase[phaseIndex], crModel, input.crParams);
    const picked = sampleFromDistribution(transitions, rng());
    const nextBitmask = applyOutcome(bitmask, copyCounts, goals, info.goalIndexById, info.phaseIndexByGoalId, info.fiveStarCharGoalIdsByPhase, closedGoalIds, closedFiveStarWeaponTargetIds, phaseIndex, banner, picked.outcome, info.characterWindowPartnerByPhase, notes);
    return { charState: picked.nextState, weaponState, weaponStateUsed: weaponState, bitmask: nextBitmask, banner, outcome: picked.outcome, maxPhaseIndexSeen: nextMaxPhaseIndexSeen };
  }
  const effectiveWeaponState = enteringNewPhase && info.resetFatePointsOnEntry[phaseIndex] ? { ...weaponState, fatePoints: 0 as const } : weaponState;
  // Fourteenth reported bug: Epitomized Path retargets to this phase's second
  // 5star_weapon goal once the first is claimed — see TrialInfo's
  // weaponConfigAfterFirstClaimedByPhase doc comment.
  const firstWeaponGoalIdx = info.firstWeaponGoalIndexByPhase[phaseIndex];
  const effectiveWeaponConfig =
    firstWeaponGoalIdx !== undefined && (bitmask & (1 << firstWeaponGoalIdx)) !== 0
      ? info.weaponConfigAfterFirstClaimedByPhase[phaseIndex]!
      : info.weaponConfigByPhase[phaseIndex];
  const transitions = transitionWeaponBanner(effectiveWeaponState, effectiveWeaponConfig);
  const picked = sampleFromDistribution(transitions, rng());
  const nextBitmask = applyOutcome(bitmask, copyCounts, goals, info.goalIndexById, info.phaseIndexByGoalId, info.fiveStarCharGoalIdsByPhase, closedGoalIds, closedFiveStarWeaponTargetIds, phaseIndex, banner, picked.outcome, info.characterWindowPartnerByPhase, notes);
  return {
    charState,
    weaponState: picked.nextState,
    weaponStateUsed: effectiveWeaponState,
    bitmask: nextBitmask,
    banner,
    outcome: picked.outcome,
    maxPhaseIndexSeen: nextMaxPhaseIndexSeen,
  };
}

/** Runs the Monte Carlo simulation and returns cumulative completion probabilities per priority prefix. */
export function runSimulation(input: SimulationInput): SimulationResult {
  const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const { pullBudget, goals, trialCount, crModelId } = input;
  if (goals.length > 30) {
    throw new Error('runSimulation supports at most 30 goals (bitmask limitation).');
  }
  const crModel = CR_MODELS[crModelId];
  const numGoals = goals.length;
  const pullCounts = Array.from({ length: pullBudget + 1 }, (_, i) => i);
  const counts: Float64Array[] = Array.from({ length: numGoals }, () => new Float64Array(pullBudget + 1));
  const rng = createRng(input.seed ?? Date.now());
  const copyCounts = new Int32Array(numGoals);
  const info = buildTrialInfo(goals, input.characterBanner.featured5StarId);

  for (let trial = 0; trial < trialCount; trial++) {
    let charState: CharacterBannerState = { ...input.characterBanner.state };
    let weaponState: WeaponBannerState = { ...input.weaponBanner.state };
    let bitmask = 0;
    let maxPhaseIndexSeen = -1;
    copyCounts.fill(0);

    for (let p = 1; p <= pullBudget; p++) {
      ({ charState, weaponState, bitmask, maxPhaseIndexSeen } = stepOnePull(info, input, crModel, charState, weaponState, bitmask, copyCounts, rng, maxPhaseIndexSeen));
      for (let k = 1; k <= numGoals; k++) {
        const mask = (1 << k) - 1;
        if ((bitmask & mask) === mask) counts[k - 1][p] += 1;
      }
    }
  }

  const series: SimulationSeries[] = [];
  for (let k = 1; k <= numGoals; k++) {
    const prefix = goals.slice(0, k);
    series.push({
      prefixLength: k,
      goalIds: prefix.map((g) => g.id),
      label: buildLabel(prefix),
      probabilities: Array.from(counts[k - 1], (c) => c / trialCount),
    });
  }

  const end = typeof performance !== 'undefined' ? performance.now() : Date.now();
  // Monte Carlo is now a verification/testing tool only (see exactEngine.ts for the
  // live runtime engine) — it doesn't compute the constellation/refinement
  // breakdown, since nothing in the shipped app calls it for that.
  return { pullCounts, series, breakdowns: [], meta: { trialsRun: trialCount, elapsedMs: end - start, engine: 'monte-carlo' } };
}
