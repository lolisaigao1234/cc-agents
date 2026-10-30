// Helpers shared by the variant's check hooks (eval variant v1, family
// A-verify-before-review). Plain Node, no dependencies. Every helper returns
// null or false when it cannot tell, and the hooks then stay out of the way.

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** @returns {any} the hook input on stdin, or null when it is not JSON */
export function readInput() {
  try {
    const v = JSON.parse(readFileSync(0, 'utf8'))
    return v && typeof v === 'object' ? v : null
  } catch {
    return null
  }
}

/** Write the hook output, if any, and exit 0. @param {object | null} out */
export function finish(out) {
  if (out) process.stdout.write(JSON.stringify(out))
  process.exit(0)
}

/**
 * @param {string[]} args @param {string} cwd @param {number} [timeout]
 * @returns {string | null} git's trimmed stdout, or null when git did not answer
 */
export function git(args, cwd, timeout = 10_000) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 })
  return r.status === 0 && typeof r.stdout === 'string' ? r.stdout.trim() : null
}

/**
 * The traced repository at `dir`: its root, when it has `.claude/trace.json`
 * and the bypass is off. The plugin acts only in traced repositories.
 *
 * @param {unknown} dir @returns {string | null}
 */
export function tracedRepo(dir) {
  if (process.env.TRACE_BYPASS === '1' || typeof dir !== 'string' || !isAbsolute(dir) || !existsSync(dir)) return null
  const root = git(['rev-parse', '--show-toplevel'], dir)
  return root && existsSync(join(root, '.claude/trace.json')) ? root : null
}

/** @param {string} root @returns {Record<string, string>} package.json's scripts, or none */
export function scriptsOf(root) {
  try {
    const s = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts
    return s && typeof s === 'object' ? s : {}
  } catch {
    return {}
  }
}

/** @param {string} root @returns {string | null} a directory for this variant's state, inside git's own directory */
export function stateDir(root) {
  const common = git(['rev-parse', '--git-common-dir'], root)
  if (!common) return null
  const dir = join(resolve(root, common), 'trace-variant-checks')
  try {
    mkdirSync(dir, { recursive: true })
    return dir
  } catch {
    return null
  }
}

/** @param {string} file @returns {any} */
export function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** @param {string} file @param {unknown} value */
export function writeJson(file, value) {
  try {
    writeFileSync(file, JSON.stringify(value))
  } catch {
    // State is a convenience: without it the hook only repeats itself.
  }
}

/**
 * Runs one shell command, as a check.
 *
 * @param {string} command @param {string} cwd @param {number} timeout ms
 * @returns {{ ok: boolean, output: string, timedOut: boolean }}
 */
export function runCheck(command, cwd, timeout) {
  const r = spawnSync('sh', ['-c', command], {
    cwd, encoding: 'utf8', timeout: Math.max(1, Math.floor(timeout)), maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  })
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const timedOut = /** @type {NodeJS.ErrnoException | undefined} */ (r.error)?.code === 'ETIMEDOUT'
  if (r.error) return { ok: false, output: `${output}\n(${command}: ${r.error.message})`, timedOut }
  return { ok: r.status === 0, output, timedOut }
}

/** @param {string} text @param {number} lines @returns {string} the last `lines` lines of `text` */
export const tail = (text, lines) => text.trimEnd().split('\n').slice(-lines).join('\n')

/** @param {string} text @param {number} max @returns {string} */
export const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}\n… (cut)` : text)

/**
 * The lines of a failing check's output that name what failed, made
 * comparable across checkouts: no paths of the checkout, no timings, no
 * positions or counters that move when lines above them do.
 *
 * @param {string} output @param {string} dir the checkout it ran in @returns {string[]}
 */
export function failureLines(output, dir) {
  let real = dir
  try {
    real = realpathSync(dir)
  } catch {
    // The path as given is all there is to strip.
  }
  return [...new Set(output.split('\n')
    .filter(l => /\bnot ok\b|✖|✘|\berror\b|\bfail(?:s|ed|ure)?\b/i.test(l))
    // A runner's summary counts say how many, not which.
    .filter(l => !/^\s*(?:ℹ|#)?\s*(?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\s+\d/i.test(l))
    .filter(l => !/^\s*npm (?:error|ERR!)/.test(l))
    .map(l => l.split(real).join('<checkout>').split(dir).join('<checkout>')
      .replace(/\(\d+(?:\.\d+)?\s*m?s\)/g, '')
      .replace(/\b\d+(?:\.\d+)?\s*m?s\b/g, '')
      .replace(/\((\d+),(\d+)\)/g, '')
      .replace(/:\d+:\d+/g, '')
      .replace(/\bnot ok \d+/g, 'not ok')
      .replace(/\s+/g, ' ')
      .trim())
    .filter(Boolean))]
}

/**
 * @typedef {{ step: string, ok: boolean, lines: string[], tail: string }} StepResult
 * @typedef {{ sha: string, steps: StepResult[] }} Results
 */

/**
 * Runs `commandsOf(scripts)` on a clean checkout of `sha` (a detached
 * worktree with a copy of the clone's dependencies, as CI's install would
 * give it), or returns the result cached for that commit.
 *
 * @param {string} root @param {string} sha @param {string} state
 * @param {string} label names the cache @param {(scripts: Record<string, string>) => string[]} commandsOf
 * @param {number} timeout ms per command
 * @param {number} deadline epoch ms by which to give up, so the hook returns before Claude Code kills it
 * @returns {Results | null} null when it could not run them all in time
 */
export function resultsAt(root, sha, state, label, commandsOf, timeout, deadline) {
  const file = join(state, `${label}-${sha}.json`)
  const cached = readJson(file)
  if (cached && cached.sha === sha && Array.isArray(cached.steps)) return cached
  const dir = mkdtempSync(join(tmpdir(), 'trace-check-'))
  try {
    if (git(['worktree', 'add', '--detach', '--force', dir, sha], root, 60_000) === null) return null
    // A copy, not a link: a check may assert that nothing it reads lies outside the tree.
    if (existsSync(join(root, 'node_modules')) && !existsSync(join(dir, 'node_modules'))) {
      cpSync(join(root, 'node_modules'), join(dir, 'node_modules'), { recursive: true, verbatimSymlinks: true })
    }
    const steps = []
    for (const step of commandsOf(scriptsOf(dir))) {
      const left = deadline - Date.now()
      if (left < 5_000) return null
      const r = runCheck(step, dir, Math.min(timeout, left))
      // Cut short by the hook's own deadline, the check said nothing either way.
      if (r.timedOut && left < timeout) return null
      steps.push({ step, ok: r.ok, lines: r.ok ? [] : failureLines(r.output, dir), tail: r.ok ? '' : tail(r.output, 40) })
    }
    const result = { sha, steps }
    writeJson(file, result)
    return result
  } finally {
    git(['worktree', 'remove', '--force', dir], root, 60_000)
    rmSync(dir, { recursive: true, force: true })
    git(['worktree', 'prune'], root, 30_000)
  }
}

/** @param {string} root @param {string} head @returns {string | null} the commit the branch grew from */
export function baseOf(root, head) {
  const remoteHead = git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], root)
  for (const ref of [remoteHead, 'refs/remotes/origin/main', 'refs/remotes/origin/master', 'refs/heads/main', 'refs/heads/master']) {
    if (!ref || git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], root) === null) continue
    const base = git(['merge-base', head, ref], root)
    if (base) return base
  }
  return null
}

/**
 * Splits the failing steps of `now` into those red only here (with the
 * failure lines the base does not have) and those the base fails the same way.
 *
 * @param {StepResult[]} now @param {StepResult[] | undefined} atBase
 * @returns {{ red: (StepResult & { fresh: string[] })[], already: string[] }}
 */
export function compare(now, atBase) {
  const red = []
  const already = []
  for (const s of now.filter(x => !x.ok)) {
    const b = atBase?.find(x => x.step === s.step)
    const fresh = !b || b.ok ? s.lines : s.lines.filter(l => !b.lines.includes(l))
    if (b && !b.ok && !fresh.length) already.push(s.step)
    else red.push({ ...s, fresh })
  }
  return { red, already }
}
