// Running the repository's own checks (tests, build, lint, types) and
// comparing two runs for regressions.

import { spawn } from 'node:child_process'
import { createWriteStream, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * @typedef {{ passed: number, failed: number, skipped: number }} TestCounts
 * @typedef {{ name: string, cmd: string, required?: boolean, timeoutSec?: number }} CheckSpec
 * @typedef {{
 *   name: string, ok: boolean, required: boolean, exitCode: number | null, timedOut: boolean,
 *   durationMs: number, tail: string, logFile: string, counts: TestCounts | null, flaky?: boolean,
 * }} CheckResult
 * @typedef {{ label: string, startedAt?: string, results: CheckResult[] }} CheckRun
 */

/** @param {RegExpMatchArray | null | undefined} m @param {number} i */
const num = (m, i) => (m && m[i] !== undefined ? Number(m[i]) : 0)

/**
 * Best-effort test counts from a runner's output; null when the format is
 * not recognised. Used to notice tests silently disappearing.
 *
 * @param {string} out
 * @returns {TestCounts | null}
 */
export function parseTestCounts(out) {
  const jest = /^Tests:\s+(.*\d+ total)\s*$/m.exec(out)
  if (jest && jest[1]) {
    const s = jest[1]
    return {
      passed: num(/(\d+) passed/.exec(s), 1),
      failed: num(/(\d+) failed/.exec(s), 1),
      skipped: num(/(\d+) skipped/.exec(s), 1) + num(/(\d+) todo/.exec(s), 1),
    }
  }
  const vitest = /^\s*Tests\s+(.+?)\s*\(\d+\)\s*$/m.exec(out)
  if (vitest && vitest[1]) {
    const s = vitest[1]
    return {
      passed: num(/(\d+) passed/.exec(s), 1),
      failed: num(/(\d+) failed/.exec(s), 1),
      skipped: num(/(\d+) skipped/.exec(s), 1) + num(/(\d+) todo/.exec(s), 1),
    }
  }
  const pytest = /^=+ (.*\b(?:passed|failed|error|errors|skipped)\b.*) in [\d.]+s(?: \([^)]*\))? =+\s*$/m.exec(out)
  if (pytest && pytest[1]) {
    const s = pytest[1]
    return {
      passed: num(/(\d+) passed/.exec(s), 1),
      failed: num(/(\d+) failed/.exec(s), 1) + num(/(\d+) errors?/.exec(s), 1),
      skipped: num(/(\d+) skipped/.exec(s), 1) + num(/(\d+) xfailed/.exec(s), 1),
    }
  }
  const node = /^(?:ℹ|#) pass (\d+)\s*$/m.exec(out)
  if (node) {
    return {
      passed: num(node, 1),
      failed: num(/^(?:ℹ|#) fail (\d+)\s*$/m.exec(out), 1),
      skipped: num(/^(?:ℹ|#) skip(?:ped)? (\d+)\s*$/m.exec(out), 1),
    }
  }
  const cargo = [...out.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored/g)]
  if (cargo.length) {
    return cargo.reduce(
      (acc, m) => ({ passed: acc.passed + num(m, 1), failed: acc.failed + num(m, 2), skipped: acc.skipped + num(m, 3) }),
      { passed: 0, failed: 0, skipped: 0 },
    )
  }
  const mocha = /^\s*(\d+) passing\b/m.exec(out)
  if (mocha) {
    return {
      passed: num(mocha, 1),
      failed: num(/^\s*(\d+) failing\b/m.exec(out), 1),
      skipped: num(/^\s*(\d+) pending\b/m.exec(out), 1),
    }
  }
  const go = [...out.matchAll(/^\s*--- (PASS|FAIL|SKIP):/gm)]
  if (go.length) {
    return {
      passed: go.filter(m => m[1] === 'PASS').length,
      failed: go.filter(m => m[1] === 'FAIL').length,
      skipped: go.filter(m => m[1] === 'SKIP').length,
    }
  }
  return null
}

/**
 * @param {CheckRun} before
 * @param {CheckRun} after
 */
export function compareRuns(before, after) {
  const prev = new Map(before.results.map(r => [r.name, r]))
  /** @type {string[]} */ const newlyFailing = []
  /** @type {string[]} */ const newlyFailingRequired = []
  /** @type {string[]} */ const fixed = []
  /** @type {string[]} */ const stillFailing = []
  /** @type {{ name: string, before: number, after: number }[]} */ const testCountDrops = []
  for (const r of after.results) {
    const p = prev.get(r.name)
    if (!r.ok && (!p || p.ok)) {
      newlyFailing.push(r.name)
      if (r.required) newlyFailingRequired.push(r.name)
    } else if (!r.ok) {
      stillFailing.push(r.name)
    } else if (p && !p.ok) {
      fixed.push(r.name)
    }
    if (p?.counts && r.counts && r.counts.passed < p.counts.passed) {
      testCountDrops.push({ name: r.name, before: p.counts.passed, after: r.counts.passed })
    }
  }
  return { newlyFailing, newlyFailingRequired, fixed, stillFailing, testCountDrops }
}

const TAIL_LINES = 40
const KEEP_BYTES = 256 * 1024

/**
 * Runs one check through the shell, streaming its output to a log file and
 * keeping the tail. A check that outlives its timeout is killed with its
 * whole process group.
 *
 * @param {CheckSpec} spec
 * @param {{ cwd: string, logDir: string }} opts
 * @returns {Promise<CheckResult>}
 */
export function runCheck(spec, opts) {
  mkdirSync(opts.logDir, { recursive: true })
  const logFile = join(opts.logDir, `${spec.name.replace(/[^\w.-]+/g, '_')}.log`)
  const log = createWriteStream(logFile)
  const started = Date.now()
  const timeoutMs = (spec.timeoutSec ?? 900) * 1000
  return new Promise(resolve => {
    let buf = ''
    let timedOut = false
    // NODE_TEST_CONTEXT leaks in when ql itself runs under `node --test`, and
    // makes a nested `node --test` report to the outer runner and exit 0.
    const { NODE_TEST_CONTEXT: _, ...env } = process.env
    const child = spawn('sh', ['-c', spec.cmd], {
      cwd: opts.cwd,
      env: { ...env, CI: env.CI ?? '1', FORCE_COLOR: '0', NO_COLOR: '1' },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    /** @param {Buffer} chunk */
    const onData = chunk => {
      log.write(chunk)
      buf += chunk.toString('utf8')
      if (buf.length > KEEP_BYTES) buf = buf.slice(-KEEP_BYTES)
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    const timer = setTimeout(() => {
      timedOut = true
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }, timeoutMs)
    /** @param {number | null} code */
    const finish = code => {
      clearTimeout(timer)
      log.end()
      // Strip ANSI so tails and count parsing read plain text.
      const plain = buf.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
      resolve({
        name: spec.name,
        ok: code === 0 && !timedOut,
        required: spec.required !== false,
        exitCode: code,
        timedOut,
        durationMs: Date.now() - started,
        tail: plain.split('\n').slice(-TAIL_LINES).join('\n'),
        logFile,
        counts: parseTestCounts(plain),
      })
    }
    child.on('error', err => {
      buf += `\n[quality-loop] failed to start: ${err.message}\n`
      finish(127)
    })
    child.on('close', code => finish(code))
  })
}

/**
 * Runs checks one after another (they often share build output).
 *
 * @param {CheckSpec[]} specs
 * @param {{ cwd: string, logDir: string, label: string }} opts
 * @returns {Promise<CheckRun>}
 */
export async function runChecks(specs, opts) {
  const results = []
  for (const spec of specs) results.push(await runCheck(spec, opts))
  return { label: opts.label, startedAt: new Date().toISOString(), results }
}
