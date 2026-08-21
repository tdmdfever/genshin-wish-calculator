import type { CRCounter, CRModel, CRParams, CRTransition } from './types';

/**
 * Hypothesis A: OneBST community 4M-pull analysis. Boost only starts at r=2 (two
 * consecutive losses). Counter transitions on a win: at r=0 or r=1, a win (always
 * "normal" there — no CR boost applies yet) decrements to 0. At r=2, a win —
 * whether the organic 50% portion or the Capturing-Radiance-boosted excess — always
 * decrements to 1, not 0. At r=3, the win is a guaranteed Capturing Radiance
 * trigger and also decrements to 1, not 0. (Cross-checked against an independent
 * implementation, community project HuTaoSite's gachacalc.tsx, which encodes this
 * exact same r=2/r=3 decrement-to-1 behavior.)
 */
const hypothesisA: CRModel = {
  id: 'A',
  resolve50_50(r: CRCounter, params: CRParams): CRTransition[] {
    if (r === 0) {
      return [
        { probability: 0.5, result: 'win_normal', nextR: 0 },
        { probability: 0.5, result: 'loss', nextR: 1 },
      ];
    }
    if (r === 1) {
      return [
        { probability: 0.5, result: 'win_normal', nextR: 0 },
        { probability: 0.5, result: 'loss', nextR: 2 },
      ];
    }
    if (r === 2) {
      const totalWin = clamp01(params.r2TotalWinRate);
      const normalWin = Math.min(0.5, totalWin);
      const crWin = totalWin - normalWin;
      const loss = 1 - totalWin;
      const transitions: CRTransition[] = [];
      if (normalWin > 0) transitions.push({ probability: normalWin, result: 'win_normal', nextR: 1 });
      if (crWin > 0) transitions.push({ probability: crWin, result: 'win_capturing_radiance', nextR: 1 });
      transitions.push({ probability: loss, result: 'loss', nextR: 3 });
      return transitions;
    }
    // r === 3
    return [{ probability: 1, result: 'win_capturing_radiance', nextR: 1 }];
  },
};

/**
 * Hypothesis B: simplified genshin-wishes.com-style model used by several public
 * calculators. Win rate = 0.5 + 0.5 * c_r for c_r in {0, 0.05, 0.5, 1} at r = 0..3.
 * Boost starts one loss earlier than hypothesis A. Any win fully resets r to 0.
 */
const WIN_RATE_BY_COUNTER: Record<CRCounter, number> = { 0: 0.5, 1: 0.525, 2: 0.75, 3: 1 };

const hypothesisB: CRModel = {
  id: 'B',
  resolve50_50(r: CRCounter): CRTransition[] {
    const winRate = WIN_RATE_BY_COUNTER[r];
    const winResult = r === 3 ? 'win_capturing_radiance' : 'win_normal';
    const transitions: CRTransition[] = [];
    if (winRate > 0) transitions.push({ probability: winRate, result: winResult, nextR: 0 });
    const lossRate = 1 - winRate;
    if (lossRate > 0) {
      const nextR = (Math.min(r + 1, 3) as CRCounter);
      transitions.push({ probability: lossRate, result: 'loss', nextR });
    }
    return transitions;
  },
};

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

export const CR_MODELS: Record<'A' | 'B', CRModel> = { A: hypothesisA, B: hypothesisB };

export const DEFAULT_CR_PARAMS: CRParams = { r2TotalWinRate: 0.55 };
