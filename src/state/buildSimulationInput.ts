import type { SimulationInput } from '../engine/types';
import type { AppState } from './AppStateContext';

/**
 * The featured-pool/Epitomized-Path config used to be derived HERE, once,
 * globally, from the whole goal list — but that caused real bugs (see CLAUDE.md):
 * a later phase's own weapon could never benefit from a Fate Point guarantee, and
 * naming 4+ named 4-stars across different phases silently diluted every phase's
 * split fraction. That derivation now happens PER PHASE, inside the engine (see
 * phases.ts's computeCharacterBannerConfigForPhase/computeWeaponBannerConfigForPhase),
 * so this function only needs to forward state and goals — the goal list itself is
 * all the engine needs to derive each phase's own config.
 */
export function buildSimulationInput(state: AppState): SimulationInput {
  return {
    pullBudget: state.pullBudget,
    characterBanner: { state: state.characterBanner.state, featured5StarId: state.characterBanner.config.featured5StarId },
    weaponBanner: { state: state.weaponBanner.state },
    crModelId: state.crModelId,
    crParams: state.crParams,
    goals: state.goals,
    trialCount: state.trialCount,
    seed: state.seed,
  };
}
