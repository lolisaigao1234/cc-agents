// Small, deterministic statistics helpers. Pure.

/**
 * Seeded PRNG (mulberry32): the same seed gives the same sequence, so splits
 * and bootstrap intervals are reproducible run to run.
 *
 * @param {number} seed
 */
export function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** @param {readonly number[]} xs */
export function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}

/** @param {readonly number[]} xs */
export function stdev(xs) {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1))
}

/**
 * Percentile bootstrap confidence interval for the mean.
 *
 * @param {readonly number[]} xs
 * @param {{ seed: number, iterations?: number, alpha?: number }} opts
 */
export function bootstrapCI(xs, opts) {
  if (!xs.length) return { mean: 0, lo: 0, hi: 0 }
  const rand = mulberry32(opts.seed)
  const n = xs.length
  const iterations = opts.iterations ?? 2000
  const alpha = opts.alpha ?? 0.05
  /** @type {number[]} */
  const means = []
  for (let i = 0; i < iterations; i++) {
    let s = 0
    for (let j = 0; j < n; j++) s += xs[Math.floor(rand() * n)] ?? 0
    means.push(s / n)
  }
  means.sort((a, b) => a - b)
  const at = (/** @type {number} */ q) => means[Math.min(iterations - 1, Math.max(0, Math.floor(q * iterations)))] ?? 0
  return { mean: mean(xs), lo: at(alpha / 2), hi: at(1 - alpha / 2) }
}
