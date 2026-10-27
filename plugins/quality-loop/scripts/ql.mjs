#!/usr/bin/env node
// ql: the deterministic core of the quality loop. Agents decide what is
// wrong and how to fix it; ql decides what counts (evidence, votes,
// regressions, convergence) and keeps the state on disk.

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runChecks } from './lib/checks.mjs'
import { ensureCompactWindow } from './lib/compact.mjs'
import { decideHillclimb, leakCheck } from './lib/evals.mjs'
import { ensureSplit, evalPaths, harvest, loadCases, loadResult, runEval } from './lib/evalrun.mjs'
import { repoRoot } from './lib/git.mjs'
import { handleHook } from './lib/hooks.mjs'
import * as loop from './lib/loop.mjs'
import { nextAction, renderReport, statusLine } from './lib/report.mjs'
import { paths, readJson, readJsonInput, writeJson, writeText } from './lib/store.mjs'

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const USAGE = `ql — quality-loop core

Setup
  ql init [--force]                 detect checks; write .quality-loop/{config.json,REVIEW.md,.gitignore}
  ql config                         print the effective config
  ql checks [--label L]             run the configured checks once

Loop
  ql start --mode review|debug [--goal G] [--base REF] [--repro CMD] [--depth quick|standard|deep] [--review-only] [--force]
  ql round begin                    checkpoint the tree and write the review scope
  ql scope [--json]                 this round's diff (full first, then diff-only)
  ql ingest <file|-> --lens L       add a bug hunter's findings (JSON array)
  ql ingest --none --lens L         record that lens L's reviewer found nothing (L=scope: the scope is empty)
  ql pending [--json]               candidates awaiting verifier votes
  ql vote <file|-> [file ...]       record votes: {id, verdict: confirm|reject, voter, reason, severity?} or arrays of them
  ql open [--json]                  confirmed findings to fix, grouped by bug class
  ql mark <id> fixed|wontfix --reason R
  ql round end [--allow-weakening]  run checks, compare, revert on regression, decide
  ql status [--json] | ql next      where the loop is and what to do now
  ql pause --reason R | ql resume | ql abort [--reason R] | ql finish (review-only)
  ql extend [--rounds N]            (user only) allow more rounds after a cap or stall
  ql report [--out FILE]            final report: Blocked on me / Changed / Found
  ql export [--out FILE] [--all]    verified findings as JSON

Evals (tuning the reviewer)
  ql eval harvest [--limit N] [--clean N]   draft cases from reverts and fixes in git history
  ql eval cases                     list cases and their split
  ql eval split [--reset]           (re)write the train/test split
  ql eval run --label L [--split train|test|all] [--repeats N] [--runner CMD] [--concurrency K] [--cases a,b] [--keep]
  ql eval show <label>              summary of a run
  ql eval compare <base> <cand>     keep / revert decision with deltas
  ql eval leakcheck [--surface F]   eval answers copied into the tuned surface
  ql eval hillclimb start|stop      protect eval answer keys while tuning

Hooks
  ql hook pre-tool-use|stop|session-start|user-prompt-submit   (reads hook JSON on stdin)
`

/**
 * @param {string[]} argv
 * @returns {{ _: string[], flags: Record<string, string | true> }}
 */
function parseArgs(argv) {
  /** @type {string[]} */
  const _ = []
  /** @type {Record<string, string | true>} */
  const flags = {}
  const BOOL = new Set(['json', 'force', 'none', 'all', 'keep', 'reset', 'allow-weakening', 'review-only', 'help'])
  for (let i = 0; i < argv.length; i++) {
    const a = /** @type {string} */ (argv[i])
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s)
      if (!k) continue
      if (v !== undefined) flags[k] = v
      else if (BOOL.has(k)) flags[k] = true
      else {
        const next = argv[i + 1]
        if (next === undefined || next.startsWith('--')) throw new loop.LoopError(`--${k} needs a value`)
        flags[k] = next
        i++
      }
    } else _.push(a)
  }
  return { _, flags }
}

/** @param {unknown} v */
const str = v => (typeof v === 'string' ? v : undefined)
/** @param {unknown} v @param {number} d */
const int = (v, d) => {
  if (typeof v !== 'string') return d
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0) throw new loop.LoopError(`expected a whole number, got "${v}"`)
  return n
}

/** @param {unknown} x */
const print = x => process.stdout.write(typeof x === 'string' ? (x.endsWith('\n') ? x : `${x}\n`) : `${JSON.stringify(x, null, 2)}\n`)

/**
 * Applies `loop.maxContextTokens` to Claude Code's auto-compaction for this
 * repository (compact.mjs); returns the line to print, if any.
 *
 * @param {string} root
 * @param {{ loop: { maxContextTokens: number | null } }} config
 */
function capContext(root, config) {
  const cap = config.loop.maxContextTokens
  if (!cap) return null
  const r = ensureCompactWindow(root, cap)
  if (r.error) return `WARNING: ${r.error}`
  return `context cap: auto-compact at ${cap} tokens (${r.changed ? 'set in' : 'already in'} .claude/settings.local.json; takes effect from the next turn)`
}

/** @param {any} run */
function formatRun(run) {
  const lines = run.results.map(
    (/** @type {any} */ r) =>
      `${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.required ? '' : ' (optional)'} · ${(r.durationMs / 1000).toFixed(1)}s` +
      (r.timedOut ? ' · TIMED OUT' : '') +
      (r.flaky ? ' · flaky (passed on retry)' : '') +
      (r.counts ? ` · tests ${r.counts.passed} passed, ${r.counts.failed} failed, ${r.counts.skipped} skipped` : ''),
  )
  // Show the output, do not just claim the result.
  for (const r of run.results.filter((/** @type {any} */ x) => !x.ok)) {
    lines.push('', `--- ${r.name} (exit ${r.exitCode}) last lines; full log ${r.logFile}`, r.tail)
  }
  return lines.join('\n')
}

/** @param {any} f */
const findingLine = f =>
  `${f.id} [${f.origin === 'pre-existing' ? 'Pre-existing' : f.severity === 'important' ? 'Important' : 'Nit'}] ${f.file}:${f.line} ${f.bugClass} — ${f.title}`

/** @param {string} root */
function evalConfig(root) {
  return loop.loadConfig(root).eval
}

/** @param {string[]} argv */
async function main(argv) {
  const { _, flags } = parseArgs(argv)
  const [cmd, sub] = _
  if (!cmd || flags.help || cmd === 'help') return print(USAGE)

  if (cmd === 'hook') {
    if (!sub) throw new loop.LoopError('ql hook <event>')
    let input = {}
    try {
      const text = readFileSync(0, 'utf8')
      input = text.trim() ? JSON.parse(text) : {}
    } catch {
      return
    }
    try {
      const { stdout } = handleHook(sub, input)
      if (stdout) process.stdout.write(stdout)
    } catch (err) {
      // Fail open: a broken hook must never wedge the session.
      process.stderr.write(`quality-loop hook ${sub}: ${/** @type {Error} */ (err).message}\n`)
    }
    return
  }

  const root = repoRoot(process.cwd())
  if (!root) throw new loop.LoopError('not inside a git repository')

  switch (cmd) {
    case 'init': {
      const { created, config } = loop.init(root, { force: !!flags.force })
      print(created.length ? `created:\n${created.map(c => `  ${c}`).join('\n')}` : 'already initialised')
      print(`checks detected: ${config.checks.length ? config.checks.map(c => `${c.name} (${c.cmd})`).join(', ') : 'none — add them to .quality-loop/config.json'}`)
      const capped = capContext(root, config)
      if (capped) print(capped)
      return
    }
    case 'config':
      return print(loop.loadConfig(root))
    case 'checks': {
      const config = loop.loadConfig(root)
      const label = str(flags.label) ?? 'manual'
      const run = await runChecks(config.checks, { cwd: root, logDir: join(paths(root).runs, 'manual', label), label })
      print(flags.json ? run : formatRun(run))
      process.exitCode = run.results.every(r => r.ok || !r.required) ? 0 : 1
      return
    }
    case 'start': {
      const mode = /** @type {'review' | 'debug'} */ (str(flags.mode) ?? 'review')
      const s = await loop.start(root, {
        mode,
        goal: str(flags.goal),
        base: str(flags.base),
        repro: str(flags.repro),
        force: !!flags.force,
        reviewOnly: !!flags['review-only'],
        depth: str(flags.depth),
      })
      const capped = capContext(root, s.config)
      if (flags.json) return print(s)
      if (capped) print(capped)
      print(`started ${s.id} · base ${s.baseCommit.slice(0, 12)} · goal: ${s.goal}`)
      if (!s.reviewOnly) print(formatRun(s.baseline.run))
      for (const w of s.warnings) print(`WARNING: ${w}`)
      if (s.status !== 'active') print(`${s.status.toUpperCase()}: ${s.statusReasons.join('; ')}`)
      return print(`next: ${nextAction(s)}`)
    }
    case 'round': {
      if (sub === 'begin') {
        const { round, scope } = loop.beginRound(root)
        if (flags.json) return print({ round, scope })
        print(`round ${round} begun · scope: ${scope.diffOnly ? 'diff-only since last kept round' : 'full change vs base'}`)
        // In debug mode the fix lands after round begin: an empty scope here
        // is the state before the fix, not a review to skip.
        const emptyNote =
          loop.loadState(root)?.mode === 'debug'
            ? 'scope is empty so far: apply the fix, then `ql scope` and review it with one bug hunter per lens'
            : 'scope is empty: nothing changed to review (record with `ql ingest --none --lens scope`)'
        print(scope.empty ? emptyNote :`diff: ${scope.diffFile}\nfiles:\n${scope.files.map(f => `  ${f.status} ${f.path} (+${f.added} -${f.removed})`).join('\n')}`)
        return print(`lenses:\n${scope.lenses.map((/** @type {{ name: string, focus: string }} */ l) => `  ${l.name}: ${l.focus}`).join('\n')}\nREVIEW.md: ${scope.reviewMd}`)
      }
      if (sub === 'end') {
        const out = await loop.endRound(root, { allowWeakening: !!flags['allow-weakening'] })
        if (flags.json) return print(out)
        print(formatRun(out.run))
        if (out.flaky.length) print(`flaky (failed then passed on retry): ${out.flaky.join(', ')}`)
        for (const w of out.weakening) print(`${w.blocking ? 'WEAKENING' : 'warning'}: ${w.kind} ${w.file}${w.line ? `:${w.line}` : ''} ${w.text}`)
        if (out.decision.revert) print(`REVERTED round ${out.round}: restored ${out.restored?.restored.length ?? 0} file(s), deleted ${out.restored?.deleted.length ?? 0}`)
        for (const d of out.discarded) print(`  discarded ${d.id} ${d.file}:${d.line} ${d.title} (its code was reverted)`)
        print(`decision: ${out.decision.status.toUpperCase()} · score ${out.decision.endScore}`)
        for (const r of out.decision.reasons) print(`  - ${r}`)
        return print(`next: ${nextAction(loop.loadState(root))}`)
      }
      throw new loop.LoopError('ql round begin|end')
    }
    case 'scope': {
      const s = loop.scope(root)
      return print(flags.json ? s : `${s.diffOnly ? 'diff-only' : 'full'} scope · ${s.files.length} file(s) · diff: ${s.diffFile}`)
    }
    case 'ingest': {
      const source = sub
      if (!flags.none && !source) throw new loop.LoopError('ql ingest <file|-> --lens L, or ql ingest --none --lens L')
      // A --none stands for one lens's hunter (or an empty scope): it must say which.
      if (flags.none && !str(flags.lens)) throw new loop.LoopError('ql ingest --none needs --lens: the lens whose hunter found nothing, or `scope` for an empty scope')
      const lens = str(flags.lens) ?? 'general'
      let raws = null
      if (!flags.none && source) {
        const parsed = readJsonInput(source)
        raws = Array.isArray(parsed) ? parsed : parsed?.findings
        if (!Array.isArray(raws)) throw new loop.LoopError('expected a JSON array of findings (or {"findings": [...]})')
      }
      const report = loop.ingest(root, raws, lens)
      if (flags.json) return print(report)
      print(`lens ${lens}: ${report.accepted.length} new, ${report.merged.length} merged, ${report.reopened.length} reopened, ${report.repeats.length} repeats ignored, ${report.rejected.length} rejected`)
      for (const r of report.rejected) print(`  rejected (${r.reason}${r.detail ? `: ${r.detail}` : ''}): ${r.file} — ${r.title}`)
      return print(`next: ${nextAction(loop.loadState(root))}`)
    }
    case 'pending': {
      const p = loop.pending(root)
      if (flags.json) return print(p)
      print(`${p.findings.length} candidate(s) · ${p.verifiers} verifier(s) each, quorum ${p.quorum}`)
      for (const f of p.findings) print(`${findingLine(f)} (needs ${f.votesNeeded} more vote(s))`)
      return
    }
    case 'vote': {
      const sources = _.slice(1)
      if (!sources.length) throw new loop.LoopError('ql vote <file|-> [file ...]')
      // Each source holds one vote object, an array of them, or {"votes": [...]}.
      const votes = sources.flatMap(src => {
        const parsed = readJsonInput(src)
        const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.votes) ? parsed.votes : parsed?.id ? [parsed] : null
        if (!list) throw new loop.LoopError(`${src}: expected a vote object, an array of votes, or {"votes": [...]}`)
        return list
      })
      const out = loop.vote(root, votes)
      if (flags.json) return print(out)
      for (const [id, v] of Object.entries(out.outcome)) print(`${id}: ${v}`)
      for (const i of out.invalid) print(`  invalid vote (${i.reason}): ${JSON.stringify(i.vote)}`)
      return print(`next: ${nextAction(loop.loadState(root))}`)
    }
    case 'open': {
      const groups = loop.openByClass(root)
      if (flags.json) return print(groups)
      const entries = Object.entries(groups)
      if (!entries.length) return print('nothing open')
      for (const [cls, fs] of entries) {
        print(`## ${cls} (${fs.length}) — fix every instance of this class, not just one line`)
        for (const f of fs) print(`${findingLine(f)}\n    why: ${f.explanation}\n    fails when: ${f.failureScenario || 'n/a'}`)
      }
      return
    }
    case 'mark': {
      const id = sub
      const status = _[2]
      if (!id || !status) throw new loop.LoopError('ql mark <id> fixed|wontfix --reason R')
      const f = loop.mark(root, id, /** @type {'fixed'} */ (status), str(flags.reason) ?? '')
      return print(`${f.id} → ${f.status}`)
    }
    case 'status': {
      const s = loop.syncState(root)
      if (flags.json) return print(s)
      print(statusLine(s))
      if (s?.statusReasons?.length) print(s.statusReasons.map((/** @type {string} */ r) => `  - ${r}`).join('\n'))
      return
    }
    case 'next':
      return print(nextAction(loop.syncState(root)))
    case 'pause':
      loop.pause(root, str(flags.reason) ?? '')
      return print('paused')
    case 'resume':
      loop.resume(root)
      return print(`resumed · next: ${nextAction(loop.loadState(root))}`)
    case 'abort':
      loop.abort(root, str(flags.reason) ?? '')
      return print('aborted')
    case 'finish':
      loop.finish(root)
      return print('review finished')
    case 'extend': {
      const s = loop.extend(root, int(flags.rounds, 1))
      return print(`extended to ${s.config.loop.maxRounds} rounds · next: ${nextAction(s)}`)
    }
    case 'report': {
      const s = loop.loadState(root)
      if (!s) throw new loop.LoopError('no loop to report on')
      const text = renderReport(s)
      if (str(flags.out)) writeText(resolve(String(flags.out)), text)
      return print(text)
    }
    case 'export': {
      const findings = loop.exportFindings(root, { all: !!flags.all })
      if (str(flags.out)) {
        writeJson(resolve(String(flags.out)), findings)
        return print(`wrote ${findings.length} finding(s) to ${flags.out}`)
      }
      return print(findings)
    }
    case 'eval':
      return evalCommand(root, sub, _.slice(2), flags)
    default:
      throw new loop.LoopError(`unknown command "${cmd}"\n\n${USAGE}`)
  }
}

/**
 * @param {string} root
 * @param {string | undefined} sub
 * @param {string[]} rest
 * @param {Record<string, string | true>} flags
 */
async function evalCommand(root, sub, rest, flags) {
  const ec = evalConfig(root)
  const ep = evalPaths(root)
  switch (sub) {
    case 'harvest': {
      const written = harvest(root, { limit: int(flags.limit, 20), clean: int(flags.clean, 5) })
      print(written.length ? `drafted ${written.length} case(s):\n${written.map(w => `  ${w}`).join('\n')}` : 'no new cases found in history')
      return print('Drafts do not count until a human confirms each: narrow expected.json to the real defect, fill whyHard, set "status": "confirmed" in case.json.')
    }
    case 'cases': {
      const cases = loadCases(root, { includeDrafts: true })
      const split = readJson(ep.split)
      for (const c of cases) {
        const side = split ? (split.test.includes(c.id) ? 'test' : split.train.includes(c.id) ? 'train' : '-') : '-'
        print(`${c.id} · ${c.kind} · ${c.status} · ${side} · ${c.expected.bugs.length} expected bug(s)`)
      }
      return print(`${cases.length} case(s), ${cases.filter(c => c.status === 'confirmed').length} confirmed`)
    }
    case 'split': {
      const cases = loadCases(root)
      const s = ensureSplit(root, cases, { seed: ec.seed, testFraction: ec.testFraction, reset: !!flags.reset })
      return print(`train ${s.train.length}: ${s.train.join(', ')}\ntest ${s.test.length}: ${s.test.join(', ')}`)
    }
    case 'run': {
      const label = str(flags.label)
      if (!label) throw new loop.LoopError('ql eval run --label L')
      const runner = str(flags.runner) ?? (ec.runner || `sh "${join(PLUGIN_ROOT, 'scripts', 'runners', 'claude-review.sh')}"`)
      const repeats = int(flags.repeats, ec.repeats)
      const split = /** @type {'train'} */ (str(flags.split) ?? 'all')
      const caseIds = str(flags.cases)?.split(',')
      const n = loadCases(root).filter(c => !caseIds || caseIds.includes(c.id)).length
      process.stderr.write(`eval ${label}: ${n} case(s) × ${repeats} repeat(s) (split ${split}), concurrency ${int(flags.concurrency, ec.concurrency)}, timeout ${ec.timeoutSec}s per trial\n`)
      const result = await runEval(root, {
        label,
        split,
        repeats,
        runner,
        concurrency: int(flags.concurrency, ec.concurrency),
        timeoutSec: ec.timeoutSec,
        tolerance: ec.tolerance,
        seed: ec.seed,
        testFraction: ec.testFraction,
        pluginRoot: PLUGIN_ROOT,
        surfacePath: str(flags.surface) ?? paths(root).reviewMd,
        caseIds,
        maxContextTokens: loop.loadConfig(root).loop.maxContextTokens,
        keep: !!flags.keep,
      })
      return print(flags.json ? result : formatEval(result, ec.minDelta))
    }
    case 'show': {
      const label = rest[0]
      if (!label) throw new loop.LoopError('ql eval show <label>')
      const r = loadResult(root, label)
      return print(flags.json ? r : formatEval(r, ec.minDelta))
    }
    case 'compare': {
      const [a, b] = rest
      if (!a || !b) throw new loop.LoopError('ql eval compare <base> <candidate>')
      const base = loadResult(root, a)
      const cand = loadResult(root, b)
      const d = decideHillclimb(base.summary, cand.summary, { minDelta: ec.minDelta })
      if (flags.json) return print(d)
      const pct = (/** @type {number} */ x) => `${(x * 100).toFixed(1)}%`
      print(`train ${pct(base.summary.train.passRate.mean)} → ${pct(cand.summary.train.passRate.mean)} (${d.dTrain >= 0 ? '+' : ''}${pct(d.dTrain)})`)
      print(`test  ${pct(base.summary.test.passRate.mean)} → ${pct(cand.summary.test.passRate.mean)} (${d.dTest >= 0 ? '+' : ''}${pct(d.dTest)}) · 95% CI ${pct(cand.summary.test.passRate.lo)}–${pct(cand.summary.test.passRate.hi)}`)
      return print(`decision: ${d.decision.toUpperCase()} — ${d.reason}`)
    }
    case 'leakcheck': {
      const surface = str(flags.surface) ?? paths(root).reviewMd
      const text = readFileSync(surface, 'utf8')
      const leaks = leakCheck(text, loadCases(root, { includeDrafts: true }))
      if (flags.json) return print(leaks)
      if (!leaks.length) return print(`no eval answers found in ${surface}`)
      for (const l of leaks) print(`LEAK (${l.kind}) from case ${l.caseId}: "${l.match}"`)
      process.exitCode = 1
      return
    }
    case 'hillclimb': {
      const action = rest[0]
      if (action === 'start') {
        writeJson(ep.hillclimb, { active: true, startedAt: new Date().toISOString(), surface: str(flags.surface) ?? paths(root).reviewMd })
        return print('hill climbing: eval cases and answer keys are now protected from edits')
      }
      if (action === 'stop') {
        writeJson(ep.hillclimb, { active: false, stoppedAt: new Date().toISOString() })
        return print('hill climbing stopped')
      }
      throw new loop.LoopError('ql eval hillclimb start|stop')
    }
    default:
      throw new loop.LoopError(`ql eval harvest|cases|split|run|show|compare|leakcheck|hillclimb`)
  }
}

/** @param {any} r @param {number} minDelta */
function formatEval(r, minDelta) {
  const pct = (/** @type {number} */ x) => `${(x * 100).toFixed(1)}%`
  const out = [`eval ${r.label} · ${r.trials.length} trial(s) · surface ${r.surfaceHash}`]
  for (const side of ['train', 'test', 'all']) {
    const s = r.summary[side]
    if (!s.trials && !s.infraErrors) continue
    out.push(
      `${side.padEnd(5)} pass ${pct(s.passRate.mean)} [${pct(s.passRate.lo)}–${pct(s.passRate.hi)}] · precision ${pct(s.precision)} · recall ${pct(s.recall)} · flip rate ${pct(s.flipRate)} · ${s.cases} case(s)` +
        (s.infraErrors ? ` · ${s.infraErrors} INFRA ERROR(S)` : ''),
    )
  }
  const all = r.summary.all
  if (all.infraErrors) out.push('Infra errors are excluded from scores; read their transcripts before trusting this run.')
  if (all.passRate.mean >= 0.95) out.push('HEADROOM WARNING: pass rate ≥ 95%. Add harder cases, or hill-climb cost/latency at parity instead.')
  if (all.flipRate > 0 && all.passRate.hi - all.passRate.lo > minDelta * 2) {
    out.push(`NOISE WARNING: the interval (${pct(all.passRate.hi - all.passRate.lo)} wide) exceeds twice the smallest change you act on (${pct(minDelta)}). Add repeats or cases before hill climbing.`)
  }
  if (!r.graderConsistent) out.push('GRADER WARNING: grading the same output twice disagreed.')
  for (const t of r.trials.filter((/** @type {any} */ t) => t.infraError)) out.push(`  infra: ${t.caseId} r${t.repeat}: ${t.infraError} (${t.transcript})`)
  return out.join('\n')
}

main(process.argv.slice(2)).catch(err => {
  if (err instanceof loop.LoopError) {
    process.stderr.write(`ql: ${err.message}\n`)
    process.exitCode = 1
  } else {
    process.stderr.write(`ql: ${err?.stack ?? err}\n`)
    process.exitCode = 2
  }
})
