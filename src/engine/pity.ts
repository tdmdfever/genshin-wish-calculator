/** Probability of a 5-star on the character banner's n-th pull since the last 5-star (n is 1-indexed). */
export function char5Rate(n: number): number {
  if (n <= 73) return 0.006;
  if (n <= 89) return 0.006 + 0.06 * (n - 73);
  return 1;
}

/** Probability of a 5-star on the weapon banner's n-th pull since the last 5-star (n is 1-indexed). */
export function weapon5Rate(n: number): number {
  if (n <= 62) return 0.007;
  if (n <= 79) return 0.007 + (0.993 / 18) * (n - 62);
  return 1;
}

/** Probability of a 4-star (character or weapon banner) on the n-th pull since the last 4-star (1-indexed). */
export function char4Rate(n: number): number {
  if (n <= 8) return 0.051;
  if (n === 9) return 0.561;
  return 1;
}
