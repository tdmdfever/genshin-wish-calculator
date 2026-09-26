import { describe, expect, it } from 'vitest';
import { CR_MODELS, DEFAULT_CR_PARAMS } from '../capturingRadiance';
import { exactCharacterBannerCdf, exactWeaponBannerCdf } from '../exactDp';
import { runExactSimulation } from '../exactEngine';
import { weapon5Rate } from '../pity';
import { runSimulation } from '../simulate';
import type {
  CharacterBannerConfig,
  CharacterBannerState,
  Goal,
  SimulationInput,
  WeaponBannerConfig,
  WeaponBannerState,
} from '../types';

const charConfig: CharacterBannerConfig = { featured5StarId: 'char5', featured4StarIds: ['c4a', 'c4b', 'c4c'] };
const weaponConfig: WeaponBannerConfig = {
  chosenWeaponId: 'chosen',
  otherFeaturedWeaponId: 'other',
  featured4WeaponIds: ['w4a', 'w4b', 'w4c', 'w4d', 'w4e'],
};
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

describe('single-phase agreement with exactDp.ts', () => {
  it('a single character-banner 5-star goal matches exactCharacterBannerCdf exactly', () => {
    const goal: Goal = { id: 'g1', name: 'Goal', kind: '5star_character', banner: 'character', targetId: 'char5' };
    const input = baseInput({ pullBudget: 120, goals: [goal] });
    const result = runExactSimulation(input);
    const expected = exactCharacterBannerCdf(zeroCharState, charConfig, CR_MODELS.A, DEFAULT_CR_PARAMS, (o) => o.rarity === 5 && o.kind === 'featured', 120);
    for (let p = 0; p <= 120; p++) {
      expect(result.series[0].probabilities[p]).toBeCloseTo(expected[p], 9);
    }
  });

  it('a single weapon-banner 5-star goal matches exactWeaponBannerCdf exactly', () => {
    const goal: Goal = { id: 'g1', name: 'Goal', kind: '5star_weapon', banner: 'weapon', targetId: 'chosen' };
    const input = baseInput({ pullBudget: 120, goals: [goal] });
    const result = runExactSimulation(input);
    const expected = exactWeaponBannerCdf(zeroWeaponState, weaponConfig, (o) => o.rarity === 5 && o.kind === 'featured' && o.itemId === 'chosen', 120);
    for (let p = 0; p <= 120; p++) {
      expect(result.series[0].probabilities[p]).toBeCloseTo(expected[p], 9);
    }
  });

  it('the earlier HuTao/Furina regression scenario (pity=40) matches the known exact value', () => {
    const first: Goal = { id: 'first', name: 'HuTao', kind: '5star_character', banner: 'character', targetId: 'char5' };
    const second: Goal = { id: 'second', name: 'Furina', kind: '5star_character', banner: 'character', targetId: 'char5' };
    const input = baseInput({
      pullBudget: 90,
      characterBanner: { state: { pity5: 40, guaranteed5: false, crCounter: 0, pity4: 0, guaranteed4: false }, featured5StarId: charConfig.featured5StarId },
      goals: [first, second],
    });
    const result = runExactSimulation(input);
    expect(result.series[0].probabilities[90]).toBeCloseTo(0.6642, 3);
    expect(result.series[1].probabilities[90]).toBeLessThan(result.series[0].probabilities[90] - 0.1);
  });
});

describe('agreement with Monte Carlo on multi-phase (cross-banner) scenarios', () => {
  it('character then weapon goal (2 phases) matches Monte Carlo within tolerance', () => {
    const charGoal: Goal = { id: 'c', name: 'Char', kind: '5star_character', banner: 'character', targetId: 'char5' };
    const weaponGoal: Goal = { id: 'w', name: 'Weapon', kind: '5star_weapon', banner: 'weapon', targetId: 'chosen' };
    const input = baseInput({ pullBudget: 150, goals: [charGoal, weaponGoal], trialCount: 300_000, seed: 1 });
    const exact = runExactSimulation(input);
    const mc = runSimulation(input);
    for (const p of [30, 60, 90, 120, 150]) {
      expect(Math.abs(exact.series[0].probabilities[p] - mc.series[0].probabilities[p])).toBeLessThan(0.02);
      expect(Math.abs(exact.series[1].probabilities[p] - mc.series[1].probabilities[p])).toBeLessThan(0.02);
    }
  }, 30_000);

  it('interleaved char->weapon->char (3 phases) matches Monte Carlo within tolerance', () => {
    const charGoal1: Goal = { id: 'c1', name: 'CharA', kind: '5star_character', banner: 'character', targetId: 'char5' };
    const weaponGoal: Goal = { id: 'w', name: 'Weapon', kind: '5star_weapon', banner: 'weapon', targetId: 'chosen' };
    const charGoal2: Goal = { id: 'c2', name: 'CharB', kind: '5star_character', banner: 'character', targetId: 'char5' };
    const input = baseInput({ pullBudget: 200, goals: [charGoal1, weaponGoal, charGoal2], trialCount: 300_000, seed: 2 });
    const exact = runExactSimulation(input);
    const mc = runSimulation(input);
    for (const p of [50, 100, 150, 200]) {
      expect(Math.abs(exact.series[0].probabilities[p] - mc.series[0].probabilities[p])).toBeLessThan(0.02);
      expect(Math.abs(exact.series[1].probabilities[p] - mc.series[1].probabilities[p])).toBeLessThan(0.03);
      expect(Math.abs(exact.series[2].probabilities[p] - mc.series[2].probabilities[p])).toBeLessThan(0.03);
    }
  }, 30_000);

  it('opportunistic same-banner 4-star + 5-star goal matches Monte Carlo within tolerance', () => {
    const fiveStar: Goal = { id: 'g5', name: '5star', kind: '5star_character', banner: 'character', targetId: 'char5' };
    const fourStar: Goal = { id: 'g4', name: '4star', kind: '4star_character', banner: 'character', targetId: 'c4a' };
    const input = baseInput({ pullBudget: 90, goals: [fiveStar, fourStar], trialCount: 300_000, seed: 3 });
    const exact = runExactSimulation(input);
    const mc = runSimulation(input);
    for (const p of [10, 30, 60, 90]) {
      expect(Math.abs(exact.series[0].probabilities[p] - mc.series[0].probabilities[p])).toBeLessThan(0.02);
      expect(Math.abs(exact.series[1].probabilities[p] - mc.series[1].probabilities[p])).toBeLessThan(0.02);
    }
  }, 30_000);
});

describe('4-star constellation/refinement breakdown', () => {
  it('an isolated 4-star goal (nothing else pulling on its banner) keeps accruing bonus copies past its own target — nineteenth reported bug', () => {
    const goal: Goal = { id: 'aino', name: 'Aino', kind: '4star_character', banner: 'character', targetId: 'c4a', targetLevel: 0 };
    const input = baseInput({ pullBudget: 90, goals: [goal] });
    const result = runExactSimulation(input);
    expect(result.breakdowns).toHaveLength(1);
    const b = result.breakdowns[0];
    expect(b.levelLabels).toEqual(['C0', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6']);
    // Matches the exact computed value (~94.4%): plausible for "at least 1 of 3
    // simultaneous rate-up 4-stars within 90 pulls" — not simply eyeballed.
    expect(b.levelProbabilities[0][90]).toBeCloseTo(0.9444, 3);
    // REVISED (nineteenth reported bug, 2026-08-20): since this is the only
    // goal, her banner owns the LITERAL last (and only) phase of the whole
    // simulation — she unconditionally qualifies for the trailing "Phase C"
    // continuation (see exactEngine.ts's own doc comment), so pulling does
    // NOT stop once C0 is reached; a player with nothing else to chase would
    // keep pulling for bonus constellations. Higher levels are strictly
    // increasing in level index (harder to reach) but all genuinely
    // achievable within 90 pulls given the same padded-pool math as any
    // other phase.
    for (let level = 1; level < 7; level++) {
      expect(b.levelProbabilities[level][90]).toBeGreaterThan(0);
      expect(b.levelProbabilities[level][90]).toBeLessThanOrEqual(b.levelProbabilities[level - 1][90]);
    }
    // A large budget should make even C6 near-certain — confirms the
    // continuation genuinely keeps running for the full remaining pulls,
    // not just a token amount.
    const bigResult = runExactSimulation(baseInput({ pullBudget: 900, goals: [goal] }));
    const bigBreakdown = bigResult.breakdowns[0];
    expect(bigBreakdown.levelProbabilities[6][900]).toBeGreaterThan(0.9);
  }, 30_000);

  it('with a companion 5-star goal keeping pulls going, higher levels become reachable — the "extra copies while pulling for the 5-star" case the breakdown exists for', () => {
    const fiveStar: Goal = { id: 'g5', name: '5star', kind: '5star_character', banner: 'character', targetId: 'char5' };
    const fourStarC2: Goal = { id: 'aino', name: 'Aino', kind: '4star_character', banner: 'character', targetId: 'c4a', targetLevel: 2 };
    const input = baseInput({ pullBudget: 90, goals: [fiveStar, fourStarC2] });
    const result = runExactSimulation(input);
    const b = result.breakdowns[0];
    // Even though the goal only needs C2, C3-C6 are still reported and meaningfully
    // nonzero now, since pulling continues past C2 while chasing the 5-star.
    expect(b.levelProbabilities[6][90]).toBeGreaterThan(0);
    expect(b.levelProbabilities[3][90]).toBeGreaterThan(0.01);
    // The prefix-2 series (both goals done) requires reaching C2, which is exactly
    // level index 2 of the breakdown — but only once the 5-star is ALSO done, so
    // prefix-2 is upper-bounded by (not necessarily equal to) the C2 curve.
    expect(result.series[1].probabilities[90]).toBeLessThanOrEqual(b.levelProbabilities[2][90] + 1e-9);
  });

  it('weapon 4-star breakdown uses R1-R5 labels and matches the goal\'s own completion series at its targetLevel', () => {
    const goalR3: Goal = { id: 'sword', name: 'Sword', kind: '4star_weapon', banner: 'weapon', targetId: 'w4a', targetLevel: 3 };
    const input = baseInput({ pullBudget: 80, goals: [goalR3] });
    const result = runExactSimulation(input);
    const b = result.breakdowns[0];
    expect(b.levelLabels).toEqual(['R1', 'R2', 'R3', 'R4', 'R5']);
    expect(result.series[0].probabilities[80]).toBeCloseTo(b.levelProbabilities[2][80], 6); // R3 = index 2
  });

  it('a phase-blocking C2 target genuinely delays the next phase (matches Monte Carlo)', () => {
    // Priority: Mavuika (5star char), Aino at C2 (4star char, needs 3 copies), then a weapon goal.
    // With Aino's target raised to C2, the weapon phase should be reached later than
    // with a default C0 target — verify this against Monte Carlo, not just internally.
    const mavuika: Goal = { id: 'mav', name: 'Mavuika', kind: '5star_character', banner: 'character', targetId: 'char5' };
    const ainoC2: Goal = { id: 'aino', name: 'Aino', kind: '4star_character', banner: 'character', targetId: 'c4a', targetLevel: 2 };
    const weapon: Goal = { id: 'w', name: 'Weapon', kind: '5star_weapon', banner: 'weapon', targetId: 'chosen' };
    const input = baseInput({ pullBudget: 150, goals: [mavuika, ainoC2, weapon], trialCount: 300_000, seed: 4 });
    const exact = runExactSimulation(input);
    const mc = runSimulation(input);
    for (const p of [50, 100, 150]) {
      expect(Math.abs(exact.series[2].probabilities[p] - mc.series[2].probabilities[p])).toBeLessThan(0.03);
    }
  }, 30_000);
});

describe('4-star anchored to specific 5-star banner(s) — end-to-end', () => {
  // Linked (sixteenth reported bug, 2026-08-19): most tests in this block are
  // specifically about SAME-PHASE anchor gating (Odette+Miko simultaneous) —
  // adjacency alone no longer implies that. The tests using a weapon detour
  // between Odette and Miko (or not using Miko at all) are unaffected either
  // way since they're not adjacent.
  const odette: Goal = { id: 'o', name: 'Odette', kind: '5star_character', banner: 'character', targetId: 'char5', linkedCharacterGoalId: 'm' };
  const miko: Goal = { id: 'm', name: 'Miko', kind: '5star_character', banner: 'character', targetId: 'char5', linkedCharacterGoalId: 'o' };

  it('anchor sharing the 4-star\'s own phase imposes NO restriction — matches an unanchored equivalent exactly and matches Monte Carlo', () => {
    // Regression test for the reported bug: Odette, Alyosha (anchored to Odette
    // only), Tsaritsa/Miko all land in one phase (same banner, consecutive). A 4-star
    // should keep accruing copies after its anchor is obtained, up to its own
    // target, since the phase can't graduate without Alyosha being done too — an
    // earlier version froze her copy count the instant Odette dropped, which could
    // deadlock her below target forever and make "Odette + Alyosha" plateau early.
    const alyoshaAnchored: Goal = {
      id: 'a',
      name: 'Alyosha',
      kind: '4star_character',
      banner: 'character',
      targetId: 'c4a',
      targetLevel: 1, // C1 = 2 copies
      anchoredFiveStarGoalIds: ['o'],
    };
    const alyoshaUnanchored: Goal = { id: 'a', name: 'Alyosha', kind: '4star_character', banner: 'character', targetId: 'c4a', targetLevel: 1 };
    const input = baseInput({ pullBudget: 150, goals: [odette, alyoshaAnchored, miko], trialCount: 300_000, seed: 5 });
    const unanchoredInput = baseInput({ pullBudget: 150, goals: [odette, alyoshaUnanchored, miko] });
    const exact = runExactSimulation(input);
    const mc = runSimulation(input);
    const unanchoredExact = runExactSimulation(unanchoredInput);

    // Same-phase anchoring is a no-op for the math: identical to unanchored.
    for (let p = 0; p <= 150; p += 15) {
      expect(exact.series[1].probabilities[p]).toBeCloseTo(unanchoredExact.series[1].probabilities[p], 9);
    }
    // And critically, it does NOT plateau early the way the frozen version did: by
    // pull 150 it's well past the ~30% ceiling the bug used to get stuck at (the
    // fraction where Alyosha happened to get a copy before Odette dropped), because
    // copies keep accruing for the whole phase instead of freezing at Odette's win.
    expect(exact.series[1].probabilities[150]).toBeGreaterThan(0.5);

    for (const p of [50, 100, 150]) {
      expect(Math.abs(exact.series[1].probabilities[p] - mc.series[1].probabilities[p])).toBeLessThan(0.03);
    }
  }, 30_000);

  it('a 4-star listed AFTER a different-banner detour still opportunistically accrues copies during the EARLIER same-banner phase, and correctly freezes once its anchor is won — matches Monte Carlo', () => {
    // Regression test for the second reported bug: Odette's phase, then a
    // weapon-banner detour, then Alyosha's own LATER character phase (anchored to
    // Odette). Alyosha isn't one of Odette's phase's own goals, but multiple
    // 4-stars coexist on a banner — copies CAN drop during Odette's own pulls,
    // before Odette (the anchor) actually wins. An earlier version tracked 4-star
    // copies per-phase only, so any copies gained during Odette's phase were
    // silently discarded and Alyosha always read as exactly 0% for the whole
    // simulation, regardless of anchoring.
    const weaponGoal: Goal = { id: 'w', name: 'Weapon', kind: '5star_weapon', banner: 'weapon', targetId: 'chosen' };
    const alyoshaLatePhase: Goal = {
      id: 'a',
      name: 'Alyosha',
      kind: '4star_character',
      banner: 'character',
      targetId: 'c4a',
      anchoredFiveStarGoalIds: ['o'],
    };
    const input = baseInput({ pullBudget: 200, goals: [odette, weaponGoal, alyoshaLatePhase], trialCount: 600_000, seed: 7 });
    const exact = runExactSimulation(input);
    const mc = runSimulation(input);

    const breakdown = exact.breakdowns.find((b) => b.goalId === 'a')!;
    // Some probability mass DOES reach at least 1 copy — accrued opportunistically
    // during Odette's own pulls, before Odette (the anchor) actually drops. This is
    // the headline fix: it must NOT be flat zero.
    expect(breakdown.levelProbabilities[0][200]).toBeGreaterThan(0.01);

    for (const p of [100, 150, 200]) {
      expect(Math.abs(exact.series[2].probabilities[p] - mc.series[2].probabilities[p])).toBeLessThan(0.05);
    }
  }, 30_000);

  it('an unanchored 4-star listed AFTER a different-banner detour keeps accruing copies through BOTH the earlier and later same-banner phases — matches Monte Carlo', () => {
    const weaponGoal: Goal = { id: 'w', name: 'Weapon', kind: '5star_weapon', banner: 'weapon', targetId: 'chosen' };
    const alyoshaLatePhase: Goal = { id: 'a', name: 'Alyosha', kind: '4star_character', banner: 'character', targetId: 'c4a', targetLevel: 1 };
    const input = baseInput({ pullBudget: 200, goals: [odette, weaponGoal, alyoshaLatePhase], trialCount: 600_000, seed: 8 });
    const exact = runExactSimulation(input);
    const mc = runSimulation(input);

    for (const p of [100, 150, 200]) {
      expect(Math.abs(exact.series[2].probabilities[p] - mc.series[2].probabilities[p])).toBeLessThan(0.035);
    }
  }, 30_000);

  it('case B (anchored to Odette only) delays Miko\'s own claim until Alyosha\'s target is met, so completing all three is strictly slower than case A (anchored to both) — matches Monte Carlo for both', () => {
    // Third reported bug: within a single shared phase, Miko's win-claim was
    // "whichever featured win comes 2nd, regardless of Alyosha's status" in both
    // cases — making case A and case B indistinguishable for anything involving
    // Miko. In case B, a featured win can't start counting toward Miko until
    // Alyosha's target (tied to Odette's specific patch) is actually reached; in
    // case A, Alyosha's patch spans Miko's banner too, so nothing blocks Miko.
    const alyoshaCaseB: Goal = { id: 'a', name: 'Alyosha', kind: '4star_character', banner: 'character', targetId: 'c4a', targetLevel: 1, anchoredFiveStarGoalIds: ['o'] };
    const alyoshaCaseA: Goal = { id: 'a', name: 'Alyosha', kind: '4star_character', banner: 'character', targetId: 'c4a', targetLevel: 1, anchoredFiveStarGoalIds: ['o', 'm'] };
    const inputB = baseInput({ goals: [odette, alyoshaCaseB, miko], pullBudget: 150, trialCount: 300_000, seed: 10 });
    const inputA = baseInput({ goals: [odette, alyoshaCaseA, miko], pullBudget: 150, trialCount: 300_000, seed: 11 });
    const resultB = runExactSimulation(inputB);
    const resultA = runExactSimulation(inputA);
    const mcB = runSimulation(inputB);
    const mcA = runSimulation(inputA);

    // series[2] = "Odette + Alyosha(C1) + Miko" all done — case A must be strictly
    // ahead, with the gap widening at later pull counts (case B's Miko-claim delay
    // compounds the longer both are pulling).
    expect(resultA.series[2].probabilities[90]).toBeGreaterThan(resultB.series[2].probabilities[90]);
    for (const p of [120, 150]) {
      expect(resultA.series[2].probabilities[p]).toBeGreaterThan(resultB.series[2].probabilities[p] + 0.01);
    }
    for (const p of [90, 120, 150]) {
      expect(Math.abs(resultA.series[2].probabilities[p] - mcA.series[2].probabilities[p])).toBeLessThan(0.03);
      expect(Math.abs(resultB.series[2].probabilities[p] - mcB.series[2].probabilities[p])).toBeLessThan(0.03);
    }
  }, 40_000);

  it("a 4-star goal's breakdown is a true marginal, not silently gated on every other goal in the list also being done", () => {
    // Fourth reported bug: the breakdown for an unanchored 4-star listed after a
    // weapon-banner detour used to read as if it required "Odette AND Weapon done"
    // as a hidden prerequisite (using only the last phase's own local math, which
    // starts counting from zero at the moment that phase is entered). At an early
    // pull count, most of the "at least 1 Alyosha copy" probability mass is still
    // mid-Odette or mid-Weapon — it must show up in the marginal regardless.
    const weaponGoal: Goal = { id: 'w', name: 'Weapon', kind: '5star_weapon', banner: 'weapon', targetId: 'chosen' };
    const alyoshaUnanchored: Goal = { id: 'a', name: 'Alyosha', kind: '4star_character', banner: 'character', targetId: 'c4a' };
    const input = baseInput({ goals: [odette, weaponGoal, alyoshaUnanchored], pullBudget: 200, seed: 12 });
    const result = runExactSimulation(input);
    const breakdown = result.breakdowns.find((b) => b.goalId === 'a')!;

    for (const p of [50, 90, 150]) {
      // The marginal must be well above the joint "all three done" requirement —
      // getting >=1 Alyosha copy doesn't require Odette AND Weapon to be finished.
      expect(breakdown.levelProbabilities[0][p]).toBeGreaterThan(result.series[2].probabilities[p] + 0.1);
    }
    // At pull 50 in particular, Odette (hard pity 90) and Weapon (5-star certain at 77)
    // are both still very unlikely to be fully done, yet Alyosha's marginal is
    // already substantial — proof it isn't gated on them.
    expect(breakdown.levelProbabilities[0][50]).toBeGreaterThan(0.5);
    expect(result.series[2].probabilities[50]).toBeLessThan(0.02);
  }, 20_000);

  it("a 4-star goal's breakdown is monotonically non-decreasing across a realistic pull range, even across a different-banner detour", () => {
    // Fifth reported bug (a follow-up to the fourth): once mass GRADUATES from
    // Odette's phase (gets Odette) but hasn't yet finished the weapon-banner
    // detour, it fell into a genuine blind spot — neither Odette's own phase (no
    // longer "active" there) nor Alyosha's own later phase (hasn't arrived yet)
    // credited it, even though it may already hold an Alyosha copy from before
    // Odette dropped. This showed up as a real, visible cliff: the breakdown would
    // rise, then crash toward zero right as Odette's completion rate spiked, then
    // slowly recover as mass finished the weapon detour and finally reached
    // Alyosha's own phase. A cumulative "P(reached level X by pull N)" curve must
    // never decrease in N — a copy once obtained is never lost. Fixed by crediting
    // in-transit mass (graduated an earlier phase of this banner, not yet arrived
    // at the next) via a survival-function convolution, plus correctly graduating
    // any state that's ALREADY done the instant a new phase is entered (it used to
    // wrongly get one extra, un-graduated pull first).
    //
    // NOTE: a much smaller, deeper residual remains at LARGE pull budgets (~200+):
    // unlike pity/CR (which reset near a win, so a time-marginalized handoff stays
    // exact), a 4-star's copy count never resets — it keeps growing, so it's
    // genuinely correlated with how long the preceding phase took. The
    // convolution-based phase handoff doesn't fully preserve that correlation,
    // which can show up as a tiny (well under 0.1 percentage point at this app's
    // realistic pull-budget range) non-monotonic wobble at large budgets. A fully
    // exact fix would need to re-run the downstream phase separately per starting
    // copy count instead of from one merged distribution — a real architectural
    // change, not attempted here since the residual is far below what's visible
    // in a UI that rounds to one decimal place. This test uses a pull budget
    // within the range where that residual doesn't appear at all.
    const weaponGoal: Goal = { id: 'w', name: 'Weapon', kind: '5star_weapon', banner: 'weapon', targetId: 'chosen' };
    const alyoshaUnanchored: Goal = { id: 'a', name: 'Alyosha', kind: '4star_character', banner: 'character', targetId: 'c4a' };
    const input = baseInput({ goals: [odette, weaponGoal, alyoshaUnanchored], pullBudget: 150 });
    const result = runExactSimulation(input);
    const breakdown = result.breakdowns.find((b) => b.goalId === 'a')!;

    for (const levelProbs of breakdown.levelProbabilities) {
      let prev = -1;
      for (let p = 0; p <= 150; p++) {
        // Small epsilon for floating-point accumulation noise across many summed
        // convolution terms — not a tolerance for genuine non-monotonicity.
        expect(levelProbs[p]).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = levelProbs[p];
      }
    }
    // And specifically: it keeps climbing well past where Odette's own completion
    // rate spikes (~pull 74-90, soft/hard pity), not crashing back down there.
    expect(breakdown.levelProbabilities[0][90]).toBeGreaterThan(breakdown.levelProbabilities[0][40]);
    expect(breakdown.levelProbabilities[0][150]).toBeGreaterThan(breakdown.levelProbabilities[0][90]);
  }, 20_000);

  it('case A (anchored to both Odette and Miko, both sharing its phase): also unrestricted, matches Monte Carlo', () => {
    const alyoshaCaseA: Goal = {
      id: 'a',
      name: 'Alyosha',
      kind: '4star_character',
      banner: 'character',
      targetId: 'c4a',
      anchoredFiveStarGoalIds: ['o', 'm'],
    };
    const input = baseInput({ pullBudget: 150, goals: [odette, alyoshaCaseA, miko], trialCount: 300_000, seed: 6 });
    const exact = runExactSimulation(input);
    const mc = runSimulation(input);
    for (const p of [50, 100, 150]) {
      expect(Math.abs(exact.series[1].probabilities[p] - mc.series[1].probabilities[p])).toBeLessThan(0.03);
    }
  }, 30_000);

  it("a 4-star anchored to a LATER same-phase 5-star doesn't accrue until focus reaches that patch — sixth reported bug", () => {
    // Priority: Odette, "41" (anchored to Odette only), Miko, "42" (anchored to
    // Miko only) — all one phase (all character banner, consecutive). Before this
    // fix, 42 accrued copies unrestricted from pull 1, identically to 41, even
    // though reaching Miko's patch requires Odette AND 41 to finish first —
    // anchoring only ever "closed" a window, never gated when it "opened."
    const fortyOne: Goal = { id: '41', name: '41', kind: '4star_character', banner: 'character', targetId: 'c4a', anchoredFiveStarGoalIds: ['o'] };
    const fortyTwo: Goal = { id: '42', name: '42', kind: '4star_character', banner: 'character', targetId: 'c4b', anchoredFiveStarGoalIds: ['m'] };
    const input = baseInput({ pullBudget: 90, goals: [odette, fortyOne, miko, fortyTwo], trialCount: 300_000, seed: 13 });
    const exact = runExactSimulation(input);
    const mc = runSimulation(input);

    const breakdown41 = exact.breakdowns.find((b) => b.goalId === '41')!;
    const breakdown42 = exact.breakdowns.find((b) => b.goalId === '42')!;
    // At a pull count well within Odette's own pity range, 41 (anchored to the
    // FIRST 5-star) should already show meaningful C0 odds, while 42 (anchored to
    // the SECOND, not-yet-reached 5-star) must still read as near-impossible — only
    // reachable via the rare case where BOTH Odette drops very early AND 41 gets
    // its copy immediately, opening Miko's patch well ahead of schedule.
    expect(breakdown41.levelProbabilities[0][22]).toBeGreaterThan(0.3);
    expect(breakdown42.levelProbabilities[0][22]).toBeLessThan(0.02);
    expect(breakdown42.levelProbabilities[0][22]).toBeLessThan(breakdown41.levelProbabilities[0][22] / 10);

    // series[3] = "Odette + 41 + Miko + 42" all done — cross-check the full chain
    // against Monte Carlo, which independently mirrors the same focus-based gating.
    for (const p of [50, 70, 90]) {
      expect(Math.abs(exact.series[3].probabilities[p] - mc.series[3].probabilities[p])).toBeLessThan(0.03);
    }
  }, 60_000);

  it("a 4-star anchored ONLY to a strictly LATER, non-adjacent phase doesn't accrue until that phase is reached — seventh reported bug", () => {
    // Priority: Odette (phase 0), B (4-star, anchored to Miko only, but sitting in
    // Odette's phase since it's adjacent to her), a weapon detour (phase 1), Miko
    // (phase 2). B's own phase never contains any of its anchors at all — before
    // this fix, closedGoalIds only ever looked at whether every anchor was in a
    // STRICTLY EARLIER phase, so an anchor entirely in a LATER phase left the
    // window open by default, and B accrued copies from pull 1 of Odette's phase,
    // long before Miko's patch could possibly start.
    const weaponGoal: Goal = { id: 'w', name: 'Weapon', kind: '5star_weapon', banner: 'weapon', targetId: 'chosen' };
    const b: Goal = { id: 'b', name: 'B', kind: '4star_character', banner: 'character', targetId: 'c4b', anchoredFiveStarGoalIds: ['m'] };
    const input = baseInput({ pullBudget: 90, goals: [odette, b, weaponGoal, miko], trialCount: 300_000, seed: 21 });
    const exact = runExactSimulation(input);
    const mc = runSimulation(input);

    const breakdownB = exact.breakdowns.find((x) => x.goalId === 'b')!;
    // Well within Odette's own pity range, B must read as essentially impossible —
    // Miko's phase can't have started yet.
    expect(breakdownB.levelProbabilities[0][15]).toBeLessThan(0.001);

    // series[3] = "Odette + B + Weapon + Miko" all done — cross-check against
    // Monte Carlo, which independently mirrors the same cross-phase gating.
    for (const p of [40, 65, 90]) {
      expect(Math.abs(exact.series[3].probabilities[p] - mc.series[3].probabilities[p])).toBeLessThan(0.03);
    }
  }, 60_000);
});

describe('5-star weapon identity is scoped to its own phase — eighth reported bug', () => {
  it("a later, unrelated weapon-banner phase's featured weapon can't be won during an earlier weapon phase", () => {
    // Priority: WeaponA (chosen, phase 0), a character detour (phase 1), WeaponB
    // (the "other featured" slot, phase 2) -- two genuinely separate weapon-banner
    // runs, not one banner with two co-featured weapons. Before this fix,
    // WeaponBannerConfig was one static (chosenWeaponId, otherFeaturedWeaponId)
    // pair reused across every weapon-banner phase, and 5-star-weapon identity
    // tracking had no phase gating at all, so WeaponB was winnable as a
    // "featured_other" outcome during phase 0's own pulls, alongside WeaponA.
    //
    // This fix made TRACKING phase-scoped only — it did NOT touch the underlying
    // WeaponBannerConfig itself (chosenWeaponId/otherFeaturedWeaponId stayed one
    // static, globally-assigned pair), so WeaponB (2nd in the whole list) could
    // still never benefit from a Fate Point guarantee, even once tracking
    // correctly recognized it as "in play" during its own phase. See the "tenth
    // reported bug" block below for that deeper, later fix.
    const weaponA: Goal = { id: 'wa', name: 'WeaponA', kind: '5star_weapon', banner: 'weapon', targetId: 'chosen' };
    const charGoal: Goal = { id: 'c', name: 'SomeChar', kind: '5star_character', banner: 'character', targetId: 'char5' };
    const weaponB: Goal = { id: 'wb', name: 'WeaponB', kind: '5star_weapon', banner: 'weapon', targetId: 'other' };
    const input = baseInput({ pullBudget: 150, goals: [weaponA, charGoal, weaponB], trialCount: 300_000, seed: 22 });
    const exact = runExactSimulation(input);
    const mc = runSimulation(input);

    // Pre-fix, P(all 3 done) by pull 10 was ~0.000136 (WeaponB piggybacking on
    // WeaponA's own phase-0 pulls). Post-fix it requires genuinely completing 3
    // sequential phases, so it should be roughly two orders of magnitude smaller.
    expect(exact.series[2].probabilities[10]).toBeLessThan(0.00001);

    for (const p of [60, 100, 150]) {
      expect(Math.abs(exact.series[2].probabilities[p] - mc.series[2].probabilities[p])).toBeLessThan(0.03);
    }
  }, 30_000);

  it('two 5-star weapon goals sharing ONE phase (chosen + other-featured on the same run) are unaffected', () => {
    const weaponA: Goal = { id: 'wa', name: 'WeaponA', kind: '5star_weapon', banner: 'weapon', targetId: 'chosen' };
    const weaponB: Goal = { id: 'wb', name: 'WeaponB', kind: '5star_weapon', banner: 'weapon', targetId: 'other' };
    const input = baseInput({ pullBudget: 90, goals: [weaponA, weaponB], trialCount: 300_000, seed: 23 });
    const exact = runExactSimulation(input);
    const expectedChosen = exactWeaponBannerCdf(zeroWeaponState, weaponConfig, (o) => o.rarity === 5 && o.kind === 'featured' && o.itemId === 'chosen', 90);
    for (const p of [30, 60, 90]) {
      expect(exact.series[0].probabilities[p]).toBeCloseTo(expectedChosen[p], 6);
    }
  });
});

describe("a 4-star's own phase must never be closed by its anchor range, even past every anchor — ninth reported bug", () => {
  it("Odette + Homa(weapon detour) + Alyosha(anchored to Odette only, C1): the chain keeps climbing after Homa finishes instead of hard-ceiling", () => {
    // User-reported regression from the seventh-bug fix (computeClosedFourStarGoalIdsForPhase's
    // [minAnchorPhase, maxAnchorPhase] range check): Alyosha's own phase is the LAST
    // one, strictly AFTER her only anchor (Odette's, the first phase) -- the range
    // check closed her window there too, but that phase contains ONLY her, so it
    // could never graduate past whatever she'd accrued opportunistically during
    // Odette's own earlier phase. The whole "Odette + Homa + Alyosha" chain (and
    // her own breakdown) hard-ceilinged the instant Homa finished, even though
    // that last phase's entire reason to exist is pulling toward her.
    const odette: Goal = { id: 'o', name: 'Odette', kind: '5star_character', banner: 'character', targetId: 'char5' };
    const homa: Goal = { id: 'h', name: 'Homa', kind: '5star_weapon', banner: 'weapon', targetId: 'chosen' };
    const alyosha: Goal = {
      id: 'a',
      name: 'Alyosha',
      kind: '4star_character',
      banner: 'character',
      targetId: 'c4a',
      targetLevel: 1, // C1 = 2 copies
      anchoredFiveStarGoalIds: ['o'],
    };
    const input = baseInput({ goals: [odette, homa, alyosha], pullBudget: 150, trialCount: 300_000, seed: 24 });
    const exact = runExactSimulation(input);
    const mc = runSimulation(input);

    const chain = exact.series[2].probabilities; // Odette + Homa + Alyosha
    // Homa (weapon, no other goals to wait on) typically finishes well before
    // pull 70; the chain must keep climbing well past that point, not flatten.
    expect(chain[150]).toBeGreaterThan(chain[70] + 0.05);

    const breakdown = exact.breakdowns.find((b) => b.goalId === 'a')!;
    expect(breakdown.levelProbabilities[1][150]).toBeGreaterThan(breakdown.levelProbabilities[1][70] + 0.05);

    for (const p of [70, 110, 150]) {
      expect(Math.abs(exact.series[2].probabilities[p] - mc.series[2].probabilities[p])).toBeLessThan(0.03);
    }
  }, 30_000);
});

describe('weapon Epitomized Path identity is computed per phase, not once globally — tenth reported bug', () => {
  it("a later-phase weapon's own Fate Point guarantee works, even though it's second in the whole priority list", () => {
    // Priority: WeaponA (phase 0), a character detour (phase 1), WeaponB (phase 2).
    // Before this fix, chosenWeaponId/otherFeaturedWeaponId were weapon5Goals[0]/[1]
    // by GLOBAL priority position -- WeaponB (position 1) was permanently
    // "otherFeaturedWeaponId", so transitionWeaponBanner's Fate Point guarantee
    // (`if (state.fatePoints === 1)` -> always resolves to config.chosenWeaponId)
    // could NEVER benefit WeaponB, in ANY phase, including its own. Without a
    // deterministic guarantee, WeaponB's odds only grow via the organic 37.5%
    // per-5-star-pull chance, forever -- P(done) approaches 1 as pulls -> infinity
    // but never actually REACHES 1 at any finite pull count. With the fix, WeaponB
    // is correctly "chosen" in its OWN phase (the only 5star_weapon goal there),
    // so it inherits the same 154-pull deterministic worst-case guarantee any
    // fresh weapon banner has (see simulate.test.ts's "P(chosen path weapon within
    // 154 pulls...) = 1" closed-form check) -- this test is that same guarantee,
    // reached through TWO earlier phases instead of from a cold start.
    //
    // Both earlier phases are seeded so their OWN deterministic worst-case bound
    // is known exactly -- each banner's "guarantee" mechanic only guarantees WHICH
    // identity your next featured win resolves to, not that the very next pull
    // itself produces one, so each is a "2 hard-pity cycles" bound (matching
    // simulate.test.ts's own "P(chosen path weapon within 154 pulls, fatePoints=0,
    // from pity 0) = 1" check), just starting partway through the first cycle:
    // - WeaponA: weapon state seeded at pity5=76 -- the VERY NEXT pull is a
    //   guaranteed 5-star (hard pity), but only 37.5% chance it's "chosen"
    //   directly; a miss sets fatePoints=1 with pity5 reset to 0, needing up to
    //   ANOTHER 77 pulls (a full hard-pity cycle, weapon 5-star certain at 77) to
    //   force the next 5-star, which IS then guaranteed chosen. Worst case:
    //   1 + 77 = 78 pulls, P=1.
    // - The character detour: a single 5star_character goal seeded at pity5=89 --
    //   the VERY NEXT pull is a guaranteed 5-star (character hard pity = 90), but
    //   still has to WIN its 50/50 to count as "featured" (5star_character
    //   matching requires outcome.kind === 'featured', not just any 5-star); a
    //   loss sets guaranteed5=true with pity5 reset to 0, needing up to ANOTHER 90
    //   pulls to force the next 5-star, which IS then guaranteed featured (bypasses
    //   the 50/50 entirely). Worst case: 1 + 90 = 91 pulls, P=1 (confirmed
    //   directly via exactCharacterBannerCdf: cdf[91] ≈ 1).
    // So by global pull 169 (78 + 91), phase 0 + phase 1 are done with certainty,
    // and WeaponB's own phase has started with certainty. Critically, every path
    // that satisfies WeaponA ends via the "chosen" outcome (the ONLY outcome that
    // completes WeaponA's goal), which ALWAYS resets pity5=0 AND fatePoints=0
    // (both the guaranteed and non-guaranteed win branches in weaponBanner.ts do
    // this) -- so WeaponB's own phase deterministically starts completely fresh on
    // the 5-star axis, regardless of which sub-path occurred, inheriting the same
    // 154-pull worst-case guarantee a cold start has. Total worst case: 169 + 154 = 323.
    const weaponA: Goal = { id: 'wa', name: 'WeaponA', kind: '5star_weapon', banner: 'weapon', targetId: 'chosen' };
    const charDetour: Goal = { id: 'c', name: 'CharDetour', kind: '5star_character', banner: 'character', targetId: 'char5' };
    const weaponB: Goal = { id: 'wb', name: 'WeaponB', kind: '5star_weapon', banner: 'weapon', targetId: 'other' };
    const input = baseInput({
      goals: [weaponA, charDetour, weaponB],
      pullBudget: 323, // 169 (deterministic setup, phases 0-1) + 154 (WeaponB's own deterministic Fate Point worst case)
      trialCount: 300_000,
      seed: 25,
      weaponBanner: { state: { pity5: 76, guaranteed5: false, fatePoints: 0, pity4: 0, guaranteed4: false } },
      characterBanner: { state: { pity5: 89, guaranteed5: false, crCounter: 0, pity4: 0, guaranteed4: false }, featured5StarId: charConfig.featured5StarId },
    });
    const exact = runExactSimulation(input);
    const mc = runSimulation(input);

    // All 3 goals done: guaranteed by construction (phases 0-1 deterministic by
    // pull 169; WeaponB's own 154-pull deterministic guarantee covers the rest).
    // This specific near-certainty is only reachable with the fix -- under the old
    // bug, WeaponB has no deterministic bound at all, so this would NOT approach 1
    // this tightly by pull 323.
    expect(exact.series[2].probabilities[323]).toBeGreaterThan(0.999);

    for (const p of [100, 200, 300, 323]) {
      expect(Math.abs(exact.series[2].probabilities[p] - mc.series[2].probabilities[p])).toBeLessThan(0.03);
    }
  }, 30_000);
});

describe('4-star pool is computed per phase, not once globally — eleventh reported bug (dilution)', () => {
  it("a phase-0 4-star's odds are unaffected by how many OTHER 4-stars are named in a later, unrelated phase", () => {
    // Odette(phase0) + 2 named char 4-stars anchored to Odette (a1,a2, phase0) +
    // a weapon detour(phase1) + Miko(phase2) + 2 MORE named char 4-stars anchored
    // to Miko (b1,b2, phase2) -- 4 total named character 4-stars, split 2+2 across
    // two DIFFERENT phases.
    //
    // NOTE: 4 total exceeds MAX_TOTAL_FOUR_STAR_GOALS_PER_BANNER.character (3) --
    // goalValidation.ts's total cap (a SEPARATE, purely performance-motivated
    // constraint discovered while profiling THIS fix -- see its own doc comment)
    // means a real user could never actually reach this exact configuration
    // through the app's UI. It's used here anyway, deliberately bypassing
    // validateGoals (which this test, like the rest of this file, never calls),
    // because demonstrating the DILUTION bug specifically requires MORE than 3
    // total real names: at N<=3, buildSimulationInput.ts's OLD padIds always
    // padded up to exactly 3 slots regardless of composition, so the split
    // fraction was ALREADY correct by coincidence -- only past 3 does padIds stop
    // padding and the pool silently grow past the real per-phase roster size. This
    // engine-level test exists to confirm the underlying computation is correct in
    // principle, independent of where the (separately-justified) cap happens to
    // sit today.
    //
    // Before this fix, buildSimulationInput.ts's padIds built ONE static pool
    // from ALL 4 real ids -- so phase0's own pulls would have split the 5.1%
    // featured-4-star rate FOUR ways (1/4 each) instead of the correct THREE ways
    // (1/3 each, since only a1/a2 are actually on phase0's real-world 3-slot
    // roster -- the third slot is a genuine anonymous placeholder; b1/b2 aren't
    // reachable there at all). That's a silent understatement of a1's true odds,
    // entirely from the PRESENCE of b1/b2 elsewhere in the list, despite b1/b2
    // never once being pullable during phase0 (closedGoalIds already correctly
    // no-ops any accidental hit -- it's the SPLIT FRACTION that was wrong, not the
    // crediting).
    //
    // The fix (computeCharacterBannerConfigForPhase, phases.ts) builds phase0's
    // pool from the COMPLEMENT of computeClosedFourStarGoalIdsForPhase -- which
    // already excludes b1/b2 from phase0 (their anchor 'm' hasn't happened yet) --
    // so phase0's pool is exactly {a1,a2,placeholder} regardless of what's named
    // elsewhere. Proven here by comparing against an EQUIVALENT single-phase-only
    // simulation containing ONLY phase0's own goals: since phase0's own DP is
    // entirely self-contained (doesn't know or care what phases follow it, and
    // a1/a2's window closes once focus leaves phase0 anyway), a1's breakdown
    // should come out very close between the two -- not exactly byte-identical,
    // because a1's FROZEN phase0-exit value still rides along as a live dimension
    // during phase2's own DP (phase2 unconditionally recomputes activeLevelCounts/
    // graduatedLevelCounts for every fourStarGoals index, a1 included, even though
    // a1's own value never changes there), which is exactly CHANGELOG.md's already-
    // documented "known remaining limitation" (a 4-star's frozen copy count is
    // correlated with how long the preceding phase took, which the time-
    // marginalized phase handoff doesn't fully preserve) -- confirmed there as "well
    // under 0.1 percentage point" at this app's realistic pull-budget range, not a
    // bug to fix here. A small pull budget is enough (and keeps this test fast --
    // profiling found a 2+2 cross-phase split gets expensive quickly at larger
    // budgets, see MAX_TOTAL_FOUR_STAR_GOALS_PER_BANNER's doc comment); the
    // dilution effect this proves is about pool COMPOSITION, not a long-run
    // asymptotic property.
    const odette: Goal = { id: 'o', name: 'Odette', kind: '5star_character', banner: 'character', targetId: 'char5' };
    const a1: Goal = { id: 'a1', name: 'A1', kind: '4star_character', banner: 'character', targetId: 'a1', anchoredFiveStarGoalIds: ['o'] };
    const a2: Goal = { id: 'a2', name: 'A2', kind: '4star_character', banner: 'character', targetId: 'a2', anchoredFiveStarGoalIds: ['o'] };
    const weaponDetour: Goal = { id: 'wd', name: 'WeaponDetour', kind: '5star_weapon', banner: 'weapon', targetId: 'chosen' };
    const miko: Goal = { id: 'm', name: 'Miko', kind: '5star_character', banner: 'character', targetId: 'char5' };
    const b1: Goal = { id: 'b1', name: 'B1', kind: '4star_character', banner: 'character', targetId: 'b1', anchoredFiveStarGoalIds: ['m'] };
    const b2: Goal = { id: 'b2', name: 'B2', kind: '4star_character', banner: 'character', targetId: 'b2', anchoredFiveStarGoalIds: ['m'] };

    const fullInput = baseInput({ goals: [odette, a1, a2, weaponDetour, miko, b1, b2], pullBudget: 20, seed: 26 });
    const isolatedInput = baseInput({ goals: [odette, a1, a2], pullBudget: 20, seed: 26 });

    const fullResult = runExactSimulation(fullInput);
    const isolatedResult = runExactSimulation(isolatedInput);

    const fullA1 = fullResult.breakdowns.find((b) => b.goalId === 'a1')!;
    const isolatedA1 = isolatedResult.breakdowns.find((b) => b.goalId === 'a1')!;
    for (const p of [5, 10, 15, 20]) {
      for (let level = 0; level < fullA1.levelProbabilities.length; level++) {
        expect(Math.abs(fullA1.levelProbabilities[level][p] - isolatedA1.levelProbabilities[level][p])).toBeLessThan(0.001);
      }
    }
  }, 60_000);
});

describe('weapon banner: the standalone 75/25 guarantee was missing, and Fate Points must reset per phase — thirteenth reported bug', () => {
  // Found 2026-08-19 by the user diagnosing E2 in the trace survey: getting a
  // standard 5-star weapon SHOULD accrue a Fate Point AND guarantee the next
  // 5-star weapon is one of the 2 event weapons (the banner's own 75/25 pity,
  // structurally parallel to the character banner's 50/50 guaranteed5) --
  // confirmed against real Genshin mechanics (both a web search and, on the
  // one specific point search results disagreed with, the user's own detailed
  // correction). Two genuinely independent bugs, both fixed together since
  // they share the same root cause (WeaponBannerState never modeled the 75/25
  // guarantee as its own flag):
  // 1. transitionWeaponBanner's OLD fatePoints=1 branch was correct in
  //    isolation, but fatePoints was the ONLY state tracking "should the next
  //    5-star avoid being standard" -- there was no way to represent "next
  //    5-star guaranteed featured, but NOT a specific one" at all.
  // 2. Even after adding `guaranteed5`, Epitomized Path is a PER-PHASE
  //    selection -- `fatePoints` must reset to 0 at the start of a NEW
  //    weapon-banner phase (exactEngine.ts's resetWeaponFatePoints,
  //    simulate.ts's resetFatePointsOnEntry), while `guaranteed5` carries
  //    over unchanged, same as pity5/guaranteed4 always have.
  it("a later weapon phase's own Fate Point starts fresh (0) even when the earlier phase exited with fatePoints=1 — exact vs Monte Carlo must agree", () => {
    // Phase 0 has TWO weapon goals (WeaponA=chosen, WeaponB=other) so it can
    // plausibly exit with fatePoints=1 still set (whichever of the two is
    // claimed LAST via the non-chosen branch leaves fatePoints=1 sitting in
    // the exit state, with nothing left in phase0 to consume it). Phase 2's
    // own WeaponC must NOT inherit that stale Fate Point.
    const weaponA: Goal = { id: 'wa', name: 'WeaponA', kind: '5star_weapon', banner: 'weapon', targetId: 'chosen' };
    const weaponB: Goal = { id: 'wb', name: 'WeaponB', kind: '5star_weapon', banner: 'weapon', targetId: 'other' };
    const charDetour: Goal = { id: 'c', name: 'CharDetour', kind: '5star_character', banner: 'character', targetId: 'char5' };
    const weaponC: Goal = { id: 'wc', name: 'WeaponC', kind: '5star_weapon', banner: 'weapon', targetId: 'chosen' };
    const input = baseInput({ goals: [weaponA, weaponB, charDetour, weaponC], pullBudget: 350, trialCount: 400_000, seed: 27 });

    const exact = runExactSimulation(input);
    const mc = runSimulation(input);

    for (const p of [150, 250, 350]) {
      expect(Math.abs(exact.series[3].probabilities[p] - mc.series[3].probabilities[p])).toBeLessThan(0.02);
    }
  }, 60_000);

  it('guaranteed5 (the standalone 75/25 guarantee) DOES carry across a weapon-banner phase boundary, unlike fatePoints', () => {
    // Start already guaranteed5=true, fatePoints=0 -- a single fresh weapon
    // phase should show the first 5-star as a 50/50 between chosen/other (no
    // standard possible), matching transitionWeaponBanner's own unit test.
    // This is the OTHER half of the thirteenth-bug fix: confirming the carried
    // state actually reaches runPhaseDp's starting distribution correctly for
    // a banner's FIRST use (no reset applies there -- only reoccurrences reset
    // fatePoints), by checking the resulting P(done) matches a 50/50 (not
    // 37.5%) bound at low pull counts where at most one 5-star has occurred.
    const weaponA: Goal = { id: 'wa', name: 'WeaponA', kind: '5star_weapon', banner: 'weapon', targetId: 'chosen' };
    const input = baseInput({
      goals: [weaponA],
      pullBudget: 1,
      weaponBanner: { state: { pity5: 0, guaranteed5: true, fatePoints: 0, pity4: 0, guaranteed4: false } },
    });
    // Not hard pity, so P(a 5-star even occurs on pull 1) < 1 -- but IF one
    // occurs, it must be 50/50, not 37.5%.
    const exact = runExactSimulation(input);
    // P(done at pull 1) = P(5-star) * P(chosen | 5-star, guaranteed5) = weapon5Rate(1) * 0.5
    expect(exact.series[0].probabilities[1]).toBeCloseTo(weapon5Rate(1) * 0.5, 9);
  });
});

describe('weapon banner: Epitomized Path must retarget to the second same-phase weapon once the first is claimed — fourteenth reported bug', () => {
  it('WeaponB is guaranteed within exactly 2 five-star pulls once WeaponA is claimed (the precise acceptance criterion from planning)', () => {
    // Seed fatePoints=1 so pull 1 is a deterministic, guaranteed WeaponA claim
    // (the "chosen" weapon) -- isolates WeaponB's OWN worst case starting from
    // pull 2. Before this fix, WeaponB had NO deterministic bound at all (Fate
    // Points always resolved to WeaponA, forever) -- it could only ever be won
    // via the organic 37.5%/50% roll. With the fix: worst case for WeaponB is
    // a full hard-pity cycle (77) landing on the OTHER identity relative to
    // WeaponB -- post-retarget that's WeaponA, which banks a fate point -- then
    // a second full cycle (<=77 more) forces the guaranteed-chosen (WeaponB)
    // win. So: 1 (WeaponA) + 77 + 77 = 155.
    const weaponA: Goal = { id: 'wa', name: 'WeaponA', kind: '5star_weapon', banner: 'weapon', targetId: 'chosen' };
    const weaponB: Goal = { id: 'wb', name: 'WeaponB', kind: '5star_weapon', banner: 'weapon', targetId: 'other' };
    const input = baseInput({
      goals: [weaponA, weaponB],
      pullBudget: 155,
      weaponBanner: { state: { pity5: 76, guaranteed5: false, fatePoints: 1, pity4: 0, guaranteed4: false } },
    });
    const exact = runExactSimulation(input);
    const pBoth = exact.series[1].probabilities; // P(WeaponA AND WeaponB done)
    expect(pBoth[1]).toBe(0); // WeaponA alone is done at pull 1; WeaponB isn't yet.
    expect(pBoth[155]).toBeCloseTo(1, 9);
    // Confirm the distribution isn't trivially saturated long before the real
    // bound -- if the retarget weren't happening, WeaponB would only have the
    // organic 50% roll (guaranteed5 is false here), and P(both) at pull 80
    // would be far below this.
    expect(pBoth[80]).toBeLessThan(0.9);
  });

  it('cross-validates against Monte Carlo for the realistic (fresh-state) E2 shape', () => {
    const weaponA: Goal = { id: 'wa', name: 'WeaponA', kind: '5star_weapon', banner: 'weapon', targetId: 'chosen' };
    const weaponB: Goal = { id: 'wb', name: 'WeaponB', kind: '5star_weapon', banner: 'weapon', targetId: 'other' };
    const input = baseInput({ goals: [weaponA, weaponB], pullBudget: 300, trialCount: 400_000, seed: 28 });
    const exact = runExactSimulation(input);
    const mc = runSimulation(input);
    for (const p of [80, 150, 220, 300]) {
      expect(Math.abs(exact.series[1].probabilities[p] - mc.series[1].probabilities[p])).toBeLessThan(0.02);
    }
  }, 30_000);

  it('EP never swaps away from the first-listed weapon before IT is actually obtained — confirms this fix already covers the full "chase both, either order" scenario, not just the sequential one', () => {
    // If WeaponB (2nd-listed, "other") happens to drop first via the organic
    // roll, EP must stay on WeaponA until WeaponA is ALSO obtained -- a
    // rational player wouldn't retarget away from their still-unclaimed
    // higher-priority weapon just because the lower-priority one dropped
    // along the way. `firstWeaponGoalIndex`'s swap check (phaseDp.ts) only
    // ever reads the FIRST-listed goal's own persistent bit, so this should
    // already hold by construction -- verified numerically here rather than
    // just by code inspection: WeaponA's OWN completion (independent of
    // whatever happens to WeaponB) must still reach its full, undiminished
    // 154-pull deterministic bound. If EP had incorrectly swapped away from
    // WeaponA at any point before WeaponA's own claim, this bound would break.
    const weaponA: Goal = { id: 'wa', name: 'WeaponA', kind: '5star_weapon', banner: 'weapon', targetId: 'chosen' };
    const weaponB: Goal = { id: 'wb', name: 'WeaponB', kind: '5star_weapon', banner: 'weapon', targetId: 'other' };
    const input = baseInput({ goals: [weaponA, weaponB], pullBudget: 154 });
    const result = runExactSimulation(input);
    expect(result.series[0].probabilities[154]).toBeCloseTo(1, 9);
  });

  // Regression guard for the guard itself (a phase with only 1 5star_weapon
  // goal must be completely unaffected -- computeWeaponBannerConfigAfterFirstClaimedForPhase
  // returns undefined, so runPhaseDp/stepOnePull take the exact same
  // single-adapter path as before this fix) is already covered by the
  // "weapon Epitomized Path identity is computed per phase" describe block's
  // tenth-bug test above, re-run unchanged after this fix and still passing.
});

describe('5star_weapon window linking is explicit, not inferred from adjacency — fifteenth reported bug', () => {
  // Found 2026-08-19: "same real weapon-banner window" used to be INFERRED
  // purely from priority-list adjacency, wrong in both directions -- see
  // types.ts's Goal.linkedWeaponGoalId doc comment for the full mechanic and
  // the two concrete counterexamples that motivated this. These tests use
  // monotonic COMPARISONS (linked vs. unlinked, same shape) rather than
  // closed-form pull counts, since a real character-banner phase's own
  // randomness makes an exact bound impractical to derive here the way the
  // fourteenth-bug tests could for a pure-weapon scenario.
  const FEATURED_5STAR = 'char5';
  function odette(): Goal {
    return { id: 'o', name: 'Odette', kind: '5star_character', banner: 'character', targetId: FEATURED_5STAR };
  }
  function raiden(): Goal {
    return { id: 'r', name: 'Raiden', kind: '5star_character', banner: 'character', targetId: FEATURED_5STAR };
  }
  function odetteWeapon(linked: boolean): Goal {
    return { id: 'ow', name: 'OdetteWeapon', kind: '5star_weapon', banner: 'weapon', targetId: 'odette-weapon', linkedWeaponGoalId: linked ? 'rw' : undefined };
  }
  function raidenWeapon(linked: boolean): Goal {
    return { id: 'rw', name: 'RaidenWeapon', kind: '5star_weapon', banner: 'weapon', targetId: 'raiden-weapon', linkedWeaponGoalId: linked ? 'ow' : undefined };
  }

  it('LINKED: [Odette, OdetteWeapon, Raiden, RaidenWeapon] lets RaidenWeapon benefit from OdetteWeapon\'s own phase, strictly improving its odds over the unlinked equivalent — and cross-validates against Monte Carlo', () => {
    const goals = (linked: boolean) => [odette(), odetteWeapon(linked), raiden(), raidenWeapon(linked)];
    const linkedInput = baseInput({ goals: goals(true), pullBudget: 260, seed: 40 });
    const unlinkedInput = baseInput({ goals: goals(false), pullBudget: 260, seed: 40 });

    const linked = runExactSimulation(linkedInput);
    const unlinked = runExactSimulation(unlinkedInput);
    for (const p of [120, 180, 240]) {
      expect(linked.series[3].probabilities[p]).toBeGreaterThan(unlinked.series[3].probabilities[p]);
    }

    const mc = runSimulation({ ...linkedInput, trialCount: 300_000 });
    for (const p of [120, 200, 260]) {
      expect(Math.abs(linked.series[3].probabilities[p] - mc.series[3].probabilities[p])).toBeLessThan(0.03);
    }
  }, 30_000);

  it("LINKED: Fate Points earned AFTER OdetteWeapon is claimed, while still chasing an extra goal sharing its own phase, survive into RaidenWeapon's phase (not just the trivial single-goal case) — and cross-validates against Monte Carlo", () => {
    // An anchored 4-star weapon goal sharing OdetteWeapon's own phase keeps
    // pulling going PAST the moment OdetteWeapon is claimed -- exactly the
    // "harder case" found during design review: the existing retarget
    // machinery (fourteenth reported bug) already points "chosen" at
    // RaidenWeapon for the rest of this stretch, so any Fate Point earned
    // here is genuine, earned progress toward RaidenWeapon specifically, and
    // must not be wiped by exactEngine.ts's resetWeaponFatePoints /
    // simulate.ts's resetFatePointsOnEntry at the phase boundary.
    const extra = (linked: boolean): Goal => ({
      id: 'x',
      name: 'X',
      kind: '4star_weapon',
      banner: 'weapon',
      targetId: 'x',
      targetLevel: 3,
      anchoredFiveStarGoalIds: linked ? ['ow', 'rw'] : ['ow'],
    });
    const goals = (linked: boolean) => [odette(), odetteWeapon(linked), extra(linked), raiden(), raidenWeapon(linked)];
    const linkedInput = baseInput({ goals: goals(true), pullBudget: 300, seed: 41 });
    const unlinkedInput = baseInput({ goals: goals(false), pullBudget: 300, seed: 41 });

    const linked = runExactSimulation(linkedInput);
    const unlinked = runExactSimulation(unlinkedInput);
    // series[4] = P(all 5 goals, including RaidenWeapon, done).
    for (const p of [150, 220, 290]) {
      expect(linked.series[4].probabilities[p]).toBeGreaterThan(unlinked.series[4].probabilities[p]);
    }

    const mc = runSimulation({ ...linkedInput, trialCount: 300_000 });
    for (const p of [150, 220, 300]) {
      expect(Math.abs(linked.series[4].probabilities[p] - mc.series[4].probabilities[p])).toBeLessThan(0.03);
    }
  }, 30_000);

  it('UNLINKED (adjacent): [WeaponA, WeaponB] no longer automatically shares a window — behaves strictly worse than the same list explicitly linked', () => {
    const weaponA = (linked: boolean): Goal => ({ id: 'wa', name: 'WeaponA', kind: '5star_weapon', banner: 'weapon', targetId: 'wa-id', linkedWeaponGoalId: linked ? 'wb' : undefined });
    const weaponB = (linked: boolean): Goal => ({ id: 'wb', name: 'WeaponB', kind: '5star_weapon', banner: 'weapon', targetId: 'wb-id', linkedWeaponGoalId: linked ? 'wa' : undefined });
    const linkedInput = baseInput({ goals: [weaponA(true), weaponB(true)], pullBudget: 200 });
    const unlinkedInput = baseInput({ goals: [weaponA(false), weaponB(false)], pullBudget: 200 });

    const linked = runExactSimulation(linkedInput);
    const unlinked = runExactSimulation(unlinkedInput);
    for (const p of [80, 130, 180]) {
      expect(unlinked.series[1].probabilities[p]).toBeLessThan(linked.series[1].probabilities[p]);
    }
  });

  it("pendingInTransit's same-banner-skip doesn't double-count a 4-star weapon goal's breakdown across a forced (unlinked) split — a goal's breakdown at its own targetLevel must exactly match its own completion series, the same invariant already asserted for ordinary cross-banner phases", () => {
    // X listed FIRST so series[0] is its own true marginal (P(X done) alone,
    // uncorrelated with any later goal) rather than a joint prefix probability
    // — matches the existing single-goal pattern this invariant is modeled on
    // ("weapon 4-star breakdown uses R1-R5 labels and matches the goal's own
    // completion series at its targetLevel", above). X still shares WeaponA's
    // own phase (adjacent, same banner, anchored to it) and WeaponB forces a
    // NEW, separate phase (case 2's shape) with NO intervening different-banner
    // phase at all -- exactly the scenario the same-banner pendingInTransit skip targets.
    const x: Goal = { id: 'x', name: 'X', kind: '4star_weapon', banner: 'weapon', targetId: 'x', targetLevel: 2, anchoredFiveStarGoalIds: ['wa'] };
    const weaponA: Goal = { id: 'wa', name: 'WeaponA', kind: '5star_weapon', banner: 'weapon', targetId: 'wa-id' };
    const weaponB: Goal = { id: 'wb', name: 'WeaponB', kind: '5star_weapon', banner: 'weapon', targetId: 'wb-id' };
    const input = baseInput({ goals: [x, weaponA, weaponB], pullBudget: 200 });
    const result = runExactSimulation(input);

    const xBreakdown = result.breakdowns.find((b) => b.goalId === 'x')!;
    const xOwnSeries = result.series[0]; // prefixLength 1 = just X
    expect(xOwnSeries.goalIds).toEqual(['x']);
    // The decisive check: at X's OWN targetLevel, its breakdown must exactly
    // match its own completion series (both derived independently -- series
    // via globalPrefixDone, breakdown via accumulatedLevelCounts). A REAL
    // double-count from adding BOTH the (incorrectly-deferred) pendingInTransit
    // AND phase1's own active reporting produced errors of 0.03-0.19 here when
    // this test was first written against the unfixed code -- confirmed
    // directly, vastly larger than the 1e-9 tolerance below.
    for (let p = 0; p <= 200; p += 20) {
      expect(xBreakdown.levelProbabilities[1][p]).toBeCloseTo(xOwnSeries.probabilities[p], 9); // level index 1 = R2, x's targetLevel
    }
    // NOT asserted here: strict monotonicity across ALL levels. Investigated
    // directly (throwaway script, plus a direct A/B against the OLD deferred/
    // bridged code by temporarily disabling this fix's same-banner-skip
    // branch) and found: the OLD code produced breakdown values EXCEEDING 1.0
    // (up to 1.43 at pull 160) here -- a real, severe double-count (up to 0.61
    // off at the exact-match check above, which this fix reduces to an exact
    // match) -- while ALSO showing its own dip of similar magnitude (~0.008) at
    // higher levels, meaning the small residual dip that remains under THIS
    // fix (up to ~0.7 percentage points around pull 128-142, levels ABOVE the
    // target R3-R5) isn't something this fix introduces -- it's CHANGELOG.md's
    // already-documented "Known remaining limitation" (a 4-star's copy count is
    // genuinely correlated with how long the preceding phase took, which the
    // convolution-based phase handoff doesn't fully preserve), present under
    // either code path, just larger here than the "well under 0.1pp" figure
    // CHANGELOG.md measured for an unanchored 4-star crossing a DIFFERENT-banner
    // detour. Not this fix's bug to solve (see CHANGELOG.md's own scoping of that
    // limitation); the exact-match check above -- which the OLD code failed by
    // up to 61 percentage points and even briefly exceeded probability 1 -- is
    // the real, decisive regression guard for what this test exists to catch.
    // See CHANGELOG.md for the updated measurement.
  });
});

describe('isNextFiveStarClaimBlocked must ignore a 4-star with ZERO anchors in this phase — eighteenth reported bug', () => {
  // Found via a broad, non-pinned exact-vs-Monte-Carlo audit sweep after the
  // seventeenth-bug ("4-star anchoring is phase-derived") fix. Odette and Miko
  // are UNLINKED (separate, sequential phases); Alyosha (4-star) is textually
  // adjacent to Odette (phase0) but anchored ONLY to Miko (phase1) -- exactly
  // the seventeenth-bug's own headline scenario. goalTracking.ts's
  // isNextFiveStarClaimBlocked (gates a same-phase 5-star FIFO claim on any
  // same-phase 4-star still short of its target) predates that fix and never
  // checked whether a candidate 4-star has ANY anchor actually in the phase
  // being checked -- for Alyosha, none of her anchors ('m') are in phase0's
  // own 5-star roster (['o']), so `allOtherAnchorsAlreadySettled` vacuously
  // returned true (treating "not in this phase" as "resolved earlier", an
  // assumption the seventeenth-bug fix broke by allowing an anchor to be
  // LATER). Result: Odette's own win was PERMANENTLY blocked from ever
  // advancing the phase-local FIFO counter -- series[0] (Odette alone) stayed
  // at EXACTLY 0 for the entire pull budget, not a small residual. Monte Carlo
  // (simulate.ts) was unaffected -- it checks "has the anchor's goal actually
  // been won yet" via the global bitmask, which happens to give the right
  // answer regardless of phase, so this was an exact-engine-only bug, not a
  // conceptual error shared by both engines.
  it("Odette's own completion is NOT blocked by Alyosha's incomplete, later-phase-anchored copy count", () => {
    const odette: Goal = { id: 'o', name: 'Odette', kind: '5star_character', banner: 'character', targetId: 'char5' };
    const alyosha: Goal = { id: 'a', name: 'Alyosha', kind: '4star_character', banner: 'character', targetId: 'a', targetLevel: 4, anchoredFiveStarGoalIds: ['m'] };
    const miko: Goal = { id: 'm', name: 'Miko', kind: '5star_character', banner: 'character', targetId: 'char5' };
    const input = baseInput({ goals: [odette, alyosha, miko], pullBudget: 200, seed: 9 });

    const exact = runExactSimulation(input);
    const mc = runSimulation(input);

    // Pre-fix, exact.series[0] was pinned at exactly 0 for every pull -- this
    // is the decisive regression guard, not a tolerance check.
    expect(exact.series[0].probabilities[200]).toBeGreaterThan(0.99);
    for (const p of [50, 100, 150, 200]) {
      expect(Math.abs(exact.series[0].probabilities[p] - mc.series[0].probabilities[p])).toBeLessThan(0.01);
    }
  }, 30_000);
});

describe('an explicit empty anchoredFiveStarGoalIds always means disconnected FROM EVERY REAL, LISTED PHASE, even with just one candidate — eighteenth reported bug follow-up', () => {
  // Before this fix, `undefined` (never touched) and an explicit `[]` (user
  // actively unchecked the one available box) were indistinguishable at the
  // engine level, since hasFourStarAnchorAmbiguity (now removed) only ever treated 2+
  // candidates as real ambiguity — with exactly one candidate, BOTH fell into
  // the same "nothing to disconnect from, keep counting" fallback. That made
  // it impossible to express "Odette (5★), then this 4★ that's on a
  // DIFFERENT, not-yet-added phase" without adding a phantom placeholder
  // 5★ goal just to create real ambiguity — exactly what the user reported
  // hitting live in the app. Now an explicit `[]` always means disconnected
  // from every REAL, listed phase (unchanged from the original fix — she
  // still never accrues during Odette's own phase, which this test still
  // pins) — but NOT "impossible to ever get." See the nineteenth reported
  // bug (disconnection used to mean "0% forever," too strong) and its
  // twentieth-reported-bug follow-up (2026-08-21): she now gets her own
  // real, isolated phase directly from `buildPhases`, right after Odette's —
  // not a synthesized trailing continuation, just an ordinary phase.
  it('explicit empty anchors -> Alyosha never accrues DURING Odette\'s own phase, but genuinely completes afterward given enough budget', () => {
    const odette: Goal = { id: 'o', name: 'Odette', kind: '5star_character', banner: 'character', targetId: 'char5' };
    const alyosha: Goal = { id: 'a', name: 'Alyosha', kind: '4star_character', banner: 'character', targetId: 'a', targetLevel: 0, anchoredFiveStarGoalIds: [] };
    const exact = runExactSimulation(baseInput({ goals: [odette, alyosha], pullBudget: 400 }));
    const breakdown = exact.breakdowns.find((b) => b.goalId === 'a')!;
    // Essentially still 0 at pull 2 — nowhere near enough budget for Odette's
    // own phase to have realistically graduated yet, so Alyosha's
    // continuation has barely had a chance to start (not exactly 0: Odette
    // has a tiny but real chance of winning within the first couple pulls).
    for (const levelProbs of breakdown.levelProbabilities) expect(levelProbs[2]).toBeLessThan(0.01);
    // But NOT 0% forever anymore — given the full 400-pull budget (Odette's
    // own median resolution is well under 90 pulls, leaving 300+ pulls of
    // continuation budget for a 3-slot padded pool), she reaches near-certain
    // completion, both in her own breakdown and in the overall chain.
    expect(breakdown.levelProbabilities[0][400]).toBeGreaterThan(0.99);
    expect(exact.series[0].probabilities[400]).toBeGreaterThan(0.99); // Odette herself is completely unaffected
    expect(exact.series[1].probabilities[400]).toBeGreaterThan(0.99); // the fix: this used to be pinned at exactly 0
  });

  it('undefined anchors (never touched) still auto-attach as before — the common case stays zero-click', () => {
    const odette: Goal = { id: 'o', name: 'Odette', kind: '5star_character', banner: 'character', targetId: 'char5' };
    const alyosha: Goal = { id: 'a', name: 'Alyosha', kind: '4star_character', banner: 'character', targetId: 'a', targetLevel: 0 };
    const exact = runExactSimulation(baseInput({ goals: [odette, alyosha], pullBudget: 400 }));
    const mc = runSimulation(baseInput({ goals: [odette, alyosha], pullBudget: 400 }));
    expect(exact.series[1].probabilities[400]).toBeGreaterThan(0.9);
    expect(Math.abs(exact.series[1].probabilities[200] - mc.series[1].probabilities[200])).toBeLessThan(0.02);
  }, 30_000);
});

describe('a disconnected 4★ resolves via her own real, isolated phase — twentieth reported bug follow-up (2026-08-21)', () => {
  // Superseded the nineteenth-bug's "Phase R" mechanism (a synthesized phase
  // appended only after the tail banner's last real phase) — a disconnected
  // 4★ now gets her own real phase directly from buildPhases, AT HER OWN
  // PRIORITY POSITION, so she resolves independently of any other banner or
  // any later real goal, not deferred to the very end of the whole list.

  // Two ADJACENT disconnected 4-stars no longer share one merged window
  // (Phase R's old AND-semantics) — each gets her own SEPARATE, SEQUENTIAL
  // phase (the user's explicit choice). Bennett's phase can't even start
  // until Alyosha's own phase graduates, so at a budget generous for ONE of
  // them but not both, only Alyosha should be plausibly done.
  it('two adjacent disconnected goals get separate sequential phases, not a shared window', () => {
    const odette: Goal = { id: 'o', name: 'Odette', kind: '5star_character', banner: 'character', targetId: 'char5' };
    const alyosha: Goal = { id: 'a', name: 'Alyosha', kind: '4star_character', banner: 'character', targetId: 'a', targetLevel: 0, anchoredFiveStarGoalIds: [] };
    const bennett: Goal = { id: 'b', name: 'Bennett', kind: '4star_character', banner: 'character', targetId: 'b', targetLevel: 0, anchoredFiveStarGoalIds: [] };
    const goals = [odette, alyosha, bennett];

    // Odette + Alyosha alone typically resolve within ~90 pulls; Bennett's
    // own phase hasn't even started yet at this budget in the vast majority
    // of trials, so her own chance should still be small.
    const midBudget = runExactSimulation(baseInput({ goals, pullBudget: 90 }));
    const bennettBreakdownMid = midBudget.breakdowns.find((b) => b.goalId === 'b')!;
    expect(bennettBreakdownMid.levelProbabilities[0][90]).toBeLessThan(0.3);
    const alyoshaBreakdownMid = midBudget.breakdowns.find((b) => b.goalId === 'a')!;
    expect(alyoshaBreakdownMid.levelProbabilities[0][90]).toBeGreaterThan(0.25);

    // Given a large budget, BOTH sequential disconnected 4-stars and Odette
    // herself should all eventually resolve.
    const bigBudget = runExactSimulation(baseInput({ goals, pullBudget: 500 }));
    expect(bigBudget.series[2].probabilities[500]).toBeGreaterThan(0.9);
    const alyoshaBreakdown = bigBudget.breakdowns.find((b) => b.goalId === 'a')!;
    const bennettBreakdown = bigBudget.breakdowns.find((b) => b.goalId === 'b')!;
    expect(alyoshaBreakdown.levelProbabilities[0][500]).toBeGreaterThan(0.9);
    expect(bennettBreakdown.levelProbabilities[0][500]).toBeGreaterThan(0.9);
  }, 60_000);

  // Superseded: a disconnected 4★ used to have NO coherent continuation
  // unless her banner owned the literal last phase of the whole simulation
  // (the "tail banner" scope boundary) — that limitation no longer exists.
  // Her own isolated phase (right after Odette's) is entirely independent of
  // Homa's later, different-banner phase.
  it('a disconnected 4★ resolves normally even when a DIFFERENT banner\'s goal comes later in the list', () => {
    const odette: Goal = { id: 'o', name: 'Odette', kind: '5star_character', banner: 'character', targetId: 'char5' };
    const alyosha: Goal = { id: 'a', name: 'Alyosha', kind: '4star_character', banner: 'character', targetId: 'a', targetLevel: 0, anchoredFiveStarGoalIds: [] };
    const homa: Goal = { id: 'h', name: 'Homa', kind: '5star_weapon', banner: 'weapon', targetId: 'homa' };
    const exact = runExactSimulation(baseInput({ goals: [odette, alyosha, homa], pullBudget: 300 }));
    const breakdown = exact.breakdowns.find((b) => b.goalId === 'a')!;
    expect(breakdown.levelProbabilities[0][300]).toBeGreaterThan(0.99);
  }, 30_000);
});

describe('a side-tracked 4★\'s own series position must not require its blocking phase\'s OTHER members too — twentieth reported bug (2026-08-20)', () => {
  // Found by the user live in the app: [Odette, Alyosha(4★ anchored to Miko
  // only, shallow C0 target), Miko] showed the "Odette+Alyosha" curve
  // (series[1]) completely overlapping "Odette+Alyosha+Miko" (series[2]) on
  // the odds chart — visibly wrong, since Alyosha can (and usually does)
  // finish well before Miko does. Root cause: resolving a side-tracked
  // goal's own series position (exactEngine.ts's ActiveSideTrack mechanism,
  // built for the seventeenth reported bug) used
  // `result.blockingPrefixDone` — the ENTIRE blocking phase's own condition
  // — as the driver, instead of a metric scoped to just the tracked goal.
  // Whenever the blocking phase has ANY other blocking member of its own
  // (here, Miko's own 5★ pull), that phase's blockingPrefixDone requires
  // BOTH jointly, silently gating the tracked goal's own resolution on that
  // OTHER member too. Fixed via goalAloneDoneCumulative (exactEngine.ts),
  // which reads activeLevelCounts+graduatedLevelCounts directly instead —
  // the same per-goal metric the breakdown panel already relies on,
  // independent of the phase's own graduation status.
  //
  // Why the existing suite didn't catch this already: oddsAudit.test.ts's S3
  // exercises the SAME code path (an anchored-to-a-later-phase-only 4★ whose
  // blocking phase has its own native 5★), but with a DEEP C4 target — at
  // that depth, Alyosha's own natural resolution time is comparable to or
  // longer than Miko's own 5★ draw, so the bug's effect (an extra,
  // unnecessary Miko requirement) stayed small enough to hide under S3's 5%
  // cross-validation tolerance. A SHALLOW target (C0, this test) is what
  // makes the gap large and obvious, since Alyosha then very often finishes
  // long before Miko's own multi-dozen-pull draw even resolves.
  it('Odette + Alyosha(C0, anchored to Miko only) + Miko: series[1] must be meaningfully above series[2] throughout, not identical', () => {
    const odette: Goal = { id: 'o', name: 'Odette', kind: '5star_character', banner: 'character', targetId: 'char5' };
    const alyosha: Goal = {
      id: 'a',
      name: 'Alyosha',
      kind: '4star_character',
      banner: 'character',
      targetId: 'c4a',
      targetLevel: 0,
      anchoredFiveStarGoalIds: ['m'],
    };
    const miko: Goal = { id: 'm', name: 'Miko', kind: '5star_character', banner: 'character', targetId: 'char5' };
    const input = baseInput({ goals: [odette, alyosha, miko], pullBudget: 300 });
    const exact = runExactSimulation(input);
    // The decisive, bug-specific check: at every sampled pull count, having
    // JUST Odette+Alyosha must be strictly, meaningfully more likely than
    // having all three — under the bug, these were byte-for-byte identical.
    for (const p of [30, 60, 90, 150, 200, 250, 300]) {
      expect(exact.series[1].probabilities[p]).toBeGreaterThan(exact.series[2].probabilities[p] + 0.01);
    }
    // Basic monotonicity sanity (series[0] >= series[1] >= series[2] always).
    for (let p = 0; p <= 300; p += 10) {
      expect(exact.series[0].probabilities[p]).toBeGreaterThanOrEqual(exact.series[1].probabilities[p] - 1e-9);
      expect(exact.series[1].probabilities[p]).toBeGreaterThanOrEqual(exact.series[2].probabilities[p] - 1e-9);
    }
    // Cross-validated against Monte Carlo — confirms the FIXED exact values
    // are actually correct, not just "different from the buggy ones."
    const mc = runSimulation(input);
    for (let k = 0; k < 3; k++) {
      for (let p = 0; p <= 300; p += 10) {
        expect(Math.abs(exact.series[k].probabilities[p] - mc.series[k].probabilities[p])).toBeLessThan(0.01);
      }
    }
  }, 30_000);
});

describe("a 4★ anchored to BOTH ends of a linked-but-non-adjacent character window must block the EARLY phase, not defer entirely to the LATE one — twenty-first reported bug (2026-08-30)", () => {
  // Found by the user live in the app: [Odette, Alyosha(4★, anchored to BOTH
  // Odette and Miko), WeaponDetour, Miko] with Odette↔Miko LINKED as
  // simultaneous (same real patch) but NOT adjacent in priority order (the
  // weapon detour sits between Alyosha and Miko). resolveFourStarBlockingPhase
  // used to compute Alyosha's blocking phase as MAX(natal, latestAnchor)
  // unconditionally — since her natal phase (Odette's, where she's textually
  // glued) is EARLIER than her latest anchor (Miko's), the old rule picked
  // Miko's phase, meaning Odette's own phase graduated the INSTANT Odette
  // dropped, with zero extra pulls ever spent chasing Alyosha before the
  // engine moved straight to the weapon banner — even though Alyosha (a
  // higher priority than the weapon) was still open and available the whole
  // time. A real player prioritizing Alyosha over the weapon would keep
  // pulling the character banner until she's done, exactly the way
  // FOCUS_RULES.md's "no exceptions" priority-order model says they should.
  //
  // Fixed two ways, both needed: (1) resolveFourStarBlockingPhase now blocks
  // on the natal phase whenever it's itself one of the goal's own anchors,
  // rather than always deferring to the latest one; (2) since that means
  // Odette's phase can now legitimately run PAST Odette's own claim, a
  // featured win landing during that extra stretch must roll over onto
  // Miko's still-open slot instead of vanishing — see phaseDp.ts's
  // always-3-part exit/entry encoding and exactEngine.ts's
  // characterWindowPartnerByPhase/carryPhaseLocalState wiring (mirrored in
  // simulate.ts's characterWindowPartnerByPhase for the same reason).
  it('series[1] (Odette+Alyosha) resolves almost as fast as Odette alone, and far faster than the full chain needing the weapon and Miko too — matches Monte Carlo', () => {
    const odette: Goal = { id: 'o', name: 'Odette', kind: '5star_character', banner: 'character', targetId: 'char5', linkedCharacterGoalId: 'm' };
    const alyosha: Goal = {
      id: 'a',
      name: 'Alyosha',
      kind: '4star_character',
      banner: 'character',
      targetId: 'c4a',
      targetLevel: 0, // C0 = 1 copy
      anchoredFiveStarGoalIds: ['o', 'm'],
    };
    const weaponGoal: Goal = { id: 'w', name: 'Homa', kind: '5star_weapon', banner: 'weapon', targetId: 'homa' };
    const miko: Goal = { id: 'm', name: 'Miko', kind: '5star_character', banner: 'character', targetId: 'char5', linkedCharacterGoalId: 'o' };
    const input = baseInput({ goals: [odette, alyosha, weaponGoal, miko], pullBudget: 300, trialCount: 400_000, seed: 21 });
    const exact = runExactSimulation(input);

    // The decisive, bug-specific check: "Odette+Alyosha" (series[1]) must
    // track close behind Odette alone (series[0]) — a shallow C0 target with
    // extra pulls freely available shouldn't cost much — while the FULL
    // chain (series[3], needing the weapon AND Miko too) lags far behind,
    // proving Alyosha resolves via her OWN early phase, not deferred to
    // Miko's much-later one. Under the old bug, series[1] would instead have
    // tracked close to series[3] (both effectively gated on reaching Miko's
    // phase), with almost no extra pulls ever spent on Alyosha specifically.
    for (const p of [100, 150, 200]) {
      expect(exact.series[1].probabilities[p]).toBeGreaterThan(exact.series[0].probabilities[p] - 0.05);
      expect(exact.series[1].probabilities[p]).toBeGreaterThan(exact.series[3].probabilities[p] + 0.3);
    }
    // Basic monotonicity sanity.
    for (let p = 0; p <= 300; p += 10) {
      for (let k = 1; k < 4; k++) {
        expect(exact.series[k - 1].probabilities[p]).toBeGreaterThanOrEqual(exact.series[k].probabilities[p] - 1e-9);
      }
    }
    // Cross-validated against Monte Carlo (mirrored fix in simulate.ts) —
    // confirms the new values are actually correct, not just different.
    const mc = runSimulation(input);
    for (let k = 0; k < 4; k++) {
      for (let p = 0; p <= 300; p += 25) {
        expect(Math.abs(exact.series[k].probabilities[p] - mc.series[k].probabilities[p])).toBeLessThan(0.02);
      }
    }
  }, 30_000);
});

describe('4★ breakdowns match Monte Carlo', () => {
  // Monte Carlo tracks copies independently (including past each target, and through the trailing
  // continuation), so these cross-check the breakdown panel the way the series tests cross-check
  // the odds chart. The one shape not covered is a 4★ still on the roster across several phases of
  // her banner, where the known time-marginalization residual remains — see ARCHITECTURE.md's
  // "Known limitations".
  function expectBreakdownsAgree(goals: Goal[], pullBudget: number, checkpoints: number[]) {
    const input = baseInput({ goals, pullBudget, trialCount: 60_000, seed: 31 });
    const exact = runExactSimulation(input);
    const mc = runSimulation(input);
    expect(mc.breakdowns.map((b) => b.goalId)).toEqual(exact.breakdowns.map((b) => b.goalId));
    for (const b of exact.breakdowns) {
      const m = mc.breakdowns.find((x) => x.goalId === b.goalId)!;
      expect(m.levelLabels).toEqual(b.levelLabels);
      b.levelProbabilities.forEach((curve, level) => {
        for (const p of checkpoints) expect(Math.abs(curve[p] - m.levelProbabilities[level][p])).toBeLessThan(0.015);
      });
    }
  }
  const odette: Goal = { id: 'o', name: 'Odette', kind: '5star_character', banner: 'character', targetId: 'char5' };

  it('a 4★ whose copies freeze when its banner is left for good', () => {
    const alyosha: Goal = { id: 'a', name: 'Alyosha', kind: '4star_character', banner: 'character', targetId: 'c4a', targetLevel: 2 };
    const weapon: Goal = { id: 'w', name: 'Weapon', kind: '5star_weapon', banner: 'weapon', targetId: 'chosen' };
    expectBreakdownsAgree([odette, alyosha, weapon], 250, [40, 90, 160, 250]);
  }, 60_000);

  it('a 4★ targeting C6, with nothing past its target', () => {
    const alyosha: Goal = { id: 'a', name: 'Alyosha', kind: '4star_character', banner: 'character', targetId: 'c4a', targetLevel: 6 };
    expectBreakdownsAgree([odette, alyosha], 250, [40, 90, 160, 250]);
  }, 60_000);

  it('a lone 4★ collecting bonus copies in the trailing continuation', () => {
    const alyosha: Goal = { id: 'a', name: 'Alyosha', kind: '4star_character', banner: 'character', targetId: 'c4a' };
    expectBreakdownsAgree([alyosha], 200, [20, 60, 120, 200]);
  }, 60_000);

  it('a disconnected 4★ in its own isolated phase', () => {
    const alyosha: Goal = { id: 'a', name: 'Alyosha', kind: '4star_character', banner: 'character', targetId: 'c4a', anchoredFiveStarGoalIds: [] };
    expectBreakdownsAgree([odette, alyosha], 250, [40, 90, 160, 250]);
  }, 60_000);

  it('a 4★ collecting bonus copies past her target in the trailing continuation (was 6pp off when the continuation was a separate, averaged phase)', () => {
    const alyosha: Goal = { id: 'a', name: 'Alyosha', kind: '4star_character', banner: 'character', targetId: 'c4a', targetLevel: 2 };
    expectBreakdownsAgree([odette, alyosha], 250, [60, 120, 161, 250]);
  }, 60_000);

  it('a 4★ whose window closes before a later phase of her banner (her copies freeze; was 8pp off via the hand-off)', () => {
    const alyosha: Goal = { id: 'a', name: 'Alyosha', kind: '4star_character', banner: 'character', targetId: 'c4a', anchoredFiveStarGoalIds: ['o'] };
    const weapon: Goal = { id: 'w', name: 'Weapon', kind: '5star_weapon', banner: 'weapon', targetId: 'chosen' };
    const miko: Goal = { id: 'm', name: 'Miko', kind: '5star_character', banner: 'character', targetId: 'char5' };
    expectBreakdownsAgree([odette, alyosha, weapon, miko], 300, [73, 150, 213, 300]);
  }, 60_000);

  it('a 4★ weapon targeting R3, with bonus refinements from the continuation', () => {
    const weapon: Goal = { id: 'w', name: 'Weapon', kind: '5star_weapon', banner: 'weapon', targetId: 'chosen' };
    const sword: Goal = { id: 's', name: 'Sword', kind: '4star_weapon', banner: 'weapon', targetId: 'w4a', targetLevel: 3 };
    expectBreakdownsAgree([weapon, sword], 250, [65, 138, 250]);
  }, 60_000);

  it('a 4★ weapon targeting R5 on the weapon banner', () => {
    const weapon: Goal = { id: 'w', name: 'Weapon', kind: '5star_weapon', banner: 'weapon', targetId: 'chosen' };
    const sword: Goal = { id: 's', name: 'Sword', kind: '4star_weapon', banner: 'weapon', targetId: 'w4a', targetLevel: 5 };
    expectBreakdownsAgree([weapon, sword], 250, [40, 90, 160, 250]);
  }, 60_000);
});
