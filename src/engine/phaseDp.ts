import { transitionCharacterBanner } from './characterBanner';
import { transitionWeaponBanner } from './weaponBanner';
import { CHAR_BANNER_MODULUS, WEAPON_BANNER_MODULUS, decodeCharState, decodeWeaponState, encodeCharState, encodeWeaponState } from './stateCodec';
import {
  buildPhaseLocalSpec,
  copyCountOf,
  decodeVector,
  encodeVector,
  isGoalDone,
  isPhaseFullyDone,
  updateGoalTracking,
  type PersistentSpec,
} from './goalTracking';
import type {
  BannerKind,
  CRModel,
  CRParams,
  CharacterBannerConfig,
  Goal,
  PullOutcome,
  WeaponBannerConfig,
} from './types';

export interface PhaseDpResult {
  /**
   * Total (unnormalized) mass that graduates within maxPulls, keyed by
   * `(bannerCode * persistentModulus + persistentCode) * phaseModulus + phaseCode` (moduli = products
   * of the persistent / this phase's own phase-local dims). Normalized, it seeds the banner's next
   * phase. The persistent spec is shared by all of a banner's phases, so persistentCode carries over
   * as-is; phaseCode only means something to a next phase built from the same `phaseGoals` (a linked
   * character window split by a detour), so exactEngine.ts resets it otherwise.
   */
    exitSubstateDist: Map<number, number>;
  /**
   * localPrefixDone[k][l] = P(phaseGoals[0..k] all done by local pull l | entered at l=0). Not simply
   * blockingPrefixDone: a phaseGoals member can be a non-blocking 4★ (it blocks a later phase), so
   * graduating doesn't imply it's done. Computed from each mass's joint prefix streak, so it's exact
   * within the phase; exactEngine.ts bridges a non-blocking goal's later resolution.
   */
    localPrefixDone: Float64Array[];
  /** The graduated-only part of localPrefixDone — exactEngine.ts's side-track needs "done and
   * graduated" apart from "done but still active". */
    graduatedPrefixDone: Float64Array[];
  /** blockingPrefixDone[l] = P(this phase's graduation condition — `blockingGoals`, not
   * `phaseGoals` — met by local pull l). Drives exitSubstateDist's timing and so the next phase's
   * arrival in exactEngine.ts. */
    blockingPrefixDone: Float64Array;
  /**
   * activeLevelCounts[fi][level][l] / graduatedLevelCounts[fi][level][l] = P(4★ `fi` — indexed like
   * persistentSpec.fourStarGoals, i.e. every 4★ on the banner — has >= level+1 copies by local pull
   * l), split by whether that mass is still active in this phase or has graduated (frozen at
   * graduation). Kept apart because exactEngine.ts combines them differently across a banner's
   * phases: every phase's active mass counts, but a non-last phase's graduated mass continues into
   * the next phase via exitSubstateDist (and is counted there), so it's only bridged while in transit.
   */
    activeLevelCounts: Float64Array[][];
  graduatedLevelCounts: Float64Array[][];
  /** Only with a `continuation`: continuationLevelCounts[fi][level][l] = P(4★ `fi` has >= level+1
   * copies by local pull l) over mass that has graduated and kept pulling in the continuation —
   * i.e. graduatedLevelCounts, but with those copies still growing after graduation. */
  continuationLevelCounts?: Float64Array[][];
}

/**
 * The trailing continuation, run inside the last real phase's own DP (see exactEngine.ts): once
 * mass graduates, a real player keeps pulling on this banner, so 4★s on this roster keep collecting
 * copies past their targets. Running it here, rather than as a separate phase seeded from the
 * normalized exit distribution, keeps each graduate's copies tied to when it graduated — the
 * averaged hand-off put a 5-10pp error into the levels above a target.
 */
export interface ContinuationSpec {
  characterConfig: CharacterBannerConfig;
  weaponConfig: WeaponBannerConfig;
  /** 4★s not on the roster (the last phase's own closed set). */
  closedGoalIds: ReadonlySet<string>;
  /** Continuation mass stops pulling after this local pull (MAX_CONTINUATION_HORIZON_PULLS): past
   * it the curves plateau, which bounds the cost for large budgets. */
  horizon: number;
}

interface CachedTransition {
  probability: number;
  outcome: PullOutcome;
  nextBannerCode: number;
  /** Index into `outcomeShapes`, resolved once per bannerCode — the innermost loop reads it, where
   * an array index beats a string-keyed Map. */
    outcomeIndex: number;
}

interface BannerAdapter {
  bannerModulus: number;
  getTransitions(bannerCode: number): CachedTransition[];
}

/**
 * A stable key for a PullOutcome's shape (rarity + kind + itemId). Featured / featured_other 5★s
 * are keyed by itemId alone: the Epitomized Path retarget adapter swaps which weapon is "chosen",
 * so the same physical weapon can arrive labelled either way, and updateGoalTracking only looks at
 * itemId there. Both adapters therefore share one outcome index space.
 */
function outcomeKey(outcome: PullOutcome): string {
  if (outcome.rarity === 3) return '3';
  if (outcome.rarity === 5 && outcome.kind !== 'standard') return `5f|${outcome.itemId}`;
  if ('itemId' in outcome) return `${outcome.rarity}|${outcome.kind}|${outcome.itemId}`;
  return `${outcome.rarity}|${outcome.kind}`;
}

/**
 * Every outcome shape a banner config can produce. Independent of bannerCode, which only changes
 * each shape's probability and next state — the small fixed set (~4-8) the DP computes goal
 * tracking for, once per slice per pull.
 */
function enumerateOutcomeShapes(banner: BannerKind, characterConfig: CharacterBannerConfig, weaponConfig: WeaponBannerConfig): PullOutcome[] {
  if (banner === 'character') {
    const shapes: PullOutcome[] = [
      { rarity: 3 },
      { rarity: 4, kind: 'standard' },
      { rarity: 5, kind: 'standard' },
      { rarity: 5, kind: 'featured', itemId: characterConfig.featured5StarId },
    ];
    for (const itemId of characterConfig.featured4StarIds) shapes.push({ rarity: 4, kind: 'featured', itemId });
    return shapes;
  }
  const shapes: PullOutcome[] = [
    { rarity: 3 },
    { rarity: 4, kind: 'standard' },
    { rarity: 5, kind: 'standard' },
    { rarity: 5, kind: 'featured', itemId: weaponConfig.chosenWeaponId },
    { rarity: 5, kind: 'featured_other', itemId: weaponConfig.otherFeaturedWeaponId },
  ];
  for (const itemId of weaponConfig.featured4WeaponIds) shapes.push({ rarity: 4, kind: 'featured', itemId });
  return shapes;
}

/**
 * Transitions per bannerCode (a pure function of it, for this phase's fixed config), memoized in
 * a dense array indexed by bannerCode, each carrying its next bannerCode and outcome index.
 */
function makeBannerAdapter(
  banner: BannerKind,
  characterConfig: CharacterBannerConfig,
  weaponConfig: WeaponBannerConfig,
  crModel: CRModel,
  crParams: CRParams,
  outcomeKeyToIndex: ReadonlyMap<string, number>,
): BannerAdapter {
  if (banner === 'character') {
    const cache: (CachedTransition[] | undefined)[] = new Array(CHAR_BANNER_MODULUS);
    return {
      bannerModulus: CHAR_BANNER_MODULUS,
      getTransitions(bannerCode: number) {
        const cached = cache[bannerCode];
        if (cached) return cached;
        const state = decodeCharState(bannerCode);
        const transitions = transitionCharacterBanner(state, characterConfig, crModel, crParams).map((t) => ({
          probability: t.probability,
          outcome: t.outcome,
          nextBannerCode: encodeCharState(t.nextState),
          outcomeIndex: outcomeKeyToIndex.get(outcomeKey(t.outcome))!,
        }));
        cache[bannerCode] = transitions;
        return transitions;
      },
    };
  }
  const cache: (CachedTransition[] | undefined)[] = new Array(WEAPON_BANNER_MODULUS);
  return {
    bannerModulus: WEAPON_BANNER_MODULUS,
    getTransitions(bannerCode: number) {
      const cached = cache[bannerCode];
      if (cached) return cached;
      const state = decodeWeaponState(bannerCode);
      const transitions = transitionWeaponBanner(state, weaponConfig).map((t) => ({
        probability: t.probability,
        outcome: t.outcome,
        nextBannerCode: encodeWeaponState(t.nextState),
        outcomeIndex: outcomeKeyToIndex.get(outcomeKey(t.outcome))!,
      }));
      cache[bannerCode] = transitions;
      return transitions;
    },
  };
}

/** One slice's goal-tracking result for one outcome shape. The not-done variant holds its
 * destination slice's dense array, so the innermost loop writes to it by plain index. */
type SliceOutcomeResult =
  | { done: true; newPersistentCode: number; newPhaseCode: number; copiesPerFourStar: number[]; prefixStreak: number; contDest: Float64Array | undefined }
  | { done: false; newSliceKey: number; destArray: Float64Array };

/** dense[bannerCode] = mass, per (persistentCode, phaseCode) slice. Dense because slices are
 * tens of percent full by the end of a run; only slices actually reached are allocated. */
class SliceMap {
  readonly arrays = new Map<number, Float64Array>();
  private readonly bannerModulus: number;

  constructor(bannerModulus: number) {
    this.bannerModulus = bannerModulus;
  }

  /** The dense array for a slice, created on first use. */
    getOrCreateArray(sliceKey: number): Float64Array {
    let arr = this.arrays.get(sliceKey);
    if (!arr) {
      arr = new Float64Array(this.bannerModulus);
      this.arrays.set(sliceKey, arr);
    }
    return arr;
  }

  add(sliceKey: number, bannerCode: number, amount: number): void {
    this.getOrCreateArray(sliceKey)[bannerCode] += amount;
  }
}

/** Total mass in a slice, summed when needed (once per slice per pull) — tracking it on every add
 * was one of the DP's two dominant costs. */
function sumMass(arr: Float64Array): number {
  let total = 0;
  for (let i = 0; i < arr.length; i++) total += arr[i];
  return total;
}

/**
 * The exact DP for one phase, from a normalized distribution over (banner substate, persistent
 * tracking vector, phase-local FIFO vector) at entry. Tracks jointly the banner's pity/CR/fate
 * state, the phase-local 5★ character FIFO counter, and the banner-wide persistent vector (4★
 * copies, 5★ weapon flags — goalTracking.ts's PersistentSpec). Mass that satisfies
 * `blockingGoals` graduates into exitSubstateDist and stops pulling in this phase.
 *
 * State is grouped into slices — one dense Float64Array over bannerCode per distinct
 * (persistentCode, phaseCode) — because the two halves of a pull are independent: the banner
 * transition depends only on bannerCode, and goal tracking only on the slice and the outcome
 * shape. So tracking is computed once per (slice, outcome shape) per pull, and the sweep over
 * bannerCodes is pure array arithmetic. This is the engine's main performance lever.
 *
 * `weaponConfigAfterFirstClaimed` (two-weapon window only): the Epitomized Path retarget — a
 * second adapter built from the swapped config serves every slice whose persistent vector already
 * shows the first weapon obtained.
 */
export function runPhaseDp(
  banner: BannerKind,
  phaseGoals: Goal[],
  persistentSpec: PersistentSpec,
  startDist: Map<number, number>,
  characterConfig: CharacterBannerConfig,
  weaponConfig: WeaponBannerConfig,
  crModel: CRModel,
  crParams: CRParams,
  maxPulls: number,
  closedGoalIds: ReadonlySet<string>,
  closedFiveStarWeaponTargetIds: ReadonlySet<string>,
  weaponConfigAfterFirstClaimed: WeaponBannerConfig | undefined,
  /** The goals gating this phase's graduation: its own 5★ goals plus the 4★s that block it
   * (phases.ts's computeBlockingFourStarGoalIdsForPhase). Required rather than defaulting to
   * `phaseGoals`, so a new caller can't silently get "every member blocks". May include a 4★ that
   * isn't in `phaseGoals` (its natal phase is earlier) — a 4★'s isGoalDone only reads the
   * persistent vector. */
    blockingGoals: Goal[],
  continuation?: ContinuationSpec,
): PhaseDpResult {
  const phaseSpec = buildPhaseLocalSpec(phaseGoals);
  const phaseModulus = phaseSpec.dims.reduce((a, b) => a * b, 1) || 1;
  const persistentModulus = persistentSpec.dims.reduce((a, b) => a * b, 1) || 1;
  const outcomeShapes = enumerateOutcomeShapes(banner, characterConfig, weaponConfig);
  const outcomeKeyToIndex = new Map(outcomeShapes.map((o, i) => [outcomeKey(o), i]));
  const adapter = makeBannerAdapter(banner, characterConfig, weaponConfig, crModel, crParams, outcomeKeyToIndex);
  const adapterAfterFirstClaimed = weaponConfigAfterFirstClaimed
    ? makeBannerAdapter(banner, characterConfig, weaponConfigAfterFirstClaimed, crModel, crParams, outcomeKeyToIndex)
    : undefined;
  const firstWeaponGoalIndex = weaponConfigAfterFirstClaimed ? (persistentSpec.fiveStarWeaponIndexByTargetId.get(weaponConfig.chosenWeaponId) ?? -1) : -1;
  const bannerModulus = adapter.bannerModulus;
  const numFourStar = persistentSpec.fourStarGoals.length;
  const numPhaseGoals = phaseGoals.length;

  // Continuation slices are keyed by persistentCode alone (no phase-local goals).
  const contPhaseSpec = buildPhaseLocalSpec([]);
  const contShapes = continuation ? enumerateOutcomeShapes(banner, continuation.characterConfig, continuation.weaponConfig) : [];
  const contAdapter = continuation
    ? makeBannerAdapter(banner, continuation.characterConfig, continuation.weaponConfig, crModel, crParams, new Map(contShapes.map((o, i) => [outcomeKey(o), i])))
    : undefined;
  const noClosedWeapons: ReadonlySet<string> = new Set();
  let contSlices = new SliceMap(bannerModulus);

  function sliceKeyOf(persistentCode: number, phaseCode: number): number {
    return persistentCode * phaseModulus + phaseCode;
  }

  // startDist/exitSubstateDist keys always carry all three parts (see exitSubstateDist). An
  // ordinary phase pins phaseCode at graduation (its own 5★s all block it), so this adds no
  // distinct keys; whether phaseCode carries into the next phase is exactEngine.ts's call.
  let active = new SliceMap(bannerModulus);
  for (const [startKey, prob] of startDist) {
    const phaseCode = startKey % phaseModulus;
    const rest = Math.floor(startKey / phaseModulus);
    const persistentCode = rest % persistentModulus;
    const bannerCode = Math.floor(rest / persistentModulus);
    active.add(sliceKeyOf(persistentCode, phaseCode), bannerCode, prob);
  }

  const exitSubstateDist = new Map<number, number>();
  const localPrefixDone: Float64Array[] = Array.from({ length: numPhaseGoals }, () => new Float64Array(maxPulls + 1));
  const graduatedPrefixDone: Float64Array[] = Array.from({ length: numPhaseGoals }, () => new Float64Array(maxPulls + 1));
  const blockingPrefixDone = new Float64Array(maxPulls + 1);
  const activeLevelCounts: Float64Array[][] = persistentSpec.fourStarGoals.map((fg) => Array.from({ length: fg.maxCopies }, () => new Float64Array(maxPulls + 1)));
  const graduatedLevelCounts: Float64Array[][] = persistentSpec.fourStarGoals.map((fg) => Array.from({ length: fg.maxCopies }, () => new Float64Array(maxPulls + 1)));
  const continuationLevelCounts: Float64Array[][] | undefined = continuation
    ? persistentSpec.fourStarGoals.map((fg) => Array.from({ length: fg.maxCopies }, () => new Float64Array(maxPulls + 1)))
    : undefined;

  let graduatedTotal = 0;
  // graduatedLevelMass[fourStarIdx][exact copy count at graduation] = accumulated mass
  const graduatedLevelMass: number[][] = persistentSpec.fourStarGoals.map((fg) => new Array(fg.maxCopies + 1).fill(0));
  // graduatedPrefixMassAtStreak[k] = graduated mass whose "phaseGoals[0..k] all done" streak was
  // exactly k (computePrefixStreak). Read as a suffix sum: a longer streak implies every shorter one.
  const graduatedPrefixMassAtStreak: number[] = new Array(numPhaseGoals).fill(0);

  /** The largest k such that phaseGoals[0..k] are ALL done (isGoalDone), or -1 if
   * not even phaseGoals[0] is done. A pure function of the given vectors — safe to
   * call on either a slice's CURRENT vectors (at entry) or a transition's NEW ones. */
  function computePrefixStreak(phaseVector: number[], persistentVector: number[]): number {
    let streak = -1;
    for (let k = 0; k < numPhaseGoals; k++) {
      if (!isGoalDone(phaseSpec, persistentSpec, phaseVector, persistentVector, phaseGoals[k])) break;
      streak = k;
    }
    return streak;
  }

  function recordGraduated(mass: number, phaseVector: number[], persistentVector: number[]): void {
    graduatedTotal += mass;
    for (let fi = 0; fi < numFourStar; fi++) {
      const copies = copyCountOf(persistentSpec, persistentVector, persistentSpec.fourStarGoals[fi].goal.targetId);
      graduatedLevelMass[fi][copies] += mass;
    }
    const streak = computePrefixStreak(phaseVector, persistentVector);
    if (streak >= 0) graduatedPrefixMassAtStreak[streak] += mass;
  }

  function flushGraduatedLevelCounts(l: number): void {
    blockingPrefixDone[l] = graduatedTotal;
    let prefixRunning = 0;
    for (let k = numPhaseGoals - 1; k >= 0; k--) {
      prefixRunning += graduatedPrefixMassAtStreak[k];
      graduatedPrefixDone[k][l] = prefixRunning;
      localPrefixDone[k][l] = prefixRunning; // baseline; reportActive adds still-active mass on top
    }
    for (let fi = 0; fi < numFourStar; fi++) {
      const maxCopies = persistentSpec.fourStarGoals[fi].maxCopies;
      let running = 0;
      for (let copies = maxCopies; copies >= 1; copies--) {
        running += graduatedLevelMass[fi][copies];
        graduatedLevelCounts[fi][copies - 1][l] += running; // level index (copies-1) = "reached >= copies"
      }
    }
  }

  /** Reports active (not-yet-fully-done) slice mass into localPrefixDone[*][l] and
   * activeLevelCounts[*][*][l] — purely a function of each slice's (persistentCode,
   * phaseCode), decoded once per slice rather than once per (bannerCode, slice). */
  function reportActive(slices: SliceMap, l: number): void {
    for (const [sliceKey, arr] of slices.arrays) {
      const mass = sumMass(arr);
      const persistentCode = Math.floor(sliceKey / phaseModulus);
      const phaseCode = sliceKey % phaseModulus;
      const phaseVector = decodeVector(phaseSpec.dims, phaseCode);
      const persistentVector = decodeVector(persistentSpec.dims, persistentCode);

      let allDoneSoFar = true;
      for (let k = 0; k < numPhaseGoals; k++) {
        if (allDoneSoFar && !isGoalDone(phaseSpec, persistentSpec, phaseVector, persistentVector, phaseGoals[k])) allDoneSoFar = false;
        if (allDoneSoFar) localPrefixDone[k][l] += mass;
      }
      for (let fi = 0; fi < numFourStar; fi++) {
        const copies = copyCountOf(persistentSpec, persistentVector, persistentSpec.fourStarGoals[fi].goal.targetId);
        for (let level = 0; level < copies; level++) activeLevelCounts[fi][level][l] += mass;
      }
    }
  }

  /** Reports continuation mass into continuationLevelCounts[*][*][l]. */
  function reportContinuation(l: number): void {
    if (!continuationLevelCounts) return;
    for (const [persistentCode, arr] of contSlices.arrays) {
      const mass = sumMass(arr);
      const persistentVector = decodeVector(persistentSpec.dims, persistentCode);
      for (let fi = 0; fi < numFourStar; fi++) {
        const copies = copyCountOf(persistentSpec, persistentVector, persistentSpec.fourStarGoals[fi].goal.targetId);
        for (let level = 0; level < copies; level++) continuationLevelCounts[fi][level][l] += mass;
      }
    }
  }

  /** One continuation pull: only 4★ copies on the roster change (no phase-local goals, no 5★
   * weapon tracking — its 5★ ids are placeholders). */
  function evolveContinuation(into: SliceMap): void {
    for (const [persistentCode, arr] of contSlices.arrays) {
      const persistentVector = decodeVector(persistentSpec.dims, persistentCode);
      const destByOutcome = contShapes.map((outcome) => {
        const next = updateGoalTracking(contPhaseSpec, persistentSpec, [], persistentVector, outcome, continuation!.closedGoalIds, noClosedWeapons);
        return into.getOrCreateArray(encodeVector(persistentSpec.dims, next.persistentVector));
      });
      for (let bannerCode = 0; bannerCode < bannerModulus; bannerCode++) {
        const mass = arr[bannerCode];
        if (mass <= 0) continue;
        for (const t of contAdapter!.getTransitions(bannerCode)) {
          const branchProb = mass * t.probability;
          if (branchProb > 0) destByOutcome[t.outcomeIndex][t.nextBannerCode] += branchProb;
        }
      }
    }
  }

  // l=0: mass that already satisfies blockingGoals on entry (carried over from an earlier phase)
  // graduates immediately. Left active, it would take a pull first — the done check only runs on
  // post-transition vectors — and could pick up copies that mass finishing during this phase can't.
  const stillActive = new SliceMap(bannerModulus);
  for (const [sliceKey, arr] of active.arrays) {
    const persistentCode = Math.floor(sliceKey / phaseModulus);
    const phaseCode = sliceKey % phaseModulus;
    const phaseVector = decodeVector(phaseSpec.dims, phaseCode);
    const persistentVector = decodeVector(persistentSpec.dims, persistentCode);
    if (isPhaseFullyDone(phaseSpec, persistentSpec, phaseVector, persistentVector, blockingGoals)) {
      for (let bannerCode = 0; bannerCode < bannerModulus; bannerCode++) {
        const mass = arr[bannerCode];
        if (mass <= 0) continue;
        const exitKey = (bannerCode * persistentModulus + persistentCode) * phaseModulus + phaseCode;
        exitSubstateDist.set(exitKey, (exitSubstateDist.get(exitKey) ?? 0) + mass);
      }
      recordGraduated(sumMass(arr), phaseVector, persistentVector);
      if (continuation) {
        const dest = contSlices.getOrCreateArray(persistentCode);
        for (let bannerCode = 0; bannerCode < bannerModulus; bannerCode++) dest[bannerCode] += arr[bannerCode];
      }
    } else {
      stillActive.arrays.set(sliceKey, arr);
    }
  }
  active = stillActive;

  flushGraduatedLevelCounts(0);
  reportActive(active, 0);
  reportContinuation(0);

  for (let l = 1; l <= maxPulls; l++) {
    const nextActive = new SliceMap(bannerModulus);
    // Continuation mass pulls until the horizon, then stays put; this pull's graduates join it after.
    let nextCont = contSlices;
    if (continuation && l <= continuation.horizon) {
      nextCont = new SliceMap(bannerModulus);
      evolveContinuation(nextCont);
    }

    for (const [sliceKey, arr] of active.arrays) {
      const persistentCode = Math.floor(sliceKey / phaseModulus);
      const phaseCode = sliceKey % phaseModulus;
      const phaseVector = decodeVector(phaseSpec.dims, phaseCode);
      const persistentVector = decodeVector(persistentSpec.dims, persistentCode);

      // This slice's goal-tracking result, once per outcome shape (indexed like outcomeShapes).
      const perOutcome: SliceOutcomeResult[] = new Array(outcomeShapes.length);
      for (let oi = 0; oi < outcomeShapes.length; oi++) {
        const outcome = outcomeShapes[oi];
        const { phaseVector: newPhaseVector, persistentVector: newPersistentVector } = updateGoalTracking(
          phaseSpec,
          persistentSpec,
          phaseVector,
          persistentVector,
          outcome,
          closedGoalIds,
          closedFiveStarWeaponTargetIds,
        );
        if (isPhaseFullyDone(phaseSpec, persistentSpec, newPhaseVector, newPersistentVector, blockingGoals)) {
          const newPersistentCode = encodeVector(persistentSpec.dims, newPersistentVector);
          const newPhaseCode = encodeVector(phaseSpec.dims, newPhaseVector);
          const copiesPerFourStar = persistentSpec.fourStarGoals.map((fg) => copyCountOf(persistentSpec, newPersistentVector, fg.goal.targetId));
          const prefixStreak = computePrefixStreak(newPhaseVector, newPersistentVector);
          const contDest = continuation ? nextCont.getOrCreateArray(newPersistentCode) : undefined;
          perOutcome[oi] = { done: true, newPersistentCode, newPhaseCode, copiesPerFourStar, prefixStreak, contDest };
        } else {
          const newPersistentCode = encodeVector(persistentSpec.dims, newPersistentVector);
          const newPhaseCode = encodeVector(phaseSpec.dims, newPhaseVector);
          const newSliceKey = sliceKeyOf(newPersistentCode, newPhaseCode);
          perOutcome[oi] = { done: false, newSliceKey, destArray: nextActive.getOrCreateArray(newSliceKey) };
        }
      }

      // Epitomized Path retarget: once this slice shows the first weapon obtained, use the swapped adapter.
      const activeAdapter = firstWeaponGoalIndex !== -1 && persistentVector[firstWeaponGoalIndex] === 1 ? adapterAfterFirstClaimed! : adapter;

      for (let bannerCode = 0; bannerCode < bannerModulus; bannerCode++) {
        const mass = arr[bannerCode];
        if (mass <= 0) continue;
        const transitions = activeAdapter.getTransitions(bannerCode);
        for (const t of transitions) {
          const branchProb = mass * t.probability;
          if (branchProb <= 0) continue;
          const pre = perOutcome[t.outcomeIndex];
          if (pre.done) {
            const exitKey = (t.nextBannerCode * persistentModulus + pre.newPersistentCode) * phaseModulus + pre.newPhaseCode;
            exitSubstateDist.set(exitKey, (exitSubstateDist.get(exitKey) ?? 0) + branchProb);
            graduatedTotal += branchProb;
            for (let fi = 0; fi < numFourStar; fi++) graduatedLevelMass[fi][pre.copiesPerFourStar[fi]] += branchProb;
            if (pre.prefixStreak >= 0) graduatedPrefixMassAtStreak[pre.prefixStreak] += branchProb;
            if (pre.contDest) pre.contDest[t.nextBannerCode] += branchProb;
          } else {
            pre.destArray[t.nextBannerCode] += branchProb;
          }
        }
      }
    }

    active = nextActive;
    contSlices = nextCont;
    flushGraduatedLevelCounts(l);
    reportActive(active, l);
    reportContinuation(l);
  }

  return { exitSubstateDist, localPrefixDone, graduatedPrefixDone, blockingPrefixDone, activeLevelCounts, graduatedLevelCounts, continuationLevelCounts };
}
