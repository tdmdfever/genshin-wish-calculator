import { describe, expect, it } from 'vitest';
import { transitionWeaponBanner } from '../weaponBanner';
import type { WeaponBannerConfig, WeaponBannerState } from '../types';

const config: WeaponBannerConfig = {
  chosenWeaponId: 'chosen',
  otherFeaturedWeaponId: 'other',
  featured4WeaponIds: ['w4a', 'w4b', 'w4c', 'w4d', 'w4e'],
};

function sumProb(transitions: { probability: number }[]): number {
  return transitions.reduce((s, t) => s + t.probability, 0);
}

describe('transitionWeaponBanner', () => {
  it('probabilities sum to 1 across a swept range of states', () => {
    for (const pity5 of [0, 10, 62, 63, 75, 76]) {
      for (const guaranteed5 of [false, true]) {
        for (const fatePoints of [0, 1] as const) {
          for (const pity4 of [0, 4, 8, 9]) {
            for (const guaranteed4 of [false, true]) {
              const state: WeaponBannerState = { pity5, guaranteed5, fatePoints, pity4, guaranteed4 };
              const transitions = transitionWeaponBanner(state, config);
              expect(sumProb(transitions)).toBeCloseTo(1, 6);
            }
          }
        }
      }
    }
  });

  it('hard-pity state (pity5=76) has 5-star probability exactly 1', () => {
    const state: WeaponBannerState = { pity5: 76, guaranteed5: false, fatePoints: 0, pity4: 0, guaranteed4: false };
    const transitions = transitionWeaponBanner(state, config);
    const p5 = transitions.filter((t) => t.outcome.rarity === 5).reduce((s, t) => s + t.probability, 0);
    expect(p5).toBeCloseTo(1);
  });

  it('fatePoints=1 forces 100% chosen weapon on a 5-star, regardless of guaranteed5 — a fate point fully overrides the 75/25 guarantee, not just the identity split within it', () => {
    for (const guaranteed5 of [false, true]) {
      const state: WeaponBannerState = { pity5: 76, guaranteed5, fatePoints: 1, pity4: 0, guaranteed4: false };
      const transitions = transitionWeaponBanner(state, config);
      const chosen = transitions.find((t) => t.outcome.rarity === 5 && t.outcome.kind === 'featured');
      expect(chosen?.probability).toBeCloseTo(1);
      expect(chosen?.nextState.fatePoints).toBe(0);
      expect(chosen?.nextState.guaranteed5).toBe(false);
      // No standard branch reachable at all once fatePoints=1.
      expect(transitions.some((t) => t.outcome.rarity === 5 && t.outcome.kind === 'standard')).toBe(false);
    }
  });

  it('baseline (guaranteed5=false, fatePoints=0): splits 5-star 37.5/37.5/25 between chosen/other/standard', () => {
    const state: WeaponBannerState = { pity5: 76, guaranteed5: false, fatePoints: 0, pity4: 0, guaranteed4: false };
    const transitions = transitionWeaponBanner(state, config);
    const chosen = transitions.find((t) => t.outcome.rarity === 5 && t.outcome.kind === 'featured');
    const other = transitions.find((t) => t.outcome.rarity === 5 && t.outcome.kind === 'featured_other');
    const standard = transitions.find((t) => t.outcome.rarity === 5 && t.outcome.kind === 'standard');
    expect(chosen?.probability).toBeCloseTo(0.375);
    expect(other?.probability).toBeCloseTo(0.375);
    expect(standard?.probability).toBeCloseTo(0.25);
    expect(chosen?.nextState.fatePoints).toBe(0);
    expect(chosen?.nextState.guaranteed5).toBe(false);
    // Getting the other event weapon earns a Fate Point, but does NOT set the
    // standalone 75/25 guarantee — that's specific to a standard loss.
    expect(other?.nextState.fatePoints).toBe(1);
    expect(other?.nextState.guaranteed5).toBe(false);
    // A standard loss earns a Fate Point AND sets guaranteed5 — two
    // independent effects from the same pull (see weaponBanner.ts's doc
    // comment on transitionWeaponBanner).
    expect(standard?.nextState.fatePoints).toBe(1);
    expect(standard?.nextState.guaranteed5).toBe(true);
  });

  it('guaranteed5=true, fatePoints=0: 50/50 between chosen/other, no standard possible — the standalone 75/25 guarantee acting on its own', () => {
    const state: WeaponBannerState = { pity5: 76, guaranteed5: true, fatePoints: 0, pity4: 0, guaranteed4: false };
    const transitions = transitionWeaponBanner(state, config);
    const chosen = transitions.find((t) => t.outcome.rarity === 5 && t.outcome.kind === 'featured');
    const other = transitions.find((t) => t.outcome.rarity === 5 && t.outcome.kind === 'featured_other');
    const standard = transitions.find((t) => t.outcome.rarity === 5 && t.outcome.kind === 'standard');
    expect(chosen?.probability).toBeCloseTo(0.5);
    expect(other?.probability).toBeCloseTo(0.5);
    expect(standard).toBeUndefined();
    // Both branches consume (reset) the guarantee — it only ever covers "the
    // very next 5-star pull".
    expect(chosen?.nextState.guaranteed5).toBe(false);
    expect(other?.nextState.guaranteed5).toBe(false);
    expect(chosen?.nextState.fatePoints).toBe(0);
    expect(other?.nextState.fatePoints).toBe(1);
  });

  it('4-star rate-up pool captures 75% of 4-star pulls (25% standard), unlike the character banner\'s 50/50', () => {
    const state: WeaponBannerState = { pity5: 0, guaranteed5: false, fatePoints: 0, pity4: 9, guaranteed4: false };
    const transitions = transitionWeaponBanner(state, config);
    const featuredTotal = transitions.filter((t) => t.outcome.rarity === 4 && t.outcome.kind === 'featured').reduce((s, t) => s + t.probability, 0);
    const standard = transitions.find((t) => t.outcome.rarity === 4 && t.outcome.kind === 'standard');
    // Ratio, not raw probability: the raw values are also scaled down slightly by
    // the (small) chance this pull is a 5-star instead, which isn't what's under test.
    const p4Total = featuredTotal + (standard?.probability ?? 0);
    expect(featuredTotal / p4Total).toBeCloseTo(0.75);
    expect((standard?.probability ?? 0) / p4Total).toBeCloseTo(0.25);
  });
});
