import { describe, expect, it } from 'vitest';
import { CR_MODELS, DEFAULT_CR_PARAMS } from '../capturingRadiance';
import { exactCharacterBannerCdf, exactWeaponBannerCdf } from '../exactDp';
import { char5Rate } from '../pity';
import { runSimulation } from '../simulate';
import type {
  CharacterBannerConfig,
  CharacterBannerState,
  Goal,
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

describe('closed-form sanity checks', () => {
  it('P(>=1 5-star within 90 pulls from pity 0) = 1 on the character banner', () => {
    const cdf = exactCharacterBannerCdf(
      zeroCharState,
      charConfig,
      CR_MODELS.A,
      DEFAULT_CR_PARAMS,
      (o) => o.rarity === 5,
      90,
    );
    expect(cdf[90]).toBeCloseTo(1, 6);
  });

  it('P(>=1 5-star within 77 pulls from pity 0) = 1 on the weapon banner', () => {
    const cdf = exactWeaponBannerCdf(zeroWeaponState, weaponConfig, (o) => o.rarity === 5, 77);
    expect(cdf[77]).toBeCloseTo(1, 6);
  });

  it('P(>=1 4-star-or-better within 10 pulls from pity 0) = 1', () => {
    const cdf = exactCharacterBannerCdf(
      zeroCharState,
      charConfig,
      CR_MODELS.A,
      DEFAULT_CR_PARAMS,
      (o) => o.rarity >= 4,
      10,
    );
    expect(cdf[10]).toBeCloseTo(1, 6);
  });

  it('E[pulls to first 5-star from pity 0] is close to the community-known ~62-63', () => {
    let survival = 1;
    let expected = 0;
    for (let n = 0; n <= 89; n++) {
      expected += survival;
      survival *= 1 - char5Rate(n + 1);
    }
    expect(expected).toBeGreaterThan(60);
    expect(expected).toBeLessThan(64);
  });

  it('P(featured character within 180 pulls, not guaranteed, from pity 0) = 1 (deterministic worst case)', () => {
    const cdf = exactCharacterBannerCdf(
      zeroCharState,
      charConfig,
      CR_MODELS.B,
      DEFAULT_CR_PARAMS,
      (o) => o.rarity === 5 && o.kind === 'featured',
      180,
    );
    expect(cdf[180]).toBeCloseTo(1, 5);
  });

  it('P(chosen path weapon within 154 pulls, fatePoints=0, from pity 0) = 1 (deterministic worst case: two 77-pull cycles)', () => {
    const cdf = exactWeaponBannerCdf(
      zeroWeaponState,
      weaponConfig,
      (o) => o.rarity === 5 && o.kind === 'featured' && o.itemId === weaponConfig.chosenWeaponId,
      154,
    );
    expect(cdf[154]).toBeCloseTo(1, 5);
  });
});

describe('Monte Carlo vs exact DP cross-validation', () => {
  it('agrees with exact DP for a single character-banner goal within ~2 percentage points', () => {
    const goal: Goal = { id: 'g1', name: 'Goal', kind: '5star_character', banner: 'character', targetId: 'char5' };
    const exact = exactCharacterBannerCdf(
      zeroCharState,
      charConfig,
      CR_MODELS.A,
      DEFAULT_CR_PARAMS,
      (o) => o.rarity === 5 && o.kind === 'featured',
      120,
    );
    const mc = runSimulation({
      pullBudget: 120,
      characterBanner: { state: zeroCharState, featured5StarId: charConfig.featured5StarId },
      weaponBanner: { state: zeroWeaponState },
      crModelId: 'A',
      crParams: DEFAULT_CR_PARAMS,
      goals: [goal],
      trialCount: 200_000,
      seed: 42,
    });
    const series = mc.series[0].probabilities;
    for (const p of [30, 60, 74, 90, 120]) {
      expect(Math.abs(series[p] - exact[p])).toBeLessThan(0.02);
    }
  }, 20_000);

  it('agrees with exact DP for a single weapon-banner goal within ~2 percentage points', () => {
    const goal: Goal = { id: 'g1', name: 'Goal', kind: '5star_weapon', banner: 'weapon', targetId: 'chosen' };
    const exact = exactWeaponBannerCdf(
      zeroWeaponState,
      weaponConfig,
      (o) => o.rarity === 5 && o.kind === 'featured' && o.itemId === 'chosen',
      120,
    );
    const mc = runSimulation({
      pullBudget: 120,
      characterBanner: { state: zeroCharState, featured5StarId: charConfig.featured5StarId },
      weaponBanner: { state: zeroWeaponState },
      crModelId: 'A',
      crParams: DEFAULT_CR_PARAMS,
      goals: [goal],
      trialCount: 200_000,
      seed: 42,
    });
    const series = mc.series[0].probabilities;
    for (const p of [20, 40, 62, 80, 120]) {
      expect(Math.abs(series[p] - exact[p])).toBeLessThan(0.02);
    }
  }, 20_000);
});

describe('RNG determinism', () => {
  it('same seed produces identical results', () => {
    const goal: Goal = { id: 'g1', name: 'Goal', kind: '5star_character', banner: 'character', targetId: 'char5' };
    const input = {
      pullBudget: 90,
      characterBanner: { state: zeroCharState, featured5StarId: charConfig.featured5StarId },
      weaponBanner: { state: zeroWeaponState },
      crModelId: 'A' as const,
      crParams: DEFAULT_CR_PARAMS,
      goals: [goal],
      trialCount: 5_000,
      seed: 123,
    };
    const a = runSimulation(input);
    const b = runSimulation(input);
    expect(a.series[0].probabilities).toEqual(b.series[0].probabilities);
  });
});

describe('multi-goal opportunistic completion', () => {
  it('a lower-priority 4-star goal can complete before a higher-priority 5-star goal', () => {
    const goal5: Goal = { id: 'g5', name: '5star', kind: '5star_character', banner: 'character', targetId: 'char5' };
    const goal4: Goal = { id: 'g4', name: '4star', kind: '4star_character', banner: 'character', targetId: 'c4a' };
    const mc = runSimulation({
      pullBudget: 20,
      characterBanner: { state: zeroCharState, featured5StarId: charConfig.featured5StarId },
      weaponBanner: { state: zeroWeaponState },
      crModelId: 'A',
      crParams: DEFAULT_CR_PARAMS,
      goals: [goal5, goal4],
      trialCount: 20_000,
      seed: 7,
    });
    // "goal5 alone" should be far less likely by pull 20 than "goal5+goal4 combined"
    // requires — but since goal4 (a 4-star) is nearly certain within 20 pulls, the
    // prefix-2 series (both done) should track close to the prefix-1 series (5-star
    // alone), confirming the 4-star isn't blocking on the 5-star's completion.
    const p1 = mc.series[0].probabilities[20];
    const p2 = mc.series[1].probabilities[20];
    expect(p2).toBeLessThanOrEqual(p1);
    expect(p1 - p2).toBeLessThan(0.05);
  });

  it('two sequential 5star_character goals require two separate featured wins, not one shared win', () => {
    // Regression test: 5star_character matching is identity-agnostic (only one
    // character is "currently featured" in the config), so without care a single
    // featured win could satisfy every pending 5star_character goal at once. Only
    // the earliest pending one should claim a given win.
    const first: Goal = { id: 'first', name: 'HuTao', kind: '5star_character', banner: 'character', targetId: 'char5' };
    const second: Goal = { id: 'second', name: 'Furina', kind: '5star_character', banner: 'character', targetId: 'char5' };
    const mc = runSimulation({
      pullBudget: 90,
      characterBanner: { state: { pity5: 40, guaranteed5: false, crCounter: 0, pity4: 0, guaranteed4: false }, featured5StarId: charConfig.featured5StarId },
      weaponBanner: { state: zeroWeaponState },
      crModelId: 'A',
      crParams: DEFAULT_CR_PARAMS,
      goals: [first, second],
      trialCount: 100_000,
      seed: 99,
    });
    const pHuTao = mc.series[0].probabilities[90];
    const pBoth = mc.series[1].probabilities[90];
    // Exact DP: P(1 featured win by pull 90 | pity=40, not guaranteed) ≈ 0.664.
    expect(pHuTao).toBeGreaterThan(0.63);
    expect(pHuTao).toBeLessThan(0.70);
    // Getting a *second* featured win by the same deadline must be strictly harder,
    // not identical to getting the first.
    expect(pBoth).toBeLessThan(pHuTao - 0.1);
  }, 20_000);
});
