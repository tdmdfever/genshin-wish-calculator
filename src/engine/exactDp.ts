import { transitionCharacterBanner } from './characterBanner';
import { transitionWeaponBanner } from './weaponBanner';
import { decodeCharState, decodeWeaponState, encodeCharState, encodeWeaponState } from './stateCodec';
import type {
  CharacterBannerConfig,
  CharacterBannerState,
  CRModel,
  CRParams,
  PullOutcome,
  WeaponBannerConfig,
  WeaponBannerState,
} from './types';

/**
 * Exact dynamic-programming ground truth for a single banner's goal-completion CDF.
 * Used by tests to verify the Monte Carlo engine and the phase-based multi-goal
 * exact engine (exactEngine.ts) agree with an exact single-banner computation.
 */

export function exactCharacterBannerCdf(
  initialState: CharacterBannerState,
  config: CharacterBannerConfig,
  crModel: CRModel,
  crParams: CRParams,
  isSuccess: (outcome: PullOutcome) => boolean,
  maxPulls: number,
): number[] {
  const cdf = new Array(maxPulls + 1).fill(0);
  let active = new Map<number, number>([[encodeCharState(initialState), 1]]);
  let achieved = 0;

  for (let p = 1; p <= maxPulls; p++) {
    const nextActive = new Map<number, number>();
    for (const [code, prob] of active) {
      if (prob <= 0) continue;
      const state = decodeCharState(code);
      const transitions = transitionCharacterBanner(state, config, crModel, crParams);
      for (const t of transitions) {
        const branchProb = prob * t.probability;
        if (branchProb <= 0) continue;
        if (isSuccess(t.outcome)) {
          achieved += branchProb;
        } else {
          const key = encodeCharState(t.nextState);
          nextActive.set(key, (nextActive.get(key) ?? 0) + branchProb);
        }
      }
    }
    active = nextActive;
    cdf[p] = achieved;
  }
  return cdf;
}

export function exactWeaponBannerCdf(
  initialState: WeaponBannerState,
  config: WeaponBannerConfig,
  isSuccess: (outcome: PullOutcome) => boolean,
  maxPulls: number,
): number[] {
  const cdf = new Array(maxPulls + 1).fill(0);
  let active = new Map<number, number>([[encodeWeaponState(initialState), 1]]);
  let achieved = 0;

  for (let p = 1; p <= maxPulls; p++) {
    const nextActive = new Map<number, number>();
    for (const [code, prob] of active) {
      if (prob <= 0) continue;
      const state = decodeWeaponState(code);
      const transitions = transitionWeaponBanner(state, config);
      for (const t of transitions) {
        const branchProb = prob * t.probability;
        if (branchProb <= 0) continue;
        if (isSuccess(t.outcome)) {
          achieved += branchProb;
        } else {
          const key = encodeWeaponState(t.nextState);
          nextActive.set(key, (nextActive.get(key) ?? 0) + branchProb);
        }
      }
    }
    active = nextActive;
    cdf[p] = achieved;
  }
  return cdf;
}
