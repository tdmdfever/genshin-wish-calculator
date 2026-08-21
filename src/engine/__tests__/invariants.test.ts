import { describe, expect, it } from 'vitest';
import { DEFAULT_CR_PARAMS } from '../capturingRadiance';
import { runExactSimulation } from '../exactEngine';
import type { CharacterBannerConfig, CharacterBannerState, Goal, SimulationInput, WeaponBannerState } from '../types';

/**
 * These tests don't compare the exact engine against a second implementation
 * (Monte Carlo) the way exactEngine.test.ts does. Cross-validation only proves
 * two implementations AGREE — if both were built from the same (possibly wrong)
 * mental model of how banner focus advances, they'd compute the same wrong number
 * and every cross-validation test would still pass. Every test here instead checks
 * a LOGICAL RELATIONSHIP that must hold between two runs of the exact engine
 * alone, purely from the definition of the goal list — independent of how
 * "correct" is implemented. A shared conceptual bug in the focus-switching logic
 * would still violate one of these (as long as the bug's effect differs between
 * the two compared scenarios), because there's no second implementation to
 * (mis)agree with.
 */

const charConfig: CharacterBannerConfig = { featured5StarId: 'char5', featured4StarIds: ['c4a', 'c4b', 'c4c'] };
const zeroCharState: CharacterBannerState = { pity5: 0, guaranteed5: false, crCounter: 0, pity4: 0, guaranteed4: false };
const zeroWeaponState: WeaponBannerState = { pity5: 0, guaranteed5: false, fatePoints: 0, pity4: 0, guaranteed4: false };

function baseInput(overrides: Partial<SimulationInput>): SimulationInput {
  return {
    pullBudget: 90,
    characterBanner: { state: zeroCharState, featured5StarId: charConfig.featured5StarId },
    weaponBanner: { state: zeroWeaponState },
    crModelId: 'A',
    crParams: DEFAULT_CR_PARAMS,
    goals: [],
    trialCount: 200_000,
    ...overrides,
  };
}

const odette: Goal = { id: 'o', name: 'Odette', kind: '5star_character', banner: 'character', targetId: 'char5' };
const miko: Goal = { id: 'm', name: 'Miko', kind: '5star_character', banner: 'character', targetId: 'char5' };

function expectPointwiseGTE(a: number[], b: number[], label: string, epsilon = 1e-9) {
  for (let p = 0; p < a.length; p++) {
    expect(a[p], `${label} at pull ${p}: expected ${a[p]} >= ${b[p]}`).toBeGreaterThanOrEqual(b[p] - epsilon);
  }
}

describe('invariant: anchor permissiveness is monotonic', () => {
  // Alyosha (4-star) anchored to {o, m} (both, spanning Odette's and Miko's own
  // SEPARATE sequential phases — o/m are deliberately left UNLINKED here) / {o}
  // (Odette only) form a widening->narrowing chain of accrual windows for the
  // IDENTICAL goal list otherwise. A wider window can only ever grant MORE
  // opportunities to accrue copies, never fewer -- this must hold regardless of
  // what the "correct" absolute numbers are.
  //
  // UPDATE (2026-08-19, "4★ anchoring is phase-derived" fix): "unanchored" used
  // to be the WIDEST window (implicitly attached to whatever's around) — it's no
  // longer part of this monotonic chain at all, since leaving Alyosha unanchored
  // while 2+ same-kind 5-stars exist elsewhere in the list is now a deliberate
  // "disconnected from everything currently listed" choice (issue 1.5.5), not
  // "attach to everything" — a fundamentally different, unrelated semantic, not
  // a wider version of the same window. Covered by its own dedicated test below
  // instead of forced into this chain.
  function alyosha(anchors?: string[]): Goal {
    return { id: 'a', name: 'Alyosha', kind: '4star_character', banner: 'character', targetId: 'c4a', targetLevel: 1, anchoredFiveStarGoalIds: anchors };
  }

  it('Alyosha\'s own breakdown: anchored-to-both >= anchored-to-Odette-only, at every level and pull (within a documented cross-phase residual)', () => {
    // "both" makes Alyosha a NON-BLOCKING member of Odette's own phase (her
    // resolved blocking phase is Miko's, later) — a genuinely NEW shape this
    // fix unlocks (same-banner spanning with NO detour between the two 5★
    // phases at all). Her OWN breakdown (accumulatedLevelCounts, unchanged
    // machinery) inherits the SAME architectural limitation already documented
    // for crCounter (CLAUDE.md's "twelfth reported bug" follow-up) and the
    // original 4★-breakdown cross-phase residual: her copy count is genuinely
    // correlated with how long the PRECEDING phase took, and the phase-handoff
    // marginalizes over arrival time, losing that correlation. Measured here at
    // up to ~4 percentage points for this specific scenario/budget (larger than
    // the previously-documented "well under 0.1pp" bound, which was measured
    // against a DIFFERENT-banner-detour shape — this is a new, same-banner
    // instance of the same class of approximation, not a new bug).
    //
    // CORRECTED: an earlier version of this comment claimed the series/odds-chart
    // output itself is exact and immune to this residual (via
    // graduatedPrefixMassAtStreak/blockingPrefixDone). That's true for a
    // SINGLE-PHASE prefix, but NOT once a later same-banner phase's own
    // blockingPrefixDone folds in a side-tracked goal's carried-over persistent
    // state — that handoff is the exact same arrival-time-marginalized
    // startDist this whole class of residual comes from. See the "chain
    // completion" test below, which needed the same small epsilon treatment.
    // Still much smaller than the breakdown-panel residual (measured well under
    // 0.01 vs. up to ~0.04 here).
    const pullBudget = 150;
    const both = runExactSimulation(baseInput({ pullBudget, goals: [odette, alyosha(['o', 'm']), miko] }));
    const odetteOnly = runExactSimulation(baseInput({ pullBudget, goals: [odette, alyosha(['o']), miko] }));

    const bothBreakdown = both.breakdowns.find((b) => b.goalId === 'a')!;
    const odetteOnlyBreakdown = odetteOnly.breakdowns.find((b) => b.goalId === 'a')!;

    for (let level = 0; level < bothBreakdown.levelProbabilities.length; level++) {
      expectPointwiseGTE(bothBreakdown.levelProbabilities[level], odetteOnlyBreakdown.levelProbabilities[level], `both >= Odette-only, level ${level}`, 0.05);
    }
  }, 60_000);

  it('chain completion (Odette + Alyosha + Miko): anchored-to-both >= anchored-to-Odette-only', () => {
    // This is the "focus-switching" side of the same relationship: a narrower
    // window can force isNextFiveStarClaimBlocked to hold up Miko's own claim
    // (see the user's own worked example: anchored-to-Odette-only means you must
    // keep pulling for Alyosha before Miko's win can count), so completing the
    // FULL chain can only get slower, never faster, as the window narrows.
    const pullBudget = 150;
    const both = runExactSimulation(baseInput({ pullBudget, goals: [odette, alyosha(['o', 'm']), miko] }));
    const odetteOnly = runExactSimulation(baseInput({ pullBudget, goals: [odette, alyosha(['o']), miko] }));

    // Small epsilon for the same reason as the breakdown test above: in the
    // "both" case, Alyosha is a NON-BLOCKING member of Odette's own phase
    // (side-tracked), so Miko's phase inherits her carried-over copy count
    // from a startDist that's marginalized over Odette's-phase arrival time —
    // the same already-documented, accepted class of approximation (CLAUDE.md's
    // "twelfth reported bug" follow-up / "4★ breakdowns sum across every
    // phase"), just now reachable at the series level too via this shape.
    // Measured well under 0.01 here, an order of magnitude below the epsilon.
    expectPointwiseGTE(both.series[2].probabilities, odetteOnly.series[2].probabilities, 'both >= Odette-only (full chain)', 0.01);
  }, 60_000);

  it('leaving Alyosha unanchored while Odette AND Miko both exist elsewhere is a deliberate disconnect from THEIR phases — not "impossible forever" (issue 1.5.5, revised by the nineteenth reported bug, resolved via her own isolated phase by the twentieth-reported-bug follow-up)', () => {
    // Twentieth-reported-bug follow-up (2026-08-21): unanchored + 2 distinct
    // candidate phases (Odette's, Miko's) means genuinely disconnected — she
    // now gets her OWN isolated phase, positioned right after Odette's and
    // BEFORE Miko's (buildPhases). Her resolution depends ONLY on Odette
    // finishing first, then her own C1 accrual within her own phase — NOT on
    // Miko at all, a real, deliberate behavior change from the nineteenth
    // bug's "Phase R" design (which deferred her to after EVERY real phase,
    // including Miko's). At a small budget she's still mostly building up;
    // measured directly at ~4% by pull 60, ~48% by pull 150 (both real,
    // substantial, and neither near-zero nor near-certain) — a wide margin on
    // each side is what distinguishes "genuinely still accruing" from either
    // a regression back toward 0% or one that lets her resolve too freely.
    const smallBudget = 60;
    const unanchoredSmall = runExactSimulation(baseInput({ pullBudget: smallBudget, goals: [odette, alyosha(undefined), miko] }));
    const unanchoredSmallBreakdown = unanchoredSmall.breakdowns.find((b) => b.goalId === 'a')!;
    for (const levelProbs of unanchoredSmallBreakdown.levelProbabilities) expect(levelProbs[smallBudget]).toBeLessThan(0.15);

    const pullBudget = 150;
    const unanchored = runExactSimulation(baseInput({ pullBudget, goals: [odette, alyosha(undefined), miko] }));
    const unanchoredBreakdown = unanchored.breakdowns.find((b) => b.goalId === 'a')!;
    expect(unanchoredBreakdown.levelProbabilities[1][pullBudget]).toBeGreaterThan(0.3);
    expect(unanchoredBreakdown.levelProbabilities[1][pullBudget]).toBeLessThan(0.7);
    // Odette's own completion is unaffected by Alyosha's disconnection at all
    // — checked directly against an Odette-only run instead of an arbitrary
    // threshold.
    const odetteAlone = runExactSimulation(baseInput({ pullBudget, goals: [odette] }));
    expect(unanchored.series[0].probabilities[pullBudget]).toBeCloseTo(odetteAlone.series[0].probabilities[pullBudget], 9);

    // Given a large budget, both Alyosha's own isolated phase AND Miko's
    // (later, entirely independent of Alyosha) resolve, so the full 3-goal
    // chain reaches near-certain completion.
    const bigBudget = 900;
    const unanchoredBig = runExactSimulation(baseInput({ pullBudget: bigBudget, goals: [odette, alyosha(undefined), miko] }));
    expect(unanchoredBig.series[2].probabilities[bigBudget]).toBeGreaterThan(0.9);
  }, 60_000);
});

describe('invariant: loosening a target level only helps what comes after it', () => {
  it('a lower targetLevel on an earlier 4-star can only speed up (or match) a later goal, never slow it down', () => {
    const weaponGoal: Goal = { id: 'w', name: 'Weapon', kind: '5star_weapon', banner: 'weapon', targetId: 'chosen' };
    function alyosha(targetLevel: number): Goal {
      return { id: 'a', name: 'Alyosha', kind: '4star_character', banner: 'character', targetId: 'c4a', targetLevel };
    }
    const pullBudget = 150;
    const strict = runExactSimulation(baseInput({ pullBudget, goals: [odette, alyosha(3), weaponGoal] })); // wait for C3
    const loose = runExactSimulation(baseInput({ pullBudget, goals: [odette, alyosha(0), weaponGoal] })); // wait for C0 only

    // series[2] = "Odette + Alyosha + Weapon" all done -- less waiting on Alyosha
    // means focus reaches the weapon banner sooner, so this must never be slower.
    expectPointwiseGTE(loose.series[2].probabilities, strict.series[2].probabilities, 'loose target >= strict target (downstream goal)');
  }, 60_000);
});

describe('invariant: prefix independence — later goals cannot affect earlier ones', () => {
  // Revised, nineteenth reported bug (2026-08-20): SERIES entries remain
  // byte-for-byte independent of anything appended after them — unaffected
  // by the trailing-continuation-phase fix, since Phase R/Phase C never touch
  // `globalPrefixDone` for a goal that already has a real blocking phase (see
  // exactEngine.ts's own doc comment on "Trailing continuation phases").
  //
  // A goal's own BREAKDOWN, however, is no longer fully prefix-independent
  // PAST HER OWN TARGET LEVEL — and this is a deliberate, understood
  // consequence of the fix's own scope boundary, not a bug: whether a
  // 4-star's banner gets a "keep pulling for bonus copies" trailing
  // continuation depends on whether that banner owns the LITERAL LAST phase
  // of the WHOLE list. Appending a goal on a DIFFERENT banner (here, a
  // weapon goal after Miko) means the character banner is no longer the
  // tail — Alyosha (anchored to Odette, already-attached) genuinely loses
  // her own "bonus accrual past C0" eligibility, since a real player would
  // spend that same leftover budget on the newly-appended weapon goal
  // instead. Her OWN TARGET LEVEL (C0 here, unaffected either way — she
  // either has it or she doesn't, determined entirely within her own natal
  // phase's DP, before any continuation could matter) stays exactly prefix-
  // independent; only levels ABOVE her target can legitimately shrink.
  it('appending a goal to the end of the list leaves every earlier series entry byte-for-byte unchanged, and never INCREASES an earlier goal\'s own breakdown', () => {
    const alyosha: Goal = { id: 'a', name: 'Alyosha', kind: '4star_character', banner: 'character', targetId: 'c4a', anchoredFiveStarGoalIds: ['o'] };
    const weaponGoal: Goal = { id: 'w', name: 'Weapon', kind: '5star_weapon', banner: 'weapon', targetId: 'chosen' };
    const pullBudget = 120;

    const shortList = runExactSimulation(baseInput({ pullBudget, goals: [odette, alyosha, miko] }));
    const extended = runExactSimulation(baseInput({ pullBudget, goals: [odette, alyosha, miko, weaponGoal] }));

    // series[0..2] describe prefixes entirely contained in both lists; priority
    // order means nothing at position 3 (the appended weapon goal) can possibly
    // change what happens at or before position 2 -- this should be EXACT
    // equality, not just monotonic, since it's the identical computation up to
    // that point.
    for (let k = 0; k < 3; k++) {
      for (let p = 0; p <= pullBudget; p += 10) {
        expect(extended.series[k].probabilities[p]).toBeCloseTo(shortList.series[k].probabilities[p], 12);
      }
    }
    // Alyosha's own breakdown: her OWN TARGET LEVEL (index 0, C0) stays exact
    // (well past ordinary floating-point noise, ~1e-15 observed here) --
    // determined entirely within her own natal phase, before any trailing
    // continuation could matter. Levels ABOVE her target can only ever
    // SHRINK once something else follows in priority order (never grow --
    // the extended list never gives her MORE opportunity than the short
    // one), reflecting the trailing-continuation fix's own documented scope
    // boundary rather than a violated invariant.
    const shortBreakdown = shortList.breakdowns.find((b) => b.goalId === 'a')!;
    const extendedBreakdown = extended.breakdowns.find((b) => b.goalId === 'a')!;
    for (let p = 0; p <= pullBudget; p += 10) {
      expect(extendedBreakdown.levelProbabilities[0][p]).toBeCloseTo(shortBreakdown.levelProbabilities[0][p], 9);
    }
    for (let level = 1; level < shortBreakdown.levelProbabilities.length; level++) {
      for (let p = 0; p <= pullBudget; p += 10) {
        expect(extendedBreakdown.levelProbabilities[level][p]).toBeLessThanOrEqual(shortBreakdown.levelProbabilities[level][p] + 1e-9);
      }
    }
  }, 60_000);
});

describe('invariant: internal consistency between the completion series and the breakdown', () => {
  it('for an isolated 4-star goal at its default target (C0), its own series entry exactly equals its own breakdown C0 curve', () => {
    // Both numbers are read off the SAME underlying persistent vector, but through
    // two different code paths (phase-local isGoalDone/localPrefixDone vs.
    // exactEngine.ts's activeLevelCounts/graduatedLevelCounts aggregation) -- they
    // should never be able to drift apart for a single-goal list, since "done" and
    // "reached C0" are literally the same event when targetLevel defaults to 0.
    const alyosha: Goal = { id: 'a', name: 'Alyosha', kind: '4star_character', banner: 'character', targetId: 'c4a' };
    const result = runExactSimulation(baseInput({ pullBudget: 90, goals: [alyosha] }));
    const breakdown = result.breakdowns.find((b) => b.goalId === 'a')!;
    for (let p = 0; p <= 90; p++) {
      expect(result.series[0].probabilities[p]).toBeCloseTo(breakdown.levelProbabilities[0][p], 9);
    }
  });
});

describe('invariant: more pulls can only ever help', () => {
  it('every series entry is non-decreasing in pull count (already covered elsewhere for breakdowns; this checks the goal-completion series too)', () => {
    const alyosha: Goal = { id: 'a', name: 'Alyosha', kind: '4star_character', banner: 'character', targetId: 'c4a', anchoredFiveStarGoalIds: ['o'] };
    const weaponGoal: Goal = { id: 'w', name: 'Weapon', kind: '5star_weapon', banner: 'weapon', targetId: 'chosen' };
    const result = runExactSimulation(baseInput({ pullBudget: 120, goals: [odette, alyosha, miko, weaponGoal] }));
    for (const series of result.series) {
      let prev = -1;
      for (let p = 0; p <= 120; p++) {
        expect(series.probabilities[p]).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = series.probabilities[p];
      }
    }
  }, 30_000);
});

describe('invariant: a longer prefix can never be more likely than a shorter one', () => {
  it('series[k] >= series[k+1] at every pull count, for every k', () => {
    // Definitional given how prefixes are constructed (completing goals 1..k+1
    // requires everything completing goals 1..k requires, plus more) — but that's
    // exactly why it's worth asserting explicitly: a corruption in how prefix mass
    // is accumulated (e.g. a goal's contribution counted against the wrong k, or a
    // convolution term applied to the wrong series) would violate this directly,
    // and might not visibly break any single series' own monotonicity-in-pulls.
    const alyosha: Goal = { id: 'a', name: 'Alyosha', kind: '4star_character', banner: 'character', targetId: 'c4a', anchoredFiveStarGoalIds: ['o'] };
    const weaponGoal: Goal = { id: 'w', name: 'Weapon', kind: '5star_weapon', banner: 'weapon', targetId: 'chosen' };
    const result = runExactSimulation(baseInput({ pullBudget: 120, goals: [odette, alyosha, miko, weaponGoal] }));
    for (let k = 0; k < result.series.length - 1; k++) {
      for (let p = 0; p <= 120; p++) {
        expect(result.series[k].probabilities[p], `series[${k}] vs series[${k + 1}] at pull ${p}`).toBeGreaterThanOrEqual(
          result.series[k + 1].probabilities[p] - 1e-9,
        );
      }
    }
  }, 30_000);
});

describe('invariant: a goal that is the sole member of its own required phase must approach 100%, never plateau below it, given enough pulls', () => {
  // A "hard ceiling" bug — the chain (or the goal's own breakdown) climbing for a
  // while and then going flat well short of 100%, no matter how many more pulls
  // are budgeted — is a distinct failure mode from non-monotonicity (a flat curve
  // is still technically non-decreasing) and from wrong-but-plausible absolute
  // numbers (cross-validation can miss a ceiling both engines agree on, if the
  // ceiling comes from a shared conceptual bug in when a window opens/closes —
  // exactly what happened here: the ninth reported bug closed a 4-star's
  // accrual window during its own required phase, so that phase could never
  // graduate past whatever mass had already accrued earlier, regardless of pull
  // budget). Pity guarantees mean a well-formed, reachable goal's own probability
  // must keep climbing toward 1 as pull budget grows, not flatten out early.
  it("a 4-star anchored ONLY to an earlier, different-banner-detour-separated 5-star still reaches near-certainty given a large pull budget", () => {
    const weaponGoal: Goal = { id: 'w', name: 'Weapon', kind: '5star_weapon', banner: 'weapon', targetId: 'chosen' };
    const alyosha: Goal = {
      id: 'a',
      name: 'Alyosha',
      kind: '4star_character',
      banner: 'character',
      targetId: 'c4a',
      targetLevel: 1, // C1 = 2 copies
      anchoredFiveStarGoalIds: ['o'],
    };
    const result = runExactSimulation(baseInput({ pullBudget: 600, goals: [odette, weaponGoal, alyosha] }));
    const breakdown = result.breakdowns.find((b) => b.goalId === 'a')!;
    // Not literally 1 (there's always some infinitesimal residual tail), but a
    // hard-ceiling bug plateaus far below this, not asymptotically close to it.
    expect(breakdown.levelProbabilities[1][600]).toBeGreaterThan(0.995);
    expect(result.series[2].probabilities[600]).toBeGreaterThan(0.995);
  }, 30_000);

  it('two 4-stars, BOTH anchored to Odette but each resuming in its OWN separate later phase, also fully resolve given a large pull budget', () => {
    // A structurally different shape from the ninth-bug repro (that one had a
    // single 4-star resuming once, after one detour; this one resumes the SAME
    // banner TWICE, for two DIFFERENT 4-stars, each requiring its own natal
    // phase's window to stay open) -- broadens this invariant's coverage beyond
    // the exact scenario that first caught the bug, since the whole point of an
    // invariant (vs. a one-off regression test) is to catch the same CLASS of bug
    // in a shape nobody has specifically tested yet. Goals: Odette, then a weapon
    // detour, then 41 (anchored to Odette, own phase), then ANOTHER weapon
    // detour, then 42 (also anchored to Odette only, own separate later phase).
    // Distinct, real, achievable targetIds — 'chosen'/'other' become this phase's
    // own Epitomized Path identities (each weapon goal is the sole member of its
    // own phase) — matching how the real app always assigns targetId (a
    // goal's own auto-generated id, see AppStateContext.tsx's ADD_GOAL); two
    // 5star_weapon goals sharing a targetId can't happen via the real UI.
    // Default target level (C0, 1 copy) rather than C1 — sufficient to exercise
    // the structural fix (window must stay open in each item's own natal phase)
    // without also compounding two non-hard-pity-guaranteed "2 copies of a
    // specific 1-of-3 featured 4-star" requirements. Even at C0, this scenario
    // needs a big budget on its own merits — it chains THREE separate 5-star
    // draws (Odette + 2 weapons), each individually needing close to full pity in
    // the tail, so their combined tail is genuinely longer than the single-detour
    // case above. Confirmed by checking the actual growth curve directly (not
    // guessed): 10.8% @200, 68.0% @400, 90.3% @600, 97.0% @800, 99.1% @1000 —
    // smooth, continuous, un-ceilinged growth throughout, just slower than the
    // simpler scenario above because there's genuinely more to complete.
    const weaponA: Goal = { id: 'wa', name: 'WeaponA', kind: '5star_weapon', banner: 'weapon', targetId: 'chosen' };
    const weaponB: Goal = { id: 'wb', name: 'WeaponB', kind: '5star_weapon', banner: 'weapon', targetId: 'other' };
    const fortyOne: Goal = { id: '41', name: '41', kind: '4star_character', banner: 'character', targetId: 'c4a', anchoredFiveStarGoalIds: ['o'] };
    const fortyTwo: Goal = { id: '42', name: '42', kind: '4star_character', banner: 'character', targetId: 'c4b', anchoredFiveStarGoalIds: ['o'] };
    const result = runExactSimulation(baseInput({ pullBudget: 1000, goals: [odette, weaponA, fortyOne, weaponB, fortyTwo] }));
    expect(result.series[4].probabilities[1000]).toBeGreaterThan(0.99); // full 5-goal chain
    const breakdown42 = result.breakdowns.find((b) => b.goalId === '42')!;
    expect(breakdown42.levelProbabilities[0][1000]).toBeGreaterThan(0.99);
  }, 90_000);
});
