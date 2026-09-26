import { CR_MODELS } from './capturingRadiance';
import { buildPersistentSpec, buildPhaseLocalSpec } from './goalTracking';
import { copiesNeeded, LEVEL_OPTIONS, levelLabel } from './goalKinds';
import { runPhaseDp, type ContinuationSpec, type PhaseDpResult } from './phaseDp';
import {
  buildPhases,
  computeBlockingFourStarGoalIdsForPhase,
  computeCharacterBannerConfigForPhase,
  computeCharacterWindowGoalsForPhase,
  computeCharacterWindowPartnerPhase,
  computeClosedFiveStarWeaponTargetIdsForPhase,
  computeClosedFourStarGoalIdsForPhase,
  computeDisconnectedFourStarGoalIds,
  computeFourStarBlockingPhaseByGoalId,
  computeWeaponBannerConfigAfterFirstClaimedForPhase,
  computeWeaponBannerConfigForPhase,
  isWeaponFatePointsResetOnEntry,
  padIds,
} from './phases';
import { decodeWeaponState, encodeCharState, encodeWeaponState } from './stateCodec';
import type {
  BannerKind,
  Goal,
  LevelBreakdownSeries,
  SimulationInput,
  SimulationResult,
  SimulationSeries,
} from './types';

/** cumulative[l] = P(event by pull l) -> density[l] = P(event at exactly pull l). */
function cumulativeToDensity(cumulative: Float64Array): Float64Array {
  const density = new Float64Array(cumulative.length);
  density[0] = cumulative[0];
  for (let l = 1; l < cumulative.length; l++) density[l] = cumulative[l] - cumulative[l - 1];
  return density;
}

/** Elementwise min of two same-length cumulative arrays. */
function minArray(a: Float64Array, b: Float64Array): Float64Array {
  const result = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) result[i] = Math.min(a[i], b[i]);
  return result;
}

/** result[N] = sum_{t=0}^{N} density[t] * cumulativeMetric[N-t] — aligns a phase's
 * local-pull-indexed cumulative metric onto the global pull axis, weighted by when
 * the phase was actually entered. */
function convolve(density: Float64Array, cumulativeMetric: Float64Array): Float64Array {
  const maxPulls = density.length - 1;
  const result = new Float64Array(maxPulls + 1);
  for (let N = 0; N <= maxPulls; N++) {
    let sum = 0;
    for (let t = 0; t <= N; t++) sum += density[t] * cumulativeMetric[N - t];
    result[N] = sum;
  }
  return result;
}

function normalizeDist(dist: Map<number, number>): Map<number, number> {
  let total = 0;
  for (const v of dist.values()) total += v;
  if (total <= 0) return new Map();
  const normalized = new Map<number, number>();
  for (const [k, v] of dist) normalized.set(k, v / total);
  return normalized;
}

/**
 * Local pull horizon cap for the two computations whose cost never tapers off: the trailing
 * continuation (graduated mass that keeps pulling inside the last phase's DP — its slices never
 * leave) and a disconnected 4★'s isolated phase. An ordinary phase gets cheaper as mass graduates
 * out; these stay at full state-space cost, so run to the full budget they measured at tens of
 * seconds to minutes (e.g. 45s for three disconnected 4★s at the default 90 pulls, 131s at 900).
 *
 * Deliberate, user-approved tradeoff: results are exact within this many pulls of entering the
 * phase; past it, a disconnected phase's arrays are padded with their last value
 * (padWithLastValue) and continuation mass stops pulling, so the affected curves plateau slightly
 * early. 400 is well past where any realistic target (even C6/R5) saturates.
 */
const MAX_CONTINUATION_HORIZON_PULLS = 400;

/** Pads `arr` to `targetLength` by repeating its last value — a capped phase claims no progress
 * past its horizon (see MAX_CONTINUATION_HORIZON_PULLS). */
function padWithLastValue(arr: Float64Array, targetLength: number): Float64Array {
  if (arr.length >= targetLength) return arr;
  const result = new Float64Array(targetLength);
  result.set(arr);
  const last = arr.length > 0 ? arr[arr.length - 1] : 0;
  for (let i = arr.length; i < targetLength; i++) result[i] = last;
  return result;
}

/** Pads every pull-indexed field of a capped phase's result to the global length (exitSubstateDist
 * is a state distribution, so it's left as is), so everything downstream can assume
 * `maxPulls + 1`-long arrays. */
function padPhaseDpResult(result: PhaseDpResult, targetLength: number): PhaseDpResult {
  return {
    exitSubstateDist: result.exitSubstateDist,
    localPrefixDone: result.localPrefixDone.map((arr) => padWithLastValue(arr, targetLength)),
    graduatedPrefixDone: result.graduatedPrefixDone.map((arr) => padWithLastValue(arr, targetLength)),
    blockingPrefixDone: padWithLastValue(result.blockingPrefixDone, targetLength),
    activeLevelCounts: result.activeLevelCounts.map((levels) => levels.map((arr) => padWithLastValue(arr, targetLength))),
    graduatedLevelCounts: result.graduatedLevelCounts.map((levels) => levels.map((arr) => padWithLastValue(arr, targetLength))),
    continuationLevelCounts: result.continuationLevelCounts?.map((levels) => levels.map((arr) => padWithLastValue(arr, targetLength))),
  };
}

/**
 * Sets `fatePoints` to 0 across a (bannerCode, persistentCode) distribution — a new weapon banner
 * is a new Epitomized Path selection, so progress toward the previous banner's weapon doesn't carry
 * (phases.ts's isWeaponFatePointsResetOnEntry decides when). Everything else, `guaranteed5`
 * included, carries over; states that differed only in fatePoints merge, so mass is summed.
 */
function resetWeaponFatePoints(dist: Map<number, number>, persistentModulus: number): Map<number, number> {
  const reset = new Map<number, number>();
  for (const [k, v] of dist) {
    const bannerCode = Math.floor(k / persistentModulus);
    const persistentCode = k % persistentModulus;
    const decoded = decodeWeaponState(bannerCode);
    const resetBannerCode = encodeWeaponState({ ...decoded, fatePoints: 0 });
    const newKey = resetBannerCode * persistentModulus + persistentCode;
    reset.set(newKey, (reset.get(newKey) ?? 0) + v);
  }
  return reset;
}

/** The index into activeLevelCounts[fi]/graduatedLevelCounts[fi]/accumulatedLevelCounts[banner][fi]
 * representing "this goal's own target is reached": index `level` means "copies >= level+1",
 * so it's one less than the copies the goal needs. */
function fourStarTargetLevelIndex(goal: Goal): number {
  return copiesNeeded(goal) - 1;
}

/**
 * result[l] = P(4★ `fi` has reached its own target level by local pull l), active plus graduated
 * mass. Resolves a side-tracked goal on its own copy count: `blockingPrefixDone` would also require
 * the blocking phase's other members (its own 5★, other 4★s) to be done.
 */
function goalAloneDoneCumulative(result: PhaseDpResult, fi: number, level: number): Float64Array {
  const active = result.activeLevelCounts[fi][level];
  const graduated = result.graduatedLevelCounts[fi][level];
  const out = new Float64Array(active.length);
  for (let l = 0; l < out.length; l++) out[l] = active[l] + graduated[l];
  return out;
}

/**
 * The live engine: exact probability propagation, no sampling. Goals are grouped into phases
 * (phases.ts); each phase runs its own exact DP (phaseDp.ts) over its banner's state, a phase-local
 * 5★ character FIFO counter and a banner-wide persistent vector (4★ copies, 5★ weapon flags —
 * goalTracking.ts's PersistentSpec). Phases are stitched onto the global pull axis by convolving
 * each phase's local completion curve with its arrival-time density, which in turn is the
 * convolution of every earlier phase's completion density. See ARCHITECTURE.md.
 */
export function runExactSimulation(input: SimulationInput): SimulationResult {
  const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const { pullBudget, goals, crModelId, crParams } = input;
  const crModel = CR_MODELS[crModelId];
  const maxPulls = pullBudget;

  const phases = buildPhases(goals);
  // Disconnected 4★s' isolated phases get a capped horizon (MAX_CONTINUATION_HORIZON_PULLS).
  const disconnectedIds = computeDisconnectedFourStarGoalIds(goals);

  // Built once per banner from the whole goal list, so codes encoded against it stay valid in
  // every phase of that banner.
  const persistentSpecByBanner = {
    character: buildPersistentSpec('character', goals),
    weapon: buildPersistentSpec('weapon', goals),
  } as const;
  const persistentModulusByBanner: Record<BannerKind, number> = {
    character: persistentSpecByBanner.character.dims.reduce((a, b) => a * b, 1) || 1,
    weapon: persistentSpecByBanner.weapon.dims.reduce((a, b) => a * b, 1) || 1,
  };

  const allPersistentFourStarGoals = [
    ...persistentSpecByBanner.character.fourStarGoals.map((fg) => fg.goal),
    ...persistentSpecByBanner.weapon.fourStarGoals.map((fg) => fg.goal),
  ];

  // Every 4★'s blocking phase (phases.ts's resolveFourStarBlockingPhase).
  const blockingPhaseByGoalId = computeFourStarBlockingPhaseByGoalId(phases, allPersistentFourStarGoals);

  // Each phase's closed 4★ set (phases.ts's computeClosedFourStarGoalIdsForPhase): the 4★s of its
  // banner that aren't on its roster.
  const closedByPhase = phases.map((phase, p) =>
    computeClosedFourStarGoalIdsForPhase(
      phases,
      p,
      persistentSpecByBanner[phase.banner].fourStarGoals.map((fg) => fg.goal),
    ),
  );
  // frozenAfterByBanner[banner][fi]: the last phase in which that 4★ is on the roster, when she's
  // off it for every later phase of her banner (so her copies never change after it). Undefined if
  // she's still on the roster in her banner's last phase.
  const frozenAfterByBanner = {} as Record<BannerKind, (number | undefined)[]>;
  for (const banner of ['character', 'weapon'] as const) {
    const bannerPhases = phases.flatMap((phase, p) => (phase.banner === banner ? [p] : []));
    const lastBannerPhase = bannerPhases[bannerPhases.length - 1];
    frozenAfterByBanner[banner] = persistentSpecByBanner[banner].fourStarGoals.map(({ goal }) => {
      const openPhases = bannerPhases.filter((p) => !closedByPhase[p].has(goal.id));
      const lastOpen = openPhases[openPhases.length - 1];
      return lastOpen !== undefined && lastOpen < lastBannerPhase ? lastOpen : undefined;
    });
  }

  // Global, per-goal cumulative "prefix done" arrays (K = 0-indexed global goal position).
  const globalPrefixDone: Float64Array[] = goals.map(() => new Float64Array(maxPulls + 1));

  // Running arrival-time density for "the phase currently being processed is entered
  // at exactly global pull tau". Phase 1 starts at global pull 0 with certainty.
  let arrivalDensity: Float64Array = new Float64Array(maxPulls + 1);
  arrivalDensity[0] = 1;

  const lastPhaseResultByBanner = new Map<BannerKind, PhaseDpResult>();
  const bannerUsedBefore = new Set<BannerKind>();
  // The phaseModulus each stored exitSubstateDist was encoded with — it varies per phase, and is
  // needed to decode that distribution when seeding the banner's next phase.
  const lastPhaseModulusByBanner = new Map<BannerKind, number>();
  // Character phases sharing a linked FIFO window with another phase (phases.ts's
  // computeCharacterWindowPartnerPhase): both get the combined goal list, and the second one
  // carries the FIFO code over instead of resetting it — so a featured win landing while the first
  // phase is held open can claim the second phase's slot.
  const characterWindowPartnerByPhase = new Map<number, number>();
  for (let p = 0; p < phases.length; p++) {
    if (phases[p].banner !== 'character') continue;
    const partner = computeCharacterWindowPartnerPhase(phases, p);
    if (partner !== undefined) characterWindowPartnerByPhase.set(p, partner);
  }

  // Whether phase p is its banner's last. Phases don't strictly alternate banners (two unlinked
  // weapon goals are two consecutive weapon phases), so this and the graduated-breakdown handling
  // below never assume they do.
  const isLastUsage: boolean[] = phases.map((phase, p) => !phases.slice(p + 1).some((later) => later.banner === phase.banner));

  // Each 4★'s full breakdown, accumulated across every phase of its banner (see phaseDp.ts's
  // activeLevelCounts/graduatedLevelCounts), from these contributions, all convolved with the
  // phase's arrival density:
  // (1) every phase's active mass;
  // (2) graduated mass whose copies can't change any more — from the banner's last phase, or from
  //     the 4★'s own last open phase once she's off the roster for good (frozenAfterByBanner).
  //     Counting it there, instead of through later phases' hand-offs, keeps it exact: a hand-off
  //     averages the carried state over arrival time, losing how copies correlate with timing.
  // (3) the very last phase's graduated mass as it keeps pulling in the trailing continuation
  //     (phaseDp.ts's continuationLevelCounts);
  // (4) any other phase's graduated mass while it's "in transit" to the banner's next phase —
  //     from graduation until that phase starts, when (1) takes over. Other-banner phases never
  //     touch this banner's state, so the copies held at graduation don't depend on how long the
  //     gap lasts: the contribution is the graduation density convolved with the gap's survival.
  const accumulatedLevelCounts: Record<BannerKind, Float64Array[][]> = {
    character: persistentSpecByBanner.character.fourStarGoals.map((fg) => Array.from({ length: fg.maxCopies }, () => new Float64Array(maxPulls + 1))),
    weapon: persistentSpecByBanner.weapon.fourStarGoals.map((fg) => Array.from({ length: fg.maxCopies }, () => new Float64Array(maxPulls + 1))),
  };

  // Per banner: graduated mass from that banner's most recent non-last-usage
  // phase, in transit until the banner's NEXT phase starts. The gap can span
  // several other-banner phases (e.g. character -> weapon -> weapon ->
  // character, since two unlinked weapon goals are separate phases), so
  // `gapDensity` accumulates the convolution of every intervening phase's own
  // completion density — the in-transit mass counts until that whole gap is
  // over, not just the first intervening phase. Both banners can have one
  // outstanding at once (each resolves when its own banner comes back up).
  const pendingInTransit = new Map<BannerKind, { globalGraduationDensity: Float64Array[][]; gapDensity: Float64Array }>();

  // Side tracks. A 4★ whose blocking phase comes after its natal phase doesn't hold up its natal
  // phase, so neither its own series entry nor those of goals after it (up to its blocking phase)
  // can come straight from their phase's localPrefixDone: each also needs "and that 4★ is done".
  // From its natal phase to its blocking phase, a second density stream runs alongside
  // arrivalDensity: gDoneDensity ("reached here, and the 4★ is already done") is used for those
  // entries, and gPendingDensity (not done yet) is carried forward and resolved at the blocking
  // phase against the 4★'s own copy count (goalAloneDoneCumulative). From the blocking phase on,
  // the ordinary arrivalDensity already requires it.
  //
  // Exact for one side track at a time. A second non-blocking 4★ met while one is active falls back
  // to pendingSeriesBridge (below), an approximation bounded by the monotonicity clamp.
  interface ActiveSideTrack {
    globalIdx: number;
    natalPhase: number;
    blockingPhase: number;
    /** The 4★ being followed and the level index of its own target, for resolving it on its own
     * copy count rather than the blocking phase's whole condition. */
        fi: number;
    level: number;
    /** Its series entry's part from finishing within its natal phase (already on the global axis);
     * the gPendingDensity part is added at the blocking phase. */
        withinNatalContribution: Float64Array;
    gDoneDensity: Float64Array;
    gPendingDensity: Float64Array;
    /** Other series entries computed with gDoneDensity while this track was active (goals between
     * its natal and blocking phases). The 4★ finishing later, in its blocking phase, satisfies them
     * too, so they get the pending resolution added as well. */
        affectedGlobalIndices: number[];
  }
  let activeSideTrack: ActiveSideTrack | null = null;
/** Fallback for a second non-blocking 4★ found while a side track is active: after the loop its
 * series entry is set to (its full breakdown at target level) − (its natal phase's active
 * contribution), floored at 0. An approximation, bounded by the monotonicity clamp. */
  const pendingSeriesBridge = new Map<number, { banner: BannerKind; fi: number; level: number; natalActive: Float64Array }>();

  for (let p = 0; p < phases.length; p++) {
    const phase = phases[p];
    const persistentSpec = persistentSpecByBanner[phase.banner];
    const persistentModulus = persistentModulusByBanner[phase.banner];

    // The goal list this phase's phase-local FIFO is built from: phase.goals itself, or for one
    // half of a split linked character window, both halves' goals combined
    // (phases.ts's computeCharacterWindowGoalsForPhase).
    const hasWindowPartner = characterWindowPartnerByPhase.has(p);
    const windowPartner = characterWindowPartnerByPhase.get(p);
    const isSecondOfWindowPair = hasWindowPartner && windowPartner! < p;
    const effectivePhaseGoals = hasWindowPartner ? computeCharacterWindowGoalsForPhase(phases, p) : phase.goals;
    const phaseModulusForThisPhase = buildPhaseLocalSpec(effectivePhaseGoals).dims.reduce((a, b) => a * b, 1) || 1;

    const startDist = new Map<number, number>();
    if (!bannerUsedBefore.has(phase.banner)) {
      const bannerCode =
        phase.banner === 'character' ? encodeCharState(input.characterBanner.state) : encodeWeaponState(input.weaponBanner.state);
      // First use of this banner: the input state, with no copies and no FIFO claims yet.
      startDist.set((bannerCode * persistentModulus + 0) * phaseModulusForThisPhase + 0, 1);
    } else {
      const prev = lastPhaseResultByBanner.get(phase.banner);
      if (prev) {
        const normalized = normalizeDist(prev.exitSubstateDist);
        // Fate Points reset for a new weapon banner (see resetWeaponFatePoints). Its 2-part key
        // decoding is right here: a weapon phase's phaseModulus is always 1.
        const carried = isWeaponFatePointsResetOnEntry(phases, p) ? resetWeaponFatePoints(normalized, persistentModulus) : normalized;
        if (isSecondOfWindowPair) {
          // Second half of a split linked window: encoded against the same combined goal list, so
          // the FIFO code carries over as-is.
          for (const [k, v] of carried) startDist.set(k, (startDist.get(k) ?? 0) + v);
        } else {
          // Ordinary reoccurrence: keep (bannerCode, persistentCode), decoded with the previous
          // phase's modulus, and start this phase's FIFO at 0 — its 5★ goals are later wins.
          const prevPhaseModulus = lastPhaseModulusByBanner.get(phase.banner)!;
          for (const [k, v] of carried) {
            const rest = Math.floor(k / prevPhaseModulus);
            const persistentCode = rest % persistentModulus;
            const bannerCode = Math.floor(rest / persistentModulus);
            const newKey = (bannerCode * persistentModulus + persistentCode) * phaseModulusForThisPhase + 0;
            startDist.set(newKey, (startDist.get(newKey) ?? 0) + v);
          }
        }
      }
    }
    bannerUsedBefore.add(phase.banner);

    const closedGoalIds = closedByPhase[p];

    // 5★ weapons not on this phase's weapon banner (empty in effect on the character banner).
    const closedFiveStarWeaponTargetIds = computeClosedFiveStarWeaponTargetIdsForPhase(
      phases,
      p,
      goals.filter((g) => g.kind === '5star_weapon'),
    );

    // This phase's own banner configs: its 4★ pool, and its Epitomized Path chosen/other.
    const characterConfig = computeCharacterBannerConfigForPhase(
      phases,
      p,
      persistentSpecByBanner.character.fourStarGoals.map((fg) => fg.goal),
      input.characterBanner.featured5StarId,
    );
    const weaponConfig = computeWeaponBannerConfigForPhase(
      phases,
      p,
      persistentSpecByBanner.weapon.fourStarGoals.map((fg) => fg.goal),
    );
    // The Epitomized Path retarget config, for a two-weapon window.
    const weaponConfigAfterFirstClaimed = computeWeaponBannerConfigAfterFirstClaimedForPhase(
      phases,
      p,
      persistentSpecByBanner.weapon.fourStarGoals.map((fg) => fg.goal),
    );

    // What gates this phase's graduation: its own 5★ goals plus the 4★s whose blocking phase it is.
    const blockingFourStarIds = computeBlockingFourStarGoalIdsForPhase(
      p,
      persistentSpec.fourStarGoals.map((fg) => fg.goal),
      blockingPhaseByGoalId,
    );
    const blockingGoals = [
      ...phase.goals.filter((g) => g.kind === '5star_character' || g.kind === '5star_weapon'),
      ...persistentSpec.fourStarGoals.map((fg) => fg.goal).filter((g) => blockingFourStarIds.has(g.id)),
    ];
    // Whether a 4★ from an earlier phase blocks this one. Its position precedes every native
    // goal's, so each native localPrefixDone[k] (which only checks phase.goals[0..k]) is capped by
    // blockingPrefixDone, which also requires it.
    const hasExtraBlockingFourStars = blockingFourStarIds.size > 0 && [...blockingFourStarIds].some((id) => !phase.goals.some((g) => g.id === id));

    // A disconnected 4★'s isolated phase runs to a capped horizon (MAX_CONTINUATION_HORIZON_PULLS).
    const isDisconnectedGoalPhase = phase.goals.length === 1 && disconnectedIds.has(phase.goals[0].id);
    const phaseHorizon = isDisconnectedGoalPhase ? Math.min(maxPulls, MAX_CONTINUATION_HORIZON_PULLS) : maxPulls;
    // The very last phase also runs the trailing continuation: graduated mass keeps pulling on this
    // banner (a player with budget left doesn't stop), so 4★s on this roster keep collecting copies
    // past their targets — the breakdown always shows every level. No Fate Point reset: the same
    // banner continues. Its 5★ ids are placeholders, since only 4★ copies matter from here.
    const isLastPhase = p === phases.length - 1;
    let continuation: ContinuationSpec | undefined;
    if (isLastPhase && persistentSpec.fourStarGoals.length > 0) {
      const openTargetIds = persistentSpec.fourStarGoals.filter((fg) => !closedGoalIds.has(fg.goal.id)).map((fg) => fg.goal.targetId);
      continuation = {
        characterConfig: { featured5StarId: input.characterBanner.featured5StarId, featured4StarIds: padIds(openTargetIds, 3, 'continuation-4star-char') },
        weaponConfig: {
          chosenWeaponId: 'continuation-chosen-weapon',
          otherFeaturedWeaponId: 'continuation-other-weapon',
          featured4WeaponIds: padIds(openTargetIds, 5, 'continuation-4star-weapon'),
        },
        closedGoalIds,
        horizon: MAX_CONTINUATION_HORIZON_PULLS,
      };
    }
    const rawResult = runPhaseDp(
      phase.banner,
      effectivePhaseGoals,
      persistentSpec,
      startDist,
      characterConfig,
      weaponConfig,
      crModel,
      crParams,
      phaseHorizon,
      closedGoalIds,
      closedFiveStarWeaponTargetIds,
      weaponConfigAfterFirstClaimed,
      blockingGoals,
      continuation,
    );
    const result = isDisconnectedGoalPhase ? padPhaseDpResult(rawResult, maxPulls + 1) : rawResult;
    lastPhaseResultByBanner.set(phase.banner, result);
    lastPhaseModulusByBanner.set(phase.banner, phaseModulusForThisPhase);
    const thisPhaseCompletionDensity = cumulativeToDensity(result.blockingPrefixDone);

    // Align this phase's outputs onto the global pull axis — with the active side track's
    // gDoneDensity instead of arrivalDensity while we're before its blocking phase. (The `as`
    // re-widens a `let` that's reassigned later in the loop, which TS narrowing mistracks.)
    const currentSideTrack = activeSideTrack as ActiveSideTrack | null;
    const effectiveDensity = currentSideTrack !== null && p < currentSideTrack.blockingPhase ? currentSideTrack.gDoneDensity : arrivalDensity;
    const fourStarIndexById = new Map(persistentSpec.fourStarGoals.map((fg, fi) => [fg.goal.id, fi]));
    for (let k = 0; k < phase.goals.length; k++) {
      const globalIdx = phase.globalStartIndex + k;
      const goal = phase.goals[k];
      // result's prefix arrays are indexed by position in effectivePhaseGoals, which differs from
      // k for the second half of a split linked window.
      const specIdx = effectivePhaseGoals === phase.goals ? k : effectivePhaseGoals.findIndex((g) => g.id === goal.id);
      const fi = fourStarIndexById.get(goal.id);
      if (fi !== undefined && !blockingFourStarIds.has(goal.id)) {
        const goalBlockingPhase = blockingPhaseByGoalId.get(goal.id);
        // Unreachable for a real goal list (every goal has a phase); defensive.
        if (goalBlockingPhase === undefined) continue;
        if (!activeSideTrack) {
          const withinNatalContribution = convolve(effectiveDensity, result.localPrefixDone[specIdx]);
          const gDoneCumulative = convolve(effectiveDensity, result.graduatedPrefixDone[specIdx]);
          const blockingCumulative = convolve(effectiveDensity, result.blockingPrefixDone);
          const gPendingCumulative = new Float64Array(maxPulls + 1);
          for (let n = 0; n <= maxPulls; n++) gPendingCumulative[n] = Math.max(0, blockingCumulative[n] - gDoneCumulative[n]);
          activeSideTrack = {
            globalIdx,
            natalPhase: p,
            blockingPhase: goalBlockingPhase,
            withinNatalContribution,
            gDoneDensity: cumulativeToDensity(gDoneCumulative),
            gPendingDensity: cumulativeToDensity(gPendingCumulative),
            affectedGlobalIndices: [],
            fi,
            level: fourStarTargetLevelIndex(goal),
          };
        } else {
          // A second non-blocking goal while a track is active (rare): pendingSeriesBridge.
          const level = fourStarTargetLevelIndex(goal);
          pendingSeriesBridge.set(globalIdx, { banner: phase.banner, fi, level, natalActive: convolve(effectiveDensity, result.activeLevelCounts[fi][level]) });
        }
        continue;
      }
      const nativeLocalPrefixDone = hasExtraBlockingFourStars ? minArray(result.localPrefixDone[specIdx], result.blockingPrefixDone) : result.localPrefixDone[specIdx];
      globalPrefixDone[globalIdx] = convolve(effectiveDensity, nativeLocalPrefixDone);
      // Computed with the side track's gDoneDensity: it also gets the track's pending resolution.
      if (currentSideTrack !== null && effectiveDensity === currentSideTrack.gDoneDensity) {
        currentSideTrack.affectedGlobalIndices.push(globalIdx);
      }
    }

    // The side track's blocking phase: resolve its pending stream against the tracked goal's own
    // copy count (goalAloneDoneCumulative), not this phase's whole blocking condition.
    if (activeSideTrack && activeSideTrack.blockingPhase === p) {
      const pendingContribution = convolve(
        activeSideTrack.gPendingDensity,
        goalAloneDoneCumulative(result, activeSideTrack.fi, activeSideTrack.level),
      );
      const resolved = new Float64Array(maxPulls + 1);
      for (let n = 0; n <= maxPulls; n++) resolved[n] = activeSideTrack.withinNatalContribution[n] + pendingContribution[n];
      globalPrefixDone[activeSideTrack.globalIdx] = resolved;
      // ...and credit the same resolution to every entry computed with gDoneDensity.
      for (const otherGlobalIdx of activeSideTrack.affectedGlobalIndices) {
        const target = globalPrefixDone[otherGlobalIdx];
        for (let n = 0; n <= maxPulls; n++) target[n] += pendingContribution[n];
      }
      activeSideTrack = null;
    } else if (activeSideTrack && activeSideTrack.natalPhase !== p) {
      // A phase in between: both streams advance like arrivalDensity. (The natal phase's own
      // timing was already applied when the track was created.)
      activeSideTrack.gDoneDensity = convolve(activeSideTrack.gDoneDensity, thisPhaseCompletionDensity);
      activeSideTrack.gPendingDensity = convolve(activeSideTrack.gPendingDensity, thisPhaseCompletionDensity);
    }

    // In-transit mass (see pendingInTransit's declaration): THIS phase extends
    // the other banner's gap, or — if it's on the pending banner itself — ends
    // it, in which case the mass counts for exactly as long as the whole gap
    // lasted (survival = 1 - the gap's CDF), after which this phase's own
    // activeLevelCounts pick it up from its startDist.
    for (const [pendingBanner, pending] of pendingInTransit) {
      if (pendingBanner !== phase.banner) {
        pending.gapDensity = convolve(pending.gapDensity, thisPhaseCompletionDensity);
        continue;
      }
      const survival = new Float64Array(maxPulls + 1);
      let gapCdf = 0;
      for (let m = 0; m <= maxPulls; m++) {
        gapCdf += pending.gapDensity[m];
        survival[m] = 1 - gapCdf;
      }
      const pendingAccumulator = accumulatedLevelCounts[pendingBanner];
      for (let fi = 0; fi < pending.globalGraduationDensity.length; fi++) {
        for (let level = 0; level < pending.globalGraduationDensity[fi].length; level++) {
          const contribution = convolve(pending.globalGraduationDensity[fi][level], survival);
          const target = pendingAccumulator[fi][level];
          for (let n = 0; n <= maxPulls; n++) target[n] += contribution[n];
        }
      }
      pendingInTransit.delete(pendingBanner);
    }

    const bannerAccumulator = accumulatedLevelCounts[phase.banner];
    const addConvolved = (fi: number, curves: Float64Array[]) => {
      for (let level = 0; level < curves.length; level++) {
        const contribution = convolve(arrivalDensity, curves[level]);
        const target = bannerAccumulator[fi][level];
        for (let n = 0; n <= maxPulls; n++) target[n] += contribution[n];
      }
    };
    const nextPhase = phases[p + 1];
    const inTransit: Float64Array[][] = persistentSpec.fourStarGoals.map(() => []);
    let anyInTransit = false;
    for (let fi = 0; fi < persistentSpec.fourStarGoals.length; fi++) {
      const frozenAfter = frozenAfterByBanner[phase.banner][fi];
      if (frozenAfter !== undefined && p > frozenAfter) continue; // her copies were fully counted at frozenAfter
      addConvolved(fi, result.activeLevelCounts[fi]); // (1)
      if (isLastPhase) {
        if (result.continuationLevelCounts) addConvolved(fi, result.continuationLevelCounts[fi]); // (3)
      } else if (frozenAfter === p || isLastUsage[p]) {
        addConvolved(fi, result.graduatedLevelCounts[fi]); // (2)
      } else if (nextPhase.banner === phase.banner) {
        // An immediately following same-banner phase starts from this exit state: its (1) covers it.
      } else {
        inTransit[fi] = result.graduatedLevelCounts[fi].map((curve) => convolve(arrivalDensity, cumulativeToDensity(curve))); // (4)
        anyInTransit = true;
      }
    }
    if (anyInTransit) {
      const gapDensity = new Float64Array(maxPulls + 1);
      gapDensity[0] = 1;
      pendingInTransit.set(phase.banner, { globalGraduationDensity: inTransit, gapDensity });
    }

    // The next phase's arrival density: phase durations add, so their densities convolve.
    arrivalDensity = convolve(arrivalDensity, thisPhaseCompletionDensity);
  }

  // Resolve pendingSeriesBridge now that accumulatedLevelCounts is final.
  const sortedBridgeEntries = Array.from(pendingSeriesBridge.entries()).sort(([a], [b]) => a - b);
  for (const [globalIdx, { banner, fi, level, natalActive }] of sortedBridgeEntries) {
    const total = accumulatedLevelCounts[banner][fi][level];
    const resolved = new Float64Array(maxPulls + 1);
    for (let n = 0; n <= maxPulls; n++) resolved[n] = Math.max(0, total[n] - natalActive[n]);
    globalPrefixDone[globalIdx] = resolved;
  }

  // Monotonicity clamp: prefix k is a strictly harder requirement than prefix k-1, so
  // series[k] <= series[k-1]. An entry after a non-blocking 4★ can otherwise come out higher —
  // it was computed from its own phase without knowing that 4★ might still be pending. This makes
  // those later entries a conservative upper bound rather than an exact joint computation.
  for (let k = 1; k < goals.length; k++) {
    const prefix = globalPrefixDone[k];
    const prev = globalPrefixDone[k - 1];
    for (let n = 0; n <= maxPulls; n++) if (prefix[n] > prev[n]) prefix[n] = prev[n];
  }

  const rawBreakdowns: { goal: Goal; labels: string[]; levelProbabilities: number[][] }[] = [];
  for (const banner of bannerUsedBefore) {
    const bannerPersistentSpec = persistentSpecByBanner[banner];
    const bannerAccumulator = accumulatedLevelCounts[banner];
    for (let fi = 0; fi < bannerPersistentSpec.fourStarGoals.length; fi++) {
      const goal = bannerPersistentSpec.fourStarGoals[fi].goal;
      const fourStarKind = goal.kind === '4star_character' ? '4star_character' : '4star_weapon';
      const labels = LEVEL_OPTIONS[fourStarKind].map((level) => levelLabel(fourStarKind, level));
      const levelProbabilities = bannerAccumulator[fi].map((arr) => Array.from(arr));
      rawBreakdowns.push({ goal, labels, levelProbabilities });
    }
  }
  const goalPosition = new Map(goals.map((g, i) => [g.id, i]));
  rawBreakdowns.sort((a, b) => goalPosition.get(a.goal.id)! - goalPosition.get(b.goal.id)!);
  const breakdowns: LevelBreakdownSeries[] = rawBreakdowns.map(({ goal, labels, levelProbabilities }) => ({
    goalId: goal.id,
    goalName: goal.name,
    levelLabels: labels,
    levelProbabilities,
  }));

  const pullCounts = Array.from({ length: maxPulls + 1 }, (_, i) => i);
  const series: SimulationSeries[] = [];
  for (let k = 1; k <= goals.length; k++) {
    const prefix = goals.slice(0, k);
    series.push({
      prefixLength: k,
      goalIds: prefix.map((g: Goal) => g.id),
      label: prefix.map((g: Goal) => g.name).join(' + '),
      probabilities: Array.from(globalPrefixDone[k - 1]),
    });
  }

  const end = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return { pullCounts, series, breakdowns, meta: { elapsedMs: end - start, engine: 'exact' } };
}
