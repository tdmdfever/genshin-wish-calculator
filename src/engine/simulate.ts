import { CR_MODELS } from './capturingRadiance';
import { transitionCharacterBanner } from './characterBanner';
import { transitionWeaponBanner } from './weaponBanner';
import { copiesNeeded, isFourStarKind, LEVEL_OPTIONS, levelLabel } from './goalKinds';
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
  padIds,
} from './phases';
import { createRng, sampleFromDistribution } from './rng';
import type {
  BannerKind,
  CharacterBannerConfig,
  CharacterBannerState,
  CRModel,
  Goal,
  LevelBreakdownSeries,
  PullOutcome,
  SimulationInput,
  SimulationResult,
  SimulationSeries,
  WeaponBannerConfig,
  WeaponBannerState,
} from './types';

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

/** How many of a phase's 5star_character goals (in FIFO/rank order) are claimed so far — shared
 * with trace.ts. */
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
 * Mirrors goalTracking.ts's isNextFiveStarClaimBlocked: whether claiming `nextGoalId` (the next
 * unclaimed 5star_character rank in this phase) is instead a wasted/repeat win, because a 4★ of
 * this phase (or of its linked window partner) is anchored only to already-claimed 5★s and is
 * short of its target. Returns that blocking goal, so trace.ts can name it.
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
    return copyCounts[i2] < copiesNeeded(g2);
  });
}

/**
 * Mirrors goalTracking.ts's isFourStarWindowOpenInPhase: whether a same-phase-anchored 4★ can accrue
 * right now — the current patch focus (the next unclaimed rank, unless isFiveStarClaimBlocked
 * holds focus on the current one) must be one of its anchors.
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

/** A note on what one pull did (or didn't do) to one goal — pushed by applyOutcome only when trace.ts
 * passes `notes`; it never changes what applyOutcome computes. */
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
    const goal = goals[idx];
    if (goal.banner !== banner) continue;
    if (next & (1 << idx)) {
      // Already done. A 4★ still collects copies past its target (for the breakdown), as the
      // exact engine's persistent vector does — silently, since it no longer affects any decision.
      if (
        isFourStarKind(goal.kind) &&
        goalMatchesOutcome(goal, outcome) &&
        copyCounts[idx] < goalMaxCopies(goal) &&
        !closedGoalIds.has(goal.id) &&
        isFourStarWindowOpen(goal, goals, phaseIndexByGoalId, goalIndexById, fiveStarCharGoalIdsByPhase, bitmask, copyCounts, characterWindowPartnerByPhase)
      ) {
        copyCounts[idx] += 1;
      }
      continue;
    }

    if (goal.kind === '5star_character') {
      if (claimedGenericFiveStar) continue;
      const goalPhase = phaseIndexByGoalId.get(goal.id)!;
      // Only a pull in the goal's own phase (or its linked window partner's) can claim it: while an
      // earlier phase is held open for a 4★, a featured win mustn't credit a later phase whose
      // patch hasn't started.
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
      // Only on its own phase's weapon banner (goalTracking.ts's closedFiveStarWeaponTargetIds).
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
        // closedGoalIds: not on this phase's roster; isFourStarWindowOpen: focus hasn't reached (or
        // has passed) its anchor within the phase. Every pending goal on this banner is checked, so
        // a 4★ accrues opportunistically regardless of its priority slot.
        if (closedGoalIds.has(goal.id)) {
          notes?.push({ goalName: goal.name, kind: 'wasted-closed', detail: 'featured 4★ hit, but its anchor window is closed this phase' });
        } else if (!isFourStarWindowOpen(goal, goals, phaseIndexByGoalId, goalIndexById, fiveStarCharGoalIdsByPhase, bitmask, copyCounts, characterWindowPartnerByPhase)) {
          notes?.push({ goalName: goal.name, kind: 'wasted-closed', detail: "featured 4★ hit, but focus hasn't reached its anchored patch yet this phase" });
        } else {
          if (copyCounts[idx] < goalMaxCopies(goal)) copyCounts[idx] += 1;
          const done = copyCounts[idx] >= copiesNeeded(goal);
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
 * Everything derived from the goal list alone, computed once and shared by every trial
 * (runSimulation) and by trace.ts, so both use exactly the same phase/anchor derivation — mirroring
 * exactEngine.ts's per-phase setup.
 */
export interface TrialInfo {
  goals: Goal[];
  goalIndexById: Map<string, number>;
  phaseIndexByGoalId: Map<string, number>;
  closedGoalIdsByPhase: ReadonlySet<string>[];
  closedFiveStarWeaponTargetIdsByPhase: ReadonlySet<string>[];
  /** Each phase's 5star_character ids in FIFO order — both halves' combined for a split linked
   * window (phases.ts's computeCharacterWindowGoalsForPhase), identical for both phases of the pair. */
    fiveStarCharGoalIdsByPhase: string[][];
  /** phases.ts's computeCharacterWindowPartnerPhase, per phase. */
    characterWindowPartnerByPhase: (number | undefined)[];
  /** Per-phase banner configs, as in exactEngine.ts (phases.ts's compute*BannerConfigForPhase). */
    characterConfigByPhase: CharacterBannerConfig[];
  weaponConfigByPhase: WeaponBannerConfig[];
  /** phases.ts's isWeaponFatePointsResetOnEntry, per phase — applied on the first pull of that phase. */
    resetFatePointsOnEntry: boolean[];
  /** The Epitomized Path retarget config (undefined unless a two-weapon window); used once
   * `firstWeaponGoalIndexByPhase[p]`'s bit is set. */
    weaponConfigAfterFirstClaimedByPhase: (WeaponBannerConfig | undefined)[];
  /** Index (into `goals`) of the phase's first 5star_weapon goal, where a retarget config exists. */
    firstWeaponGoalIndexByPhase: (number | undefined)[];
  fullMask: number;
  /** The trailing continuation, as in exactEngine.ts: once every goal is done, pulling
   * continues on the last phase's banner so 4★s on that phase's roster keep collecting copies.
   * Undefined when that banner has no 4★ goal. Used by runSimulation only (a trace stops when
   * every goal is done). */
  continuation?: {
    banner: BannerKind;
    characterConfig: CharacterBannerConfig;
    weaponConfig: WeaponBannerConfig;
    closedGoalIds: ReadonlySet<string>;
  };
  /** `phases[p].banner`. */
    bannerByPhase: BannerKind[];
  /** The goals gating phase p's graduation, as in exactEngine.ts's `blockingGoals`: its own 5★ goals
   * plus the 4★s whose blocking phase it is (which may live in an earlier phase). */
    blockingGoalIdsByPhase: string[][];
}

export function buildTrialInfo(goals: Goal[], featured5StarId: string): TrialInfo {
  const goalIndexById = new Map<string, number>();
  goals.forEach((g, idx) => goalIndexById.set(g.id, idx));

  // Phase membership, per-phase closed sets, and per-phase FIFO order — as in exactEngine.ts.
  const phases = buildPhases(goals);
  const phaseIndexByGoalId = new Map<string, number>();
  phases.forEach((phase, p) => {
    for (const phaseGoal of phase.goals) phaseIndexByGoalId.set(phaseGoal.id, p);
  });
  const closedGoalIdsByPhase = phases.map((_, p) => computeClosedFourStarGoalIdsForPhase(phases, p, goals));
  const fiveStarWeaponGoals = goals.filter((g) => g.kind === '5star_weapon');
  const closedFiveStarWeaponTargetIdsByPhase = phases.map((_, p) => computeClosedFiveStarWeaponTargetIdsForPhase(phases, p, fiveStarWeaponGoals));
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
  const weaponConfigAfterFirstClaimedByPhase = phases.map((_, p) => computeWeaponBannerConfigAfterFirstClaimedForPhase(phases, p, weaponFourStarGoals));
  const firstWeaponGoalIndexByPhase = phases.map((phase, p) =>
    weaponConfigAfterFirstClaimedByPhase[p] ? goalIndexById.get(phase.goals.find((g) => g.kind === '5star_weapon')!.id) : undefined,
  );
  const fullMask = goals.length === 0 ? 0 : (1 << goals.length) - 1;

  // Mirrors exactEngine.ts's continuation: the last phase's banner, its roster, placeholder 5★ ids.
  let continuation: TrialInfo['continuation'];
  const tailBanner = phases.length > 0 ? phases[phases.length - 1].banner : undefined;
  const tailFourStarGoals = tailBanner === 'character' ? characterFourStarGoals : weaponFourStarGoals;
  if (tailBanner !== undefined && tailFourStarGoals.length > 0) {
    const closedGoalIds = computeClosedFourStarGoalIdsForPhase(phases, phases.length - 1, tailFourStarGoals);
    const openTargetIds = tailFourStarGoals.filter((g) => !closedGoalIds.has(g.id)).map((g) => g.targetId);
    continuation = {
      banner: tailBanner,
      characterConfig: { featured5StarId, featured4StarIds: padIds(openTargetIds, 3, 'continuation-4star-char') },
      weaponConfig: {
        chosenWeaponId: 'continuation-chosen-weapon',
        otherFeaturedWeaponId: 'continuation-other-weapon',
        featured4WeaponIds: padIds(openTargetIds, 5, 'continuation-4star-weapon'),
      },
      closedGoalIds,
    };
  }

  const bannerByPhase = phases.map((phase) => phase.banner);
  const blockingPhaseByGoalId = computeFourStarBlockingPhaseByGoalId(phases, [...characterFourStarGoals, ...weaponFourStarGoals]);
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
    continuation,
  };
}

/**
 * One pull: if goals remain, find the first phase whose blocking goals aren't all done, sample a pull
 * on its banner, and apply it. Shared by runSimulation's trials and trace.ts's walkthrough, so a
 * trace narrates exactly the logic the statistics run.
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
  /** Highest phase index reached so far this trial (-1 before any pull). Phase indices never decrease
   * within a trial, so a higher one means this is the new phase's first pull — when Fate Points
   * may reset. */
    maxPhaseIndexSeen: number,
  notes?: TraceNote[],
): {
  charState: CharacterBannerState;
  weaponState: WeaponBannerState;
  /** The weapon state actually fed into transitionWeaponBanner this pull (after any phase-entry
   * Fate Point reset) — for trace.ts's annotations. Equals `weaponState` on a character pull. */
    weaponStateUsed: WeaponBannerState;
  bitmask: number;
  banner: BannerKind | null;
  outcome: PullOutcome | null;
  maxPhaseIndexSeen: number;
} {
  if (bitmask === info.fullMask) return { charState, weaponState, weaponStateUsed: weaponState, bitmask, banner: null, outcome: null, maxPhaseIndexSeen };
  const { goals } = info;
  // The first phase whose blocking goals aren't all done — mirrors exactEngine.ts's graduation check.
  // -1 (everything blocking is done but some goal isn't) shouldn't happen for a valid goal list,
  // since every goal is in some phase; it's handled defensively.
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
  // Epitomized Path retarget once the phase's first weapon is obtained.
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

/**
 * One pull of the trailing continuation (TrialInfo's `continuation`), after every goal is done:
 * only 4★ copies on the continuation roster change. No Fate Point reset — it's the same banner
 * continuing. Unlike exactEngine.ts, no MAX_CONTINUATION_HORIZON_PULLS cap: cross-checks against
 * the exact engine should stay within its first 400 pulls of the last phase.
 */
function stepContinuationPull(
  info: TrialInfo,
  input: SimulationInput,
  crModel: CRModel,
  charState: CharacterBannerState,
  weaponState: WeaponBannerState,
  copyCounts: Int32Array,
  rng: () => number,
): { charState: CharacterBannerState; weaponState: WeaponBannerState } {
  const c = info.continuation!;
  let outcome: PullOutcome;
  if (c.banner === 'character') {
    const picked = sampleFromDistribution(transitionCharacterBanner(charState, c.characterConfig, crModel, input.crParams), rng());
    charState = picked.nextState;
    outcome = picked.outcome;
  } else {
    const picked = sampleFromDistribution(transitionWeaponBanner(weaponState, c.weaponConfig), rng());
    weaponState = picked.nextState;
    outcome = picked.outcome;
  }
  info.goals.forEach((goal, idx) => {
    if (goal.banner !== c.banner || !isFourStarKind(goal.kind) || c.closedGoalIds.has(goal.id)) return;
    if (goalMatchesOutcome(goal, outcome) && copyCounts[idx] < goalMaxCopies(goal)) copyCounts[idx] += 1;
  });
  return { charState, weaponState };
}

/**
 * Runs the Monte Carlo simulation: cumulative completion probabilities per priority prefix, plus
 * each 4★ goal's constellation/refinement breakdown — computed independently of the exact engine
 * so the breakdown panel can be cross-checked too.
 */
export function runSimulation(input: SimulationInput): SimulationResult {
  const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const { pullBudget, goals, trialCount, crModelId } = input;
  if (!trialCount) throw new Error('runSimulation needs a trialCount.');
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

  // Breakdowns: firstReached[j][level][p] counts trials whose 4★ goal j first had level+1 copies at
  // pull p; a cumulative sum at the end gives P(>= level+1 copies by pull p).
  const fourStarIdxs = goals.flatMap((g, idx) => (isFourStarKind(g.kind) ? [idx] : []));
  const firstReached = fourStarIdxs.map((idx) => Array.from({ length: goalMaxCopies(goals[idx]) }, () => new Float64Array(pullBudget + 1)));
  const recordedCopies = new Int32Array(fourStarIdxs.length);

  for (let trial = 0; trial < trialCount; trial++) {
    let charState: CharacterBannerState = { ...input.characterBanner.state };
    let weaponState: WeaponBannerState = { ...input.weaponBanner.state };
    let bitmask = 0;
    let maxPhaseIndexSeen = -1;
    copyCounts.fill(0);
    recordedCopies.fill(0);

    for (let p = 1; p <= pullBudget; p++) {
      if (bitmask === info.fullMask) {
        // Every goal done: keep pulling for bonus 4★ copies if there's a continuation, else idle.
        if (info.continuation) ({ charState, weaponState } = stepContinuationPull(info, input, crModel, charState, weaponState, copyCounts, rng));
      } else {
        ({ charState, weaponState, bitmask, maxPhaseIndexSeen } = stepOnePull(info, input, crModel, charState, weaponState, bitmask, copyCounts, rng, maxPhaseIndexSeen));
      }
      for (let k = 1; k <= numGoals; k++) {
        const mask = (1 << k) - 1;
        if ((bitmask & mask) === mask) counts[k - 1][p] += 1;
      }
      for (let j = 0; j < fourStarIdxs.length; j++) {
        while (recordedCopies[j] < copyCounts[fourStarIdxs[j]]) firstReached[j][recordedCopies[j]++][p] += 1;
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

  const breakdowns: LevelBreakdownSeries[] = fourStarIdxs.map((idx, j) => {
    const goal = goals[idx];
    const kind = goal.kind === '4star_character' ? '4star_character' : '4star_weapon';
    const levelProbabilities = firstReached[j].map((firsts) => {
      let running = 0;
      return Array.from(firsts, (c) => (running += c) / trialCount);
    });
    return { goalId: goal.id, goalName: goal.name, levelLabels: LEVEL_OPTIONS[kind].map((level) => levelLabel(kind, level)), levelProbabilities };
  });

  const end = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return { pullCounts, series, breakdowns, meta: { trialsRun: trialCount, elapsedMs: end - start, engine: 'monte-carlo' } };
}
