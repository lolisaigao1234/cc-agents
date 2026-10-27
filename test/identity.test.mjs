// Finding identity (ADR 0002): a known finding is tracked to the current tree
// through the real diff between the tree it was last seen in and now, and a
// report matches it only where its code still is. Each scenario runs against
// real git snapshot trees, so git's own alignment of repeated code decides,
// as it does in a loop.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { decodeGitPath, ingestFindings, newLedger, recordVotes } from '../plugins/quality-loop/scripts/lib/findings.mjs'
import { snapshotTree } from '../plugins/quality-loop/scripts/lib/git.mjs'
import { lineTranslator, parseHunks, translateRange } from '../plugins/quality-loop/scripts/lib/track.mjs'
import { makeRepo, writeFiles } from './helpers.mjs'

const Q = '  const cap = order.total'
const FIX = '  const cap = toUsd(order.amount)'

const mk = (/** @type {Record<string, unknown>} */ o) => ({
  title: 't',
  file: 'a.js',
  category: 'correctness',
  explanation: 'e',
  severity: 'important',
  bugClass: 'unit',
  quote: Q.trim(),
  ...o,
})

/**
 * A loop over one file, `a.js`, in a real repository: each step writes the
 * file, snapshots the tree and ingests reports against it with the same
 * translator the loop uses.
 */
function scenario() {
  const root = makeRepo({ 'README.md': 'x\n' })
  const ledger = newLedger()
  let round = 0
  /**
   * @param {string[]} lines
   * @param {any[]} reports
   * @param {string} [lens]
   */
  const step = (lines, reports, lens = 'c') => {
    writeFiles(root, { 'a.js': lines.join('\n') + '\n' })
    const tree = snapshotTree(root)
    round++
    const { report } = ingestFindings(ledger, reports, {
      round,
      lens,
      diffFiles: [],
      readLines: p => (p === 'a.js' ? lines : null),
      config: {},
      tree,
      translate: lineTranslator(root, tree),
    })
    return { acc: report.accepted, rep: report.repeats, reo: report.reopened, mer: report.merged }
  }
  /** @param {string} id @param {string} status */
  const settle = (id, status) => {
    const f = ledger.findings[id]
    if (!f) throw new Error(`no ${id}`)
    f.status = /** @type {any} */ (status)
    return f
  }
  return { root, ledger, step, settle }
}

const none = { acc: [], rep: [], reo: [], mer: [] }
const pad = (/** @type {number} */ n, /** @type {string} */ p) => Array.from({ length: n }, (_, i) => `${p}${i}`)

// A 14-line function whose name is five non-blank lines above the quote and
// whose last line is five below it: identical copies share every nearby line.
const longFn = (/** @type {string} */ name, q = Q) => [
  `function ${name}(order) {`,
  '  validate(order)',
  '  log(order)',
  '  audit(order)',
  '  trace(order)',
  '  check(order)',
  q,
  '  const x = capAt(cap)',
  '  emit(x)',
  '  store(x)',
  '  notify(x)',
  '  return x',
  '}',
  '',
]
const qOf = (/** @type {number} */ i) => i * 14 + 7

// ---------------------------------------------------------------------------
// Hunk arithmetic

test('translateRange: lines before a hunk keep their number, after it shift by its delta, inside it are gone', () => {
  // old 10-11 replaced by three lines; three lines inserted after old 30; old 50 deleted
  const hunks = [
    { oldStart: 10, oldCount: 2, newStart: 10, newCount: 3 },
    { oldStart: 30, oldCount: 0, newStart: 32, newCount: 3 },
    { oldStart: 50, oldCount: 1, newStart: 54, newCount: 0 },
  ]
  assert.deepEqual(translateRange(hunks, 5, 9), { line: 5, endLine: 9 })
  assert.equal(translateRange(hunks, 9, 10), null, 'a range that reaches into a changed hunk is gone')
  assert.equal(translateRange(hunks, 11, 11), null)
  assert.deepEqual(translateRange(hunks, 12, 12), { line: 13, endLine: 13 })
  assert.deepEqual(translateRange(hunks, 30, 30), { line: 31, endLine: 31 }, 'an insertion right after the range leaves it')
  assert.equal(translateRange(hunks, 29, 31), null, 'an insertion inside the range breaks it')
  assert.deepEqual(translateRange(hunks, 31, 32), { line: 35, endLine: 36 })
  assert.equal(translateRange(hunks, 50, 50), null)
  assert.deepEqual(translateRange(hunks, 51, 52), { line: 54, endLine: 55 })
  assert.deepEqual(translateRange([{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 2 }], 1, 1), { line: 3, endLine: 3 })
})

test('parseHunks: reads -U0 hunk headers, with omitted counts as 1', () => {
  assert.deepEqual(parseHunks('diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -3 +3,2 @@\n-x\n+y\n+z\n@@ -9,0 +11 @@\n+w\n'), [
    { oldStart: 3, oldCount: 1, newStart: 3, newCount: 2 },
    { oldStart: 9, oldCount: 0, newStart: 11, newCount: 1 },
  ])
})

test('lineTranslator: follows a file between snapshot trees, including a git-quoted non-ASCII path', () => {
  const root = makeRepo({ 'README.md': 'x\n' })
  const file = 'src/café.js'
  writeFiles(root, { [file]: 'a\nb\nc\n' })
  const t1 = snapshotTree(root)
  writeFiles(root, { [file]: 'new\na\nB\nc\n' })
  const t2 = snapshotTree(root)
  const tr = lineTranslator(root, t2)
  assert.deepEqual(tr(file, 1, 1, t1), { line: 2, endLine: 2 })
  assert.equal(tr(file, 2, 2, t1), null, 'the changed line is gone')
  assert.deepEqual(tr(file, 3, 3, t1), { line: 4, endLine: 4 })
  assert.deepEqual(tr(file, 3, 3, t2), { line: 3, endLine: 3 }, 'same tree: unchanged')
  assert.deepEqual(tr('README.md', 1, 1, t1), { line: 1, endLine: 1 }, 'an untouched file')
  assert.equal(tr(file, 1, 1, '0'.repeat(40)), null, 'an unknown tree tracks nothing')
  writeFileSync(join(root, file), '')
  assert.equal(lineTranslator(root, snapshotTree(root))(file, 1, 1, t1), null, 'emptied: every line is gone')
  assert.equal(decodeGitPath('src/caf\\303\\251.js'), file)
})

// ---------------------------------------------------------------------------
// Required properties

for (const [st, key] of /** @type {const} */ ([['rejected', 'rep'], ['fixed', 'reo'], ['wontfix', 'rep']])) {
  test(`identity: a ${st} finding re-reported at the same place with a trimmed or extended quote is the same finding`, () => {
    const fn = (/** @type {string} */ name) => [`function ${name}(order) {`, Q, '  return capAt(cap)', '}', '']
    const L = [...fn('a'), ...fn('b')]
    for (const [line, endLine, quote] of /** @type {const} */ ([
      [2, 2, 'cap = order.total'],
      [2, 3, `${Q.trim()}\n  return capAt(cap)`],
      [1, 3, L.slice(0, 3).join('\n')],
    ])) {
      const s = scenario()
      s.step(L, [mk({ line: 2 })])
      s.settle('F1', st)
      // an unrelated edit above shifts the code down three lines
      const L2 = ['// a', '// b', '// c', ...L]
      const got = s.step(L2, [mk({ line: line + 3, endLine: endLine + 3, quote, title: 'again' })])
      assert.deepEqual(got, { ...none, [key]: ['F1'] }, `quote ${JSON.stringify(quote)}`)
      assert.equal(Object.keys(s.ledger.findings).length, 1)
    }
    // the same place under another bug class and category is a different issue
    const s = scenario()
    s.step(L, [mk({ line: 2 })])
    s.settle('F1', st)
    assert.deepEqual(s.step(L, [mk({ line: 2, quote: 'order.total', bugClass: 'null', category: 'security' })]), { ...none, acc: ['F2'] })
  })
}

test('identity: unique code moved more than 25 lines by line shifts is the same finding (diff translation)', () => {
  const s = scenario()
  // a copy of the quote elsewhere, so only the diff can tell which one moved
  const L = ['function a(order) {', Q, '  return capAt(cap)', '}', ...pad(10, 'p'), 'function b(order) {', Q, '}']
  s.step(L, [mk({ line: 2 })])
  s.settle('F1', 'rejected')
  const L2 = [...pad(40, 'new'), ...L]
  assert.deepEqual(s.step(L2, [mk({ line: 42 })]), { ...none, rep: ['F1'] })
  assert.equal(s.ledger.findings.F1?.line, 42)
  assert.deepEqual(s.step(L2, [mk({ line: 57, title: 'the other copy' })]), { ...none, acc: ['F2'] })
})

test('identity: unique code cut and pasted far away with new neighbours is the same finding (unique-quote fallback)', () => {
  const s = scenario()
  const L = [...pad(5, 'p'), 'function a(o) {', '  const cap = o.total', '  const t = cap * 2', '  return t', '}', ...pad(10, 'r')]
  const quote = 'const cap = o.total\n  const t = cap * 2'
  s.step(L, [mk({ line: 7, endLine: 8, quote })])
  s.settle('F1', 'rejected')
  const L2 = [...pad(5, 'p'), ...pad(10, 'r'), ...pad(200, 'q'), 'function zz(o, k) {', '  const cap = o.total', '  const t = cap * 2', '  return t + k', '}']
  assert.deepEqual(s.step(L2, [mk({ line: 217, endLine: 218, quote })]), { ...none, rep: ['F1'] })
  // fixed, moved 40 further, and re-reported with an extended quote: a reopen
  s.settle('F1', 'fixed')
  const L3 = [...pad(40, 'n'), ...L2.map(l => (l.startsWith('q') ? `x${l}` : l))]
  const got = s.step(L3, [mk({ line: 257, endLine: 259, quote: `${quote}\n  return t + k`, title: 'back' })])
  assert.deepEqual(got, { ...none, reo: ['F1'] })
  assert.equal(s.ledger.findings.F1?.title, 'back')
})

for (const n of [3, 12, 30]) {
  test(`identity: ${n} copy-pasted functions: fixing copy A in place never reopens it for copy B`, () => {
    const names = Array.from({ length: n }, (_, i) => `h${i}`)
    const L = names.flatMap(x => longFn(x))
    const s = scenario()
    s.step(L, [mk({ line: qOf(0), title: 'A' })])
    s.settle('F1', 'fixed')
    const fixedA = [...longFn('h0', FIX), ...names.slice(1).flatMap(x => longFn(x))]
    assert.deepEqual(s.step(fixedA, [mk({ line: qOf(1), title: 'B' })]), { ...none, acc: ['F2'] })
    assert.equal(s.ledger.findings.F1?.status, 'fixed')
    assert.equal(s.ledger.findings.F1?.reopens, 0)
    assert.equal(s.ledger.findings.F1?.title, 'A')
  })

  test(`identity: ${n} copy-pasted functions: a rejected copy rewritten does not swallow copy B`, () => {
    const names = Array.from({ length: n }, (_, i) => `h${i}`)
    const s = scenario()
    s.step(names.flatMap(x => longFn(x)), [mk({ line: qOf(0) })])
    s.settle('F1', 'rejected')
    const edited = [...longFn('h0', '  const cap = guarded(order.total)'), ...names.slice(1).flatMap(x => longFn(x))]
    assert.deepEqual(s.step(edited, [mk({ line: qOf(1), title: 'B' })]), { ...none, acc: ['F2'] })
    assert.deepEqual(s.step(edited, [mk({ line: qOf(1), title: 'B' })], 'other'), { ...none, mer: ['F2'] })
  })

  test(`identity: ${n} copy-pasted functions: a settled copy stays itself when a sibling above is rewritten`, () => {
    const names = Array.from({ length: n }, (_, i) => `h${i}`)
    const s = scenario()
    s.step(names.flatMap(x => longFn(x)), [mk({ line: qOf(1), title: 'h1 bug' })])
    s.settle('F1', 'rejected')
    const edited = [...longFn('h0', FIX), ...names.slice(1).flatMap(x => longFn(x))]
    assert.deepEqual(s.step(edited, [mk({ line: qOf(2), title: 'h2 bug' })]), { ...none, acc: ['F2'] })
    assert.deepEqual(s.step(edited, [mk({ line: qOf(1) })]), { ...none, rep: ['F1'] })
    assert.equal(s.ledger.findings.F1?.title, 'h1 bug')
  })
}

test('identity: with two copies, fixing copy A in place and reporting copy B is a new finding', () => {
  // after the fix the quote is unique in the file, but it was not when A was seen
  const fn = (/** @type {string} */ name, q = Q) => [`function ${name}(order) {`, q, '  return capAt(cap)', '}', '']
  for (const st of ['fixed', 'rejected']) {
    const s = scenario()
    s.step([...fn('refund'), ...fn('charge')], [mk({ line: 2, title: 'A' })])
    s.settle('F1', st)
    assert.deepEqual(s.step([...fn('refund', FIX), ...fn('charge')], [mk({ line: 7, title: 'B' })]), { ...none, acc: ['F2'] }, st)
    assert.equal(s.ledger.findings.F1?.reopens, 0)
  }
})

test('identity: three copies fixed one per round, in place or by deleting them, never count as a reopen', () => {
  const short = (/** @type {string} */ name, q = Q) => [`function ${name}(order) {`, q, '  return capAt(cap)', '}', '']
  const inPlace = scenario()
  const files = [
    [...short('refund'), ...short('charge'), ...short('credit')],
    [...short('refund', FIX), ...short('charge'), ...short('credit')],
    [...short('refund', FIX), ...short('charge', FIX), ...short('credit')],
  ]
  files.forEach((lines, i) => {
    const got = inPlace.step(lines, [mk({ line: 2 + 5 * i })])
    assert.deepEqual(got, { ...none, acc: [`F${i + 1}`] }, `round ${i + 1}`)
    inPlace.settle(`F${i + 1}`, 'fixed')
  })
  const deleted = scenario()
  const names = ['refund', 'charge', 'credit']
  names.forEach((_, i) => {
    const got = deleted.step(names.slice(i).flatMap(x => longFn(x)), [mk({ line: 7, title: `${names[i]} bug` })])
    assert.deepEqual(got, { ...none, acc: [`F${i + 1}`] }, `round ${i + 1}`)
    deleted.settle(`F${i + 1}`, 'fixed')
  })
  for (const s of [inPlace, deleted]) assert.deepEqual(Object.values(s.ledger.findings).map(f => f.reopens), [0, 0, 0])
})

const blk = (/** @type {string} */ q) => ['x', '  foo()', q, '  bar()']
const qLine = (/** @type {number} */ b) => b * 4 + 3

for (const shift of [-1, 0, 3]) {
  test(`identity: periodic code, 30 copies: a sibling rewritten with a shift of ${shift} leaves the rejected copy a repeat`, () => {
    const N = 30
    const K = 10
    const s = scenario()
    s.step(Array.from({ length: N }, () => blk(Q)).flat(), [mk({ line: qLine(K), title: 'block K' })])
    s.settle('F1', 'rejected')
    const fixed =
      shift < 0 ? ['x', FIX, '  bar()'] : ['x', '  foo()', ...Array.from({ length: shift }, (_, i) => `  guard${i}()`), FIX, '  bar()']
    const L2 = Array.from({ length: N }, (_, b) => (b === K - 1 ? fixed : blk(Q))).flat()
    assert.deepEqual(s.step(L2, [mk({ line: qLine(K) + shift })]), { ...none, rep: ['F1'] })
    assert.deepEqual(s.step(L2, [mk({ line: qLine(K + 1) + shift, title: 'block K+1' })]), { ...none, acc: ['F2'] })
    assert.deepEqual(s.step(L2, [mk({ line: qLine(K - 2), title: 'block K-2' })]), { ...none, acc: ['F3'] })
  })
}

test('identity: deleting copy A, then reporting copy B on A\'s old line, is a new finding', () => {
  for (const st of ['fixed', 'rejected']) {
    const names = ['refund', 'charge', 'credit']
    const s = scenario()
    s.step(names.flatMap(x => longFn(x)), [mk({ line: 7, title: 'refund bug' })])
    s.settle('F1', st)
    assert.deepEqual(s.step(names.slice(1).flatMap(x => longFn(x)), [mk({ line: 7, title: 'charge bug' })]), { ...none, acc: ['F2'] }, st)
    assert.equal(s.ledger.findings.F1?.title, 'refund bug')
    assert.equal(s.ledger.findings.F1?.reopens, 0)
  }
})

test('identity: distinct bugs on adjacent lines (15, 16, different bug class) stay separate and merge into the right ones', () => {
  const L = pad(30, 'l')
  L[14] = '  const a = x / y'
  L[15] = '  const b = a.total'
  const s = scenario()
  const div = mk({ line: 15, quote: 'const a = x / y', bugClass: 'div0' })
  const nul = mk({ line: 16, quote: 'const b = a.total', bugClass: 'null' })
  assert.deepEqual(s.step(L, [div, nul]), { ...none, acc: ['F1', 'F2'] })
  const L2 = ['// moved', ...L]
  assert.deepEqual(s.step(L2, [{ ...nul, line: 17 }, { ...div, line: 16 }], 'other'), { ...none, mer: ['F2', 'F1'] })
})

test('identity: identical code on adjacent lines is two instances', () => {
  const L = [...pad(10, 'p'), '  total += x', '  total += x', ...pad(5, 'q')]
  const s = scenario()
  assert.deepEqual(s.step(L, [mk({ line: 11, quote: 'total += x' }), mk({ line: 12, quote: 'total += x' })]), { ...none, acc: ['F1', 'F2'] })
  s.settle('F1', 'rejected')
  assert.deepEqual(s.step(L, [mk({ line: 12, quote: 'total += x' })], 'other'), { ...none, mer: ['F2'] })
  const s2 = scenario()
  s2.step(L, [mk({ line: 11, quote: 'total += x' })])
  s2.settle('F1', 'rejected')
  assert.deepEqual(s2.step(L, [mk({ line: 12, quote: 'total += x' })]), { ...none, acc: ['F2'] })
})

test('identity: one batch: the same quote at different lines is distinct instances, and two reports cannot claim one finding', () => {
  const L = [...pad(5, 'p'), Q, ...pad(5, 'q'), Q, ...pad(5, 'r')]
  const s = scenario()
  assert.deepEqual(s.step(L, [mk({ line: 6 }), mk({ line: 12 })]), { ...none, acc: ['F1', 'F2'] })
  const s2 = scenario()
  s2.step(L, [mk({ line: 6, quote: 'const cap = order.total' })])
  s2.settle('F1', 'rejected')
  // both quote text that contains F1's; the one at F1's own line claims it
  const got = s2.step(L, [mk({ line: 12, title: 'second copy' }), mk({ line: 6, quote: 'cap = order.total', title: 'trimmed' })])
  assert.deepEqual(got, { ...none, acc: ['F2'], rep: ['F1'] })
  assert.equal(s2.ledger.findings.F2?.line, 12)
})

test('identity: a ledger from before line tracking relocates only a quote that is unique in the file', () => {
  const s = scenario()
  const L = ['function a(order) {', Q, '}', ...pad(5, 'p'), 'function b(order) {', '  const t = order.tax', '}']
  s.step(L, [mk({ line: 2 }), mk({ line: 10, quote: 'const t = order.tax' })])
  for (const f of Object.values(s.ledger.findings)) {
    f.status = 'rejected'
    delete f.tree
    delete f.copies
  }
  const L2 = [...pad(30, 'n'), ...L]
  assert.deepEqual(s.step(L2, [mk({ line: 32 }), mk({ line: 40, quote: 'const t = order.tax' })]), { ...none, rep: ['F1', 'F2'] })
  // a second copy of F1's code makes it ambiguous: the report is new
  for (const f of Object.values(s.ledger.findings)) delete f.tree
  const L3 = [...L2, 'function c(order) {', Q, '}']
  assert.deepEqual(s.step(L3, [mk({ line: 32 })]), { ...none, acc: ['F3'] })
})

test('recordVotes: a vote without a voter, or with a blank one, is rejected', () => {
  const s = scenario()
  s.step(longFn('a'), [mk({ line: 7 })])
  const out = recordVotes(
    s.ledger,
    [{ id: 'F1', verdict: 'confirm', reason: 'r' }, { id: 'F1', verdict: 'confirm', reason: 'r', voter: '  ' }],
    { verifiers: 3, quorum: 2 },
  )
  assert.deepEqual(out.invalid.map(i => i.reason), ['a vote needs its voter name', 'a vote needs its voter name'])
  assert.deepEqual(s.ledger.findings.F1?.votes, [])
})

// ---------------------------------------------------------------------------
// The loop records the tree and translates through it.

const QL = resolve(import.meta.dirname, '../plugins/quality-loop/scripts/ql.mjs')

/** @param {string} cwd @param {string[]} args @param {string} [input] */
function qlOk(cwd, args, input) {
  const r = spawnSync(process.execPath, [QL, ...args], { cwd, input, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } })
  assert.equal(r.status, 0, `ql ${args.join(' ')} failed:\n${r.stderr}\n${r.stdout}`)
  return r.stdout
}
/** @param {string} cwd */
const state = cwd => JSON.parse(readFileSync(join(cwd, '.quality-loop/state.json'), 'utf8'))

const TWO = `export function a(items) {
  let sum = 0
  for (const it of items) sum += it.price ?? 0
  return sum
}

export function b(items) {
  let sum = 0
  for (const it of items) sum += it.price ?? 0
  return sum
}
`
const TWO_TEST = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { a } from '../src/two.js'

test('sums', () => assert.equal(a([{ price: 2 }]), 2))
`
const DEFAULT = {
  title: 'A missing price is summed as 0',
  file: 'src/two.js',
  quote: 'for (const it of items) sum += it.price ?? 0',
  category: 'correctness',
  severity: 'important',
  bugClass: 'silent-default',
  explanation: 'A missing price reads as 0.',
  failureScenario: 'an item without a price is free',
}

/** @param {string} root @param {object[] | null} findings @param {string} lens */
const ingest = (root, findings, lens) =>
  findings ? qlOk(root, ['ingest', '-', '--lens', lens], JSON.stringify(findings)) : qlOk(root, ['ingest', '--none', '--lens', lens])

/** A debug loop on a project whose two functions share a buggy line. */
function project() {
  const root = makeRepo({
    'package.json': JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }),
    'src/two.js': TWO,
    'test/two.test.js': TWO_TEST,
  })
  const repro = `node -e "process.exit(1)"`
  qlOk(root, ['start', '--mode', 'debug', '--repro', repro, '--depth', 'quick'])
  return root
}

test('loop: ingest records the snapshot tree, and a later lens finds the finding through an edit that moved it', () => {
  const root = project()
  qlOk(root, ['round', 'begin'])
  ingest(root, [{ ...DEFAULT, line: 3 }], 'correctness')
  const f = state(root).ledger.findings.F1
  assert.match(f.tree, /^[0-9a-f]{40,64}$/)
  // an edit lands above both copies before the next lens reports
  writeFiles(root, { 'src/two.js': '// header\n// more\n' + TWO })
  const out = JSON.parse(qlOk(root, ['ingest', '-', '--lens', 'security', '--json'], JSON.stringify([{ ...DEFAULT, line: 5 }])))
  assert.deepEqual(out.merged, ['F1'])
  const after = state(root).ledger.findings.F1
  assert.equal(after.line, 5)
  assert.notEqual(after.tree, f.tree)
})

test('loop: a reverted round re-anchors its findings in the restored tree', () => {
  const root = project()
  qlOk(root, ['round', 'begin'])
  // the "fix" prepends docs, so copy a moves from 3 to 33
  const pad30 = Array.from({ length: 30 }, (_, i) => `// doc ${i}`).join('\n') + '\n'
  writeFiles(root, { 'src/two.js': pad30 + TWO })
  ingest(root, [{ ...DEFAULT, line: 33 }], 'correctness')
  const s = state(root)
  for (const lens of s.config.review.lenses) if (lens !== 'correctness') ingest(root, null, lens)
  const votes = Array.from({ length: s.config.review.verifiers }, (_, i) => ({ id: 'F1', verdict: 'confirm', voter: `v${i}`, reason: 'traced it', severity: 'important' }))
  qlOk(root, ['vote', '-'], JSON.stringify(votes))
  writeFiles(root, { 'test/broken.test.js': `import { test } from 'node:test'\nimport assert from 'node:assert/strict'\ntest('x', () => assert.equal(1, 2))\n` })
  assert.match(qlOk(root, ['round', 'end']), /REVERTED/)
  assert.equal(readFileSync(join(root, 'src/two.js'), 'utf8'), TWO)
  assert.equal(state(root).ledger.findings.F1.line, 3)
  qlOk(root, ['round', 'begin'])
  const again = JSON.parse(qlOk(root, ['ingest', '-', '--lens', 'correctness', '--json'], JSON.stringify([{ ...DEFAULT, line: 3 }])))
  assert.deepEqual(again.merged, ['F1'], 'the same finding, not a new one on copy a')
  assert.deepEqual(again.accepted, [])
})
