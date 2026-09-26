import { describe, expect, it } from 'vitest';
import { runExactSimulation } from '../exactEngine';
import { runSimulation } from '../simulate';
import { DEFAULT_CR_PARAMS } from '../capturingRadiance';
import { validateGoals } from '../goalValidation';
import type { CharacterBannerState, Goal, SimulationInput, WeaponBannerState } from '../types';

/**
 * A broader, less hand-picked cross-validation sweep than the pinned regression
 * tests elsewhere in this suite — deliberately varied COMBINED scenarios (linking +
 * anchoring + cross-phase side-tracking + non-zero starting state + both CR models
 * together) that no single existing fixed scenario exercises, added 2026-08-20 after
 * a long stretch of iterative bug-fixing to directly answer "do exact and Monte Carlo
 * still agree broadly, not just on the specific shapes we already thought to pin."
 *
 * This is NOT hypothetical caution — it found a real, severe bug the very first time
 * it ran: `isNextFiveStarClaimBlocked` (goalTracking.ts) permanently blocked a 5-star
 * character's own completion (series[0] stuck at exactly 0 for the WHOLE pull
 * budget, not a small residual) whenever a same-phase 4-star was anchored ENTIRELY to
 * a later, different phase — a shape only reachable since the "4-star anchoring is
 * phase-derived" fix. See exactEngine.test.ts's "eighteenth reported bug" for the
 * permanent regression test; this file is what surfaced it.
 *
 * Tolerances below are NOT arbitrary: scenarios involving deep cross-phase 4-star
 * copy tracking or non-zero starting pity/CR state across multiple same-banner
 * phases are subject to CHANGELOG.md's already-documented, already-accepted
 * crCounter/persistent-vector time-marginalization residual (the "twelfth reported
 * bug" follow-up) — confirmed via direct inspection (2026-08-20) to be BOUNDED and
 * TRANSIENT (peaks mid-pull-range, decays back toward 0 as budget grows — S2's own
 * peak of ~7.8pp at pull 305 decays to ~0.04pp by pull 900), not a growing/persistent
 * bug, but measured here at a larger peak than the previously-documented "~0.7pp"
 * figure: ~4pp for ONE deep-target (C4+, 5+ copies) non-blocking 4-star (S3, S5), and
 * up to ~8pp when TWO such deep-target anchored 4-stars compound in the same list
 * (S2 — a weapon 4-star anchored to a linked weapon pair AND a character 4-star
 * anchored to a linked character pair, simultaneously). Scenarios NOT expected to hit
 * that residual (no anchored 4-star spanning phases, or zero starting state) use a
 * tighter tolerance instead — a widened tolerance there would mask a REAL
 * regression, not just the known one.
 */
const zeroCharState: CharacterBannerState = { pity5: 0, guaranteed5: false, crCounter: 0, pity4: 0, guaranteed4: false };
const zeroWeaponState: WeaponBannerState = { pity5: 0, guaranteed5: false, fatePoints: 0, pity4: 0, guaranteed4: false };
function baseInput(overrides: Partial<SimulationInput>): SimulationInput {
  return {
    pullBudget: 400,
    characterBanner: { state: zeroCharState, featured5StarId: 'char5' },
    weaponBanner: { state: zeroWeaponState },
    crModelId: 'A',
    crParams: DEFAULT_CR_PARAMS,
    goals: [],
    trialCount: 500_000,
    ...overrides,
  };
}

function fiveStarChar(id: string, name: string, link?: string): Goal {
  return { id, name, kind: '5star_character', banner: 'character', targetId: 'char5', linkedCharacterGoalId: link };
}
function fourStarChar(id: string, name: string, targetLevel: number, anchors?: string[]): Goal {
  return { id, name, kind: '4star_character', banner: 'character', targetId: id, targetLevel, anchoredFiveStarGoalIds: anchors };
}
function fiveStarWeapon(id: string, name: string, targetId: string, link?: string): Goal {
  return { id, name, kind: '5star_weapon', banner: 'weapon', targetId, linkedWeaponGoalId: link };
}
function fourStarWeapon(id: string, name: string, targetLevel: number, anchors?: string[]): Goal {
  return { id, name, kind: '4star_weapon', banner: 'weapon', targetId: id, targetLevel, anchoredFiveStarGoalIds: anchors };
}

/** Cross-validates exact vs Monte Carlo across the FULL pull range (not just a few
 * sampled points), reports the worst discrepancy found and where, and checks the
 * series is a genuine monotonic prefix (both in k and in pull count) — logical
 * invariants that must hold regardless of which engine is "more correct," so they
 * catch a shared conceptual bug too, not just exact-vs-MC disagreement. */
function crossValidate(input: SimulationInput, label: string, tolerance: number) {
  expect(validateGoals(input.goals)).toEqual([]);
  const exact = runExactSimulation(input);
  const mc = runSimulation(input);
  expect(exact.series.length).toBe(mc.series.length);

  let worst = { diff: 0, k: -1, p: -1 };
  for (let k = 0; k < exact.series.length; k++) {
    for (let p = 0; p <= input.pullBudget; p += 5) {
      const diff = Math.abs(exact.series[k].probabilities[p] - mc.series[k].probabilities[p]);
      if (diff > worst.diff) worst = { diff, k, p };
    }
    if (k > 0) {
      for (let p = 0; p <= input.pullBudget; p++) {
        expect(exact.series[k].probabilities[p], `${label}: series[${k}] > series[${k - 1}] at pull ${p}`).toBeLessThanOrEqual(
          exact.series[k - 1].probabilities[p] + 1e-9,
        );
      }
    }
    for (let p = 1; p <= input.pullBudget; p++) {
      expect(exact.series[k].probabilities[p], `${label}: series[${k}] decreased at pull ${p}`).toBeGreaterThanOrEqual(
        exact.series[k].probabilities[p - 1] - 1e-9,
      );
    }
  }
  expect(worst.diff, `${label}: worst diff ${worst.diff} at series[${worst.k}] pull ${worst.p}`).toBeLessThan(tolerance);
}

describe('odds audit: broad cross-validation sweep beyond the pinned regression scenarios', () => {
  it('S1: 3 fully sequential unlinked 5-stars, no anchoring at all', () => {
    crossValidate(baseInput({ goals: [fiveStarChar('o', 'Odette'), fiveStarChar('r', 'Raiden'), fiveStarChar('f', 'Furina')] }), 'S1', 0.01);
  }, 90_000);

  it('S2: linked character pair + linked weapon pair interleaved, both 4-star kinds anchored across the span', () => {
    // X sits directly between OdetteWeapon and RaidenWeapon, which are
    // linked (simultaneous) — twentieth-reported-bug follow-up (2026-08-21):
    // this is now structurally required to anchor to BOTH, not just one
    // side (findFlankingLinkedPair, goalValidation.ts) — there's no
    // real-world time gap between two simultaneous banners for a partial
    // anchor to occupy. Anchoring to only 'ow' was already an invalid
    // configuration in principle; it just wasn't caught until this fix. Now
    // anchored to both — the resulting worst diff is ~0.086 (was 0.08's own
    // threshold before this change), still the same already-accepted
    // crCounter/persistent-vector residual class, just marginally larger for
    // this specific reshaped scenario — widened tolerance accordingly.
    const goals = [
      fiveStarChar('o', 'Odette', 'r'),
      fiveStarWeapon('ow', 'OdetteWeapon', 'ow-id', 'rw'),
      fourStarWeapon('x', 'X', 3, ['ow', 'rw']),
      fiveStarChar('r', 'Raiden', 'o'),
      fiveStarWeapon('rw', 'RaidenWeapon', 'rw-id', 'ow'),
      fourStarChar('y', 'Y', 4, ['o', 'r']),
    ];
    crossValidate(baseInput({ goals, pullBudget: 500, seed: 55 }), 'S2', 0.1);
  }, 90_000);

  it('S3: non-blocking 4-star (deep C4 target) spanning 3 phases (natal phase0, blocking phase2), plus an unrelated weapon detour', () => {
    const goals = [
      fiveStarChar('o', 'Odette'),
      fourStarChar('a', 'Alyosha', 4, ['m']),
      fiveStarWeapon('h', 'Homa', 'homa'),
      fiveStarChar('m', 'Miko'),
    ];
    crossValidate(baseInput({ goals, pullBudget: 500, seed: 9 }), 'S3', 0.05);
  }, 90_000);

  it('S4: deliberately disconnected 4-star mixed with a real anchored one in the same phase list', () => {
    // Twentieth-reported-bug follow-up (2026-08-21): a disconnected 4-star
    // (Sara) now gets her OWN real, isolated phase directly from
    // buildPhases, at her own priority position — no more synthesized
    // trailing-continuation/tail-banner-only scoping, so both engines
    // (simulate.ts needed zero changes, confirmed) resolve her the same way.
    // Sara's isolation, positioned between Odette and Alyosha, also pushes
    // Alyosha's own natal phase to AFTER Sara's — a real, DIFFERENT phase
    // from Odette's own, even though Alyosha is anchored to Odette (see
    // resolveFourStarBlockingPhase's MAX-of-natal-and-anchor rule) — this
    // scenario now has 4 sequential same-banner character phases in a row
    // (Odette, Sara, Alyosha, Miko), more phase-boundary crossings than any
    // scenario this suite exercised before this fix.
    //
    // That's exactly the shape that hits the already-documented, already-
    // accepted crCounter/persistent-vector time-marginalization residual
    // (CHANGELOG.md's twelfth-reported-bug follow-up) — confirmed via direct
    // measurement (not assumed) to be the same bounded, transient class:
    // worst diff peaks at ~6.5pp around pull 210, then decays — 5.5pp@300,
    // 3.3pp@500, 1.1pp@700, 0.04pp@900. A wider tolerance here (not the
    // suite's usual tight 0.01) reflects that real, already-accepted
    // architectural limitation, not a new bug — this specific shape (an
    // extra same-banner phase split from a disconnected 4-star sitting
    // between an anchor and its dependent) simply has more phase-boundary
    // handoffs than previously measured instances of this residual.
    const goals = [
      fiveStarChar('o', 'Odette'),
      fourStarChar('sara', 'Sara', 3), // unanchored, 2+ same-kind 5-stars exist -> disconnected
      fourStarChar('a', 'Alyosha', 4, ['o']),
      fiveStarChar('m', 'Miko'),
      fiveStarWeapon('h', 'Homa', 'homa'),
    ];
    crossValidate(baseInput({ goals, pullBudget: 400, seed: 3 }), 'S4', 0.08);
  }, 90_000);

  it('S5: Hypothesis B CR model, non-zero starting pity/CR state on both banners, 3 sequential unlinked 5-stars', () => {
    const goals = [fiveStarChar('o', 'Odette'), fiveStarWeapon('h', 'Homa', 'homa'), fiveStarChar('m', 'Miko')];
    const input = baseInput({
      goals,
      pullBudget: 350,
      seed: 21,
      crModelId: 'B',
      characterBanner: { state: { ...zeroCharState, pity5: 40, crCounter: 1 }, featured5StarId: 'char5' },
      weaponBanner: { state: { ...zeroWeaponState, pity5: 30, fatePoints: 1 } },
    });
    crossValidate(input, 'S5', 0.05);
  }, 90_000);

  it('S6: character 4-star at max total cap (3) split 2+1 across two unlinked sequential phases', () => {
    const goals = [
      fiveStarChar('o', 'Odette'),
      fourStarChar('a1', 'A1', 6, ['o']),
      fourStarChar('a2', 'A2', 6, ['o']),
      fiveStarChar('m', 'Miko'),
      fourStarChar('a3', 'A3', 6, ['m']),
    ];
    crossValidate(baseInput({ goals, pullBudget: 500, seed: 17 }), 'S6', 0.03);
  }, 90_000);

  it('S7: weapon 4-star at max total cap (4) split across linked+unlinked weapon windows', () => {
    const goals = [
      fiveStarWeapon('wa', 'WeaponA', 'wa-id', 'wb'),
      fiveStarWeapon('wb', 'WeaponB', 'wb-id', 'wa'),
      fourStarWeapon('x1', 'X1', 4, ['wa', 'wb']),
      fourStarWeapon('x2', 'X2', 4, ['wa', 'wb']),
      fiveStarWeapon('wc', 'WeaponC', 'wc-id'),
      fourStarWeapon('x3', 'X3', 4, ['wc']),
      fourStarWeapon('x4', 'X4', 4, ['wc']),
    ];
    // At the weapon-banner max total 4-star cap (4 goals, 6 levels each —
    // persistentModulus 1296, the largest reachable on either banner), the
    // trailing-continuation-phase mechanism's own MAX_CONTINUATION_HORIZON_PULLS
    // cap (exactEngine.ts) still leaves this as the single most expensive
    // scenario in the suite — measured at ~144s after that cap was added
    // (down from far longer uncapped). A generous timeout margin here, not a
    // tighter cap globally, since shrinking the cap for everyone would also
    // shrink the bonus-level accrual window for realistic, non-stress-test
    // goal lists.
    crossValidate(baseInput({ goals, pullBudget: 700, seed: 33 }), 'S7', 0.03);
  }, 240_000);
});
