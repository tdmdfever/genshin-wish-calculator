import { CR_MODELS } from './capturingRadiance';
import { buildPersistentSpec, buildPhaseLocalSpec } from './goalTracking';
import { runPhaseDp, type PhaseDpResult } from './phaseDp';
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
  CharacterBannerConfig,
  Goal,
  LevelBreakdownSeries,
  SimulationInput,
  SimulationResult,
  SimulationSeries,
  WeaponBannerConfig,
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
 * A "never-graduates" phase's (see "Phase C" under "Trailing continuation
 * phase" below) own local DP cost is O(bannerModulus * persistentModulus *
 * localMaxPulls) with NO tapering-off over time — unlike every ordinary
 * phase, whose active-slice set shrinks as mass graduates out, its blocking
 * condition is unconditionally unsatisfiable, so it stays maximally
 * expensive for its entire local range. Running it out to the full global
 * `maxPulls` (as an early version of this fix did) measured a real ~4x
 * regression on this app's own documented worst-case scenario, and tens of
 * seconds to minutes on larger budgets (nineteenth reported bug, performance
 * follow-up, 2026-08-20). There is no way to shrink this exactly: the "skip
 * local pull indices that can never be reached" trick that fixed the
 * ORIGINAL performance regression elsewhere in this file doesn't apply here,
 * because a real scenario can enter such a phase at local pull 0 (e.g.
 * carried-over state that already satisfies everything), so
 * `arrivalDensity[0]` is generically nonzero and the convolution genuinely
 * needs the full local range to stay exact.
 *
 * A DIFFERENT, ORDINARY (does eventually graduate) phase can also hit this
 * same cost profile for a different reason: a disconnected 4★'s own isolated
 * phase (twentieth-reported-bug follow-up, 2026-08-21 — see buildPhases in
 * phases.ts) is a single, banner-wide-costed phase that used to run to the
 * full global budget too — measured directly at 45s for 3 disconnected
 * 4★s (this app's own per-banner max) at the DEFAULT 90-pull budget, and
 * 131s at pullBudget=900, since `PersistentSpec`'s expensive state space is
 * paid again for EACH sequential disconnected-goal phase. Capped here too,
 * by explicit user choice after being shown these numbers directly.
 *
 * Explicitly chosen, user-approved tradeoff both times: cap the phase's own
 * local horizon at a fixed, generous bound rather than the full remaining
 * budget. Within this many pulls past entry, results stay exactly correct;
 * beyond it, a goal's series/breakdown probabilities simply stop accruing
 * (the array is padded forward by repeating the last computed value — see
 * `padWithLastValue`/`padPhaseDpResult`), the same "plateaus below where it
 * should keep climbing" symptom as the bug this whole mechanism exists to
 * fix, just pushed out past this many pulls instead of past a goal's own
 * target. 400 was chosen as comfortably beyond where any realistic goal
 * (even a deep C6/R5 target chasing hard pity repeatedly) saturates
 * near-certainty, while keeping the worst-case cost bounded regardless of
 * how large a pull budget the user configures.
 */
const MAX_CONTINUATION_HORIZON_PULLS = 400;

/** Pads `arr` out to `targetLength` by repeating its last value — used to
 * bring a capped phase's result back up to the full global pull-axis length
 * before convolving it against a `maxPulls`-length density, without claiming
 * any further progress happened past the cap (see
 * MAX_CONTINUATION_HORIZON_PULLS's doc comment). */
function padWithLastValue(arr: Float64Array, targetLength: number): Float64Array {
  if (arr.length >= targetLength) return arr;
  const result = new Float64Array(targetLength);
  result.set(arr);
  const last = arr.length > 0 ? arr[arr.length - 1] : 0;
  for (let i = arr.length; i < targetLength; i++) result[i] = last;
  return result;
}

/**
 * Pads every pull-indexed array field of a `PhaseDpResult` (everything
 * except `exitSubstateDist`, a `Map` representing a STATE distribution, not
 * pull-indexed at all — used as-is regardless of the phase's own local
 * horizon) out to `targetLength`, via `padWithLastValue`. Used for a
 * disconnected 4★'s own isolated phase (twentieth-reported-bug follow-up)
 * when its local horizon was capped at MAX_CONTINUATION_HORIZON_PULLS —
 * applied ONCE, immediately after `runPhaseDp` returns, so every existing
 * downstream consumption site in the main loop below (`globalPrefixDone`
 * writes, `arrivalDensity` updates, the graduated-4★-breakdown bridging
 * logic) can keep assuming every phase's own arrays are always
 * `maxPulls + 1` long, exactly like an uncapped ordinary phase — rather than
 * needing every individual call site updated to pad on demand.
 */
function padPhaseDpResult(result: PhaseDpResult, targetLength: number): PhaseDpResult {
  return {
    exitSubstateDist: result.exitSubstateDist,
    localPrefixDone: result.localPrefixDone.map((arr) => padWithLastValue(arr, targetLength)),
    graduatedPrefixDone: result.graduatedPrefixDone.map((arr) => padWithLastValue(arr, targetLength)),
    blockingPrefixDone: padWithLastValue(result.blockingPrefixDone, targetLength),
    activeLevelCounts: result.activeLevelCounts.map((levels) => levels.map((arr) => padWithLastValue(arr, targetLength))),
    graduatedLevelCounts: result.graduatedLevelCounts.map((levels) => levels.map((arr) => padWithLastValue(arr, targetLength))),
  };
}

/**
 * Resets the weapon banner's `fatePoints` component to 0 across a whole
 * `(bannerCode, persistentCode)` distribution — Epitomized Path is a
 * per-phase selection, so any Fate Point progress toward a PREVIOUS phase's
 * chosen weapon is meaningless once a NEW weapon-banner phase begins (see
 * weaponBanner.ts's doc comment on transitionWeaponBanner). `guaranteed5`
 * (the separate 75/25 pity guarantee) and everything else in the substate
 * carry over unchanged — only this one component resets. Two input states
 * that only differed by `fatePoints` collapse onto the same output key here,
 * so probabilities are summed, not overwritten.
 *
 * NOT called at all (see the phase loop below) when the reoccurring phase's own
 * weapon goal is explicitly LINKED (Goal.linkedWeaponGoalId — fifteenth reported
 * bug, 2026-08-19) to the goal whose phase we're carrying over FROM: a linked
 * pair represents ONE continuous real Epitomized Path window split apart in
 * priority order by a character-banner detour, not a new EP selection, so any
 * Fate Point progress toward the (now-claimed) first weapon that was actually
 * earned AFTER it was claimed — via the existing retarget machinery already
 * pointing "chosen" at the second weapon for the rest of that first phase, e.g.
 * while chasing an anchored 4-star weapon goal sharing it — genuinely belongs to
 * the second weapon and must survive into its own phase. goalValidation.ts's
 * "no intervening weapon-banner phase of any composition between a linked
 * pair" rule is what makes skipping the reset safe without tracking WHICH
 * phase a carried-over Fate Point came from: the immediately-preceding
 * same-banner phase is guaranteed to be the linked partner's own phase.
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

const LEVEL_LABELS_CHARACTER = ['C0', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6'];
const LEVEL_LABELS_WEAPON = ['R1', 'R2', 'R3', 'R4', 'R5'];

/** The index into activeLevelCounts[fi]/graduatedLevelCounts[fi]/accumulatedLevelCounts[banner][fi]
 * representing "this goal's own target is reached" — mirrors isGoalDone's own
 * copy-count thresholds (goalTracking.ts): character needs targetLevel+1 copies
 * (C0 default = 1 copy), weapon needs targetLevel copies (R1 default = 1 copy);
 * since activeLevelCounts[fi][level] means "copies > level" (i.e. "copies >=
 * level+1"), the level index is one less than the copy count needed. */
function fourStarTargetLevelIndex(goal: Goal): number {
  return goal.kind === '4star_character' ? (goal.targetLevel ?? 0) : (goal.targetLevel ?? 1) - 1;
}

/**
 * result[l] = P(the persistent 4★ at index `fi` has reached its OWN target
 * level by local pull l), regardless of whether the phase's own
 * `blockingGoals` condition is met — i.e. `activeLevelCounts` (still active,
 * blocking condition not yet met) plus `graduatedLevelCounts` (already
 * graduated) summed. Used to resolve a side-tracked goal's own completion:
 * `result.blockingPrefixDone` is NOT the right driver for that whenever the
 * blocking phase has OTHER blocking members of its own (its own native 5★,
 * or another persistent 4★) — it requires ALL of them jointly, not just the
 * one goal the track is following. Twentieth reported bug (2026-08-20):
 * `[Odette, Alyosha(4★, anchored to Miko only), Miko]` showed the
 * "Odette+Alyosha" series entry incorrectly IDENTICAL to "Odette+Alyosha+Miko"
 * — resolving Alyosha's own completion via Miko's phase's `blockingPrefixDone`
 * (which requires Miko too) instead of Alyosha's own copy-count condition
 * alone. */
function goalAloneDoneCumulative(result: PhaseDpResult, fi: number, level: number): Float64Array {
  const active = result.activeLevelCounts[fi][level];
  const graduated = result.graduatedLevelCounts[fi][level];
  const out = new Float64Array(active.length);
  for (let l = 0; l < out.length; l++) out[l] = active[l] + graduated[l];
  return out;
}

/**
 * The primary runtime engine: exact probability propagation, not sampling. Goals
 * are grouped into "phases" (maximal runs of consecutive same-banner goals in
 * priority order — see phases.ts for why banner focus only ever switches at those
 * boundaries). Each phase runs its own compact exact DP (phaseDp.ts) tracking that
 * banner's pity/CR/fate state jointly with a phase-local 5-star-character counter
 * AND a banner-wide persistent tracking vector (4-star copies, 5-star-weapon
 * identity) that carries across every phase of that banner — see goalTracking.ts's
 * PersistentSpec doc comment for why 4-star/5-star-weapon tracking can't be
 * scoped to a single phase the way 5-star-character claiming can. Phases are
 * stitched together by convolving each one's own completion-time distribution with
 * the accumulated arrival-time distribution from every phase before it, so the
 * final probabilities are exact — not statistically estimated — on the global
 * pull axis.
 */
export function runExactSimulation(input: SimulationInput): SimulationResult {
  const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const { pullBudget, goals, crModelId, crParams } = input;
  const crModel = CR_MODELS[crModelId];
  const maxPulls = pullBudget;

  const phases = buildPhases(goals);
  // Which 4★ goals are disconnected (see phases.ts) — used below to cap a
  // disconnected goal's own isolated phase at MAX_CONTINUATION_HORIZON_PULLS,
  // same as the tail-only "Phase C" mechanism, and for the same reason
  // (measured directly: 45s for 3 disconnected 4★s at the DEFAULT 90-pull
  // budget, 131s at pullBudget=900, uncapped).
  const disconnectedIds = computeDisconnectedFourStarGoalIds(goals);

  // Built once per banner from the WHOLE goal list, so the persistent tracking
  // vector's dimension layout — and any code encoded against it — stays valid
  // across every phase that reuses this banner.
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

  // Every persistent 4★ goal's resolved blocking phase — see
  // resolveFourStarBlockingPhase's doc comment (phases.ts). A disconnected
  // goal now gets a real, isolated phase of her own directly from
  // `buildPhases` (twentieth-reported-bug follow-up), so `ownPhase` is
  // always the right answer here — no more redirect/fallback machinery
  // needed (that used to live here as a two-pass "Phase R" computation).
  const blockingPhaseByGoalId = computeFourStarBlockingPhaseByGoalId(phases, allPersistentFourStarGoals);

  // "Phase C" (below, under "Trailing continuation") still needs to know
  // which banner owns the very last phase, to give an already-attached 4★'s
  // breakdown a chance to keep accruing bonus copies past its own target,
  // forever, once every real phase is exhausted — unrelated to disconnected
  // goals (they resolve via ordinary phase-loop processing now, wherever
  // they sit).
  const tailBanner: BannerKind | undefined = phases.length > 0 ? phases[phases.length - 1].banner : undefined;

  // Global, per-goal cumulative "prefix done" arrays (K = 0-indexed global goal position).
  const globalPrefixDone: Float64Array[] = goals.map(() => new Float64Array(maxPulls + 1));

  // Running arrival-time density for "the phase currently being processed is entered
  // at exactly global pull tau". Phase 1 starts at global pull 0 with certainty.
  let arrivalDensity: Float64Array = new Float64Array(maxPulls + 1);
  arrivalDensity[0] = 1;

  const lastPhaseResultByBanner = new Map<BannerKind, PhaseDpResult>();
  const bannerUsedBefore = new Set<BannerKind>();
  // Twenty-first reported bug (2026-08-30): the phaseModulus each stored
  // exitSubstateDist was actually encoded with — needed to correctly decode
  // it back out when seeding the NEXT same-banner phase's startDist, since
  // phaseModulus varies per phase (it's derived from that phase's own
  // effectivePhaseGoals, see below) and phaseDp.ts's exitSubstateDist keys
  // are always 3-part (bannerCode, persistentCode, phaseCode) now.
  const lastPhaseModulusByBanner = new Map<BannerKind, number>();
  // Precomputed once: for every character-banner phase, the OTHER phase
  // index it shares a real, linked-simultaneous 5star_character FIFO window
  // with (see phases.ts's computeCharacterWindowPartnerPhase) — undefined
  // for the overwhelming majority of phases. Used below to (a) widen the
  // phase-local FIFO shape both phases of such a pair are built against, so
  // a featured win landing during the FIRST phase's own extra pulls can roll
  // over onto the SECOND phase's still-open slot instead of vanishing, and
  // (b) decide whether a same-banner reoccurrence should CARRY its
  // phase-local code forward (true continuation of the same shared window)
  // or reset it to 0 (an ordinary reoccurrence, ordinary same-banner phase).
  const characterWindowPartnerByPhase = new Map<number, number>();
  for (let p = 0; p < phases.length; p++) {
    if (phases[p].banner !== 'character') continue;
    const partner = computeCharacterWindowPartnerPhase(phases, p);
    if (partner !== undefined) characterWindowPartnerByPhase.set(p, partner);
  }

  // Phases USED TO strictly alternate banner (buildPhases merged any consecutive
  // same-banner run into one phase), which meant a banner's reoccurrence was
  // always exactly 2 phases later — exactly one intervening other-banner phase.
  // Since the fifteenth reported bug (2026-08-19), buildPhases can also produce
  // two CONSECUTIVE same-banner phases (an adjacent-but-explicitly-UNLINKED pair
  // of 5star_weapon goals, forced apart into separate real windows — see
  // phases.ts's buildPhases) — the graduated-4-star-breakdown handling below
  // checks for this directly (nextPhase.banner === phase.banner) rather than
  // assuming alternation. isLastUsage[p] marks phases with no later same-banner
  // phase at all, regardless of what (if anything) sits between them.
  const isLastUsage: boolean[] = phases.map((phase, p) => !phases.slice(p + 1).some((later) => later.banner === phase.banner));

  // Accumulates each 4-star goal's FULL marginal breakdown across every phase of
  // its banner, not just its own "home" phase — see phaseDp.ts's doc comment on
  // activeLevelCounts/graduatedLevelCounts. Three kinds of contribution, summed:
  // (1) every phase's ACTIVE mass (still hasn't satisfied that phase's own goals),
  // convolved with that phase's own arrival density; (2) for a banner's LAST-used
  // phase, its GRADUATED mass (nothing left to evolve through), likewise; (3) for
  // every non-last phase, its graduated mass is instead mass "IN TRANSIT" toward
  // the next phase of the same banner — it must count for exactly the pull range
  // between graduating THIS phase and actually ARRIVING at that next phase, or it
  // falls into a blind spot no other term covers (this was a real bug: mass that,
  // say, already got the first 5-star and picked up a 4-star copy along the way,
  // but hasn't yet finished an intervening weapon-banner goal, would vanish from
  // the breakdown for that whole stretch — despite already holding a copy). Since
  // the intervening phase's OWN mechanics never touch this banner's state, the
  // level achieved at graduation is independent of how long that detour takes, so
  // "graduated with level>=X at global pull t, AND the intervening phase hasn't
  // finished by pull N" is exactly a convolution of the graduation-time density
  // with the intervening phase's own survival function (1 - its completion CDF).
  const accumulatedLevelCounts: Record<BannerKind, Float64Array[][]> = {
    character: persistentSpecByBanner.character.fourStarGoals.map((fg) => Array.from({ length: fg.maxCopies }, () => new Float64Array(maxPulls + 1))),
    weapon: persistentSpecByBanner.weapon.fourStarGoals.map((fg) => Array.from({ length: fg.maxCopies }, () => new Float64Array(maxPulls + 1))),
  };

  // Holds the most recently graduated non-last-usage phase's global graduation
  // density, awaiting resolution by the very next phase processed (which is
  // guaranteed to be the intervening phase of the other banner — see isLastUsage's
  // comment). At most one of these is ever outstanding at a time.
  let pendingInTransit: { banner: BannerKind; globalGraduationDensity: Float64Array[][] } | null = null;

  // A 4★'s BLOCKING phase (phases.ts's resolveFourStarBlockingPhase) can now
  // differ from its own textual/natal phase — its graduation-gating there
  // doesn't hand off UNTIL its blocking phase's own condition is met. When
  // that happens, phaseGoals[k]'s own globalPrefixDone entry can't simply come
  // from THIS phase's own localPrefixDone[k] (that's now scoped to the
  // BLOCKING condition, which excludes this goal) — nor can EVERY LATER
  // global position's own entry, since a later position's blocking chain has
  // no way to know this goal must ALSO be satisfied by the same pull.
  //
  // Fixed via an explicit "side track": from the goal's own natal phase
  // through to its own blocking phase (exclusive), maintain a SECOND,
  // parallel density stream (`gDoneDensity`) alongside the main
  // `arrivalDensity` — representing "reached this point in the blocking
  // chain, AND this goal is ALSO already done" — used INSTEAD OF the main
  // arrivalDensity for every globalPrefixDone entry in that span. A second
  // stream (`gPendingDensity`) tracks the complementary mass (goal not yet
  // done) forward the same way; once the goal's own blocking phase is
  // reached, `gPendingDensity` gets ONE more convolution against that phase's
  // OWN blockingPrefixDone (which, by construction, already requires the
  // goal done too) to resolve the goal's own series entry, and BOTH streams
  // are then discarded — every phase from that point on already, correctly,
  // requires the goal via the ordinary (never-split) `arrivalDensity`.
  //
  // This is exact for exactly ONE simultaneously-active side track — the
  // reported bug's own shape, and the overwhelming majority of realistic
  // configurations. If a SECOND non-blocking goal is discovered while one is
  // already active (multiple non-blocking goals in flight at once — a rare,
  // deliberately-constructed edge case), it falls back to `pendingSeriesBridge`,
  // the same documented, bounded marginal-subtraction approximation used
  // before this side-track mechanism existed, guarded by the monotonicity
  // clamp applied after the main loop.
  interface ActiveSideTrack {
    globalIdx: number;
    natalPhase: number;
    blockingPhase: number;
    /** Which persistent 4★ this track is following, and the copy-count level
     * index representing ITS OWN target — needed at resolution time to ask
     * "is THIS goal alone done," not "is the blocking phase's WHOLE
     * blockingGoals condition met" (see the resolution site's own comment for
     * why those two are not the same thing whenever the blocking phase has
     * other native/blocking members of its own, e.g. its own 5★). */
    fi: number;
    level: number;
    /** series[globalIdx]'s own contribution from resolving WITHIN this goal's
     * natal phase alone (active-or-graduated, already convolved onto the
     * global axis) — the OTHER contribution (resolving later, via
     * gPendingDensity) gets added to this once the blocking phase is reached. */
    withinNatalContribution: Float64Array;
    gDoneDensity: Float64Array;
    gPendingDensity: Float64Array;
    /** Every OTHER global position (strictly between this goal's own natal
     * phase and its blocking phase) whose globalPrefixDone was computed using
     * gDoneDensity while this track was active — e.g. a 5★ goal in an
     * intervening phase. These positions ALSO need the pending stream's
     * eventual resolution added once it resolves at the blocking phase: the
     * goal finishing LATER than that position (via its own blocking phase,
     * which only starts once every intervening phase — including this one —
     * has already graduated) is an equally valid way to satisfy THAT
     * position's own prefix, not just the goal's own. Missing this was a real
     * bug, found via direct cross-validation against Monte Carlo: a later
     * position's own series value was severely UNDERSTATED (order of tens of
     * percentage points) by only ever crediting the "goal resolves within its
     * own natal phase" path and never "goal resolves later, via its own
     * blocking phase, still within budget." */
    affectedGlobalIndices: number[];
  }
  let activeSideTrack: ActiveSideTrack | null = null;
  const pendingSeriesBridge = new Map<number, { banner: BannerKind; fi: number; level: number; natalActive: Float64Array }>();

  for (let p = 0; p < phases.length; p++) {
    const phase = phases[p];
    const persistentSpec = persistentSpecByBanner[phase.banner];
    const persistentModulus = persistentModulusByBanner[phase.banner];

    // Twenty-first reported bug (2026-08-30): the phase-local FIFO shape this
    // phase's own DP run is built against. For the overwhelming majority of
    // phases this is just `phase.goals` unchanged (fast-pathed via reference
    // equality below); for a phase sharing a linked-simultaneous
    // 5star_character window with another, non-adjacent phase (an
    // interleaved different-banner detour, or another unlinked 5-star, sits
    // between them), it's the combined, priority-ordered goal set spanning
    // BOTH phases — see phases.ts's computeCharacterWindowGoalsForPhase for
    // why both phases of such a pair must share this exact same shape.
    const hasWindowPartner = characterWindowPartnerByPhase.has(p);
    const windowPartner = characterWindowPartnerByPhase.get(p);
    const isSecondOfWindowPair = hasWindowPartner && windowPartner! < p;
    const effectivePhaseGoals = hasWindowPartner ? computeCharacterWindowGoalsForPhase(phases, p) : phase.goals;
    const phaseModulusForThisPhase = buildPhaseLocalSpec(effectivePhaseGoals).dims.reduce((a, b) => a * b, 1) || 1;

    const startDist = new Map<number, number>();
    if (!bannerUsedBefore.has(phase.banner)) {
      const bannerCode =
        phase.banner === 'character' ? encodeCharState(input.characterBanner.state) : encodeWeaponState(input.weaponBanner.state);
      // Persistent tracking AND the phase-local FIFO counter both start at
      // zero on the banner's first-ever use.
      startDist.set((bannerCode * persistentModulus + 0) * phaseModulusForThisPhase + 0, 1);
    } else {
      const prev = lastPhaseResultByBanner.get(phase.banner);
      if (prev) {
        const normalized = normalizeDist(prev.exitSubstateDist);
        // A NEW weapon-banner phase means a NEW Epitomized Path selection —
        // any Fate Point progress toward the PREVIOUS phase's chosen weapon
        // doesn't carry over — UNLESS this phase's own weapon goal is
        // explicitly linked to the goal whose phase we're carrying over from,
        // in which case it's the SAME real EP window continuing, not a new
        // selection (see isWeaponFatePointsResetOnEntry's doc comment).
        // guaranteed5 (and everything else) carries over unchanged regardless,
        // same as the character banner's own pity/guaranteed5/CR always have.
        // Safe to decode with the 2-part assumption `resetWeaponFatePoints`
        // itself uses even under the now-always-3-part encoding below: this
        // only ever runs for a weapon-banner phase, and a weapon phase's own
        // phaseModulus is always exactly 1 (no 5star_character members are
        // ever possible there), so the 3-part key is numerically identical
        // to the 2-part one.
        const carried = isWeaponFatePointsResetOnEntry(phases, p) ? resetWeaponFatePoints(normalized, persistentModulus) : normalized;
        if (isSecondOfWindowPair) {
          // True continuation of a linked-simultaneous character window
          // split by a detour: `carried` was already encoded against this
          // EXACT SAME effectivePhaseGoals (both phases of the pair share
          // one computeCharacterWindowGoalsForPhase result), so its own
          // phaseCode digit is directly meaningful here — preserve it
          // instead of resetting, so a featured win claimed during the
          // earlier phase's own extra pulls (after ITS OWN 5-star already
          // dropped, while a shared-window 4-star was still short of
          // target) correctly rolls over onto THIS phase's own still-open
          // slot instead of having been silently dropped there.
          for (const [k, v] of carried) startDist.set(k, (startDist.get(k) ?? 0) + v);
        } else {
          // Ordinary reoccurrence (including entering a brand-new window
          // pair, after some earlier unrelated phase of this banner) —
          // decode out just (bannerCode, persistentCode) using the PREVIOUS
          // phase's own phaseModulus, then re-seed THIS phase's own
          // phase-local FIFO at 0 — the normal, resetting behavior a later
          // phase's 5star_character goal has always had (it's a genuinely
          // separate, later win).
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

    // Which of this banner's persistent 4-star goals are closed FOR THIS
    // SPECIFIC PHASE — recomputed per phase since the same goal can be open in an
    // earlier phase and closed once a later phase picks it back up after its
    // anchor's own phase has passed. See phases.ts's doc comment for the full rule.
    const closedGoalIds = computeClosedFourStarGoalIdsForPhase(
      phases,
      p,
      persistentSpec.fourStarGoals.map((fg) => fg.goal),
    );

    // Weapon banner only (empty/no-op on the character banner, since
    // persistentSpec.fiveStarWeaponTargetIds is always empty there) — restricts
    // each 5star_weapon goal's identity tracking to its own natal phase, since
    // each phase has exactly one weapon banner with its own distinct pair of
    // featured weapons. See phases.ts's computeClosedFiveStarWeaponTargetIdsForPhase.
    const closedFiveStarWeaponTargetIds = computeClosedFiveStarWeaponTargetIdsForPhase(
      phases,
      p,
      goals.filter((g) => g.kind === '5star_weapon'),
    );

    // Computed fresh for THIS phase (not the one static global config a prior
    // version reused everywhere) — fixes both the weapon Epitomized Path bug
    // (chosen/other identity was global-by-priority-position, so a later phase's
    // own weapon could never benefit from a Fate Point guarantee) and the 4-star
    // pool dilution bug (a global pool past 3/5 real names silently diluted every
    // phase's split fraction). See phases.ts's doc comments on both functions.
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
    // Fourteenth reported bug: when this phase has 2 named 5star_weapon goals,
    // a rational player retargets Epitomized Path to the second once the first
    // is claimed — see phases.ts's own doc comment on this function.
    const weaponConfigAfterFirstClaimed = computeWeaponBannerConfigAfterFirstClaimedForPhase(
      phases,
      p,
      persistentSpecByBanner.weapon.fourStarGoals.map((fg) => fg.goal),
    );

    // Which of this banner's persistent 4-star goals actually GATE this
    // phase's own graduation (phases.ts's resolveFourStarBlockingPhase) — a 4★
    // whose own textual phase differs from its resolved blocking phase is
    // trackable (per closedGoalIds above) but must NOT hold this phase's
    // handoff hostage; see the "4★ anchoring is phase-derived" fix. 5★ goals
    // native to this phase always block it (unaffected — the fix is 4★-only).
    const blockingFourStarIds = computeBlockingFourStarGoalIdsForPhase(
      p,
      persistentSpec.fourStarGoals.map((fg) => fg.goal),
      blockingPhaseByGoalId,
    );
    const blockingGoals = [
      ...phase.goals.filter((g) => g.kind === '5star_character' || g.kind === '5star_weapon'),
      ...persistentSpec.fourStarGoals.map((fg) => fg.goal).filter((g) => blockingFourStarIds.has(g.id)),
    ];
    // Whether this phase has a blocking 4★ that ISN'T one of its own raw
    // `phase.goals` members (e.g. a non-blocking 4★ from an EARLIER phase of
    // this banner whose blocking phase resolved to THIS one). When true, every
    // native member's own `localPrefixDone[k]` — which only ever checks
    // `phase.goals[0..k]`, oblivious to that extra requirement — understates
    // what's actually needed: the phase (and therefore every native member's
    // own series position) can't be considered "reached" without that extra
    // goal too, since its natal phase is always strictly earlier than this
    // one (blocking phase = MAX(natal, anchors) > natal for a non-blocking
    // goal), meaning its global position precedes every native member's.
    // Confirmed via direct Monte Carlo cross-validation this was a real,
    // growing discrepancy (up to ~0.11 at pull 300) for a native goal's own
    // series position downstream of a side-tracked 4★'s resolution.
    const hasExtraBlockingFourStars = blockingFourStarIds.size > 0 && [...blockingFourStarIds].some((id) => !phase.goals.some((g) => g.id === id));

    // A disconnected 4★'s own isolated phase (phases.ts's buildPhases) is
    // capped at MAX_CONTINUATION_HORIZON_PULLS too, same as "Phase C" below
    // and for the same reason — see that constant's own doc comment for the
    // measured numbers. Every other phase runs uncapped, exactly as before.
    const isDisconnectedGoalPhase = phase.goals.length === 1 && disconnectedIds.has(phase.goals[0].id);
    const phaseHorizon = isDisconnectedGoalPhase ? Math.min(maxPulls, MAX_CONTINUATION_HORIZON_PULLS) : maxPulls;
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
    );
    const result = isDisconnectedGoalPhase ? padPhaseDpResult(rawResult, maxPulls + 1) : rawResult;
    lastPhaseResultByBanner.set(phase.banner, result);
    lastPhaseModulusByBanner.set(phase.banner, phaseModulusForThisPhase);

    // Align this phase's local-axis outputs onto the global pull axis. Uses
    // `effectiveDensity` — the main arrivalDensity, UNLESS we're still inside
    // an active side-track's span (an EARLIER non-blocking goal hasn't
    // reached its own blocking phase yet), in which case only the "that goal
    // is ALREADY done" portion should count toward THIS phase's own entries
    // (see ActiveSideTrack's doc comment above). At/after the track's own
    // blocking phase, the goal is guaranteed done either way, so the full,
    // unsplit arrivalDensity is correct again.
    // TS's control-flow analysis doesn't cleanly track a `let` mutated later
    // in this same loop body across iterations — the `as` re-widens the type
    // instead of relying on that (otherwise-unsound-across-loops) narrowing.
    const currentSideTrack = activeSideTrack as ActiveSideTrack | null;
    const effectiveDensity = currentSideTrack !== null && p < currentSideTrack.blockingPhase ? currentSideTrack.gDoneDensity : arrivalDensity;
    const fourStarIndexById = new Map(persistentSpec.fourStarGoals.map((fg, fi) => [fg.goal.id, fi]));
    for (let k = 0; k < phase.goals.length; k++) {
      const globalIdx = phase.globalStartIndex + k;
      const goal = phase.goals[k];
      // Twenty-first reported bug (2026-08-30): `result.localPrefixDone`/
      // `graduatedPrefixDone` are indexed by position in `effectivePhaseGoals`
      // (what was actually passed into runPhaseDp), not necessarily by `k`
      // (position in `phase.goals`, this phase's own NATIVE members) — the two
      // only coincide when there's no window partner (the fast, common path:
      // `effectivePhaseGoals === phase.goals` by reference) or when this is the
      // FIRST phase of a window pair (whose native goals are always the
      // earlier prefix of the combined, priority-ordered list). For the
      // SECOND phase of a pair, its own native goal sits LATER in that
      // combined list, so its position must be looked up by id instead of
      // assumed to equal k — see phases.ts's computeCharacterWindowGoalsForPhase.
      const specIdx = effectivePhaseGoals === phase.goals ? k : effectivePhaseGoals.findIndex((g) => g.id === goal.id);
      const fi = fourStarIndexById.get(goal.id);
      if (fi !== undefined && !blockingFourStarIds.has(goal.id)) {
        const goalBlockingPhase = blockingPhaseByGoalId.get(goal.id);
        // Defensive only — should be unreachable for any real, validated
        // goal now that resolveFourStarBlockingPhase always returns a real
        // phase index (a disconnected goal gets her own isolated phase
        // directly from buildPhases; see phases.ts). `undefined` here would
        // mean a goal with no phase at all, which shouldn't be possible.
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
          // A second, simultaneously-active non-blocking goal (rare) — fall
          // back to the documented marginal approximation.
          const level = fourStarTargetLevelIndex(goal);
          pendingSeriesBridge.set(globalIdx, { banner: phase.banner, fi, level, natalActive: convolve(effectiveDensity, result.activeLevelCounts[fi][level]) });
        }
        continue;
      }
      const nativeLocalPrefixDone = hasExtraBlockingFourStars ? minArray(result.localPrefixDone[specIdx], result.blockingPrefixDone) : result.localPrefixDone[specIdx];
      globalPrefixDone[globalIdx] = convolve(effectiveDensity, nativeLocalPrefixDone);
      // This entry was computed using an active track's gDoneDensity (not the
      // main arrivalDensity) — it ALSO needs the pending stream's eventual
      // resolution added once that track resolves (see affectedGlobalIndices'
      // own doc comment: the tracked goal finishing LATER than this position,
      // but still within budget, is an equally valid way to satisfy it).
      if (currentSideTrack !== null && effectiveDensity === currentSideTrack.gDoneDensity) {
        currentSideTrack.affectedGlobalIndices.push(globalIdx);
      }
    }

    // Resolve the active side track if THIS phase is its own blocking phase.
    // Uses `goalAloneDoneCumulative`, NOT `result.blockingPrefixDone` — the
    // latter requires this phase's WHOLE blockingGoals condition (e.g. its
    // own native 5★, or another persistent 4★), not just the tracked goal
    // itself, which would wrongly make the tracked goal's own resolution
    // depend on those other members too (twentieth reported bug — see
    // goalAloneDoneCumulative's own doc comment).
    if (activeSideTrack && activeSideTrack.blockingPhase === p) {
      const pendingContribution = convolve(
        activeSideTrack.gPendingDensity,
        goalAloneDoneCumulative(result, activeSideTrack.fi, activeSideTrack.level),
      );
      const resolved = new Float64Array(maxPulls + 1);
      for (let n = 0; n <= maxPulls; n++) resolved[n] = activeSideTrack.withinNatalContribution[n] + pendingContribution[n];
      globalPrefixDone[activeSideTrack.globalIdx] = resolved;
      // Every OTHER position computed via this track's gDoneDensity also
      // needs pendingContribution added — see affectedGlobalIndices' own doc
      // comment (the tracked goal resolving LATER than that position, via
      // THIS same blocking phase, still within budget, is an equally valid
      // way to satisfy that position's own prefix).
      for (const otherGlobalIdx of activeSideTrack.affectedGlobalIndices) {
        const target = globalPrefixDone[otherGlobalIdx];
        for (let n = 0; n <= maxPulls; n++) target[n] += pendingContribution[n];
      }
      activeSideTrack = null;
    } else if (activeSideTrack && activeSideTrack.natalPhase !== p) {
      // Still pending — progress both streams forward the same way the main
      // arrivalDensity progresses (this phase doesn't care about the
      // side-tracked goal at all, so both streams get the identical update).
      // Skipped when p === natalPhase: that phase's own timing is ALREADY
      // baked in via the convolve() calls at track-creation time above — this
      // branch is only for phases AFTER the one the track was created in.
      const completionDensity = cumulativeToDensity(result.blockingPrefixDone);
      activeSideTrack.gDoneDensity = convolve(activeSideTrack.gDoneDensity, completionDensity);
      activeSideTrack.gPendingDensity = convolve(activeSideTrack.gPendingDensity, completionDensity);
    }

    // Resolve any pending in-transit contribution: THIS phase is guaranteed to be
    // the intervening phase for whichever earlier phase left one pending, so its
    // own completion CDF (1 - that = survival) is exactly what's needed.
    if (pendingInTransit !== null) {
      const pending = pendingInTransit;
      const survival = result.blockingPrefixDone.map((c) => 1 - c);
      const pendingAccumulator = accumulatedLevelCounts[pending.banner];
      for (let fi = 0; fi < pending.globalGraduationDensity.length; fi++) {
        for (let level = 0; level < pending.globalGraduationDensity[fi].length; level++) {
          const contribution = convolve(pending.globalGraduationDensity[fi][level], survival);
          const target = pendingAccumulator[fi][level];
          for (let n = 0; n <= maxPulls; n++) target[n] += contribution[n];
        }
      }
      pendingInTransit = null;
    }

    // Accumulate this phase's ACTIVE-only contribution.
    const bannerAccumulator = accumulatedLevelCounts[phase.banner];
    for (let fi = 0; fi < persistentSpec.fourStarGoals.length; fi++) {
      const maxCopies = persistentSpec.fourStarGoals[fi].maxCopies;
      for (let level = 0; level < maxCopies; level++) {
        const contribution = convolve(arrivalDensity, result.activeLevelCounts[fi][level]);
        const target = bannerAccumulator[fi][level];
        for (let n = 0; n <= maxPulls; n++) target[n] += contribution[n];
      }
    }

    // This phase's GRADUATED contribution: added directly (unrestricted) if this
    // is the banner's last usage, otherwise deferred as in-transit for the next
    // (intervening) phase to resolve against — UNLESS the very next phase in the
    // array is the SAME banner (reachable since the fifteenth reported bug,
    // 2026-08-19: buildPhases can now produce two consecutive same-banner phases
    // with no intervening different-banner phase at all, when an adjacent-but-
    // UNLINKED pair of 5star_weapon goals is forced apart into separate real
    // windows — see phases.ts's buildPhases). In that case there's no "elsewhere"
    // gap to bridge at all: the next phase's own startDist directly inherits this
    // phase's exit state (via bannerUsedBefore/lastPhaseResultByBanner below,
    // unconditionally, regardless of adjacency), and its own activeLevelCounts,
    // convolved with its own arrivalDensity (which already exactly encodes "when
    // did THIS phase finish," since arrivalDensity advances every phase
    // unconditionally) will report the SAME carried-over level with ZERO gap to
    // bridge — adding it here too, via either path, would double-count it.
    const nextPhase = phases[p + 1];
    if (p === phases.length - 1) {
      // The LITERAL last real phase of the whole simulation — "Phase C"
      // (constructed right after this loop, see "Trailing continuation
      // phase" below) absorbs this phase's own graduated contribution
      // exactly like an ordinary immediate same-banner reoccurrence (the
      // branch right below): its own `activeLevelCounts`, seeded from this
      // phase's `exitSubstateDist`, already include everything graduated
      // here as its own starting mass. Adding it AGAIN here would
      // double-count it (see phaseDp.ts's own history of this exact failure
      // mode, CLAUDE.md's fifteenth-reported-bug section).
    } else if (isLastUsage[p]) {
      for (let fi = 0; fi < persistentSpec.fourStarGoals.length; fi++) {
        const maxCopies = persistentSpec.fourStarGoals[fi].maxCopies;
        for (let level = 0; level < maxCopies; level++) {
          const contribution = convolve(arrivalDensity, result.graduatedLevelCounts[fi][level]);
          const target = bannerAccumulator[fi][level];
          for (let n = 0; n <= maxPulls; n++) target[n] += contribution[n];
        }
      }
    } else if (nextPhase && nextPhase.banner === phase.banner) {
      // Immediate same-banner reoccurrence, no gap — skip both paths (see comment above).
    } else {
      const globalGraduationDensity = persistentSpec.fourStarGoals.map((fg, fi) =>
        Array.from({ length: fg.maxCopies }, (_, level) => convolve(arrivalDensity, cumulativeToDensity(result.graduatedLevelCounts[fi][level]))),
      );
      pendingInTransit = { banner: phase.banner, globalGraduationDensity };
    }

    // Next phase's arrival density = convolve this phase's own completion density
    // into the running arrival density (sum of independent phase durations). The
    // same convolve() used above for aligning cumulative metrics works unchanged
    // here — it's the same sum-product formula either way.
    const completionDensity = cumulativeToDensity(result.blockingPrefixDone);
    arrivalDensity = convolve(arrivalDensity, completionDensity);
  }

  // Trailing continuation phase ("Phase C") — nineteenth reported bug
  // (2026-08-20), scope narrowed by the twentieth-reported-bug follow-up
  // (2026-08-21). Once the LAST real phase of the whole simulation graduates,
  // if pull budget remains, a real player keeps pulling on that SAME banner
  // rather than stopping outright — an already-attached 4★'s constellation
  // breakdown should keep accruing bonus copies past its own target, even
  // though priority focus has moved on, since the breakdown panel is
  // documented to always show the full C0-C6 range regardless of target
  // level. (The nineteenth bug's OTHER original symptom — a disconnected 4★
  // never getting a chance to accrue at all — is now fixed structurally,
  // by `buildPhases` giving her a real, isolated phase at her own priority
  // position; see phases.ts. That made the "Phase R" half of this mechanism,
  // and its tail-banner-only scope boundary, unnecessary — removed.)
  //
  // Only coherent for the banner owning the LITERAL last phase (`tailBanner`,
  // computed before the main loop) — the engine models banner focus as
  // strictly sequential/exclusive, so a continuation anywhere else would
  // double-spend the same pull-budget axis across two mutually exclusive
  // stories.
  //
  // Synthesized with EMPTY `.goals` (never a real member of any phase —
  // avoids the double-membership collision risk described on
  // computeFourStarBlockingPhaseByGoalId's own doc comment) and an
  // UNCONDITIONALLY-open pool built directly here (bypassing
  // computeClosedFourStarGoalIdsForPhase/computeCharacterBannerConfigForPhase/
  // computeWeaponBannerConfigForPhase entirely) — every persistent 4★ of this
  // banner is open. Safe because goalValidation.ts's
  // MAX_TOTAL_FOUR_STAR_GOALS_PER_BANNER already caps the total at-or-under
  // the real roster size, so there's no dilution risk the way an uncapped
  // pool would have. `blockingGoals` = a single synthetic 4★-kind sentinel
  // goal whose `targetId` never matches any real goal's, so `isGoalDone` is
  // unconditionally false (`fourStarIndex` returns -1 forever) and this phase
  // NEVER graduates — runs for the FULL remaining budget, keeping every
  // persistent 4★ of this banner accruing bonus copies past their own
  // target.
  //
  // Doesn't touch `globalPrefixDone` directly (its own `.goals` are empty) —
  // no goal's own completion depends on it. Weapon Fate Points are
  // deliberately NOT reset entering it (`isWeaponFatePointsResetOnEntry` is
  // not called at all here) — this is not a new Epitomized Path selection,
  // it's the same real-time window continuing.
  //
  // Runs its own local DP out to MAX_CONTINUATION_HORIZON_PULLS, not the
  // full remaining global budget — see that constant's own doc comment for
  // why (a real, measured performance regression, and why it can't be fixed
  // exactly). Results are padded back to the full global length by
  // repeating the last computed value before being convolved against
  // arrivalDensity — an explicit, user-approved tradeoff, not an oversight.
  if (tailBanner !== undefined && persistentSpecByBanner[tailBanner].fourStarGoals.length > 0) {
    const definiteTailBanner: BannerKind = tailBanner;
    const lastRealResult = lastPhaseResultByBanner.get(definiteTailBanner);
    const lastRealPhaseModulus = lastPhaseModulusByBanner.get(definiteTailBanner);
    if (lastRealResult && lastRealPhaseModulus !== undefined) {
      const tailPersistentSpec = persistentSpecByBanner[definiteTailBanner];
      const bannerAccumulator = accumulatedLevelCounts[definiteTailBanner];
      const tailFourStarTargetIds = tailPersistentSpec.fourStarGoals.map((fg) => fg.goal.targetId);
      const continuationCharConfig: CharacterBannerConfig = {
        featured5StarId: input.characterBanner.featured5StarId,
        featured4StarIds: padIds(tailFourStarTargetIds, 3, 'continuation-4star-char'),
      };
      const continuationWeaponConfig: WeaponBannerConfig = {
        chosenWeaponId: 'continuation-chosen-weapon',
        otherFeaturedWeaponId: 'continuation-other-weapon',
        featured4WeaponIds: padIds(tailFourStarTargetIds, 5, 'continuation-4star-weapon'),
      };
      const continuationSentinel: Goal = {
        id: '__continuation_sentinel__',
        name: '(continuation)',
        kind: definiteTailBanner === 'character' ? '4star_character' : '4star_weapon',
        banner: definiteTailBanner,
        targetId: '__continuation_unreachable__',
      };

      // Phase C's own phaseGoals is always [] (no 5star_character members
      // possible, so its own phaseModulus is fixed at 1) — but
      // `lastRealResult.exitSubstateDist` was encoded against the REAL last
      // phase's own (possibly >1) phaseModulus. Strip that phaseCode digit
      // back out before feeding it in (mirroring the main loop's "ordinary
      // reoccurrence" re-encoding above) — the continuation phase has no use
      // for a carried FIFO state (it has no 5star_character goals of its own
      // to claim with it), only (bannerCode, persistentCode).
      const tailPersistentModulus = persistentModulusByBanner[definiteTailBanner];
      const strippedTailStartDist = new Map<number, number>();
      for (const [k, v] of normalizeDist(lastRealResult.exitSubstateDist)) {
        const rest = Math.floor(k / lastRealPhaseModulus);
        const persistentCode = rest % tailPersistentModulus;
        const bannerCode = Math.floor(rest / tailPersistentModulus);
        const newKey = bannerCode * tailPersistentModulus + persistentCode;
        strippedTailStartDist.set(newKey, (strippedTailStartDist.get(newKey) ?? 0) + v);
      }

      const continuationHorizon = Math.min(maxPulls, MAX_CONTINUATION_HORIZON_PULLS);
      const phaseCResult = runPhaseDp(
        definiteTailBanner,
        [],
        tailPersistentSpec,
        strippedTailStartDist,
        continuationCharConfig,
        continuationWeaponConfig,
        crModel,
        crParams,
        continuationHorizon,
        new Set(),
        new Set(),
        undefined,
        [continuationSentinel],
      );
      for (let fi = 0; fi < tailPersistentSpec.fourStarGoals.length; fi++) {
        const maxCopies = tailPersistentSpec.fourStarGoals[fi].maxCopies;
        for (let level = 0; level < maxCopies; level++) {
          const contribution = convolve(arrivalDensity, padWithLastValue(phaseCResult.activeLevelCounts[fi][level], maxPulls + 1));
          const target = bannerAccumulator[fi][level];
          for (let n = 0; n <= maxPulls; n++) target[n] += contribution[n];
        }
      }
    }
  }

  // Resolve every deferred non-blocking-goal series entry now that
  // accumulatedLevelCounts is FINAL (every phase has been processed) — see
  // pendingSeriesBridge's own doc comment for the formula. Processed in
  // ASCENDING global-index order so each entry's own monotonicity clamp
  // against the PRECEDING global position can rely on that position already
  // being resolved (whether it was written directly during the main loop
  // above, or resolved earlier in THIS same pass).
  const sortedBridgeEntries = Array.from(pendingSeriesBridge.entries()).sort(([a], [b]) => a - b);
  for (const [globalIdx, { banner, fi, level, natalActive }] of sortedBridgeEntries) {
    const total = accumulatedLevelCounts[banner][fi][level];
    const resolved = new Float64Array(maxPulls + 1);
    for (let n = 0; n <= maxPulls; n++) resolved[n] = Math.max(0, total[n] - natalActive[n]);
    globalPrefixDone[globalIdx] = resolved;
  }

  // A non-blocking goal's own resolved completion (just above) is NOT
  // automatically reflected in any LATER global position's own value — a
  // later position that's a genuine blocking-chain member (e.g. a 5★, or
  // another 4★ that itself blocks its own phase) was computed independently,
  // via that phase's own localPrefixDone, with NO knowledge that an EARLIER,
  // non-blocking 4★ might still be pending. Left alone, this can produce a
  // logically impossible series (a later, strictly-narrower prefix showing a
  // HIGHER probability than an earlier one it's supposed to be a subset of).
  // This forward pass enforces the one invariant series MUST satisfy
  // (series[k] <= series[k-1], since prefix k is a strictly harder
  // requirement than prefix k-1) by taking the pointwise min against the
  // preceding position. This is EXACT for series[k] restricted to k = the
  // non-blocking goal's own position (proven in pendingSeriesBridge's own
  // derivation) but is only a conservative UPPER BOUND — not a fully joint,
  // exact computation — for LATER positions, since it doesn't track the true
  // joint distribution between the non-blocking goal's own completion and
  // whatever blocks those later positions. A fully exact fix would need to
  // track that joint distribution directly (a substantially larger
  // architectural change); this bound is measured (see CLAUDE.md) rather than
  // asserted to be tiny — deliberately conservative rather than silently
  // wrong the way the pre-fix code was.
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
      const labels = goal.kind === '4star_character' ? LEVEL_LABELS_CHARACTER : LEVEL_LABELS_WEAPON;
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
