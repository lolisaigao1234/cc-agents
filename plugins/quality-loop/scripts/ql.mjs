#!/usr/bin/env node
// ql: the deterministic core of the quality loop. Agents decide what is
// wrong and how to fix it; ql decides what counts (evidence, votes,
// regressions, convergence) and keeps the state on disk.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { briefLine, clearRoundWork, fixBriefs, hunterBriefs, investigateBrief, resolveLens, verifierBriefs } from './lib/brief.mjs'
import { runChecks } from './lib/checks.mjs'
import { ensureCompactWindow } from './lib/compact.mjs'
import { DEPTHS } from './lib/config.mjs'
import { decideHillclimb, leakCheck } from './lib/evals.mjs'
import { ensureSplit, evalPaths, harvest, loadCases, loadResult, runEval } from './lib/evalrun.mjs'
import { repoRoot } from './lib/git.mjs'
import { handleHook } from './lib/hooks.mjs'
import * as loop from './lib/loop.mjs'
import { nextAction, phaseOf, renderReport, statusLine, stepFile } from './lib/report.mjs'
import { paths, readJson, readJsonInput, writeJson, writeText } from './lib/store.mjs'

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// The round protocol, one small file per step: ql names the one to read.
const STEP_DIR = join(PLUGIN_ROOT, 'references', 'round')
// A failing check shows this many lines of its output; the rest is in its log.
const TAIL_LINES = 15
const MAX_LINE = 200

const USAGE = `ql — quality-loop core

Setup
  ql init [--force]                 detect checks; write .quality-loop/{config.json,REVIEW.md,.gitignore}
  ql config                         print the effective config
  ql checks [--label L]             run the configured checks once

Loop
  ql start --mode review|debug [--goal G] [--base REF] [--repro CMD] [--depth quick|standard|deep] [--review-only] [--force]
  ql round begin                    checkpoint the tree and write the review scope
  ql scope [--json]                 this round's diff (full first, then diff-only)
  ql brief hunters [--intent T]     write one bug-hunter brief per lens; print "<agent> <brief> -> <output>" per brief
  ql brief verifiers                one finding-verifier brief per missing vote, each with its own stance
  ql brief fix <bugClass>|--all     one fixer brief per open bug class (with its wave)
  ql brief investigate --hypothesis H [--k N]   one root-cause-investigator brief (debug)
  ql ingest <file|-> --lens L       add a bug hunter's findings (JSON array)
  ql ingest --none --lens L         record that lens L's reviewer found nothing (L=scope: the scope is empty)
  ql pending [--json]               candidates awaiting verifier votes (one line each; full JSON in a file)
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
  ql eval run --label L [--split train|test|all] [--repeats N] [--runner CMD] [--concurrency K] [--cases a,b] [--depth quick|standard|deep] [--surface FILE] [--keep]
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

/** @param {string} line */
const clip = line => (line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line)

/**
 * Finding ids as compact ranges: F1-F30, F32.
 *
 * @param {string[]} ids
 */
function idList(ids) {
  /** @type {string[]} */
  const out = []
  let i = 0
  while (i < ids.length) {
    const m = /^(\D*)(\d+)$/.exec(ids[i] ?? '')
    let j = i
    while (m && j + 1 < ids.length && ids[j + 1] === `${m[1]}${Number(m[2]) + (j + 1 - i)}`) j++
    out.push(j > i + 1 ? `${ids[i]}-${ids[j]}` : ids.slice(i, j + 1).join(', '))
    i = j + 1
  }
  return out.join(', ')
}

/**
 * The `next:` line, and the protocol step file to read when the command
 * moved the loop to another step (or `step` names one).
 *
 * @param {any} s the state after the command
 * @param {string | null} before the phase before the command
 * @param {{ always?: boolean, step?: string | null }} [opts]
 */
function printNext(s, before, opts = {}) {
  print(`next: ${nextAction(s)}`)
  const name = opts.step ?? stepFile(s)
  if (name && (opts.always || opts.step || phaseOf(s) !== before)) print(`step: ${join(STEP_DIR, name)}`)
}

/** @param {string} root */
function phaseNow(root) {
  try {
    return phaseOf(loop.loadState(root))
  } catch {
    return null
  }
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
  // Show the output, do not just claim the result: the last lines here, all of it in the log.
  for (const r of run.results.filter((/** @type {any} */ x) => !x.ok)) {
    const tail = String(r.tail ?? '').replace(/\s+$/, '').split('\n').slice(-TAIL_LINES).map(clip)
    lines.push(`--- ${r.name} (exit ${r.exitCode}): last ${tail.length} lines; full log ${r.logFile}`, ...tail)
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
  const before = phaseNow(root)
  const rel = (/** @type {string} */ p) => relative(root, p)

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
      // Work paths are built from round numbers and finding ids, which restart here.
      clearRoundWork(root)
      const capped = capContext(root, s.config)
      if (flags.json) return print(s)
      if (capped) print(capped)
      print(`started ${s.id} · base ${s.baseCommit.slice(0, 12)} · goal: ${s.goal}`)
      if (!s.reviewOnly) print(formatRun(s.baseline.run))
      for (const w of s.warnings) print(`WARNING: ${w}`)
      if (s.status !== 'active') print(`${s.status.toUpperCase()}: ${s.statusReasons.join('; ')}`)
      return printNext(s, before, { always: true })
    }
    case 'round': {
      if (sub === 'begin') {
        const { round, scope } = loop.beginRound(root)
        if (flags.json) return print({ round, scope })
        const s = loop.loadState(root)
        // The file list and each lens's focus go into the hunter briefs (`ql brief hunters`), not here.
        print(
          `round ${round} begun · ${scope.diffOnly ? 'diff-only since last kept round' : 'full change vs base'} · ${scope.files.length} file(s) · diff ${rel(scope.diffFile)}`,
        )
        print(`lenses: ${scope.lenses.map((/** @type {{ name: string }} */ l) => l.name).join(', ')}`)
        // In debug mode the fix lands after round begin: an empty scope here
        // is the state before the fix, not a review to skip.
        if (scope.empty) {
          print(
            s?.mode === 'debug'
              ? 'scope is empty so far: apply the fix, then `ql brief hunters` and review it with one bug hunter per lens'
              : 'scope is empty: nothing changed to review (record with `ql ingest --none --lens scope`)',
          )
        }
        return printNext(s, before)
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
        // Anything but a plain CONTINUE is acted on from the decision table.
        const settled = out.decision.revert || out.decision.status !== 'continue'
        return printNext(loop.loadState(root), before, { step: settled ? 'decisions.md' : null })
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
      const lenses = /** @type {string[]} */ (loop.loadState(root)?.config.review.lenses ?? [])
      // A hunter brief's file name carries the lens as a slug: that names the lens too.
      const lens = resolveLens(lenses, str(flags.lens) ?? 'general')
      let raws = null
      if (!flags.none && source) {
        const parsed = readJsonInput(source)
        raws = Array.isArray(parsed) ? parsed : parsed?.findings
        if (!Array.isArray(raws)) throw new loop.LoopError('expected a JSON array of findings (or {"findings": [...]})')
      }
      const report = loop.ingest(root, raws, lens)
      if (flags.json) return print(report)
      const n = (/** @type {string[]} */ ids, /** @type {string} */ what) => `${ids.length} ${what}${ids.length ? ` (${idList(ids)})` : ''}`
      print(
        `lens ${lens}: ${n(report.accepted, 'new')}, ${n(report.merged, 'merged')}, ${n(report.reopened, 'reopened')}, ${n(report.repeats, 'repeats ignored')}, ${report.rejected.length} rejected`,
      )
      if (lens !== 'scope' && !lenses.includes(lens)) print(`note: "${lens}" is not a configured lens (${lenses.join(', ')}): it counts toward no lens's review`)
      for (const r of report.rejected) {
        print(clip(`  rejected ${r.reason}${r.detail ? ` (${String(r.detail).slice(0, 80)})` : ''}: ${r.file} ${String(r.title ?? '').slice(0, 80)}`))
      }
      return printNext(loop.loadState(root), before)
    }
    case 'pending': {
      const p = loop.pending(root)
      if (flags.json) return print(p)
      // The full JSON goes to a file, read on demand (or `ql brief verifiers`).
      const file = join(paths(root).work, `round-${loop.loadState(root)?.round ?? 0}`, 'pending.json')
      writeJson(file, p)
      print(`${p.findings.length} candidate(s) · ${p.verifiers} voter(s) each, quorum ${p.quorum} · full JSON: ${rel(file)}`)
      for (const f of p.findings) print(clip(`${f.id} ${f.severity} ${f.file}:${f.line} ${f.title.slice(0, 100)} (needs ${f.votesNeeded})`))
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
      const s = loop.loadState(root)
      const { quorum, verifiers } = s.config.review
      // One line per finding touched: the outcome and the tally, never the votes.
      for (const [id, v] of Object.entries(out.outcome)) {
        const fv = /** @type {any[]} */ (s.ledger.findings[id]?.votes ?? [])
        const yes = fv.filter(x => x.verdict === 'confirm').length
        print(`${id}: ${v} · ${yes} confirm, ${fv.length - yes} reject (quorum ${quorum} of ${verifiers})`)
      }
      for (const i of out.invalid) {
        print(clip(`  invalid vote (${i.reason}): id ${String(i.vote?.id ?? '?').slice(0, 20)}, voter ${String(i.vote?.voter ?? '?').slice(0, 40)}`))
      }
      return printNext(s, before)
    }
    case 'open': {
      const groups = loop.openByClass(root)
      if (flags.json) return print(groups)
      const entries = Object.entries(groups)
      if (!entries.length) return print('nothing open')
      for (const [cls, fs] of entries) {
        print(`## ${cls} (${fs.length}) — fix every instance of this class, not just one line`)
        for (const f of fs) print(clip(findingLine(f)))
      }
      return
    }
    case 'mark': {
      const id = sub
      const status = _[2]
      if (!id || !status) throw new loop.LoopError('ql mark <id> fixed|wontfix --reason R')
      const f = loop.mark(root, id, /** @type {'fixed'} */ (status), str(flags.reason) ?? '')
      print(`${f.id} → ${f.status}`)
      const s = loop.loadState(root)
      if (phaseOf(s) !== before) printNext(s, before)
      return
    }
    case 'status': {
      const s = loop.syncState(root)
      if (flags.json) return print(s)
      print(statusLine(s))
      if (s?.statusReasons?.length) print(s.statusReasons.map((/** @type {string} */ r) => `  - ${r}`).join('\n'))
      return
    }
    case 'next': {
      const s = loop.syncState(root)
      print(nextAction(s))
      const step = stepFile(s)
      if (step) print(`step: ${join(STEP_DIR, step)}`)
      return
    }
    case 'brief':
      return briefCommand(root, sub, _.slice(2), flags)
    case 'pause':
      loop.pause(root, str(flags.reason) ?? '')
      return print('paused')
    case 'resume':
      loop.resume(root)
      print('resumed')
      return printNext(loop.loadState(root), before, { always: true })
    case 'abort':
      loop.abort(root, str(flags.reason) ?? '')
      return print('aborted')
    case 'finish':
      loop.finish(root)
      return print('review finished')
    case 'extend': {
      const s = loop.extend(root, int(flags.rounds, 1))
      print(`extended to ${s.config.loop.maxRounds} rounds`)
      return printNext(s, before, { always: true })
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
 * Writes agent briefs to files and prints one `<agent> <brief> -> <output>`
 * line per brief: the Agent prompt is then just "Brief: <brief>".
 *
 * @param {string} root
 * @param {string | undefined} sub
 * @param {string[]} rest
 * @param {Record<string, string | true>} flags
 */
function briefCommand(root, sub, rest, flags) {
  const intent = str(flags.intent)
  const show = (/** @type {import('./lib/brief.mjs').Brief[]} */ bs, /** @type {string} */ none) => print(bs.length ? bs.map(briefLine).join('\n') : none)
  switch (sub) {
    case 'hunters': {
      const out = hunterBriefs(root, { intent })
      if (out.empty) return print('scope is empty: nothing to review (record with `ql ingest --none --lens scope`; in debug, apply the fix first)')
      return show(out.briefs, '')
    }
    case 'verifiers':
      return show(verifierBriefs(root, { intent }), 'no candidates awaiting votes')
    case 'fix': {
      const bugClass = rest[0]
      if (!bugClass && !flags.all) throw new loop.LoopError('ql brief fix <bugClass>|--all')
      return show(fixBriefs(root, { bugClass: flags.all ? undefined : bugClass, intent }), 'nothing open')
    }
    case 'investigate': {
      const k = flags.k === undefined ? undefined : int(flags.k, 1)
      return show([investigateBrief(root, { hypothesis: str(flags.hypothesis) ?? '', k, intent })], '')
    }
    default:
      throw new loop.LoopError('ql brief hunters|verifiers|fix <bugClass>|--all|investigate --hypothesis "<h>"')
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
        print(`${c.id} · ${c.kind} · ${c.status} · ${side} · ${c.expected.bugs.length} expected bug(s)${c.problem ? ` · INVALID: ${c.problem}` : ''}`)
      }
      const invalid = cases.filter(c => c.problem).length
      return print(`${cases.length} case(s), ${cases.filter(c => c.status === 'confirmed').length} confirmed${invalid ? `, ${invalid} INVALID (each would be an infra error; fix case.json)` : ''}`)
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
      // The runner reads the review depth from QL_DEPTH.
      const depth = str(flags.depth)
      if (flags.depth !== undefined && !(depth && Object.hasOwn(DEPTHS, depth))) throw new loop.LoopError(`--depth must be one of ${Object.keys(DEPTHS).join(', ')}`)
      // A mistyped --surface must not silently run an empty REVIEW.md.
      const surfacePath = flags.surface === undefined ? paths(root).reviewMd : resolve(root, str(flags.surface) ?? '')
      if (flags.surface !== undefined && !(str(flags.surface) && existsSync(surfacePath))) throw new loop.LoopError(`--surface: no such file ${str(flags.surface) ?? ''}`)
      const n = loadCases(root).filter(c => !caseIds || caseIds.includes(c.id)).length
      process.stderr.write(`eval ${label}: ${n} case(s) × ${repeats} repeat(s) (split ${split}${depth ? `, depth ${depth}` : ''}), concurrency ${int(flags.concurrency, ec.concurrency)}, timeout ${ec.timeoutSec}s per trial\n`)
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
        surfacePath,
        caseIds,
        maxContextTokens: loop.loadConfig(root).loop.maxContextTokens,
        keep: !!flags.keep,
        depth,
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
      // An undecidable comparison must not read as success to a script.
      if (d.decision === 'invalid') process.exitCode = 1
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
  const out = [`eval ${r.label} · ${r.trials.length} trial(s) · surface ${r.surfaceHash}${r.depth ? ` · depth ${r.depth}` : ''}`]
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
