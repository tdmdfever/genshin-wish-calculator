import type { CRCounter, CharacterBannerState, WeaponBannerState } from './types';

/**
 * Fixed-size integer encoders for banner states, used by the exact-DP engines to key
 * a Map<number, probability>. pity4 is capped at 9 by the transition functions
 * (characterBanner.ts / weaponBanner.ts) since the 4-star rate is flat beyond that —
 * so unlike pity5 (which needs no cap, it's naturally bounded by hard pity), pity4's
 * bound here is exact, not an approximation, and the codec can use a fixed modulus.
 */

const CHAR_G5 = 2;
const CHAR_CR = 4;
const CHAR_P4 = 10;
const CHAR_G4 = 2;
/** pity5 is 0-89 (hard pity at 90 forces a win, resetting to 0) — the one digit
 * with no fixed per-encode modulus above, since it's the encoding's outermost
 * (highest-order) digit. Exported so callers that need the FULL banner
 * state-space size (e.g. to size a dense array indexed by encoded state) have a
 * single source of truth instead of re-deriving/hardcoding it. */
const CHAR_PITY5_VALUES = 90;
export const CHAR_BANNER_MODULUS = CHAR_PITY5_VALUES * CHAR_G5 * CHAR_CR * CHAR_P4 * CHAR_G4;

export function encodeCharState(s: CharacterBannerState): number {
  return (((s.pity5 * CHAR_G5 + (s.guaranteed5 ? 1 : 0)) * CHAR_CR + s.crCounter) * CHAR_P4 + s.pity4) * CHAR_G4 + (s.guaranteed4 ? 1 : 0);
}

export function decodeCharState(codeIn: number): CharacterBannerState {
  let code = codeIn;
  const guaranteed4 = code % CHAR_G4 === 1;
  code = Math.floor(code / CHAR_G4);
  const pity4 = code % CHAR_P4;
  code = Math.floor(code / CHAR_P4);
  const crCounter = (code % CHAR_CR) as CRCounter;
  code = Math.floor(code / CHAR_CR);
  const guaranteed5 = code % CHAR_G5 === 1;
  code = Math.floor(code / CHAR_G5);
  const pity5 = code;
  return { pity5, guaranteed5, crCounter, pity4, guaranteed4 };
}

const WEAPON_G5 = 2;
const WEAPON_FP = 2;
const WEAPON_P4 = 10;
const WEAPON_G4 = 2;
/** pity5 is 0-79 (hard pity at 80) — see CHAR_BANNER_MODULUS's comment above. */
const WEAPON_PITY5_VALUES = 80;
export const WEAPON_BANNER_MODULUS = WEAPON_PITY5_VALUES * WEAPON_G5 * WEAPON_FP * WEAPON_P4 * WEAPON_G4;

export function encodeWeaponState(s: WeaponBannerState): number {
  return (((s.pity5 * WEAPON_G5 + (s.guaranteed5 ? 1 : 0)) * WEAPON_FP + s.fatePoints) * WEAPON_P4 + s.pity4) * WEAPON_G4 + (s.guaranteed4 ? 1 : 0);
}

export function decodeWeaponState(codeIn: number): WeaponBannerState {
  let code = codeIn;
  const guaranteed4 = code % WEAPON_G4 === 1;
  code = Math.floor(code / WEAPON_G4);
  const pity4 = code % WEAPON_P4;
  code = Math.floor(code / WEAPON_P4);
  const fatePoints = (code % WEAPON_FP) as 0 | 1;
  code = Math.floor(code / WEAPON_FP);
  const guaranteed5 = code % WEAPON_G5 === 1;
  code = Math.floor(code / WEAPON_G5);
  const pity5 = code;
  return { pity5, guaranteed5, fatePoints, pity4, guaranteed4 };
}
