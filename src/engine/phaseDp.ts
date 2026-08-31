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
   * Total (unnormalized) probability mass that fully completes this phase within
   * maxPulls, broken down by (banner substate, persistent tracking vector,
   * phase-local FIFO vector) it ends in — key =
   * (bannerCode * persistentModulus + persistentCode) * phaseModulus + phaseCode,
   * where persistentModulus = product of persistentSpec.dims and phaseModulus =
   * product of THIS phase's own phaseSpec.dims (built from whatever `phaseGoals`
   * this call was given — see exactEngine.ts's `effectivePhaseGoals`). Used to
   * seed a later phase that reuses this same banner (normalize by dividing by
   * the sum of this map's values) — persistentSpec is identical across every
   * phase of a banner (built once from the whole goal list), so that component
   * of the key is always directly reusable there; the phaseCode component is
   * only meaningfully reusable when the NEXT phase was built from the exact
   * same `phaseGoals` (a linked-simultaneous character window spanning both —
   * see phases.ts's `computeCharacterWindowGoalsForPhase`), which is why
   * exactEngine.ts decodes-and-resets it back to 0 for every ordinary
   * (non-window) same-banner reoccurrence instead of passing it through
   * unchanged — twenty-first reported bug (2026-08-30), see this file's own
   * doc comment on the startDist-ingestion loop below for the full story.
   */
  exitSubstateDist: Map<number, number>;
  /** localPrefixDone[k][l] = P(first k+1 phase goals done by local pull l | just entered phase at l=0), k=0..phaseGoals.length-1.
   *
   * NOTE (2026-08-19, the "4★ anchoring is phase-derived" fix): this is NO LONGER
   * simply `blockingPrefixDone` repeated for every k — a phaseGoals member can now
   * be a non-blocking 4★ (its own graduation-gating phase, per
   * phases.ts's resolveFourStarBlockingPhase, differs from this phase), in which
   * case this phase's own graduation doesn't guarantee it's done. Computed via a
   * genuine joint per-k streak (see recordGraduated's `graduatedPrefixMassAtStreak`)
   * so it's still exact WITHIN this one phase — for a k whose phaseGoals[k] IS a
   * blocking member, this equals the OLD blanket-`graduatedTotal` behavior exactly;
   * for a non-blocking k, it correctly comes out smaller. exactEngine.ts bridges
   * the remainder for non-blocking k's using `accumulatedLevelCounts` (see its own
   * comment on this). */
  localPrefixDone: Float64Array[];
  /** graduatedPrefixDone[k][l] = the GRADUATED-ONLY component of
   * localPrefixDone[k][l] (excludes mass still ACTIVE, i.e. this phase's own
   * blockingGoals condition not yet met) — exactEngine.ts uses this to
   * separate "phaseGoals[k] done AND this phase's blocking condition ALREADY
   * met" from "...done but still active," needed to correctly bridge a
   * non-blocking goal's own resolution through LATER phases (see
   * exactEngine.ts's side-track mechanism) without conflating the two. */
  graduatedPrefixDone: Float64Array[];
  /** blockingPrefixDone[l] = P(this phase's own GRADUATION condition — i.e.
   * blockingGoals, not phaseGoals — met by local pull l). This, not
   * `localPrefixDone[phaseGoals.length-1]`, is what drives exitSubstateDist's
   * timing and therefore the NEXT phase's arrivalDensity in exactEngine.ts — see
   * the 2026-08-19 fix's doc comment above for why those two are no longer
   * guaranteed to coincide. */
  blockingPrefixDone: Float64Array;
  /**
   * activeLevelCounts[fourStarIdx][level][l] / graduatedLevelCounts[fourStarIdx][level][l]
   * = P(that 4-star goal — indexed against persistentSpec.fourStarGoals, i.e. EVERY
   * 4-star goal on this banner, not just this phase's own — has reached level+1
   * total copies by local pull l), split by whether that probability mass is still
   * ACTIVE within this phase (hasn't satisfied phase.goals yet) or has already
   * GRADUATED out of it (phase.goals satisfied, mass frozen at graduation).
   *
   * Kept SEPARATE (rather than summed into one array, as an earlier version did)
   * because exactEngine.ts needs to combine them differently across phases of the
   * same banner: active contributions from EVERY phase must be summed (that mass
   * hasn't left this banner yet), but only the LAST phase's graduated contribution
   * should be added — an earlier (non-last) phase's graduated mass flows into a
   * later phase via exitSubstateDist and gets tracked as THAT phase's own active
   * mass, so re-adding it here would double-count it. Reporting only the SUM here
   * previously made a goal's breakdown silently require "reached its own phase" as
   * a hidden prerequisite, undercounting mass still active in an earlier phase of
   * the same banner.
   */
  activeLevelCounts: Float64Array[][];
  graduatedLevelCounts: Float64Array[][];
}

interface CachedTransition {
  probability: number;
  outcome: PullOutcome;
  nextBannerCode: number;
  /** Precomputed once per bannerCode (not per pull, not per slice) — an index into
   * the fixed, small `outcomeShapes` array (via `outcomeKeyToIndex`), not a string
   * key. This is looked up in the innermost per-(bannerCode, transition) loop —
   * tens of thousands of times per slice per pull — so a plain array index beats a
   * string-keyed Map.get there; profiling showed the string lookup and the old
   * eager `SliceMap` totalMass bookkeeping (see below) as the two dominant costs
   * once the goal-tracking re-derivation itself was already eliminated by the
   * slice restructuring. */
  outcomeIndex: number;
}

interface BannerAdapter {
  bannerModulus: number;
  getTransitions(bannerCode: number): CachedTransition[];
}

/** A stable string key for a PullOutcome's SHAPE (rarity + kind + itemId if any) —
 * used to look up a slice-local, bannerCode-independent goal-tracking result (see
 * runPhaseDp's doc comment on the slice restructuring) without re-deriving it.
 *
 * A rarity-5 featured/featured_other outcome is canonicalized by `itemId` ALONE,
 * dropping `kind` — needed for the weapon banner's dual-adapter Epitomized Path
 * retarget (see runPhaseDp's doc comment): once a phase's first 5star_weapon goal
 * is claimed, a second adapter swaps which physical weapon is "chosen" vs
 * "other-featured", so the SAME physical item can arrive labeled either way
 * depending on which adapter produced it. `updateGoalTracking`'s own
 * 5star_weapon branch already treats `'featured'`/`'featured_other'` identically
 * (it keys purely on `itemId`), so this loses no real distinction — it just makes
 * the precomputed per-slice goal-tracking result (`perOutcome`) valid regardless
 * of which adapter is active for a given slice. Safe unconditionally (not just
 * when a swap is in play): the character banner's one such slot, and a weapon
 * banner's (at most) two, are already uniquely identified by itemId alone. */
function outcomeKey(outcome: PullOutcome): string {
  if (outcome.rarity === 3) return '3';
  if (outcome.rarity === 5 && outcome.kind !== 'standard') return `5f|${outcome.itemId}`;
  if ('itemId' in outcome) return `${outcome.rarity}|${outcome.kind}|${outcome.itemId}`;
  return `${outcome.rarity}|${outcome.kind}`;
}

/**
 * Every distinct PullOutcome SHAPE a banner can ever produce, derived directly
 * from its config — independent of any specific bannerCode's state (which only
 * affects each shape's PROBABILITY and next-state, never which shapes exist at
 * all). This is the fixed, small (~4-8 entries) set the slice-based DP precomputes
 * a goal-tracking result for once per slice per pull, instead of once per
 * (bannerCode, slice) pair — see runPhaseDp's doc comment.
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
 * `getTransitions(bannerCode)` is a pure function of `bannerCode` alone (given a
 * fixed config/crModel/crParams for this whole phase run), but the DP loop visits
 * it far more than once per distinct bannerCode (the banner substate space is
 * bounded to a few thousand values; the persistent/phase dimensions multiply on
 * top of that per visit). Caching by bannerCode is pure memoization of a pure
 * function — zero behavior change, just avoids redundant recomputation. Each
 * cached transition also carries a precomputed `outcomeIndex` (an index into
 * `outcomeShapes`, via `outcomeKeyToIndex` — see `outcomeKey()` above), so the
 * slice-based main loop never needs to re-derive or look it up by string per
 * visit either.
 */
function makeBannerAdapter(
  banner: BannerKind,
  characterConfig: CharacterBannerConfig,
  weaponConfig: WeaponBannerConfig,
  crModel: CRModel,
  crParams: CRParams,
  outcomeKeyToIndex: ReadonlyMap<string, number>,
): BannerAdapter {
  // A plain array indexed directly by bannerCode (a bounded integer, 0..bannerModulus-1)
  // beats a Map here — this is looked up once per active bannerCode per slice per
  // pull (up to bannerModulus times), so avoiding hash/collision overhead on every
  // call is worth the small fixed upfront allocation.
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

/** One (persistentCode, phaseCode) "slice"'s precomputed, bannerCode-independent
 * result for a single outcome shape — see runPhaseDp's doc comment. The "not
 * done" variant carries a DIRECT REFERENCE to its destination slice's dense
 * array (`destArray`), resolved once per outcome per slice (not once per
 * bannerCode) — since `newSliceKey` never varies with `bannerCode`, the innermost
 * per-(bannerCode, transition) loop can write straight into `destArray` with a
 * plain index instead of calling `SliceMap.add()` (a `Map.get` per call) tens of
 * thousands of times per slice per pull. */
type SliceOutcomeResult =
  | { done: true; newPersistentCode: number; newPhaseCode: number; copiesPerFourStar: number[]; prefixStreak: number }
  | { done: false; newSliceKey: number; destArray: Float64Array };

/** dense[bannerCode] = probability mass, for one (persistentCode, phaseCode)
 * slice. Sized to the banner's full state-space modulus, which is small (a few
 * thousand) and — per profiling — genuinely dense enough (tens of percent full by
 * the end of a typical run) that a flat array beats a sparse Map here, both for
 * lookup speed and for iteration. Memory stays bounded because the outer
 * structure only allocates one of these per DISTINCT slice actually reached, not
 * per every theoretically-possible (persistentCode, phaseCode) combination. */
class SliceMap {
  readonly arrays = new Map<number, Float64Array>();
  private readonly bannerModulus: number;

  constructor(bannerModulus: number) {
    this.bannerModulus = bannerModulus;
  }

  /** Returns (creating if needed) the dense array for a slice — used both by
   * `add()` and by callers that want to resolve a destination array ONCE (e.g.
   * per outcome per slice) rather than once per bannerCode. */
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

/** Total mass in a slice's dense array — computed lazily (only where actually
 * needed, once per slice per pull) rather than tracked eagerly on every `add()`
 * call. Profiling found the eager version (a `Map<number,number>` get+set on
 * every single elementary transition — tens of thousands of times per slice per
 * pull) was one of the two dominant costs in this function; a tight numeric
 * reduce over the (already cache-resident) Float64Array, called far less often,
 * is both simpler and substantially faster. */
function sumMass(arr: Float64Array): number {
  let total = 0;
  for (let i = 0; i < arr.length; i++) total += arr[i];
  return total;
}

/**
 * Runs the exact DP for one phase (a maximal run of consecutive same-banner
 * goals), starting from a NORMALIZED (sums to ~1) distribution over (banner
 * substate, persistent tracking vector) representing "just entered this phase".
 * Tracks three things jointly: the banner's own pity/CR/fate state, a phase-local
 * 5-star-character FIFO counter (resets every phase — see goalTracking.ts), and a
 * persistent tracking vector covering every 4-star and 5-star-weapon goal on this
 * banner from the WHOLE goal list (carries across phases — see PersistentSpec's
 * doc comment for why: those items can be opportunistically obtained on any pull
 * of this banner, not just once their own priority slot's phase is reached).
 * Probability mass that satisfies every phase goal "graduates" out of the active
 * pool into exitSubstateDist and stops evolving THIS phase's own DP (no more pulls
 * happen on a banner once it's no longer in focus) — but its persistent vector
 * keeps evolving normally if/when this banner is used again in a later phase. See
 * exactEngine.ts for how phases are stitched together across the whole goal list.
 *
 * STRUCTURE: state is organized into "slices" — one per distinct (persistentCode,
 * phaseCode) pair reached — each holding a dense array of probability mass indexed
 * by bannerCode. This isn't just a data-structure swap: the goal-tracking side of
 * a pull (updateGoalTracking/isGoalDone/isPhaseFullyDone and the anchor-gating
 * helpers they call) depends ONLY on (persistentCode, phaseCode, which outcome
 * shape occurred) — never on bannerCode. The banner-transition side
 * (getTransitions) depends ONLY on bannerCode. Before this restructuring, every
 * (bannerCode, persistentCode, phaseCode) combination re-derived the goal-tracking
 * result from scratch — profiled as the majority of this function's cost, since
 * the banner substate space (thousands of values) makes that re-derivation happen
 * thousands of times more often than the handful of distinct results it could ever
 * produce. Now it's computed once per (slice, outcome shape) pair — a fixed, small
 * set — and the inner sweep over bannerCode just looks up the precomputed result
 * and does array arithmetic, no decode/encode/allocation per bannerCode at all.
 *
 * `weaponConfigAfterFirstClaimed` (weapon banner only, optional): when a phase has
 * TWO `5star_weapon` goals, a rational player retargets their Epitomized Path
 * selection to the second one the instant the first is claimed — the fourteenth
 * reported bug was that `weaponConfig`'s chosen/other identity used to be static
 * for the whole phase, so a Fate Point could never benefit the second weapon.
 * Fixed by building a SECOND `BannerAdapter` from the swapped config and choosing
 * which one to use PER SLICE (not once for the whole run), based on whether that
 * slice's own persistent vector already shows the phase's first weapon goal's
 * `targetId` as obtained — this is read directly off `persistentVector`, already
 * decoded once per slice per pull for goal-tracking, so the check is free. Made
 * possible entirely by `outcomeKey()`'s itemId-only canonicalization above: both
 * adapters' transitions resolve into the SAME `outcomeKeyToIndex` space (built
 * once, from `weaponConfig` alone), so `perOutcome` doesn't need to double either
 * — the goal-tracking result for "you got physical weapon X" is identical
 * regardless of which adapter currently labels X as `'featured'` vs
 * `'featured_other'`.
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
  /** The goals that actually gate THIS phase's own graduation (moving mass from
   * `active` to `exitSubstateDist`) — see phases.ts's
   * computeBlockingFourStarGoalIdsForPhase. Required, not defaulted to
   * `phaseGoals` — this function has exactly one caller (exactEngine.ts), which
   * always computes and passes the real blocking set; a default here would be
   * unreachable in practice but would silently reintroduce pre-seventeenth-bug
   * ("every phase member blocks") behavior for any future caller that omitted
   * it by mistake, rather than failing to compile. Can legally include a goal
   * that ISN'T in `phaseGoals` at all — a 4★ whose own textual phase is
   * EARLIER than its resolved blocking phase (see phases.ts's
   * resolveFourStarBlockingPhase) — which works because isGoalDone for a 4★ only
   * ever reads `persistentVector` (tracked banner-wide, not phase-scoped), never
   * `phaseVector`/`phaseSpec`. */
  blockingGoals: Goal[],
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

  function sliceKeyOf(persistentCode: number, phaseCode: number): number {
    return persistentCode * phaseModulus + phaseCode;
  }

  // `startDist`/`exitSubstateDist` keys are ALWAYS 3-part-encoded, mixed-radix
  // (bannerCode, persistentCode, phaseCode) — see phaseKeyOf/decodePhaseKey
  // below. Twenty-first reported bug (2026-08-30): this used to be 2-part
  // (bannerCode, persistentCode only), with the phase-local FIFO counter
  // unconditionally reset to 0 on every phase entry — correct for the
  // overwhelming majority of phases (a later phase's 5star_character goal
  // really is a separate, later win), but wrong for two phases sharing one
  // real, LINKED-simultaneous 5star_character window split apart by an
  // interleaved different-banner detour (see phases.ts's
  // computeCharacterWindowPartnerPhase) — there, a featured win landing
  // during the FIRST phase's own extra pulls (past its own claim, while a
  // same-window 4-star is still short of target) must roll over onto the
  // SECOND phase's still-open slot instead of vanishing. Always including
  // phaseCode costs nothing for an ordinary phase — every one of its own
  // native 5star_character members already blocks it (exactEngine.ts's
  // `blockingGoals` always includes a phase's own native 5-star/weapon
  // goals unconditionally), so phaseCode is pinned to a single fixed value
  // at the point of graduation regardless, adding no new distinct keys.
  // Whether a given phase transition actually CARRIES the decoded phaseCode
  // forward or resets it to 0 is entirely exactEngine.ts's call — see its
  // own doc comment on `effectivePhaseGoals`/`isSecondOfWindowPair`.
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

  let graduatedTotal = 0;
  // graduatedLevelMass[fourStarIdx][exact copy count at graduation] = accumulated mass
  const graduatedLevelMass: number[][] = persistentSpec.fourStarGoals.map((fg) => new Array(fg.maxCopies + 1).fill(0));
  // graduatedPrefixMassAtStreak[k] = mass that graduated (blockingGoals satisfied)
  // WHILE its own joint "phaseGoals[0..k] all done" streak reached exactly k — see
  // computePrefixStreak below and localPrefixDone's own doc comment. Read via a
  // suffix sum in flushGraduatedLevelCounts (mass with streak>=k also counts
  // toward localPrefixDone[k], since a longer streak implies every shorter one).
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

  // l=0: split out any state that ALREADY satisfies every phase goal upon entry
  // (carried over from a prior phase via startDist) before it gets a chance to take
  // an extra, un-graduated pull. Without this, "already done at entry" mass would
  // sit in `active` through l=1's transition and could pick up one more copy (or
  // more, across the loop) before ever being checked for isPhaseFullyDone — since
  // that check only ever runs on a POST-transition vector — over-counting relative
  // to "became done during THIS phase" mass, which graduates on the exact pull
  // that satisfies it, not one pull later. This was a real bug: with cross-phase
  // persistent carryover, entering "already done" is now a normal occurrence (a
  // 4-star's target can already be met from an earlier phase's opportunistic
  // accrual), not just a theoretical edge case.
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
    } else {
      stillActive.arrays.set(sliceKey, arr);
    }
  }
  active = stillActive;

  flushGraduatedLevelCounts(0);
  reportActive(active, 0);

  for (let l = 1; l <= maxPulls; l++) {
    const nextActive = new SliceMap(bannerModulus);

    for (const [sliceKey, arr] of active.arrays) {
      const persistentCode = Math.floor(sliceKey / phaseModulus);
      const phaseCode = sliceKey % phaseModulus;
      const phaseVector = decodeVector(phaseSpec.dims, phaseCode);
      const persistentVector = decodeVector(persistentSpec.dims, persistentCode);

      // Precompute this slice's goal-tracking result ONCE per outcome shape — see
      // this function's doc comment for why this is the whole point. Indexed by
      // position in outcomeShapes (matching each CachedTransition's precomputed
      // outcomeIndex) rather than keyed by string, since this is read from the
      // innermost per-(bannerCode, transition) loop below — tens of thousands of
      // times per slice per pull — where a plain array index beats a Map.get.
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
          // Always encoded (not just when a window-carry is in play, see this
          // function's doc comment on the 3-part key format) — a plain,
          // never-carried phase pins this to the phase's own single "every
          // native 5-star claimed" value, adding no new distinct exit keys.
          const newPhaseCode = encodeVector(phaseSpec.dims, newPhaseVector);
          const copiesPerFourStar = persistentSpec.fourStarGoals.map((fg) => copyCountOf(persistentSpec, newPersistentVector, fg.goal.targetId));
          const prefixStreak = computePrefixStreak(newPhaseVector, newPersistentVector);
          perOutcome[oi] = { done: true, newPersistentCode, newPhaseCode, copiesPerFourStar, prefixStreak };
        } else {
          const newPersistentCode = encodeVector(persistentSpec.dims, newPersistentVector);
          const newPhaseCode = encodeVector(phaseSpec.dims, newPhaseVector);
          const newSliceKey = sliceKeyOf(newPersistentCode, newPhaseCode);
          perOutcome[oi] = { done: false, newSliceKey, destArray: nextActive.getOrCreateArray(newSliceKey) };
        }
      }

      // Epitomized Path retarget (see this function's doc comment on
      // weaponConfigAfterFirstClaimed): once this slice's own persistent vector
      // already shows the phase's first weapon goal as obtained, use the
      // swapped adapter for every bannerCode in this slice — resolved once per
      // slice per pull, not once per bannerCode.
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
          } else {
            pre.destArray[t.nextBannerCode] += branchProb;
          }
        }
      }
    }

    active = nextActive;
    flushGraduatedLevelCounts(l);
    reportActive(active, l);
  }

  return { exitSubstateDist, localPrefixDone, graduatedPrefixDone, blockingPrefixDone, activeLevelCounts, graduatedLevelCounts };
}
