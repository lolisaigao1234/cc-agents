// The reviewer eval harness: cases on disk, isolated workspaces, a pluggable
// runner command, programmatic grading, and harvesting cases from history.

import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseUnifiedDiff } from './diff.mjs'
import { extendSplit, gradeCase, splitCases, summarize } from './evals.mjs'
import { git } from './git.mjs'
import { paths, readJson, writeJson } from './store.mjs'

/**
 * @typedef {{
 *   id: string, kind: 'bug' | 'clean', status: 'draft' | 'confirmed', intent?: string, whyHard?: string,
 *   source: { type: 'git', base: string, head: string } | { type: 'files' },
 *   dir: string, expected: import('./evals.mjs').Expected, problem?: string,
 * }} EvalCase
 */

/**
 * The case's source, inferred when `type` is left out: a source naming
 * `base`/`head` commits is a git case, otherwise the case's `before/` and
 * `after/` folders are. A case that has neither gets a `problem` instead of
 * crashing the run.
 *
 * @param {any} meta
 * @param {string} caseDir
 * @returns {{ source: EvalCase['source'], problem?: string }}
 */
function resolveSource(meta, caseDir) {
  const s = meta.source && typeof meta.source === 'object' ? meta.source : {}
  if (s.type === 'git' || (s.type === undefined && (s.base !== undefined || s.head !== undefined))) {
    const isRev = (/** @type {unknown} */ v) => typeof v === 'string' && v !== '' && !v.startsWith('-')
    return {
      source: { type: 'git', base: String(s.base ?? ''), head: String(s.head ?? '') },
      ...(isRev(s.base) && isRev(s.head) ? {} : { problem: 'a git source needs both "base" and "head" commits' }),
    }
  }
  if (s.type !== undefined && s.type !== 'files') return { source: { type: 'files' }, problem: `unknown source type "${s.type}" (use "git" or "files")` }
  if (!existsSync(join(caseDir, 'before')) || !existsSync(join(caseDir, 'after'))) {
    return { source: { type: 'files' }, problem: 'needs a git source { "base", "head" } or before/ and after/ folders' }
  }
  return { source: { type: 'files' } }
}

/** @param {string} root */
export function evalPaths(root) {
  const dir = paths(root).evals
  return {
    dir,
    cases: join(dir, 'cases'),
    split: join(dir, 'split.json'),
    results: join(dir, 'results'),
    work: join(dir, 'work'),
    hillclimb: join(dir, 'hillclimb.json'),
  }
}

/**
 * @param {string} root
 * @param {{ includeDrafts?: boolean }} [opts]
 * @returns {EvalCase[]}
 */
export function loadCases(root, opts = {}) {
  const dir = evalPaths(root).cases
  if (!existsSync(dir)) return []
  /** @type {EvalCase[]} */
  const out = []
  for (const name of readdirSync(dir).sort()) {
    const caseDir = join(dir, name)
    const meta = readJson(join(caseDir, 'case.json'))
    if (!meta) continue
    const expected = readJson(join(caseDir, 'expected.json')) ?? { bugs: [] }
    const { source, problem } = resolveSource(meta, caseDir)
    const kindProblem = meta.kind === 'bug' || meta.kind === 'clean' ? undefined : `"kind" must be "bug" or "clean", got ${JSON.stringify(meta.kind)}`
    const c = { ...meta, id: meta.id ?? name, dir: caseDir, source, expected: { kind: meta.kind, bugs: expected.bugs ?? [] } }
    if (problem || kindProblem) c.problem = [problem, kindProblem].filter(Boolean).join('; ')
    if (c.status === 'confirmed' || opts.includeDrafts) out.push(c)
  }
  return out
}

/**
 * @param {string} root
 * @param {EvalCase[]} cases
 * @param {{ seed: number, testFraction: number, reset?: boolean }} opts
 */
export function ensureSplit(root, cases, opts) {
  const p = evalPaths(root).split
  const existing = readJson(p)
  const ids = cases.map(c => c.id)
  // An existing split is kept as long as it covers every case: reshuffling
  // would leak test cases into training.
  if (existing && !opts.reset && ids.every(id => existing.train.includes(id) || existing.test.includes(id))) return existing
  if (existing && !opts.reset) {
    const merged = extendSplit(existing, cases, opts)
    writeJson(p, merged)
    return merged
  }
  const s = splitCases(cases, opts)
  writeJson(p, s)
  return s
}

/** @param {string[]} args @param {string} cwd */
function g(args, cwd) {
  return git(args, { cwd }).stdout.trim()
}

/**
 * Builds a fresh repository holding only the case's base commit and the
 * change on top of it. Nothing from the source repository's later history
 * (the fix, the revert, their messages) is reachable from it.
 *
 * The reviewer must not learn the answer from its surroundings: the
 * workspace's name is random (case ids like `clean-…` or `revert-…` would
 * give the verdict away), and any `.quality-loop/` directory the case's
 * trees carry, committed eval cases and their answer keys included, is
 * dropped. Only the surface under test and the config are placed there.
 * On failure the workspace is removed before the error is rethrown.
 *
 * @param {string} root
 * @param {EvalCase} c
 * @param {string} surface REVIEW.md text to place in the workspace
 */
export function materialize(root, c, surface) {
  const ws = mkdtempSync(join(tmpdir(), 'ql-eval-'))
  try {
    return materializeInto(root, ws, c, surface)
  } catch (err) {
    rmSync(ws, { recursive: true, force: true })
    throw err
  }
}

/** @param {string} root @param {string} ws @param {EvalCase} c @param {string} surface */
function materializeInto(root, ws, c, surface) {
  if (c.problem) throw new Error(`invalid case: ${c.problem}`)
  const run = (/** @type {string[]} */ args) => g(args, ws)
  run(['init', '-q', '-b', 'main'])
  run(['config', 'user.email', 'eval@quality-loop.invalid'])
  run(['config', 'user.name', 'quality-loop eval'])
  run(['config', 'commit.gpgsign', 'false'])
  /** @param {string} rev */
  const extract = rev => {
    const tar = spawnSync('git', ['archive', '--format=tar', rev], { cwd: root, maxBuffer: 1024 * 1024 * 1024 })
    if (tar.status !== 0) throw new Error(`git archive ${rev} failed: ${tar.stderr}`)
    const x = spawnSync('tar', ['-x', '-C', ws], { input: tar.stdout })
    if (x.status !== 0) throw new Error(`tar failed: ${x.stderr}`)
  }
  const clear = () => {
    for (const e of readdirSync(ws)) if (e !== '.git') rmSync(join(ws, e), { recursive: true, force: true })
  }
  // The plugin's own directory (eval cases, answer keys, old REVIEW.md) is
  // never part of the change under review.
  const dropPluginDir = () => rmSync(join(ws, '.quality-loop'), { recursive: true, force: true })
  if (c.source.type === 'git') {
    extract(c.source.base)
  } else {
    cpSync(join(c.dir, 'before'), ws, { recursive: true })
  }
  dropPluginDir()
  run(['add', '-A'])
  run(['commit', '-q', '--allow-empty', '-m', 'base'])
  const base = run(['rev-parse', 'HEAD'])
  clear()
  if (c.source.type === 'git') extract(c.source.head)
  else cpSync(join(c.dir, 'after'), ws, { recursive: true })
  dropPluginDir()
  run(['add', '-A'])
  run(['commit', '-q', '--allow-empty', '-m', 'change under review'])
  mkdirSync(join(ws, '.quality-loop'), { recursive: true })
  writeFileSync(join(ws, '.quality-loop', 'REVIEW.md'), surface)
  const cfg = readJson(join(paths(root).config))
  if (cfg) writeJson(join(ws, '.quality-loop', 'config.json'), { ...cfg, checks: [] })
  return { ws, base }
}

/**
 * Runs one trial: materialise, run the runner command with a timeout, read
 * its JSON findings and grade them. Plumbing failures (an invalid case, a
 * workspace that cannot be built, timeout, crash, no or invalid output) are
 * infra errors, kept apart from model failures; they never throw, so one bad
 * case cannot discard a run's finished trials. The workspace is always
 * removed unless `keep` is set.
 *
 * @param {string} root
 * @param {EvalCase} c
 * @param {{ runner: string, repeat: number, timeoutSec: number, tolerance: number, surface: string, transcriptDir: string, pluginRoot: string, maxContextTokens?: number | null, keep?: boolean, depth?: string }} o
 */
export async function runTrial(root, c, o) {
  const started = Date.now()
  mkdirSync(o.transcriptDir, { recursive: true })
  const transcript = join(o.transcriptDir, `${safeId(c.id)}.r${o.repeat}.log`)
  /** @type {string | null} */
  let ws = null
  /** @type {string | null} */
  let infraError = null
  /** @type {any[]} */
  let predicted = []
  try {
    let base = ''
    try {
      ;({ ws, base } = materialize(root, c, o.surface))
    } catch (err) {
      const msg = /** @type {Error} */ (err)?.message ?? String(err)
      writeFileSync(transcript, `could not build the case workspace: ${msg}\n`)
      infraError = `workspace setup failed: ${msg.split('\n')[0]}`
    }
    if (ws) ({ infraError, predicted } = await execRunner(ws, base, c, o, transcript))
  } catch (err) {
    infraError = `trial failed: ${/** @type {Error} */ (err)?.message ?? err}`
  } finally {
    if (ws && !o.keep) rmSync(ws, { recursive: true, force: true })
  }
  const grade = infraError ? { tp: 0, fp: 0, fn: 0, duplicates: 0, pass: false } : gradeCase(c.expected, predicted, { tolerance: o.tolerance })
  // The grader is programmatic; grading twice must agree.
  const again = infraError ? grade : gradeCase(c.expected, predicted, { tolerance: o.tolerance })
  return {
    caseId: c.id,
    kind: c.kind,
    repeat: o.repeat,
    ...grade,
    graderConsistent: JSON.stringify(grade) === JSON.stringify(again),
    infraError,
    durationMs: Date.now() - started,
    predicted,
    transcript,
    workspace: o.keep ? ws : null,
  }
}

/**
 * Runs the runner command in a materialised workspace and reads its findings.
 * The runner learns the base, the output path and the change's intent, never
 * the case id: ids such as `clean-…` would give the verdict away.
 *
 * @param {string} ws
 * @param {string} base
 * @param {EvalCase} c
 * @param {{ runner: string, timeoutSec: number, pluginRoot: string, maxContextTokens?: number | null, depth?: string }} o
 * @param {string} transcript
 * @returns {Promise<{ infraError: string | null, predicted: any[] }>}
 */
async function execRunner(ws, base, c, o, transcript) {
  const output = join(ws, '.quality-loop', 'eval-output.json')
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    ...process.env,
    QL_WORKSPACE: ws,
    QL_BASE: base,
    QL_OUTPUT: output,
    QL_INTENT: c.intent ?? '',
    QL_PLUGIN_ROOT: o.pluginRoot,
  }
  delete env.QL_CASE_ID
  if (o.depth) env.QL_DEPTH = o.depth
  // The context cap (compact.mjs), unless the caller set a lower window.
  const window = Number(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW)
  if (o.maxContextTokens && !(window > 0 && window <= o.maxContextTokens)) env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(o.maxContextTokens)
  const exec = await new Promise(resolve => {
    let out = ''
    let timedOut = false
    const child = spawn('sh', ['-c', o.runner], { cwd: ws, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const onData = (/** @type {Buffer} */ d) => {
      out += d.toString('utf8')
      if (out.length > 4 * 1024 * 1024) out = out.slice(-4 * 1024 * 1024)
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
    }, o.timeoutSec * 1000)
    child.on('error', err => {
      clearTimeout(timer)
      resolve({ code: 127, out: `${out}\n${err.message}`, timedOut })
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code, out, timedOut })
    })
  })
  writeFileSync(transcript, exec.out)
  /** @type {string | null} */
  let infraError = null
  /** @type {any[]} */
  let predicted = []
  if (exec.timedOut) infraError = 'timeout'
  else if (exec.code !== 0) infraError = `runner exited ${exec.code}`
  else if (!existsSync(output)) infraError = 'runner wrote no output file'
  else {
    try {
      const parsed = JSON.parse(readFileSync(output, 'utf8'))
      predicted = Array.isArray(parsed) ? parsed : parsed.findings
      if (!Array.isArray(predicted)) infraError = 'output is not a findings array'
    } catch (err) {
      infraError = `output is not JSON: ${/** @type {Error} */ (err).message}`
    }
  }
  if (infraError) predicted = []
  return { infraError, predicted }
}

/**
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<R>} fn
 */
async function pool(items, limit, fn) {
  /** @type {R[]} */
  const out = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(/** @type {T} */ (items[i]))
    }
  })
  await Promise.all(workers)
  return out
}

/** FNV-1a. @param {string} s */
function hash(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * @param {string} root
 * @param {{
 *   label: string, split: 'train' | 'test' | 'all', repeats: number, runner: string, concurrency: number,
 *   timeoutSec: number, tolerance: number, seed: number, testFraction: number, pluginRoot: string,
 *   surfacePath: string, caseIds?: string[], maxContextTokens?: number | null, keep?: boolean, depth?: string,
 * }} o
 */
export async function runEval(root, o) {
  const cases = loadCases(root)
  if (!cases.length) throw new Error('no confirmed eval cases under .quality-loop/evals/cases (harvest or write some, then confirm them)')
  const split = ensureSplit(root, cases, { seed: o.seed, testFraction: o.testFraction })
  const which = (/** @type {string} */ id) => (split.test.includes(id) ? 'test' : 'train')
  const selected = cases.filter(c => (o.split === 'all' || which(c.id) === o.split) && (!o.caseIds || o.caseIds.includes(c.id)))
  const surface = existsSync(o.surfacePath) ? readFileSync(o.surfacePath, 'utf8') : ''
  const jobs = selected.flatMap(c => Array.from({ length: o.repeats }, (_, r) => ({ c, r })))
  const transcriptDir = join(evalPaths(root).results, o.label, 'transcripts')
  const trials = await pool(jobs, o.concurrency, ({ c, r }) =>
    runTrial(root, c, { runner: o.runner, repeat: r, timeoutSec: o.timeoutSec, tolerance: o.tolerance, surface, transcriptDir, pluginRoot: o.pluginRoot, maxContextTokens: o.maxContextTokens, keep: o.keep, depth: o.depth }),
  )
  const bySplit = (/** @type {string} */ s) => trials.filter(t => which(t.caseId) === s)
  const result = {
    label: o.label,
    createdAt: new Date().toISOString(),
    surfacePath: o.surfacePath,
    surfaceHash: hash(surface),
    runner: o.runner,
    depth: o.depth ?? null,
    repeats: o.repeats,
    split: o.split,
    trials,
    summary: {
      train: summarize(bySplit('train'), { seed: o.seed }),
      test: summarize(bySplit('test'), { seed: o.seed }),
      all: summarize(trials, { seed: o.seed }),
    },
    graderConsistent: trials.every(t => t.graderConsistent),
  }
  writeJson(join(evalPaths(root).results, `${o.label}.json`), result)
  return result
}

/** @param {string} root @param {string} label */
export function loadResult(root, label) {
  const r = readJson(join(evalPaths(root).results, `${label}.json`))
  if (!r) throw new Error(`no eval result "${label}" (looked in .quality-loop/evals/results/)`)
  return r
}

/**
 * Groups added lines into ranges per file.
 *
 * @param {import('./diff.mjs').DiffFile[]} files
 */
function addedRanges(files) {
  /** @type {{ file: string, line: number, endLine: number }[]} */
  const out = []
  for (const f of files) {
    if (f.status === 'deleted') continue
    let cur = null
    for (const l of f.added) {
      if (cur && l.line === cur.endLine + 1) cur.endLine = l.line
      else {
        cur = { file: f.path, line: l.line, endLine: l.line }
        out.push(cur)
      }
    }
  }
  return out
}

/**
 * Groups lines into contiguous ranges per file.
 *
 * @param {{ file: string, line: number }[]} lines
 */
function lineRanges(lines) {
  const sorted = [...lines].sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1))
  /** @type {{ file: string, line: number, endLine: number }[]} */
  const out = []
  /** @type {{ file: string, line: number, endLine: number } | null} */
  let cur = null
  for (const l of sorted) {
    if (cur && cur.file === l.file && l.line <= cur.endLine + 1) cur.endLine = Math.max(cur.endLine, l.line)
    else {
      cur = { file: l.file, line: l.line, endLine: l.line }
      out.push(cur)
    }
  }
  return out
}

/**
 * Blames the lines a fix removed, at the fix's parent: which commit
 * introduced each of them, and where the line sat in that commit. One
 * `git blame` per file, with one `-L` per run of removed lines.
 *
 * @param {string} root
 * @param {string} sha the fix commit
 * @returns {Map<string, { file: string, line: number }[]>} intro commit -> its lines
 */
function blameRemoved(root, sha) {
  /** @type {Map<string, { file: string, line: number }[]>} */
  const byIntro = new Map()
  const fixDiff = parseUnifiedDiff(git(['diff', '-U0', `${sha}^`, sha], { cwd: root }).stdout)
  for (const f of fixDiff) {
    if (f.status !== 'modified' && f.status !== 'renamed') continue
    const ranges = lineRanges(f.removed.map(l => ({ file: f.oldPath, line: l.line })))
    if (!ranges.length) continue
    const b = git(['blame', '--line-porcelain', ...ranges.flatMap(r => ['-L', `${r.line},${r.endLine}`]), `${sha}^`, '--', f.oldPath], {
      cwd: root,
      allowFail: true,
    })
    if (!b.ok) continue
    /** @type {{ sha: string, line: number, file: string } | null} */
    let cur = null
    for (const text of b.stdout.split('\n')) {
      const head = /^([0-9a-f]{40}) (\d+) \d+/.exec(text)
      if (head?.[1] && head[2]) cur = { sha: head[1], line: Number(head[2]), file: f.oldPath }
      else if (cur && text.startsWith('filename ')) cur.file = text.slice('filename '.length)
      else if (cur && text.startsWith('\t')) {
        const list = byIntro.get(cur.sha) ?? []
        list.push({ file: cur.file, line: cur.line })
        byIntro.set(cur.sha, list)
        cur = null
      }
    }
  }
  return byIntro
}

/** @param {string} id */
const safeId = id => id.replace(/[^\w.-]+/g, '-').slice(0, 60)

const FIX_SUBJECT = /^(?:fix|bugfix|hotfix)\b|\bfix(?:es|ed)?\s+(?:#\d+|bug|crash|regression)/i

/**
 * Proposes draft eval cases from history: reverted commits (the revert marks
 * the bug), fix commits (blame the lines the fix replaced to find the commit
 * that introduced them) and, as should-not-fire cases, commits nothing later
 * reverted or fixed. Drafts need a human to confirm them before they count.
 *
 * Every revert and fix in the scanned history marks the commits it
 * implicates before any case is written, so `--limit` never lets a
 * reverted or fixed commit through as a clean case.
 *
 * @param {string} root
 * @param {{ limit: number, clean: number, maxLines?: number }} opts
 */
export function harvest(root, opts) {
  const log = git(['log', '--no-merges', '-n', '2000', '--format=%H%x1f%P%x1f%s%x1f%b%x1e'], { cwd: root }).stdout
  const commits = log
    .split('\x1e')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => {
      const [sha = '', parents = '', subject = '', body = ''] = s.split('\x1f')
      return { sha, parents: parents.split(' ').filter(Boolean), subject, body }
    })
  const maxLines = opts.maxLines ?? 400
  const dir = evalPaths(root).cases
  /** @type {string[]} */
  const written = []
  /** @type {Set<string>} full shas a later revert or fix implicates */
  const implicated = new Set()
  /** @type {string[]} revert targets that do not resolve: matched by prefix */
  const implicatedPrefixes = []
  /**
   * @param {string} id
   * @param {any} meta
   * @param {any[]} bugs
   */
  const write = (id, meta, bugs) => {
    const caseDir = join(dir, safeId(id))
    if (existsSync(caseDir)) return
    writeJson(join(caseDir, 'case.json'), { id: safeId(id), status: 'draft', ...meta })
    writeJson(join(caseDir, 'expected.json'), { bugs })
    written.push(safeId(id))
  }

  // Pass 1: every revert and fix, newest first. Implication is recorded for
  // all of them; the drafts themselves are built lazily, up to the limit.
  /** @type {(() => void)[]} */
  const bugDrafts = []
  for (const c of commits) {
    const revertedRef = /This reverts commit ([0-9a-f]{7,40})/.exec(c.body)?.[1]
    if (revertedRef) {
      const resolved = git(['rev-parse', '--verify', '--quiet', `${revertedRef}^{commit}`], { cwd: root, allowFail: true })
      if (!resolved.ok) {
        implicatedPrefixes.push(revertedRef)
        continue
      }
      const reverted = resolved.stdout.trim()
      implicated.add(reverted)
      bugDrafts.push(() => {
        const parent = git(['rev-parse', '--verify', '--quiet', `${reverted}^`], { cwd: root, allowFail: true })
        if (!parent.ok) return
        const diff = parseUnifiedDiff(git(['diff', '-U0', `${reverted}^`, reverted], { cwd: root }).stdout)
        const ranges = addedRanges(diff)
        if (!ranges.length || ranges.reduce((a, r) => a + r.endLine - r.line + 1, 0) > maxLines) return
        const subject = git(['log', '-1', '--format=%s', reverted], { cwd: root }).stdout.trim()
        write(
          `revert-${reverted.slice(0, 10)}`,
          {
            kind: 'bug',
            intent: subject,
            whyHard: 'TODO: say why a reviewer would miss this',
            source: { type: 'git', base: parent.stdout.trim(), head: reverted },
            provenance: `reverted by ${c.sha.slice(0, 10)}: ${c.subject}`,
          },
          ranges.map(r => ({ ...r, description: `TODO: narrow to the actual defect (reverted in ${c.sha.slice(0, 10)})` })),
        )
      })
      continue
    }
    if (!FIX_SUBJECT.test(c.subject) || c.parents.length !== 1) continue
    const byIntro = blameRemoved(root, c.sha)
    // Every commit the fix's lines came from is suspect, not only the main one.
    for (const intro of byIntro.keys()) implicated.add(intro)
    const best = [...byIntro.entries()].sort((a, b) => b[1].length - a[1].length)[0]
    if (!best) continue
    const [intro, lines] = best
    bugDrafts.push(() => {
      const parent = git(['rev-parse', '--verify', '--quiet', `${intro}^`], { cwd: root, allowFail: true })
      if (!parent.ok) return
      const subject = git(['log', '-1', '--format=%s', intro], { cwd: root }).stdout.trim()
      write(
        `fix-${c.sha.slice(0, 10)}`,
        {
          kind: 'bug',
          intent: subject,
          whyHard: 'TODO: say why a reviewer would miss this',
          source: { type: 'git', base: parent.stdout.trim(), head: intro },
          provenance: `introduced by ${intro.slice(0, 10)}, fixed by ${c.sha.slice(0, 10)}: ${c.subject}`,
        },
        lineRanges(lines).map(r => ({ ...r, description: `TODO: describe the defect fixed in ${c.sha.slice(0, 10)}` })),
      )
    })
  }
  for (const draft of bugDrafts) {
    if (written.length >= opts.limit) break
    draft()
  }

  const isImplicated = (/** @type {string} */ sha) => implicated.has(sha) || implicatedPrefixes.some(p => sha.startsWith(p))
  let cleanCount = 0
  for (const c of commits.slice(20)) {
    if (cleanCount >= opts.clean) break
    if (isImplicated(c.sha) || c.parents.length !== 1 || /revert|fix/i.test(c.subject)) continue
    const stat = git(['diff', '--numstat', `${c.sha}^`, c.sha], { cwd: root }).stdout.trim().split('\n').filter(Boolean)
    const added = stat.reduce((a, l) => a + (Number(l.split('\t')[0]) || 0), 0)
    if (!stat.length || added === 0 || added > maxLines) continue
    write(
      `clean-${c.sha.slice(0, 10)}`,
      { kind: 'clean', intent: c.subject, whyHard: 'should-not-fire: a change that shipped without incident', source: { type: 'git', base: c.parents[0], head: c.sha } },
      [],
    )
    cleanCount++
  }
  return written
}
