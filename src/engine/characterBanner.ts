import { char4Rate, char5Rate } from './pity';
import type {
  CharacterBannerConfig,
  CharacterBannerState,
  CRModel,
  CRParams,
  PullOutcome,
  Transition,
} from './types';

/**
 * Exhaustive, deterministic list of (probability, outcome, nextState) branches for a
 * single pull on the character banner, given the current state. Used both by the
 * exact-DP verification harness (probability propagation) and the Monte Carlo engine
 * (sampling). This is the single source of truth for character banner mechanics.
 */
export function transitionCharacterBanner(
  state: CharacterBannerState,
  config: CharacterBannerConfig,
  crModel: CRModel,
  crParams: CRParams,
): Transition<CharacterBannerState>[] {
  const p5 = char5Rate(state.pity5 + 1);
  const p4 = char4Rate(state.pity4 + 1);

  const transitions: Transition<CharacterBannerState>[] = [];

  // 5-star branch.
  if (p5 > 0) {
    // char4Rate is flat (=1) for any pity4 >= 9, so capping the stored value there
    // is lossless — it never changes a future rate lookup — and keeps the state
    // space bounded for the exact-DP engine instead of growing unboundedly across
    // runs of consecutive 5-stars.
    const pity4After = Math.min(state.pity4 + 1, 9); // no 4-star this pull
    if (state.guaranteed5) {
      const outcome: PullOutcome = { rarity: 5, kind: 'featured', itemId: config.featured5StarId };
      transitions.push({
        probability: p5,
        outcome,
        nextState: { pity5: 0, guaranteed5: false, crCounter: state.crCounter, pity4: pity4After, guaranteed4: state.guaranteed4 },
      });
    } else {
      for (const t of crModel.resolve50_50(state.crCounter, crParams)) {
        const branchProb = p5 * t.probability;
        if (branchProb <= 0) continue;
        const isWin = t.result !== 'loss';
        const outcome: PullOutcome = isWin
          ? { rarity: 5, kind: 'featured', itemId: config.featured5StarId }
          : { rarity: 5, kind: 'standard' };
        transitions.push({
          probability: branchProb,
          outcome,
          nextState: {
            pity5: 0,
            guaranteed5: !isWin,
            crCounter: t.nextR,
            pity4: pity4After,
            guaranteed4: state.guaranteed4,
          },
        });
      }
    }
  }

  // 4-star branch (only reached if this pull isn't a 5-star).
  const p4Remaining = (1 - p5) * p4;
  if (p4Remaining > 0) {
    const pity5After = state.pity5 + 1; // no 5-star this pull
    if (state.guaranteed4) {
      const n = config.featured4StarIds.length;
      const each = p4Remaining / n;
      for (const itemId of config.featured4StarIds) {
        transitions.push({
          probability: each,
          outcome: { rarity: 4, kind: 'featured', itemId },
          nextState: { pity5: pity5After, guaranteed5: state.guaranteed5, crCounter: state.crCounter, pity4: 0, guaranteed4: false },
        });
      }
    } else {
      const winProb = p4Remaining * 0.5;
      const lossProb = p4Remaining * 0.5;
      const n = config.featured4StarIds.length;
      const each = winProb / n;
      for (const itemId of config.featured4StarIds) {
        transitions.push({
          probability: each,
          outcome: { rarity: 4, kind: 'featured', itemId },
          nextState: { pity5: pity5After, guaranteed5: state.guaranteed5, crCounter: state.crCounter, pity4: 0, guaranteed4: false },
        });
      }
      transitions.push({
        probability: lossProb,
        outcome: { rarity: 4, kind: 'standard' },
        nextState: { pity5: pity5After, guaranteed5: state.guaranteed5, crCounter: state.crCounter, pity4: 0, guaranteed4: true },
      });
    }
  }

  // 3-star / nothing branch.
  const p3 = (1 - p5) * (1 - p4);
  if (p3 > 0) {
    transitions.push({
      probability: p3,
      outcome: { rarity: 3 },
      nextState: {
        pity5: state.pity5 + 1,
        guaranteed5: state.guaranteed5,
        crCounter: state.crCounter,
        pity4: Math.min(state.pity4 + 1, 9),
        guaranteed4: state.guaranteed4,
      },
    });
  }

  return transitions;
}
