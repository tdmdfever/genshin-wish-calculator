import { describe, expect, it } from 'vitest';
import { runExactSimulation } from '../exactEngine';
import { sliceSimulationResult } from '../sliceResult';
import { DEFAULT_CR_PARAMS } from '../capturingRadiance';
import type { CharacterBannerState, Goal, SimulationInput, WeaponBannerState } from '../types';

/**
 * Verifies `sliceSimulationResult`'s own doc comment: byte-identical to a
 * fresh smaller-budget computation when no banner is reused across phases, and
 * bounded (not exact, but tiny — well under this app's display precision) when
 * a banner IS reused, since that's where a phase handoff's `exitSubstateDist`
 * becomes implicitly conditioned on how large the cached budget was. This is
 * what `useSimulation.ts`'s cache-and-slice optimization relies on.
 */
const zeroCharState: CharacterBannerState = { pity5: 0, guaranteed5: false, crCounter: 0, pity4: 0, guaranteed4: false };
const zeroWeaponState: WeaponBannerState = { pity5: 0, guaranteed5: false, fatePoints: 0, pity4: 0, guaranteed4: false };
function baseInput(overrides: Partial<SimulationInput>): SimulationInput {
  return {
    pullBudget: 90,
    characterBanner: { state: zeroCharState, featured5StarId: 'char5' },
    weaponBanner: { state: zeroWeaponState },
    crModelId: 'A',
    crParams: DEFAULT_CR_PARAMS,
    goals: [],
    trialCount: 1,
    ...overrides,
  };
}
function fiveStarChar(id: string, name: string): Goal {
  return { id, name, kind: '5star_character', banner: 'character', targetId: 'char5' };
}
function fourStarChar(id: string, name: string, targetLevel: number, anchors?: string[]): Goal {
  return { id, name, kind: '4star_character', banner: 'character', targetId: id, targetLevel, anchoredFiveStarGoalIds: anchors };
}
function fiveStarWeapon(id: string, name: string, targetId: string): Goal {
  return { id, name, kind: '5star_weapon', banner: 'weapon', targetId };
}

function expectSliceMatchesFreshExactly(largeInput: SimulationInput, smallBudget: number) {
  const large = runExactSimulation(largeInput);
  const sliced = sliceSimulationResult(large, smallBudget);
  const fresh = runExactSimulation({ ...largeInput, pullBudget: smallBudget });

  expect(sliced.pullCounts).toEqual(fresh.pullCounts);
  expect(sliced.series.length).toBe(fresh.series.length);
  for (let k = 0; k < sliced.series.length; k++) {
    expect(sliced.series[k].probabilities).toEqual(fresh.series[k].probabilities);
  }
  expect(sliced.breakdowns.length).toBe(fresh.breakdowns.length);
  for (let i = 0; i < sliced.breakdowns.length; i++) {
    expect(sliced.breakdowns[i].levelProbabilities).toEqual(fresh.breakdowns[i].levelProbabilities);
  }
}

/** Worst absolute discrepancy anywhere between a sliced result and a fresh
 * direct computation at the same (smaller) budget. */
function worstSliceDiscrepancy(largeInput: SimulationInput, smallBudget: number): number {
  const large = runExactSimulation(largeInput);
  const sliced = sliceSimulationResult(large, smallBudget);
  const fresh = runExactSimulation({ ...largeInput, pullBudget: smallBudget });
  let worst = 0;
  for (let k = 0; k < sliced.series.length; k++) {
    for (let n = 0; n <= smallBudget; n++) worst = Math.max(worst, Math.abs(sliced.series[k].probabilities[n] - fresh.series[k].probabilities[n]));
  }
  return worst;
}

describe('sliceSimulationResult', () => {
  describe('exact (byte-identical) when no banner is reused across phases', () => {
    // The trailing continuation runs inside the last phase's own DP (no hand-off), so a 4★ on a
    // single-phase list no longer breaks exactness — it used to, as a separate phase seeded from
    // the normalized exit distribution.
    it('single phase plus an anchored 4-star, breakdowns included', () => {
      const input = baseInput({ pullBudget: 200, goals: [fiveStarChar('o', 'Odette'), fourStarChar('a', 'Alyosha', 2, ['o'])] });
      expectSliceMatchesFreshExactly(input, 90);
    });

    it('single 5-star goal, no 4-stars at all', () => {
      const input = baseInput({ pullBudget: 200, goals: [fiveStarChar('o', 'Odette')] });
      expectSliceMatchesFreshExactly(input, 90);
    });

    it('cross-banner, no 4-stars (character -> weapon)', () => {
      const input = baseInput({ pullBudget: 300, goals: [fiveStarChar('o', 'Odette'), fiveStarWeapon('h', 'Homa', 'homa')] });
      expectSliceMatchesFreshExactly(input, 150);
    });

    it('maxPulls=0 (empty slice)', () => {
      const input = baseInput({ pullBudget: 90, goals: [fiveStarChar('o', 'Odette')] });
      expectSliceMatchesFreshExactly(input, 0);
    });
  });

  describe('bounded (small, nonzero) discrepancy whenever a banner is reused across phases', () => {
    it('character banner reused (character -> weapon -> character), no 4-stars: discrepancy is negligible', () => {
      const input = baseInput({
        pullBudget: 300,
        goals: [fiveStarChar('o', 'Odette'), fiveStarWeapon('h', 'Homa', 'homa'), fiveStarChar('m', 'Miko')],
      });
      // No goal here is EXTENDED past its own natal phase's own win (no anchored
      // 4-star widening the conditioning window), so the residual should be at
      // floating-point-noise magnitude, not just "small".
      expect(worstSliceDiscrepancy(input, 150)).toBeLessThan(1e-9);
    });

    it('adversarial: disconnected 4-star + deep-target same-phase 4-star, large cache-to-request gap', () => {
      // Deliberately constructed to stress the exitSubstateDist-conditioning
      // effect described in sliceSimulationResult's own doc comment: a
      // disconnected 4-star (own isolated same-banner phase) plus a deep C6
      // target 4-star extending Odette's own phase, sliced from a 900-pull
      // cache down to a much smaller request.
      const input = baseInput({
        pullBudget: 900,
        goals: [
          fiveStarChar('o', 'Odette'),
          fourStarChar('sara', 'Sara', 3), // unanchored, 2 same-kind 5-stars exist -> disconnected
          fourStarChar('a', 'Alyosha', 6, ['o']),
          fiveStarChar('m', 'Miko'),
        ],
      });
      // Measured worst case ~0.0007pp (7.2e-4 as a probability) at a 90-pull
      // request — well under this app's own 1-decimal display precision (1e-3
      // as a probability) but NOT zero. Tolerance set with margin above the
      // measured value, not exactly at it, so this doesn't flake on unrelated
      // engine changes that shift the residual slightly.
      expect(worstSliceDiscrepancy(input, 90)).toBeLessThan(0.002);
      // And confirm it decays as the requested budget approaches the cached one.
      expect(worstSliceDiscrepancy(input, 600)).toBeLessThan(0.0001);
    }, 120_000); // pullBudget=900 with a deep C6 target is this file's own heaviest case — bumped from 60s (2026-08-30) after confirming via a stash-based A/B run that this specific test times out under parallel-file load even on an unmodified baseline, not just when other engine changes are in flight.
  });
});
