// Per-repository configuration: `.quality-loop/config.json`, merged over
// defaults, with the checks detected from the repository's own tooling.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { MAX_WINDOW, MIN_WINDOW } from './compact.mjs'

/** @typedef {import('./checks.mjs').CheckSpec} CheckSpec */

export const LENSES = {
  correctness: 'Logic errors: wrong conditions, off-by-one, wrong variable, broken invariants, incorrect algorithm, bad state transitions.',
  security: 'Injection, authn/authz gaps, secrets, unsafe deserialization, path traversal, SSRF, missing validation at trust boundaries.',
  'regressions-and-edge-cases':
    'Behaviour the change breaks for existing callers; empty/null/huge/unicode/concurrent inputs; boundary values; removed handling.',
  conventions: "Violations of this repository's CLAUDE.md / REVIEW.md rules that cause real defects (not style), and stale instructions.",
  'concurrency-and-resources': 'Races, missing awaits, deadlocks, leaks of handles/memory/listeners, unbounded growth, retries without backoff.',
  'errors-and-contracts': 'Swallowed errors, wrong error types, API/schema contract drift, mismatched types across boundaries, missing migrations.',
}

/** @type {Record<'quick' | 'standard' | 'deep', { lenses: string[], verifiers: number, quorum: number }>} */
export const DEPTHS = {
  quick: { lenses: ['correctness', 'regressions-and-edge-cases'], verifiers: 1, quorum: 1 },
  standard: { lenses: ['correctness', 'security', 'regressions-and-edge-cases', 'conventions'], verifiers: 3, quorum: 2 },
  deep: { lenses: Object.keys(LENSES), verifiers: 5, quorum: 3 },
}

export const DEFAULTS = {
  version: 1,
  baseRef: 'auto',
  /** @type {CheckSpec[]} */
  checks: [],
  review: {
    depth: /** @type {'quick' | 'standard' | 'deep'} */ ('standard'),
    /** @type {string[] | null} null: the depth's lenses */
    lenses: null,
    /** @type {Record<string, string>} focus text for lenses beyond the built-in ones */
    customLenses: {},
    /** @type {number | null} */
    verifiers: null,
    /** @type {number | null} */
    quorum: null,
    dropCategories: ['style', 'formatting', 'naming', 'typo'],
    maxNitsPerRound: 3,
    skipPaths: [
      '**/*.lock',
      '**/package-lock.json',
      '**/pnpm-lock.yaml',
      '**/node_modules/**',
      '**/vendor/**',
      '**/dist/**',
      '**/build/**',
      '**/*.min.js',
      '**/*.snap',
      '**/__generated__/**',
    ],
    fixPreExisting: false,
  },
  loop: {
    maxRounds: 3,
    stallRounds: 2,
    maxAttemptsPerFinding: 2,
    diffOnlyAfterRound: 1,
    maxStopNudges: 8,
    retryFailedChecks: 1,
    // Tokens of context at which a session compacts (null: no cap). See compact.mjs.
    maxContextTokens: 300000,
  },
  guard: {
    blockDestructive: true,
    protectedPaths: ['.quality-loop/config.json', '.quality-loop/state.json'],
  },
  eval: {
    tolerance: 5,
    repeats: 3,
    testFraction: 0.3,
    seed: 1729,
    minDelta: 0.05,
    timeoutSec: 1800,
    concurrency: 2,
    runner: '',
  },
}

/** @typedef {typeof DEFAULTS} Config */

/**
 * The focus line a bug hunter gets for a lens.
 *
 * @param {string} name
 * @param {Record<string, string>} [custom]
 */
export function lensFocus(name, custom = {}) {
  return custom[name] ?? /** @type {Record<string, string>} */ (LENSES)[name] ?? `Defects related to ${name}.`
}

/**
 * @param {any} base
 * @param {any} over
 * @returns {any}
 */
function merge(base, over) {
  if (Array.isArray(base) || Array.isArray(over)) return over ?? base
  if (base && typeof base === 'object' && over && typeof over === 'object') {
    /** @type {Record<string, any>} */
    const out = { ...base }
    for (const k of Object.keys(over)) out[k] = merge(base[k], over[k])
    return out
  }
  return over === undefined ? base : over
}

/**
 * The effective configuration: file over defaults, with the depth preset
 * filling lenses and voting unless set explicitly.
 *
 * @param {any} fileConfig
 * @returns {Config & { review: { lenses: string[], verifiers: number, quorum: number } }}
 */
export function resolveConfig(fileConfig) {
  // A copy: the merge shares DEFAULTS' nested objects, and a loop's config is
  // changed in place (a review-only start sets loop.maxRounds).
  const c = structuredClone(merge(DEFAULTS, fileConfig ?? {}))
  const preset = DEPTHS[/** @type {'quick'} */ (c.review.depth)] ?? DEPTHS.standard
  c.review.lenses = c.review.lenses ?? preset.lenses
  c.review.verifiers = c.review.verifiers ?? preset.verifiers
  c.review.quorum = Math.min(c.review.quorum ?? preset.quorum, c.review.verifiers)
  return c
}

/**
 * @param {any} c
 * @returns {string[]}
 */
export function validateConfig(c) {
  const errors = []
  if (!Array.isArray(c.checks)) errors.push('checks must be an array')
  else {
    c.checks.forEach((/** @type {any} */ k, /** @type {number} */ i) => {
      if (!k || typeof k.name !== 'string' || !k.name) errors.push(`checks[${i}].name is required`)
      if (!k || typeof k.cmd !== 'string' || !k.cmd) errors.push(`checks[${i}].cmd is required`)
    })
    const names = c.checks.map((/** @type {any} */ k) => k?.name)
    if (new Set(names).size !== names.length) errors.push('check names must be unique')
  }
  if (!(c.review?.quorum >= 1)) errors.push('review.quorum must be >= 1')
  if (!(c.review?.verifiers >= c.review?.quorum)) errors.push('review.verifiers must be >= review.quorum')
  if (!(c.loop?.maxRounds >= 1)) errors.push('loop.maxRounds must be >= 1')
  if (!(c.loop?.stallRounds >= 1)) errors.push('loop.stallRounds must be >= 1')
  if (!(Number.isInteger(c.loop?.maxStopNudges) && c.loop.maxStopNudges >= 0)) errors.push('loop.maxStopNudges must be a whole number >= 0')
  const cap = c.loop?.maxContextTokens
  if (cap !== null && !(Number.isInteger(cap) && cap >= MIN_WINDOW && cap <= MAX_WINDOW)) {
    errors.push(`loop.maxContextTokens must be an integer from ${MIN_WINDOW} to ${MAX_WINDOW}, or null`)
  }
  /** @type {Map<string, string>} */ const files = new Map()
  for (const lens of c.review?.lenses ?? []) {
    if (typeof lens !== 'string') {
      errors.push('review.lenses must be strings')
      continue
    }
    // A lens's brief and output files are named after it, and a file system
    // may ignore case.
    const key = slug(lens).toLowerCase()
    const other = files.get(key)
    if (other !== undefined) errors.push(`review.lenses "${other}" and "${lens}" share the file name "${slug(lens)}": rename one`)
    else files.set(key, lens)
  }
  return errors
}

/** The file-name form of a lens, finding id or bug class. @param {string} s */
export const slug = s => s.replace(/[^\w.-]+/g, '_').slice(0, 80) || '_'

/** @param {string} p */
function readText(p) {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

/**
 * Detects the repository's checks from its own tooling. Only what is
 * already configured is used: nothing is installed.
 *
 * @param {string} root
 * @returns {CheckSpec[]}
 */
export function detectChecks(root) {
  /** @type {CheckSpec[]} */
  const checks = []
  const has = (/** @type {string} */ f) => existsSync(join(root, f))
  const add = (/** @type {string} */ name, /** @type {string} */ cmd, required = true) => {
    if (!checks.some(c => c.name === name)) checks.push({ name, cmd, required })
  }

  const pkgText = readText(join(root, 'package.json'))
  if (pkgText) {
    /** @type {Record<string, string>} */
    let scripts = {}
    try {
      scripts = JSON.parse(pkgText).scripts ?? {}
    } catch {
      // unreadable package.json: fall through to other ecosystems
    }
    const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : 'npm'
    const run = (/** @type {string} */ s) => (pm === 'npm' ? `npm run -s ${s}` : `${pm} run ${s}`)
    for (const s of ['typecheck', 'type-check', 'check-types', 'tsc']) {
      if (scripts[s]) {
        add('typecheck', run(s))
        break
      }
    }
    if (scripts.lint) add('lint', run('lint'))
    if (scripts.build) add('build', run('build'))
    if (scripts.test && !/no test specified/.test(scripts.test)) add('test', pm === 'npm' ? 'npm test --silent' : `${pm} test`)
  }

  const pyproject = readText(join(root, 'pyproject.toml')) ?? ''
  const isPython = pyproject || has('setup.py') || has('setup.cfg') || has('requirements.txt')
  if (isPython) {
    if (/\[tool\.ruff/.test(pyproject) || has('ruff.toml') || has('.ruff.toml')) add('lint', 'ruff check .')
    if (/\[tool\.mypy/.test(pyproject) || has('mypy.ini')) add('typecheck', 'mypy .')
    if (/\[tool\.pytest/.test(pyproject) || has('pytest.ini') || has('tests') || has('test') || has('conftest.py')) {
      add('test', 'python -m pytest -q')
    }
  }
  if (has('go.mod')) {
    add('build', 'go build ./...')
    add('lint', 'go vet ./...')
    add('test', 'go test ./...')
  }
  if (has('Cargo.toml')) {
    add('build', 'cargo build --all-targets')
    add('test', 'cargo test')
  }
  if (has('pom.xml')) add('test', 'mvn -q test')
  else if (has('gradlew')) add('test', './gradlew test')
  if (has('mix.exs')) add('test', 'mix test')
  if (has('Gemfile') && has('Rakefile')) add('test', 'bundle exec rake test')

  const makefile = readText(join(root, 'Makefile'))
  if (makefile) {
    for (const t of ['lint', 'typecheck', 'test']) {
      if (new RegExp(`^${t}:`, 'm').test(makefile)) add(t, `make ${t}`)
    }
  }
  return checks
}
