import { describe, expect, it } from 'vitest';
import { CR_MODELS, DEFAULT_CR_PARAMS } from '../capturingRadiance';
import type { CRCounter } from '../types';

function sumProb(transitions: { probability: number }[]): number {
  return transitions.reduce((s, t) => s + t.probability, 0);
}

describe('hypothesis A (OneBST)', () => {
  const model = CR_MODELS.A;
  it('sums to 1 at every counter', () => {
    for (const r of [0, 1, 2, 3] as CRCounter[]) {
      expect(sumProb(model.resolve50_50(r, DEFAULT_CR_PARAMS))).toBeCloseTo(1);
    }
  });
  it('is a plain 50/50 at r=0 and r=1', () => {
    const r0 = model.resolve50_50(0, DEFAULT_CR_PARAMS);
    expect(r0.find((t) => t.result === 'win_normal')?.probability).toBeCloseTo(0.5);
    expect(r0.find((t) => t.result === 'loss')?.probability).toBeCloseTo(0.5);
    expect(r0.find((t) => t.result === 'loss')?.nextR).toBe(1);

    const r1 = model.resolve50_50(1, DEFAULT_CR_PARAMS);
    expect(r1.find((t) => t.result === 'win_normal')?.probability).toBeCloseTo(0.5);
    expect(r1.find((t) => t.result === 'loss')?.nextR).toBe(2);
  });
  it('splits r=2 win into normal and capturing-radiance portions per r2TotalWinRate, both decrementing to 1', () => {
    const r2 = model.resolve50_50(2, { r2TotalWinRate: 0.55 });
    const normal = r2.find((t) => t.result === 'win_normal');
    const cr = r2.find((t) => t.result === 'win_capturing_radiance');
    const loss = r2.find((t) => t.result === 'loss');
    expect(normal?.probability).toBeCloseTo(0.5);
    expect(normal?.nextR).toBe(1);
    expect(cr?.probability).toBeCloseTo(0.05);
    expect(cr?.nextR).toBe(1);
    expect(loss?.probability).toBeCloseTo(0.45);
    expect(loss?.nextR).toBe(3);
  });
  it('is a guaranteed capturing-radiance win at r=3, decrementing to 1', () => {
    const r3 = model.resolve50_50(3, DEFAULT_CR_PARAMS);
    expect(r3).toHaveLength(1);
    expect(r3[0].result).toBe('win_capturing_radiance');
    expect(r3[0].probability).toBeCloseTo(1);
    expect(r3[0].nextR).toBe(1);
  });
});

describe('hypothesis B (genshin-wishes.com formula)', () => {
  const model = CR_MODELS.B;
  it('sums to 1 at every counter', () => {
    for (const r of [0, 1, 2, 3] as CRCounter[]) {
      expect(sumProb(model.resolve50_50(r, DEFAULT_CR_PARAMS))).toBeCloseTo(1);
    }
  });
  it('matches the documented win rates 50/52.5/75/100', () => {
    const expected = [0.5, 0.525, 0.75, 1.0];
    for (const r of [0, 1, 2, 3] as CRCounter[]) {
      const transitions = model.resolve50_50(r, DEFAULT_CR_PARAMS);
      const winProb = transitions.filter((t) => t.result !== 'loss').reduce((s, t) => s + t.probability, 0);
      expect(winProb).toBeCloseTo(expected[r]);
    }
  });
  it('any win resets counter to 0, any loss increments (capped at 3)', () => {
    for (const r of [0, 1, 2, 3] as CRCounter[]) {
      const transitions = model.resolve50_50(r, DEFAULT_CR_PARAMS);
      for (const t of transitions) {
        if (t.result === 'loss') expect(t.nextR).toBe(Math.min(r + 1, 3));
        else expect(t.nextR).toBe(0);
      }
    }
  });
});
