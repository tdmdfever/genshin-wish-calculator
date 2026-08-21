import { char4Rate, weapon5Rate } from './pity';
import type { PullOutcome, Transition, WeaponBannerConfig, WeaponBannerState } from './types';

/**
 * Exhaustive, deterministic list of (probability, outcome, nextState) branches for a
 * single pull on the weapon banner, given the current state. Mirrors
 * transitionCharacterBanner as the single source of truth for weapon banner mechanics
 * (no Capturing Radiance here — that mechanic is character-banner-only).
 *
 * The 5-star branch combines TWO genuinely independent mechanics — confirmed
 * against real Genshin mechanics (75/25 pity + Epitomized Path Fate Points are
 * documented as separate systems) and the user's own detailed correction on
 * exactly how they interact, 2026-08-19:
 * - `guaranteed5` (this banner's own 75/25 pity, parallel to the character
 *   banner's 50/50 `guaranteed5`): after a standard (non-event) 5-star, the
 *   NEXT 5-star is guaranteed to be one of the 2 event weapons. On its own
 *   (fatePoints=0) this is a 50/50 between them, not a guarantee of a SPECIFIC
 *   one. Carries across weapon-banner phases — it's a pity mechanic, not tied
 *   to a phase's Epitomized Path selection.
 * - `fatePoints` (Epitomized Path): earned by getting a 5-star weapon that
 *   ISN'T your chosen one — either the other event weapon OR a standard one.
 *   Once 1, it FULLY OVERRIDES the next 5-star to be 100% your chosen weapon,
 *   regardless of `guaranteed5`'s value (a fate point subsumes the 75/25
 *   guarantee entirely, it doesn't merely act within it). This is why a
 *   standard pull's effect on `guaranteed5` is invisible within the SAME
 *   phase (the fate point it also grants already forces 100% chosen next) but
 *   becomes observable across a phase boundary: `fatePoints` resets to 0 for
 *   a new phase (see exactEngine.ts/simulate.ts) while `guaranteed5` carries
 *   over, so the new phase's first 5-star is a 50/50 between ITS OWN
 *   chosen/other identities, not a specific guarantee.
 * - Both flags are consumed (reset false/0) the moment any 5-star lands,
 *   whichever branch decided the outcome — a guarantee only ever covers "the
 *   very next 5-star pull".
 */
export function transitionWeaponBanner(
  state: WeaponBannerState,
  config: WeaponBannerConfig,
): Transition<WeaponBannerState>[] {
  const p5 = weapon5Rate(state.pity5 + 1);
  const p4 = char4Rate(state.pity4 + 1);

  const transitions: Transition<WeaponBannerState>[] = [];

  // 5-star branch.
  if (p5 > 0) {
    // See characterBanner.ts: capping at 9 is lossless since char4Rate is flat
    // beyond it, and keeps the exact-DP state space bounded.
    const pity4After = Math.min(state.pity4 + 1, 9);
    const base = { pity4: pity4After, guaranteed4: state.guaranteed4 };
    if (state.fatePoints === 1) {
      transitions.push({
        probability: p5,
        outcome: { rarity: 5, kind: 'featured', itemId: config.chosenWeaponId },
        nextState: { ...base, pity5: 0, guaranteed5: false, fatePoints: 0 },
      });
    } else if (state.guaranteed5) {
      transitions.push({
        probability: p5 * 0.5,
        outcome: { rarity: 5, kind: 'featured', itemId: config.chosenWeaponId },
        nextState: { ...base, pity5: 0, guaranteed5: false, fatePoints: 0 },
      });
      transitions.push({
        probability: p5 * 0.5,
        outcome: { rarity: 5, kind: 'featured_other', itemId: config.otherFeaturedWeaponId },
        nextState: { ...base, pity5: 0, guaranteed5: false, fatePoints: 1 },
      });
    } else {
      transitions.push({
        probability: p5 * 0.375,
        outcome: { rarity: 5, kind: 'featured', itemId: config.chosenWeaponId },
        nextState: { ...base, pity5: 0, guaranteed5: false, fatePoints: 0 },
      });
      transitions.push({
        probability: p5 * 0.375,
        outcome: { rarity: 5, kind: 'featured_other', itemId: config.otherFeaturedWeaponId },
        nextState: { ...base, pity5: 0, guaranteed5: false, fatePoints: 1 },
      });
      transitions.push({
        probability: p5 * 0.25,
        outcome: { rarity: 5, kind: 'standard' },
        nextState: { ...base, pity5: 0, guaranteed5: true, fatePoints: 1 },
      });
    }
  }

  // 4-star branch (only reached if this pull isn't a 5-star).
  const p4Remaining = (1 - p5) * p4;
  if (p4Remaining > 0) {
    const pity5After = state.pity5 + 1;
    if (state.guaranteed4) {
      const n = config.featured4WeaponIds.length;
      const each = p4Remaining / n;
      for (const itemId of config.featured4WeaponIds) {
        transitions.push({
          probability: each,
          outcome: { rarity: 4, kind: 'featured', itemId },
          nextState: { pity5: pity5After, guaranteed5: state.guaranteed5, fatePoints: state.fatePoints, pity4: 0, guaranteed4: false },
        });
      }
    } else {
      // Unlike the character banner's 50/50, the weapon banner's 4-star rate-up
      // pool captures 75% of 4-star pulls (25% standard) — confirmed against an
      // independent implementation (HuTaoSite's gachacalc.tsx).
      const winProb = p4Remaining * 0.75;
      const lossProb = p4Remaining * 0.25;
      const n = config.featured4WeaponIds.length;
      const each = winProb / n;
      for (const itemId of config.featured4WeaponIds) {
        transitions.push({
          probability: each,
          outcome: { rarity: 4, kind: 'featured', itemId },
          nextState: { pity5: pity5After, guaranteed5: state.guaranteed5, fatePoints: state.fatePoints, pity4: 0, guaranteed4: false },
        });
      }
      transitions.push({
        probability: lossProb,
        outcome: { rarity: 4, kind: 'standard' },
        nextState: { pity5: pity5After, guaranteed5: state.guaranteed5, fatePoints: state.fatePoints, pity4: 0, guaranteed4: true },
      });
    }
  }

  // 3-star / nothing branch.
  const p3 = (1 - p5) * (1 - p4);
  if (p3 > 0) {
    transitions.push({
      probability: p3,
      outcome: { rarity: 3 } as PullOutcome,
      nextState: { pity5: state.pity5 + 1, guaranteed5: state.guaranteed5, fatePoints: state.fatePoints, pity4: Math.min(state.pity4 + 1, 9), guaranteed4: state.guaranteed4 },
    });
  }

  return transitions;
}
