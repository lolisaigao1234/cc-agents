// Context budgets: the orchestrating session's window is the loop's scarcest
// resource. Agent briefs live in files `ql brief` writes, ql prints one short
// line per item by default (details on demand: --json or a file), the round
// protocol is read one step file at a time, and LOOP.md stays bounded. These
// tests pin those budgets on a deterministic CLI loop.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

import { makeRepo, writeFiles } from './helpers.mjs'

const PLUGIN = resolve(import.meta.dirname, '../plugins/quality-loop')
const QL = join(PLUGIN, 'scripts/ql.mjs')

/** @param {string} cwd @param {string[]} args @param {string} [input] */
function ql(cwd, args, input) {
  const r = spawnSync(process.execPath, [QL, ...args], { cwd, input, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

/** @param {string} cwd @param {string[]} args @param {string} [input] */
function qlOk(cwd, args, input) {
  const r = ql(cwd, args, input)
  assert.equal(r.code, 0, `ql ${args.join(' ')} failed:\n${r.err}\n${r.out}`)
  return r.out
}

/** @param {string} out */
const lines = out => out.split('\n').filter(l => l.trim() !== '')
/** @param {string} cwd */
const state = cwd => JSON.parse(readFileSync(join(cwd, '.quality-loop/state.json'), 'utf8'))
const LENSES = ['correctness', 'security', 'regressions-and-edge-cases', 'conventions']
const LONG = 'x'.repeat(3000)

/**
 * A repository whose uncommitted change touches `n` lines of src/many.js,
 * with one passing required check.
 *
 * @param {number} n
 * @param {object} [config]
 */
function project(n, config = {}) {
  const base = Array.from({ length: n }, (_, i) => `export const v${i} = ${i}`)
  const root = makeRepo({
    'src/many.js': base.join('\n') + '\n',
    'ok.check.mjs': 'process.exit(0)\n',
    '.quality-loop/config.json': JSON.stringify({ checks: [{ name: 'ok', cmd: 'node ok.check.mjs', required: true }], ...config }),
  })
  writeFiles(root, { 'src/many.js': base.map(l => `${l} // changed`).join('\n') + '\n' })
  return root
}

/** @param {number} i */
const finding = i => ({
  title: `Value ${i} is off by one`,
  file: 'src/many.js',
  line: i + 1,
  quote: `export const v${i} = ${i} // changed`,
  category: 'correctness',
  severity: 'important',
  bugClass: `class-${i}`,
  explanation: `v${i} should be ${i + 1}.`,
  failureScenario: `Reading v${i} returns ${i}.`,
})

/** Ingests findings 0..n-1 under correctness and closes the other lenses. @param {string} root @param {number} n */
function review(root, n) {
  const out = qlOk(root, ['ingest', '-', '--lens', 'correctness'], JSON.stringify(Array.from({ length: n }, (_, i) => finding(i))))
  for (const lens of LENSES.slice(1)) qlOk(root, ['ingest', '--none', '--lens', lens])
  return out
}

/** @param {string} root @param {string} id @param {number} n @param {'confirm' | 'reject'} [verdict] */
function votes(root, id, n, verdict = 'confirm') {
  const vs = Array.from({ length: n }, (_, k) => ({ id, verdict, voter: `v${k}-${id}`, reason: `traced ${LONG}`, severity: 'important' }))
  return qlOk(root, ['vote', '-'], JSON.stringify(vs))
}

/** The `<agent> <brief> -> <output>` lines `ql brief` prints. @param {string} out */
function briefLines(out) {
  return lines(out).map(l => {
    const m = /^(bug-hunter|finding-verifier|fixer|root-cause-investigator) (\S+) -> (\S+)/.exec(l)
    assert.ok(m, `not a brief line: ${l}`)
    assert.ok(l.length <= 200, `brief line too long (${l.length}): ${l}`)
    return { agent: m[1], brief: /** @type {string} */ (m[2]), output: /** @type {string} */ (m[3]), line: l }
  })
}

/** @param {string} root @param {string} p */
const readAt = (root, p) => readFileSync(isAbsolute(p) ? p : join(root, p), 'utf8')

// --- 1. file-backed briefs

test('brief hunters: one brief file per configured lens holding everything the hunter needs; one short line each', () => {
  const root = project(3)
  qlOk(root, ['start', '--mode', 'review', '--goal', 'ship the values'])
  qlOk(root, ['round', 'begin'])
  const out = qlOk(root, ['brief', 'hunters', '--intent', 'Bump every value by one'])
  const briefs = briefLines(out)
  assert.deepEqual(briefs.map(b => b.agent), LENSES.map(() => 'bug-hunter'))
  for (const [i, lens] of LENSES.entries()) {
    const b = /** @type {(typeof briefs)[number]} */ (briefs[i])
    assert.match(b.brief, new RegExp(`work/round-1/briefs/hunter-${lens}\\.md$`))
    assert.match(b.output, new RegExp(`work/round-1/hunter-${lens}\\.json$`))
    const text = readAt(root, b.brief)
    assert.match(text, new RegExp(`\\b${lens}\\b`))
    assert.match(text, /src\/many\.js/, 'the changed files')
    assert.match(text, /work\/round-1\/scope\.diff/, 'the scope diff path')
    assert.match(text, /REVIEW\.md/)
    assert.match(text, /Bump every value by one/, 'the intent')
    assert.match(text, /ship the values/, 'the finish line')
    assert.ok(text.includes(b.output), 'the exact output path')
  }
  assert.match(readAt(root, /** @type {any} */ (briefs[1]).brief), /Injection/, "the lens's focus text")
  // The intent is kept for later briefs of this loop.
  qlOk(root, ['brief', 'hunters'])
  assert.match(readAt(root, /** @type {any} */ (briefs[0]).brief), /Bump every value by one/)
})

test('round begin is short: diff path, file count and lens names; the lens focus text lives in the hunter briefs', () => {
  const root = project(3, { review: { depth: 'deep' } })
  qlOk(root, ['start', '--mode', 'review'])
  const out = qlOk(root, ['round', 'begin'])
  assert.ok(lines(out).length <= 5, `round begin printed ${lines(out).length} lines:\n${out}`)
  assert.match(out, /scope\.diff/)
  assert.match(out, /1 file/)
  assert.match(out, /concurrency-and-resources/)
  assert.doesNotMatch(out, /Injection|Races/, 'no focus text on stdout')
  const briefs = briefLines(qlOk(root, ['brief', 'hunters']))
  assert.equal(briefs.length, 6)
  assert.match(readAt(root, /** @type {any} */ (briefs.find(b => /concurrency/.test(b.brief))).brief), /Races/)
})

test('brief hunters refreshes the scope (a debug fix made after round begin is in it), and an empty scope writes no brief', () => {
  const root = makeRepo({ 'calc.js': 'export const add = (a, b) => a - b\n', 'add.check.mjs': "import { add } from './calc.js'\nprocess.exit(add(2, 3) === 5 ? 0 : 1)\n" })
  qlOk(root, ['start', '--mode', 'debug', '--repro', 'node add.check.mjs'])
  qlOk(root, ['round', 'begin'])
  const empty = qlOk(root, ['brief', 'hunters'])
  assert.match(empty, /scope is empty/)
  assert.equal(existsSync(join(root, '.quality-loop/work/round-1/briefs')), false)
  writeFileSync(join(root, 'calc.js'), 'export const add = (a, b) => a + b\n')
  const briefs = briefLines(qlOk(root, ['brief', 'hunters']))
  assert.ok(briefs.length > 0)
  assert.match(readFileSync(join(root, '.quality-loop/work/round-1/scope.diff'), 'utf8'), /\+export const add = \(a, b\) => a \+ b/)
  assert.match(readAt(root, /** @type {any} */ (briefs[0]).brief), /calc\.js/)
})

test('brief verifiers: one brief per missing vote, distinct stances, holding the finding, stance, voter name and output path', () => {
  const root = project(3)
  qlOk(root, ['start', '--mode', 'review'])
  qlOk(root, ['round', 'begin'])
  review(root, 2)
  const briefs = briefLines(qlOk(root, ['brief', 'verifiers']))
  assert.equal(briefs.length, 6, 'standard depth: 3 verifiers for each of 2 candidates')
  for (const id of ['F1', 'F2']) {
    const mine = briefs.filter(b => new RegExp(`verify-${id}-`).test(b.brief))
    assert.equal(mine.length, 3)
    const stances = mine.map(b => /verify-F\d+-([a-z-]+)\.md$/.exec(b.brief)?.[1])
    assert.equal(new Set(stances).size, 3, 'each voter takes a different stance')
    for (const b of mine) {
      const stance = /verify-F\d+-([a-z-]+)\.md$/.exec(b.brief)?.[1]
      assert.equal(b.agent, 'finding-verifier')
      assert.match(b.output, new RegExp(`work/round-1/vote-${id}-${stance}\\.json$`))
      const text = readAt(root, b.brief)
      assert.match(text, new RegExp(`\\b${stance}-${id}\\b`), 'the voter name')
      assert.match(text, new RegExp(`Stance: \\*\\*${stance}\\*\\*`))
      assert.match(text, new RegExp(`"id": "${id}"`), 'the finding JSON')
      assert.match(text, /"quote": "export const v\d = \d \/\/ changed"/)
      assert.ok(text.includes(b.output))
    }
  }
  // A vote already in takes its stance out of the next batch.
  qlOk(root, ['vote', '-'], JSON.stringify({ id: 'F1', voter: 'trace-F1', verdict: 'confirm', reason: 'traced', severity: 'important' }))
  const again = briefLines(qlOk(root, ['brief', 'verifiers'])).filter(b => /verify-F1-/.test(b.brief))
  assert.equal(again.length, 2)
  assert.ok(again.every(b => !/verify-F1-trace\.md$/.test(b.brief)))
  assert.doesNotMatch(readAt(root, /** @type {any} */ (again[0]).brief), /"votes"/, 'a verifier does not see the other votes')
})

test('brief fix: one brief per open bug class with every instance, the check commands and the output path', () => {
  const root = project(3)
  qlOk(root, ['start', '--mode', 'review'])
  qlOk(root, ['round', 'begin'])
  const same = (/** @type {number} */ i) => ({ ...finding(i), bugClass: 'off-by-one' })
  qlOk(root, ['ingest', '-', '--lens', 'correctness'], JSON.stringify([same(0), same(1), finding(2)]))
  for (const lens of LENSES.slice(1)) qlOk(root, ['ingest', '--none', '--lens', lens])
  for (const id of ['F1', 'F2', 'F3']) votes(root, id, 2)
  const all = briefLines(qlOk(root, ['brief', 'fix', '--all']))
  assert.deepEqual(all.map(b => b.agent), ['fixer', 'fixer'])
  const cls = /** @type {any} */ (all.find(b => /fix-off-by-one\.md$/.test(b.brief)))
  assert.match(cls.output, /work\/round-1\/fix-off-by-one\.json$/)
  const text = readAt(root, cls.brief)
  assert.match(text, /"id": "F1"/)
  assert.match(text, /"id": "F2"/)
  assert.doesNotMatch(text, /"id": "F3"/)
  assert.match(text, /node ok\.check\.mjs/, 'the check commands')
  assert.ok(text.includes(cls.output))
  const one = briefLines(qlOk(root, ['brief', 'fix', 'class-2']))
  assert.equal(one.length, 1)
  assert.equal(ql(root, ['brief', 'fix', 'no-such-class']).code, 1)
})

test('brief investigate: the symptom, repro, hypothesis and output path, numbered per hypothesis', () => {
  const root = makeRepo({ 'calc.js': 'export const add = (a, b) => a - b\n', 'add.check.mjs': "import { add } from './calc.js'\nprocess.exit(add(2, 3) === 5 ? 0 : 1)\n" })
  qlOk(root, ['start', '--mode', 'debug', '--repro', 'node add.check.mjs', '--goal', 'add(2, 3) returns 5'])
  qlOk(root, ['round', 'begin'])
  const [first] = briefLines(qlOk(root, ['brief', 'investigate', '--hypothesis', 'add subtracts instead of adding']))
  assert.ok(first)
  assert.equal(first.agent, 'root-cause-investigator')
  assert.match(first.output, /work\/round-1\/hypothesis-1\.json$/)
  const text = readAt(root, first.brief)
  assert.match(text, /add subtracts instead of adding/)
  assert.match(text, /node add\.check\.mjs/)
  assert.match(text, /add\(2, 3\) returns 5/)
  assert.ok(text.includes(first.output))
  const [second] = briefLines(qlOk(root, ['brief', 'investigate', '--hypothesis', 'the check imports a stale build']))
  assert.match(/** @type {any} */ (second).output, /hypothesis-2\.json$/)
  const [chosen] = briefLines(qlOk(root, ['brief', 'investigate', '--hypothesis', 'x', '--k', '7']))
  assert.match(/** @type {any} */ (chosen).output, /hypothesis-7\.json$/)
})

// --- 2. agents read the brief file and reply in one line

test('agents: the brief is a file read first, and the final reply is one line naming the output file and a count', () => {
  for (const agent of ['bug-hunter', 'finding-verifier', 'fixer', 'root-cause-investigator']) {
    const md = readFileSync(join(PLUGIN, 'agents', `${agent}.md`), 'utf8')
    assert.match(md, /Brief: <path>/, `${agent}: the prompt is the brief path`)
    assert.match(md, /[Rr]ead (the|your) brief( file)? first/, `${agent}: reads the brief first`)
    assert.match(md, /reply with one line/i, `${agent}: one-line final reply`)
    assert.match(md, /output path/i)
  }
})

// --- 3. terse output by default

test('ingest prints counts, ids and one line per refusal', () => {
  const root = project(30)
  qlOk(root, ['start', '--mode', 'review'])
  qlOk(root, ['round', 'begin'])
  const bad = [0, 1, 2].map(i => ({ ...finding(i), quote: `not in the file ${i}`, title: `Invented ${i} ${LONG}`, bugClass: `inv-${i}` }))
  const out = qlOk(root, ['ingest', '-', '--lens', 'correctness'], JSON.stringify([...Array.from({ length: 30 }, (_, i) => finding(i)), ...bad]))
  const ls = lines(out)
  assert.ok(ls.length <= 1 + 3 + 2, `ingest printed ${ls.length} lines:\n${out}`)
  assert.match(out, /30 new/)
  assert.match(out, /F1\b/)
  assert.match(out, /F30\b/)
  assert.equal(ls.filter(l => /quote-not-found/.test(l)).length, 3)
  for (const l of ls) assert.ok(l.length <= (l.startsWith('next:') ? 320 : 240), `line too long (${l.length}): ${l}`)
})

test('pending prints one line per finding and where the full JSON is', () => {
  const root = project(30)
  qlOk(root, ['start', '--mode', 'review'])
  qlOk(root, ['round', 'begin'])
  review(root, 30)
  const out = qlOk(root, ['pending'])
  const ls = lines(out)
  assert.ok(ls.length <= 30 + 2, `pending printed ${ls.length} lines`)
  assert.equal(ls.filter(l => /^F\d+ /.test(l)).length, 30)
  assert.match(out, /F7 important src\/many\.js:7 Value 6 is off by one/)
  for (const l of ls) assert.ok(l.length <= 200, `line too long (${l.length}): ${l}`)
  const where = /(\S+pending\.json)/.exec(out)?.[1]
  assert.ok(where, 'names the JSON file')
  assert.equal(JSON.parse(readAt(root, where)).findings.length, 30)
  assert.equal(JSON.parse(qlOk(root, ['pending', '--json'])).findings.length, 30, '--json still prints it all')
})

test('vote prints one line per finding touched (id, outcome, tally) and never echoes the votes', () => {
  const root = project(5)
  qlOk(root, ['start', '--mode', 'review'])
  qlOk(root, ['round', 'begin'])
  review(root, 5)
  const vs = ['F1', 'F2', 'F3', 'F4', 'F5'].flatMap(id =>
    ['a', 'b', 'c'].map(v => ({ id, voter: `${v}-${id}`, verdict: id === 'F5' ? 'reject' : 'confirm', reason: `seen ${LONG}`, severity: 'important' })),
  )
  vs.push({ id: 'F99', voter: 'z', verdict: 'confirm', reason: LONG, severity: 'important' })
  const out = qlOk(root, ['vote', '-'], JSON.stringify(vs))
  const ls = lines(out)
  assert.ok(ls.length <= 5 + 1 + 2, `vote printed ${ls.length} lines:\n${out}`)
  assert.match(out, /^F1: confirmed · 3 confirm, 0 reject/m)
  assert.match(out, /^F5: rejected · 0 confirm, 3 reject/m)
  assert.equal(ls.filter(l => /invalid vote/.test(l)).length, 1)
  assert.doesNotMatch(out, /xxxxxxxxxx/, 'no vote reasons echoed')
  assert.ok(out.length < 1200, `vote printed ${out.length} chars`)
})

test('checks, start and round end print one line per check; a failing check shows at most 15 tail lines and its log path', () => {
  const noisy = 'node -e "for (let i = 0; i < 100; i++) console.log(\'line \' + i); process.exit(1)"'
  const root = project(2, { checks: [{ name: 'ok', cmd: 'node ok.check.mjs', required: true }, { name: 'noisy', cmd: noisy, required: true }] })
  for (const out of [ql(root, ['checks']).out, qlOk(root, ['start', '--mode', 'review'])]) {
    assert.match(out, /^PASS ok/m)
    assert.match(out, /^FAIL noisy/m)
    assert.match(out, /line 99/)
    assert.doesNotMatch(out, /line 84\b/)
    assert.match(out, /\.log/, 'the full log path')
    assert.ok(lines(out).length <= 24, `printed ${lines(out).length} lines:\n${out}`)
  }
  qlOk(root, ['round', 'begin'])
  review(root, 0)
  const end = qlOk(root, ['round', 'end'])
  assert.doesNotMatch(end, /line 84\b/)
  assert.ok(lines(end).length <= 26, `round end printed ${lines(end).length} lines:\n${end}`)
})

// --- 4. the protocol, one step file at a time

/** @param {string} out */
const stepsNamed = out => [...out.matchAll(/step: (\S+)/g)].map(m => /** @type {string} */ (m[1]))

test('`ql next` names the absolute path of an existing step file for each phase of a fixing loop', () => {
  const root = project(2)
  /** @type {Record<string, string>} */
  const seen = {}
  const at = (/** @type {string} */ phase) => {
    const out = qlOk(root, ['next'])
    const [step] = stepsNamed(out)
    assert.ok(step, `ql next in phase ${phase} names a step file:\n${out}`)
    assert.ok(isAbsolute(step), step)
    assert.ok(existsSync(step), `${step} exists`)
    seen[phase] = step
  }
  qlOk(root, ['start', '--mode', 'review'])
  at('begin')
  qlOk(root, ['round', 'begin'])
  at('review')
  review(root, 1)
  at('verify')
  votes(root, 'F1', 2)
  at('fix')
  writeFiles(root, { 'src/many.js': readFileSync(join(root, 'src/many.js'), 'utf8').replace('v0 = 0 // changed', 'v0 = 1 // changed') })
  qlOk(root, ['mark', 'F1', 'fixed', '--reason', 'bumped'])
  at('end')
  assert.match(seen.begin ?? '', /round\/1-begin\.md$/)
  assert.match(seen.review ?? '', /round\/2-review\.md$/)
  assert.match(seen.verify ?? '', /round\/3-verify\.md$/)
  assert.match(seen.fix ?? '', /round\/4-fix\.md$/)
  assert.match(seen.end ?? '', /round\/5-validate\.md$/)
  const end = qlOk(root, ['round', 'end'])
  assert.match(end, /decision: DONE/)
  assert.match(stepsNamed(end).join(' '), /round\/decisions\.md$/, 'round end points at the decision table')
  assert.ok(existsSync(join(PLUGIN, 'references/round/decisions.md')))
})

test('a review-only run never points at the fix or validate steps', () => {
  const root = project(2)
  const named = [...stepsNamed(qlOk(root, ['start', '--mode', 'review', '--review-only']))]
  named.push(...stepsNamed(qlOk(root, ['next'])))
  named.push(...stepsNamed(qlOk(root, ['round', 'begin'])))
  named.push(...stepsNamed(qlOk(root, ['next'])))
  named.push(...stepsNamed(review(root, 1)))
  named.push(...stepsNamed(qlOk(root, ['next'])))
  named.push(...stepsNamed(votes(root, 'F1', 3)))
  named.push(...stepsNamed(qlOk(root, ['next'])))
  qlOk(root, ['finish'])
  named.push(...stepsNamed(qlOk(root, ['next'])))
  assert.ok(named.some(p => /2-review\.md$/.test(p)))
  assert.ok(named.some(p => /3-verify\.md$/.test(p)))
  for (const p of named) assert.doesNotMatch(p, /4-fix|5-validate|decisions/, p)
})

test('the protocol is split into small step files and the skills read a step only when `ql next` names it', () => {
  assert.equal(existsSync(join(PLUGIN, 'references/round-protocol.md')), false, 'no monolithic protocol to read up front')
  const dir = join(PLUGIN, 'references/round')
  const files = readdirSync(dir).sort()
  assert.deepEqual(files, ['1-begin.md', '2-review.md', '3-verify.md', '4-fix.md', '5-validate.md', 'decisions.md'])
  for (const f of files) {
    const size = readFileSync(join(dir, f), 'utf8').length
    assert.ok(size <= 2600, `${f} is ${size} chars`)
  }
  for (const skill of ['improve', 'review', 'debug']) {
    const md = readFileSync(join(PLUGIN, 'skills', skill, 'SKILL.md'), 'utf8')
    assert.doesNotMatch(md, /round-protocol\.md/, skill)
    assert.doesNotMatch(md, /read (it|that file) now/i, `${skill}: no reading ahead`)
    assert.match(md, /step file/i, `${skill}: reads the step file ql names`)
  }
  assert.doesNotMatch(readFileSync(join(PLUGIN, 'skills/review/SKILL.md'), 'utf8'), /4-fix|5-validate|decisions\.md/)
})

// --- 5. LOOP.md stays bounded

test('LOOP.md lists at most 10 open findings, then how many more and where to see them', () => {
  const root = project(30)
  qlOk(root, ['start', '--mode', 'review'])
  qlOk(root, ['round', 'begin'])
  review(root, 30)
  const md = readFileSync(join(root, '.quality-loop/LOOP.md'), 'utf8')
  const rows = md.split('\n').filter(l => /^\| F\d+ /.test(l))
  assert.equal(rows.length, 10)
  assert.match(md, /\+20 more: `ql pending`/)
  assert.ok(md.length < 3000, `LOOP.md is ${md.length} chars`)
  // Confirmed findings come before candidates.
  votes(root, 'F30', 2)
  const after = readFileSync(join(root, '.quality-loop/LOOP.md'), 'utf8')
  assert.match(after.split('\n').filter(l => /^\| F\d+ /.test(l))[0] ?? '', /^\| F30 /)
})

// --- 6. the per-prompt status line only while a loop is active

test('the UserPromptSubmit status line appears only while a loop is active', () => {
  const root = project(1)
  const prompt = () => qlOk(root, ['hook', 'user-prompt-submit'], JSON.stringify({ cwd: root, prompt: 'hi' }))
  assert.equal(prompt(), '', 'no loop')
  qlOk(root, ['start', '--mode', 'review'])
  assert.match(prompt(), /quality-loop review · active/)
  qlOk(root, ['pause', '--reason', 'need input'])
  assert.equal(prompt(), '', 'paused')
  qlOk(root, ['resume'])
  qlOk(root, ['abort'])
  assert.equal(prompt(), '', 'aborted')
  assert.equal(state(root).status, 'aborted')
})

// --- 7. the report names every open finding

test('report: a confirmed nit still open after DONE is listed under Found, not "Nothing beyond the above"', () => {
  const root = project(2)
  qlOk(root, ['start', '--mode', 'review', '--goal', 'every finding fixed, nits included'])
  qlOk(root, ['round', 'begin'])
  qlOk(root, ['ingest', '-', '--lens', 'correctness'], JSON.stringify([{ ...finding(0), severity: 'nit' }]))
  for (const lens of LENSES.slice(1)) qlOk(root, ['ingest', '--none', '--lens', lens])
  qlOk(root, ['vote', '-'], JSON.stringify(['a', 'b'].map(v => ({ id: 'F1', voter: v, verdict: 'confirm', reason: 'seen', severity: 'nit' }))))
  assert.match(qlOk(root, ['round', 'end']), /decision: DONE/)
  const report = qlOk(root, ['report'])
  const found = report.split('## Found')[1] ?? ''
  assert.match(found, /\[Nit\] F1 `src\/many\.js:1`/)
  assert.doesNotMatch(found, /Nothing beyond the above/)
})
