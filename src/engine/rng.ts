/** Seedable PRNG (mulberry32) returning floats in [0, 1). Deterministic given a seed. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Given a list of items each with a `.probability`, draw one item according to those
 * probabilities using a single uniform sample `u` in [0, 1). Probabilities are assumed
 * to sum to ~1 (small floating point slack is tolerated by clamping to the last item).
 */
export function sampleFromDistribution<T extends { probability: number }>(items: T[], u: number): T {
  let cumulative = 0;
  for (const item of items) {
    cumulative += item.probability;
    if (u < cumulative) return item;
  }
  return items[items.length - 1];
}
