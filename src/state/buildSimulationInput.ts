import type { SimulationInput } from '../engine/types';
import type { AppState } from './AppStateContext';
import { withDisplayNames } from './goalDisplay';

/**
 * Forwards app state to the engine. Banner configs (featured 4★ pools, Epitomized Path identities)
 * aren't built here: the engine derives them per phase from the goal list (phases.ts's
 * compute*BannerConfigForPhase).
 */
export function buildSimulationInput(state: AppState): SimulationInput {
  return {
    pullBudget: state.pullBudget,
    characterBanner: { state: state.characterBanner.state, featured5StarId: state.characterBanner.config.featured5StarId },
    weaponBanner: { state: state.weaponBanner.state },
    crModelId: state.crModelId,
    crParams: state.crParams,
    // display names ("Xingqiu (C2)") so every label the engine builds carries the level
    goals: withDisplayNames(state.goals),
  };
}
