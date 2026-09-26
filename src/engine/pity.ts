/** Probability of a 5-star on the character banner's n-th pull since the last 5-star (n is 1-indexed). */
export function char5Rate(n: number): number {
  if (n <= 73) return 0.006;
  if (n <= 89) return 0.006 + 0.06 * (n - 73);
  return 1;
}

/**
 * Probability of a 5-star on the weapon banner's n-th pull since the last 5-star (n is 1-indexed).
 * +7% per pull from pull 63, reaching certainty at pull 77 — GGanalysis's PITY_W5STAR. The in-game
 * description says hard pity is 80, but the measured rate is already 100% by 77.
 */
export function weapon5Rate(n: number): number {
  if (n <= 62) return 0.007;
  if (n <= 76) return 0.007 + 0.07 * (n - 62);
  return 1;
}

/** Probability of a 4-star on the character banner's n-th pull since the last 4-star (1-indexed). */
export function char4Rate(n: number): number {
  if (n <= 8) return 0.051;
  if (n === 9) return 0.561;
  return 1;
}

/**
 * Probability of a 4-star on the weapon banner's n-th pull since the last 4-star (1-indexed).
 * Official base rate 6.0% (vs the character banner's 5.1%), soft pity from pull 8 — curve from
 * GGanalysis's PITY_W4STAR, ~14.9% consolidated vs the official 14.5%.
 */
export function weapon4Rate(n: number): number {
  if (n <= 7) return 0.06;
  if (n === 8) return 0.66;
  return 1;
}
