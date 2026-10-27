import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

import { makeRepo, writeFiles } from './helpers.mjs'
import { decideHillclimb, gradeCase, summarize } from '../plugins/quality-loop/scripts/lib/evals.mjs'
import { ensureSplit } from '../plugins/quality-loop/scripts/lib/evalrun.mjs'

const QL = resolve(import.meta.dirname, '../plugins/quality-loop/scripts/ql.mjs')

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {Record<string, string>} [env]
 */
function ql(cwd, args, env = {}) {
  const r = spawnSync(process.execPath, [QL, ...args], { cwd, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', ...env } })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

/** @param {string} cwd @param {string[]} args @param {Record<string, string>} [env] */
function qlOk(cwd, args, env) {
  const r = ql(cwd, args, env)
  assert.equal(r.code, 0, `ql ${args.join(' ')} failed:\n${r.err}\n${r.out}`)
  return r.out
}

/** @param {string} root */
function gitIn(root) {
  const git = (/** @type {string[]} */ args) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
    return r.stdout.trim()
  }
  const commit = (/** @type {string} */ msg) => {
    git(['add', '-A'])
    git(['commit', '-qm', msg])
    return git(['rev-parse', 'HEAD'])
  }
  return { git, commit }
}

/** @param {string} root @param {string} id @param {any} meta @param {any[]} [bugs] */
function writeCase(root, id, meta, bugs = []) {
  writeFiles(root, {
    [`.quality-loop/evals/cases/${id}/case.json`]: JSON.stringify({ id, status: 'confirmed', ...meta }),
    [`.quality-loop/evals/cases/${id}/expected.json`]: JSON.stringify({ bugs }),
  })
}

/**
 * A probe runner: logs what the reviewer process can see (cwd, case-identifying
 * env, the workspace's files, the depth) to $PROBE, then reports nothing.
 */
const PROBE_RUNNER = `#!/bin/sh
{
  echo "PWD=$(pwd)"
  echo "CASE=\${QL_CASE_ID:-}"
  echo "DEPTH=\${QL_DEPTH:-}"
  find . -path ./.git -prune -o -type f -print | sed 's/^/FILE=/'
} >> "$PROBE"
echo '[]' > "$QL_OUTPUT"
`

/** @param {string} root */
function probeSetup(root) {
  const probeDir = mkdtempSync(join(tmpdir(), 'ql-probe-'))
  writeFileSync(join(root, 'probe.sh'), PROBE_RUNNER)
  return { probe: join(probeDir, 'log'), tmp: mkdtempSync(join(tmpdir(), 'ql-tmp-')), runner: `sh ${join(root, 'probe.sh')}` }
}

/** A repository whose history already commits an eval case (answer key included), then a later change. */
function repoWithCommittedEvals() {
  const root = makeRepo({ 'src/x.js': 'export const x = 1\n' })
  const { commit } = gitIn(root)
  writeFiles(root, {
    '.quality-loop/evals/cases/clean-old1/case.json': JSON.stringify({ id: 'clean-old1', kind: 'clean', status: 'confirmed', source: { type: 'files' } }),
    '.quality-loop/evals/cases/clean-old1/expected.json': JSON.stringify({ bugs: [{ file: 'src/x.js', line: 3, description: 'SECRET-ANSWER' }] }),
    '.quality-loop/evals/cases/clean-old1/before/src/x.js': 'export const x = 1\n',
    '.quality-loop/evals/cases/clean-old1/after/src/x.js': 'export const x = 2\n',
  })
  const base = commit('add an eval case')
  writeFiles(root, { 'src/x.js': 'export const x = 1\nexport const y = x / 0\n' })
  const head = commit('add y')
  return { root, base, head }
}

test('materialized workspaces hold no eval answer keys and do not reveal the case id (#28, #29)', () => {
  const { root, base, head } = repoWithCommittedEvals()
  writeCase(root, 'revert-new1', { kind: 'bug', source: { type: 'git', base, head } }, [{ file: 'src/x.js', line: 2 }])
  const { probe, tmp, runner } = probeSetup(root)
  qlOk(root, ['eval', 'run', '--label', 'p', '--runner', runner, '--repeats', '1', '--concurrency', '1'], { PROBE: probe, TMPDIR: tmp })
  const log = readFileSync(probe, 'utf8')
  const files = log.split('\n').filter(l => l.startsWith('FILE='))
  assert.ok(files.some(f => f.endsWith('src/x.js')), log)
  assert.deepEqual(files.filter(f => f.includes('.quality-loop/evals') || f.includes('expected.json')), [], 'no answer keys in the workspace')
  for (const line of log.split('\n').filter(l => l.startsWith('PWD='))) {
    const name = basename(line.slice(4))
    assert.doesNotMatch(name, /old1|new1|revert|clean|bug/, `workspace name leaks the case: ${name}`)
  }
  for (const line of log.split('\n').filter(l => l.startsWith('CASE='))) assert.equal(line, 'CASE=', 'no case id in the runner env')
})

test('a case that cannot be materialised is an infra error; the run still finishes and cleans up (#31)', () => {
  const { root, base, head } = repoWithCommittedEvals()
  writeCase(root, 'good', { kind: 'bug', source: { type: 'git', base, head } }, [{ file: 'src/x.js', line: 2 }])
  writeCase(root, 'gone', { kind: 'bug', source: { type: 'git', base: 'deadbeef'.repeat(5), head: 'deadbeef'.repeat(5) } }, [{ file: 'src/x.js', line: 2 }])
  const { probe, tmp, runner } = probeSetup(root)
  const out = qlOk(root, ['eval', 'run', '--label', 't3', '--runner', runner, '--repeats', '1', '--cases', 'good,gone'], { PROBE: probe, TMPDIR: tmp })
  assert.match(out, /infra: gone r0/)
  const result = JSON.parse(readFileSync(join(root, '.quality-loop/evals/results/t3.json'), 'utf8'))
  assert.equal(result.trials.length, 2)
  assert.equal(result.trials.find((/** @type {any} */ t) => t.caseId === 'good').infraError, null)
  assert.ok(result.trials.find((/** @type {any} */ t) => t.caseId === 'gone').infraError)
  assert.deepEqual(readdirSync(tmp).filter(n => n.startsWith('ql-eval')), [], 'no workspace left behind')
  // A run with infra errors cannot back a keep/revert decision (#30).
  const cmp = ql(root, ['eval', 'compare', 't3', 't3'])
  assert.equal(cmp.code, 1)
  assert.match(cmp.out, /decision: INVALID/)
})

test('hand-written cases without source.type work; invalid ones are flagged, not crashed on (#40)', () => {
  const { root, base, head } = repoWithCommittedEvals()
  // A git case written as the skill describes it: base and head only.
  writeCase(root, 'hand1', { kind: 'bug', source: { base, head } }, [{ file: 'src/x.js', line: 2 }])
  // A before/after case with no source at all.
  writeCase(root, 'hand2', { kind: 'bug' }, [{ file: 'src/a.js', line: 2 }])
  writeFiles(root, {
    '.quality-loop/evals/cases/hand2/before/src/a.js': 'let a = 1\n',
    '.quality-loop/evals/cases/hand2/after/src/a.js': 'let a = 1\nlet b = a / 0\n',
  })
  // Neither git commits nor folders: not runnable.
  writeCase(root, 'hand3', { kind: 'bug' }, [{ file: 'src/a.js', line: 2 }])
  assert.match(qlOk(root, ['eval', 'cases']), /hand3 .*INVALID/)
  const { probe, tmp, runner } = probeSetup(root)
  const out = qlOk(root, ['eval', 'run', '--label', 'h', '--runner', runner, '--repeats', '1', '--concurrency', '1'], { PROBE: probe, TMPDIR: tmp })
  const result = JSON.parse(readFileSync(join(root, '.quality-loop/evals/results/h.json'), 'utf8'))
  const byId = Object.fromEntries(result.trials.map((/** @type {any} */ t) => [t.caseId, t]))
  assert.equal(byId.hand1.infraError, null, out)
  assert.equal(byId.hand2.infraError, null, out)
  assert.ok(byId.hand3.infraError)
  const log = readFileSync(probe, 'utf8')
  assert.match(log, /FILE=\.\/src\/x\.js/)
  assert.match(log, /FILE=\.\/src\/a\.js/)
})

test('ql eval run --depth reaches the runner as QL_DEPTH (#42)', () => {
  const { root, base, head } = repoWithCommittedEvals()
  writeCase(root, 'd1', { kind: 'bug', source: { type: 'git', base, head } }, [{ file: 'src/x.js', line: 2 }])
  const { probe, tmp, runner } = probeSetup(root)
  qlOk(root, ['eval', 'run', '--label', 'q', '--runner', runner, '--repeats', '1', '--depth', 'quick'], { PROBE: probe, TMPDIR: tmp })
  assert.match(readFileSync(probe, 'utf8'), /DEPTH=quick/)
  const result = JSON.parse(readFileSync(join(root, '.quality-loop/evals/results/q.json'), 'utf8'))
  assert.equal(result.depth, 'quick')
  const bad = ql(root, ['eval', 'run', '--label', 'x', '--runner', runner, '--depth', 'huge'], { PROBE: probe, TMPDIR: tmp })
  assert.equal(bad.code, 1)
  assert.match(bad.err, /--depth/)
})

test('compare never keeps a candidate whose failures turned into infra errors (#30)', () => {
  /** @param {[string, boolean | 'infra'][]} rows */
  const mk = rows => rows.map(([caseId, p]) => ({ caseId, repeat: 0, pass: p === true, tp: p === true ? 1 : 0, fp: 0, fn: p === true ? 0 : 1, infraError: p === 'infra' ? 'runner exited 1' : null }))
  const train = summarize(mk([['t1', true], ['t2', false]]), { seed: 1 })
  const base = { train, test: summarize(mk([['e1', true], ['h1', false], ['h2', false]]), { seed: 1 }) }
  const cand = { train, test: summarize(mk([['e1', true], ['h1', 'infra'], ['h2', 'infra']]), { seed: 1 }) }
  const d = decideHillclimb(base, cand, { minDelta: 0.1 })
  assert.notEqual(d.decision, 'keep')
  assert.equal(d.decision, 'invalid')
  // Different scored case sets (e.g. one run limited with --cases) cannot be compared either.
  const fewer = { train, test: summarize(mk([['e1', true]]), { seed: 1 }) }
  assert.equal(decideHillclimb(base, fewer, { minDelta: 0.1 }).decision, 'invalid')
})

test('ensureSplit grows the test split as cases are added one at a time (#32)', () => {
  const root = mkdtempSync(join(tmpdir(), 'ql-split-'))
  const cases = [...['b1', 'b2', 'b3', 'b4'].map(id => ({ id, kind: 'bug' })), { id: 'c1', kind: 'clean' }, { id: 'c2', kind: 'clean' }]
  const first = ensureSplit(root, /** @type {any} */ (cases), { seed: 1, testFraction: 0.3 })
  let prev = first
  for (let i = 5; i <= 11; i++) {
    cases.push({ id: `b${i}`, kind: 'bug' })
    const s = ensureSplit(root, /** @type {any} */ (cases), { seed: 1, testFraction: 0.3 })
    // Stable: no case ever changes side.
    for (const id of prev.test) assert.ok(s.test.includes(id), `${id} stayed in test`)
    for (const id of prev.train) assert.ok(s.train.includes(id), `${id} stayed in train`)
    prev = s
  }
  const bugTest = prev.test.filter((/** @type {string} */ id) => id.startsWith('b')).length
  assert.equal(bugTest, Math.round(11 * 0.3), `test split: ${prev.test.join(', ')}`)
})

test('gradeCase: maximum matching independent of finding order (#33)', () => {
  /** @type {import('../plugins/quality-loop/scripts/lib/evals.mjs').Expected} */
  const expected = { kind: 'bug', bugs: [{ file: 'a.js', line: 10 }, { file: 'a.js', line: 14 }] }
  const p = (/** @type {number} */ line) => ({ file: 'a.js', line, severity: 'important' })
  const g1 = gradeCase(expected, [p(12), p(8)], { tolerance: 5 })
  const g2 = gradeCase(expected, [p(8), p(12)], { tolerance: 5 })
  assert.deepEqual(g1, g2)
  assert.equal(g1.pass, true)
  assert.equal(g1.tp, 2)
  // A multi-line finding matches a multi-line expected bug by range overlap.
  const range = gradeCase({ kind: 'bug', bugs: [{ file: 'a.js', line: 10, endLine: 12 }] }, [{ file: 'a.js', line: 11, endLine: 12, severity: 'important' }], { tolerance: 0 })
  assert.equal(range.pass, true)
})

test('gradeCase: findings tagged pre-existing are not false positives (#34)', () => {
  const pre = [{ file: 'src/old.js', line: 3, severity: 'important', tag: 'pre-existing' }]
  const g = gradeCase({ kind: 'clean', bugs: [] }, pre, { tolerance: 3 })
  assert.equal(g.fp, 0)
  assert.equal(g.pass, true)
  const origin = gradeCase({ kind: 'clean', bugs: [] }, [{ file: 'src/old.js', line: 3, severity: 'important', origin: 'pre-existing' }], { tolerance: 3 })
  assert.equal(origin.pass, true)
})

test('harvest never drafts a reverted or fixed commit as clean, even past --limit; fix lines become ranges (#35, #33)', () => {
  const root = makeRepo({ 'src/a.js': 'export const a = 1\n' })
  const { git, commit } = gitIn(root)
  writeFiles(root, { 'src/w.js': 'export function parseWidget(s) {\n  return JSON.parse(s)\n}\n' })
  const widget = commit('add widget parser')
  git(['revert', '--no-edit', widget])
  writeFiles(root, { 'src/m.js': 'export function m(o) {\n  const v = o.v.w\n  return v.x\n}\n' })
  const alpha = commit('add alpha')
  writeFiles(root, { 'src/m.js': 'export function m(o) {\n  const v = o.v.w\n  return v.x\n}\nexport const k = m.y.z\n' })
  const beta = commit('add beta')
  writeFiles(root, { 'src/m.js': 'export function m(o) {\n  const v = o?.v?.w\n  return v?.x\n}\nexport const k = m?.y?.z\n' })
  const fix = commit('fix: crash in m')
  for (let i = 0; i < 22; i++) {
    writeFiles(root, { [`docs/n${i}.md`]: `note ${i}\n` })
    commit(`docs: note ${i}`)
  }
  writeFiles(root, { 'src/t.js': 'export const t = 1\n' })
  const thing = commit('add thing')
  git(['revert', '--no-edit', thing])

  const out = qlOk(root, ['eval', 'harvest', '--limit', '1', '--clean', '30'])
  assert.match(out, /revert-/)
  for (const sha of [widget, alpha, beta]) assert.doesNotMatch(out, new RegExp(`clean-${sha.slice(0, 10)}`), `${sha} was reverted or fixed`)
  assert.match(out, /clean-/, 'filler commits are still drafted as clean')

  qlOk(root, ['eval', 'harvest', '--limit', '20', '--clean', '0'])
  const fixDir = join(root, `.quality-loop/evals/cases/fix-${fix.slice(0, 10)}`)
  assert.ok(existsSync(fixDir))
  const exp = JSON.parse(readFileSync(join(fixDir, 'expected.json'), 'utf8'))
  assert.deepEqual(
    exp.bugs.map((/** @type {any} */ b) => [b.file, b.line, b.endLine]),
    [['src/m.js', 2, 3]],
    'the contiguous lines the fix replaced are one expected bug',
  )
})

test('ql eval run --depth rejects inherited object keys such as constructor (#42)', () => {
  const { root, base, head } = repoWithCommittedEvals()
  writeCase(root, 'd1', { kind: 'bug', source: { type: 'git', base, head } }, [{ file: 'src/x.js', line: 2 }])
  const { probe, tmp, runner } = probeSetup(root)
  for (const depth of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const r = ql(root, ['eval', 'run', '--label', `x-${depth}`, '--runner', runner, '--repeats', '1', '--depth', depth], { PROBE: probe, TMPDIR: tmp })
    assert.equal(r.code, 1, `--depth ${depth} was accepted:\n${r.err}`)
    assert.match(r.err, /--depth must be one of/)
  }
  assert.equal(existsSync(probe), false, 'the runner never ran')
})

test('cases whose ids map to the same file name keep separate transcripts (#31)', () => {
  const { root, base, head } = repoWithCommittedEvals()
  // 'a/b' and 'a-b' both sanitise to 'a-b'; the second cannot be built.
  writeFiles(root, {
    '.quality-loop/evals/cases/one/case.json': JSON.stringify({ id: 'a/b', kind: 'bug', status: 'confirmed', source: { type: 'git', base, head } }),
    '.quality-loop/evals/cases/one/expected.json': JSON.stringify({ bugs: [] }),
    '.quality-loop/evals/cases/two/case.json': JSON.stringify({ id: 'a-b', kind: 'bug', status: 'confirmed', source: { type: 'git', base: 'deadbeef'.repeat(5), head: 'deadbeef'.repeat(5) } }),
    '.quality-loop/evals/cases/two/expected.json': JSON.stringify({ bugs: [] }),
  })
  const { probe, tmp, runner } = probeSetup(root)
  qlOk(root, ['eval', 'run', '--label', 'ids', '--runner', runner, '--repeats', '1', '--concurrency', '1'], { PROBE: probe, TMPDIR: tmp })
  const result = JSON.parse(readFileSync(join(root, '.quality-loop/evals/results/ids.json'), 'utf8'))
  const byId = Object.fromEntries(result.trials.map((/** @type {any} */ t) => [t.caseId, t]))
  assert.notEqual(byId['a/b'].transcript, byId['a-b'].transcript)
  assert.match(readFileSync(byId['a-b'].transcript, 'utf8'), /could not build the case workspace/)
  assert.doesNotMatch(readFileSync(byId['a/b'].transcript, 'utf8'), /could not build/)
  // Long ids that share a 60-character prefix do not collide either.
  const long = 'x'.repeat(70)
  writeCase(root, 'l1', { id: `${long}1`, kind: 'bug', source: { type: 'git', base, head } })
  writeCase(root, 'l2', { id: `${long}2`, kind: 'bug', source: { type: 'git', base, head } })
  qlOk(root, ['eval', 'run', '--label', 'long', '--runner', runner, '--repeats', '1', '--cases', `${long}1,${long}2`], { PROBE: probe, TMPDIR: tmp })
  const lr = JSON.parse(readFileSync(join(root, '.quality-loop/evals/results/long.json'), 'utf8'))
  assert.equal(lr.trials.length, 2)
  assert.equal(new Set(lr.trials.map((/** @type {any} */ t) => t.transcript)).size, 2)
})

test('INVALID from changed case sets says what to rerun; rerunning the best on the current cases clears it', () => {
  const { root, base, head } = repoWithCommittedEvals()
  for (const id of ['e1', 'e2', 'e3', 'e4']) writeCase(root, id, { kind: 'bug', source: { type: 'git', base, head } }, [{ file: 'src/x.js', line: 2 }])
  const { probe, tmp, runner } = probeSetup(root)
  const env = { PROBE: probe, TMPDIR: tmp }
  qlOk(root, ['eval', 'run', '--label', 'base', '--runner', runner, '--repeats', '1'], env)
  // A stall analysis drops a case; the next candidate runs on the remaining cases.
  const split = JSON.parse(readFileSync(join(root, '.quality-loop/evals/split.json'), 'utf8'))
  const dropped = split.test[0]
  rmSync(join(root, '.quality-loop/evals/cases', dropped), { recursive: true })
  mkdirSync(join(root, '.quality-loop/work'), { recursive: true })
  writeFileSync(join(root, '.quality-loop/work/REVIEW.best.md'), '')
  writeFileSync(join(root, '.quality-loop/REVIEW.md'), 'candidate rule\n')
  qlOk(root, ['eval', 'run', '--label', 'cand', '--runner', runner, '--repeats', '1'], env)
  const cmp = ql(root, ['eval', 'compare', 'base', 'cand'])
  assert.equal(cmp.code, 1)
  assert.match(cmp.out, /decision: INVALID/)
  assert.match(cmp.out, new RegExp(`only in base: ${dropped}`), cmp.out)
  assert.match(cmp.out, /rerun the best/i, cmp.out)
  // The skill says how: rerun the best's saved surface on the current cases.
  const skill = readFileSync(resolve(import.meta.dirname, '../plugins/quality-loop/skills/tune-reviewer/SKILL.md'), 'utf8')
  assert.match(skill, /--surface \.quality-loop\/work\/REVIEW\.best\.md/)
  assert.match(qlOk(root, ['--help']), /eval run .*--surface/)
  // A mistyped surface is an error, not a silent run with an empty REVIEW.md.
  const typo = ql(root, ['eval', 'run', '--label', 'typo', '--runner', runner, '--repeats', '1', '--surface', '.quality-loop/work/REVIEW.bset.md'], env)
  assert.equal(typo.code, 1)
  assert.match(typo.err, /--surface/)
  qlOk(root, ['eval', 'run', '--label', 'base2', '--runner', runner, '--repeats', '1', '--surface', '.quality-loop/work/REVIEW.best.md'], env)
  const again = ql(root, ['eval', 'compare', 'base2', 'cand'])
  assert.equal(again.code, 0, again.out)
  assert.doesNotMatch(again.out, /INVALID/)
})

test('harvest skips changes that touch only .quality-loop/: materialised, they would be empty', () => {
  const root = makeRepo({ 'src/a.js': 'export const a = 1\n' })
  const { git, commit } = gitIn(root)
  writeFiles(root, { '.quality-loop/REVIEW.md': 'rule one\nrule two\n' })
  const tune = commit('tune review rules')
  writeFiles(root, { '.quality-loop/REVIEW.md': 'rule one\nrule two\nrule three\n' })
  const tune2 = commit('tune review rules again')
  git(['revert', '--no-edit', tune2])
  writeFiles(root, { '.quality-loop/REVIEW.md': 'rule one\nrule 2\n' })
  const fixRules = commit('fix: rule two was misleading')
  // A mixed change counts only its code lines.
  writeFiles(root, { 'src/b.js': 'export const b = 2\n', '.quality-loop/REVIEW.md': 'rule one\nrule 2\nrule four\n' })
  const mixed = commit('add b')
  for (let i = 0; i < 21; i++) {
    writeFiles(root, { [`docs/n${i}.md`]: `note ${i}\n` })
    commit(`docs: note ${i}`)
  }
  const out = qlOk(root, ['eval', 'harvest', '--limit', '20', '--clean', '30'])
  for (const sha of [tune, tune2]) assert.doesNotMatch(out, new RegExp(`-${sha.slice(0, 10)}`), `${sha} touches only .quality-loop/`)
  assert.doesNotMatch(out, new RegExp(`fix-${fixRules.slice(0, 10)}`), 'a fix of .quality-loop/ lines is not a code bug')
  assert.match(out, new RegExp(`clean-${mixed.slice(0, 10)}`), 'a change with code lines is still drafted')
})

test('gradeCase: a finding spanning a whole file does not match every bug in it', () => {
  const wide = gradeCase({ kind: 'bug', bugs: [{ file: 'a.js', line: 100, endLine: 120 }] }, [{ file: 'a.js', line: 1, endLine: 500 }], { tolerance: 0 })
  assert.deepEqual([wide.tp, wide.fp, wide.fn, wide.pass], [0, 1, 1, false])
  const wide5 = gradeCase({ kind: 'bug', bugs: [{ file: 'a.js', line: 300 }] }, [{ file: 'a.js', line: 1, endLine: 500 }], { tolerance: 5 })
  assert.equal(wide5.pass, false)
  // A wide finding still matches a bug at its first line, give or take the tolerance.
  const anchored = gradeCase({ kind: 'bug', bugs: [{ file: 'a.js', line: 104 }] }, [{ file: 'a.js', line: 100, endLine: 500 }], { tolerance: 5 })
  assert.equal(anchored.pass, true)
  // A range no longer than tolerance × 4 lines matches by overlap as before.
  const narrow = gradeCase({ kind: 'bug', bugs: [{ file: 'a.js', line: 28 }] }, [{ file: 'a.js', line: 10, endLine: 25 }], { tolerance: 5 })
  assert.equal(narrow.pass, true)
})

test('INVALID caused only by infra errors does not claim the cases changed', () => {
  /** @param {[string, boolean | 'infra'][]} rows */
  const mk = rows => rows.map(([caseId, p]) => ({ caseId, repeat: 0, pass: p === true, tp: p === true ? 1 : 0, fp: 0, fn: p === true ? 0 : 1, infraError: p === 'infra' ? 'runner exited 1' : null }))
  const train = summarize(mk([['t1', true], ['t2', false]]), { seed: 1 })
  const base = { train, test: summarize(mk([['e1', true], ['h1', false], ['h2', false]]), { seed: 1 }) }
  const cand = { train, test: summarize(mk([['e1', true], ['h1', 'infra'], ['h2', 'infra']]), { seed: 1 }) }
  const d = decideHillclimb(base, cand, { minDelta: 0.1 })
  assert.equal(d.decision, 'invalid')
  assert.match(d.reason, /infra error/)
  assert.match(d.reason, /h1, h2/, 'names the cases the infra errors hid')
  assert.doesNotMatch(d.reason, /different/, d.reason)
  assert.doesNotMatch(d.reason, /rerun the best/, d.reason)
  // A case really dropped is still reported, next to the infra errors.
  const dropped = { train, test: summarize(mk([['h1', 'infra'], ['h2', 'infra']]), { seed: 1 }) }
  const d2 = decideHillclimb(base, dropped, { minDelta: 0.1 })
  assert.match(d2.reason, /different test cases \(only in base: e1\)/, d2.reason)
  assert.match(d2.reason, /rerun the best/)
})

test('--surface resolves against the repo root in eval run, leakcheck and hillclimb start', () => {
  const { root, base, head } = repoWithCommittedEvals()
  writeCase(root, 'k1', { kind: 'bug', source: { type: 'git', base, head } }, [{ file: 'src/x.js', line: 2 }])
  writeFiles(root, { 's.md': 'Watch src/x.js closely\n', 'sub/s.md': 'nothing here\n' })
  const real = realpathSync(root)
  const sub = join(root, 'sub')
  const { probe, tmp, runner } = probeSetup(root)
  qlOk(sub, ['eval', 'run', '--label', 's', '--runner', runner, '--repeats', '1', '--surface', 's.md'], { PROBE: probe, TMPDIR: tmp })
  const result = JSON.parse(readFileSync(join(root, '.quality-loop/evals/results/s.json'), 'utf8'))
  assert.equal(result.surfacePath, join(real, 's.md'))
  const leak = ql(sub, ['eval', 'leakcheck', '--surface', 's.md'])
  assert.equal(leak.code, 1, leak.out)
  assert.match(leak.out, /LEAK \(path\) from case k1/)
  const missing = ql(sub, ['eval', 'leakcheck', '--surface', 'nope.md'])
  assert.equal(missing.code, 1, missing.err)
  assert.match(missing.err, /--surface: no such file/)
  qlOk(sub, ['eval', 'hillclimb', 'start', '--surface', 's.md'])
  assert.equal(JSON.parse(readFileSync(join(root, '.quality-loop/evals/hillclimb.json'), 'utf8')).surface, join(real, 's.md'))
  qlOk(sub, ['eval', 'hillclimb', 'stop'])
})

test('an inherited QL_DEPTH is recorded as the run depth, and validated', () => {
  const { root, base, head } = repoWithCommittedEvals()
  writeCase(root, 'd1', { kind: 'bug', source: { type: 'git', base, head } }, [{ file: 'src/x.js', line: 2 }])
  const { probe, tmp, runner } = probeSetup(root)
  const out = qlOk(root, ['eval', 'run', '--label', 'envdeep', '--runner', runner, '--repeats', '1'], { PROBE: probe, TMPDIR: tmp, QL_DEPTH: 'deep' })
  assert.match(readFileSync(probe, 'utf8'), /DEPTH=deep/)
  assert.match(out, /· depth deep/)
  assert.equal(JSON.parse(readFileSync(join(root, '.quality-loop/evals/results/envdeep.json'), 'utf8')).depth, 'deep')
  // --depth wins over the environment.
  qlOk(root, ['eval', 'run', '--label', 'flag', '--runner', runner, '--repeats', '1', '--depth', 'quick'], { PROBE: probe, TMPDIR: tmp, QL_DEPTH: 'deep' })
  assert.equal(JSON.parse(readFileSync(join(root, '.quality-loop/evals/results/flag.json'), 'utf8')).depth, 'quick')
  const bad = ql(root, ['eval', 'run', '--label', 'bad', '--runner', runner, '--repeats', '1'], { PROBE: probe, TMPDIR: tmp, QL_DEPTH: 'huge' })
  assert.equal(bad.code, 1, bad.err)
  assert.match(bad.err, /QL_DEPTH/)
})
