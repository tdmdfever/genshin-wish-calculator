import { describe, expect, it } from 'vitest';
import { CR_MODELS, DEFAULT_CR_PARAMS } from '../capturingRadiance';
import { transitionCharacterBanner } from '../characterBanner';
import type { CharacterBannerConfig, CharacterBannerState } from '../types';

const config: CharacterBannerConfig = {
  featured5StarId: 'char5',
  featured4StarIds: ['c4a', 'c4b', 'c4c'],
};

function sumProb(transitions: { probability: number }[]): number {
  return transitions.reduce((s, t) => s + t.probability, 0);
}

describe('transitionCharacterBanner', () => {
  it('probabilities sum to 1 across a swept range of states', () => {
    for (const pity5 of [0, 10, 50, 73, 74, 88, 89]) {
      for (const guaranteed5 of [false, true]) {
        for (const crCounter of [0, 1, 2, 3] as const) {
          for (const pity4 of [0, 4, 8, 9]) {
            for (const guaranteed4 of [false, true]) {
              const state: CharacterBannerState = { pity5, guaranteed5, crCounter, pity4, guaranteed4 };
              const transitions = transitionCharacterBanner(state, config, CR_MODELS.A, DEFAULT_CR_PARAMS);
              expect(sumProb(transitions)).toBeCloseTo(1, 6);
            }
          }
        }
      }
    }
  });

  it('hard-pity state (pity5=89) has 5-star probability exactly 1', () => {
    const state: CharacterBannerState = { pity5: 89, guaranteed5: false, crCounter: 0, pity4: 0, guaranteed4: false };
    const transitions = transitionCharacterBanner(state, config, CR_MODELS.A, DEFAULT_CR_PARAMS);
    const p5 = transitions.filter((t) => t.outcome.rarity === 5).reduce((s, t) => s + t.probability, 0);
    expect(p5).toBeCloseTo(1);
  });

  it('guaranteed5 forces 100% featured regardless of CR counter', () => {
    const state: CharacterBannerState = { pity5: 89, guaranteed5: true, crCounter: 2, pity4: 0, guaranteed4: false };
    const transitions = transitionCharacterBanner(state, config, CR_MODELS.A, DEFAULT_CR_PARAMS);
    const featured = transitions.find((t) => t.outcome.rarity === 5 && t.outcome.kind === 'featured');
    expect(featured?.probability).toBeCloseTo(1);
    expect(featured?.nextState.guaranteed5).toBe(false);
  });

  it('4-star hard pity (pity4=9) guarantees a 4-star or 5-star, never a 3-star, on the next pull', () => {
    const state: CharacterBannerState = { pity5: 0, guaranteed5: false, crCounter: 0, pity4: 9, guaranteed4: false };
    const transitions = transitionCharacterBanner(state, config, CR_MODELS.A, DEFAULT_CR_PARAMS);
    const p3 = transitions.filter((t) => t.outcome.rarity === 3).reduce((s, t) => s + t.probability, 0);
    expect(p3).toBeCloseTo(0);
  });

  it('featured 4-star probability is split evenly across the configured ids on a win', () => {
    const state: CharacterBannerState = { pity5: 0, guaranteed5: false, crCounter: 0, pity4: 9, guaranteed4: true };
    const transitions = transitionCharacterBanner(state, config, CR_MODELS.A, DEFAULT_CR_PARAMS);
    const perId = transitions.filter((t) => t.outcome.rarity === 4 && t.outcome.kind === 'featured');
    expect(perId).toHaveLength(3);
    for (const t of perId) expect(t.probability).toBeCloseTo(1 / 3);
  });
});
