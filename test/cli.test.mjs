import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { makeRepo, writeFiles } from './helpers.mjs'

const QL = resolve(import.meta.dirname, '../plugins/quality-loop/scripts/ql.mjs')

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {string} [input]
 */
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

/** @param {string} cwd */
const state = cwd => JSON.parse(readFileSync(join(cwd, '.quality-loop/state.json'), 'utf8'))

const CART = `export function total(items) {
  let sum = 0
  for (let i = 0; i < items.length; i++) {
    sum += items[i].price
  }
  return sum
}
`
const CART_TEST = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { total } from '../src/cart.js'

test('sums prices', () => {
  assert.equal(total([{ price: 2 }, { price: 3 }]), 5)
})
`

/** A node project whose uncommitted change introduces an off-by-one. */
function buggyProject() {
  const root = makeRepo({
    'package.json': JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }),
    'src/cart.js': CART,
    'test/cart.test.js': CART_TEST,
  })
  writeFiles(root, {
    'src/cart.js': CART.replace('i < items.length', 'i <= items.length').replace('sum += items[i].price', 'sum += items[i]?.price ?? 0'),
  })
  return root
}

const FINDING = {
  title: 'Loop bound reads past the end of items',
  file: 'src/cart.js',
  line: 3,
  quote: 'for (let i = 0; i <= items.length; i++) {',
  category: 'correctness',
  severity: 'important',
  bugClass: 'off-by-one',
  explanation: 'The <= bound iterates once past the last item; the ?. hides it.',
  failureScenario: 'total(items) silently adds 0 for items[length], masking corrupt input',
}

/** @param {string} root @param {object[]} findings @param {string} lens */
function ingest(root, findings, lens) {
  return qlOk(root, ['ingest', '-', '--lens', lens], JSON.stringify(findings))
}

/** Records the standard-depth lenses that have not reported as finding nothing. @param {string} root */
function finishReview(root) {
  for (const lens of ['correctness', 'security', 'regressions-and-edge-cases', 'conventions']) {
    if (!state(root).rounds.at(-1).lensesDone?.includes(lens)) qlOk(root, ['ingest', '--none', '--lens', lens])
  }
}

/** @param {string} root @param {string} id @param {number} n */
function confirm(root, id, n = 2) {
  const votes = Array.from({ length: n }, (_, i) => ({ id, verdict: 'confirm', voter: `v${i}`, reason: 'traced: i reaches items.length', severity: 'important' }))
  return qlOk(root, ['vote', '-'], JSON.stringify(votes))
}

test('init detects checks from package.json', () => {
  const root = buggyProject()
  const out = qlOk(root, ['init'])
  assert.match(out, /test \(npm test --silent\)/)
  assert.ok(existsSync(join(root, '.quality-loop/REVIEW.md')))
  assert.match(readFileSync(join(root, '.quality-loop/.gitignore'), 'utf8'), /state\.json/)
})

test('full review loop: hallucination rejected, finding confirmed, fixed, done', () => {
  const root = buggyProject()
  const started = qlOk(root, ['start', '--mode', 'review'])
  assert.match(started, /PASS test/)
  assert.match(qlOk(root, ['next']), /round begin/)

  const begun = qlOk(root, ['round', 'begin'])
  assert.match(begun, /src\/cart\.js/)
  assert.match(readFileSync(join(root, '.quality-loop/work/round-1/scope.diff'), 'utf8'), /i <= items\.length/)

  const out = ingest(root, [FINDING, { ...FINDING, quote: 'items.reduce((a, b) => a + b)', bugClass: 'invented', title: 'Invented' }], 'correctness')
  assert.match(out, /1 new/)
  assert.match(out, /quote-not-found/)
  // a second lens reporting the same bug merges instead of duplicating
  assert.match(ingest(root, [{ ...FINDING, title: 'Off by one' }], 'regressions-and-edge-cases'), /1 merged/)
  assert.equal(state(root).ledger.findings.F1.origin, 'introduced')
  finishReview(root)

  assert.match(qlOk(root, ['next']), /Verify/)
  assert.match(confirm(root, 'F1'), /F1: confirmed/)
  assert.match(qlOk(root, ['open']), /off-by-one/)

  // refusing to mark without evidence
  const noReason = ql(root, ['mark', 'F1', 'fixed'])
  assert.equal(noReason.code, 1)
  writeFiles(root, { 'src/cart.js': CART })
  writeFiles(root, {
    'test/cart.test.js': CART_TEST + `\ntest('ignores nothing past the end', () => {\n  assert.equal(total([{ price: 1 }]), 1)\n})\n`,
  })
  qlOk(root, ['mark', 'F1', 'fixed', '--reason', 'restored < bound; regression test added'])

  const end = qlOk(root, ['round', 'end'])
  assert.match(end, /decision: DONE/)
  const s = state(root)
  assert.equal(s.status, 'done')
  assert.equal(s.rounds[0].reverted, false)
  const report = qlOk(root, ['report'])
  assert.match(report, /^\*\*1 fixed/)
  assert.match(report, /## Blocked on me/)
  assert.match(readFileSync(join(root, '.quality-loop/LOOP.md'), 'utf8'), /Goal \(finish line\)/)
})

test('a fix that breaks a test is reverted and the finding reopens for another attempt', () => {
  const root = buggyProject()
  qlOk(root, ['start', '--mode', 'review'])
  qlOk(root, ['round', 'begin'])
  ingest(root, [FINDING], 'correctness')
  finishReview(root)
  confirm(root, 'F1')
  const before = readFileSync(join(root, 'src/cart.js'), 'utf8')
  writeFiles(root, { 'src/cart.js': before.replace('return sum', 'return sum + 1'), 'src/extra.js': 'export const x = 1\n' })
  qlOk(root, ['mark', 'F1', 'fixed', '--reason', 'tried'])
  const end = qlOk(root, ['round', 'end'])
  assert.match(end, /REVERTED/)
  assert.match(end, /required check "test" now fails/)
  assert.equal(readFileSync(join(root, 'src/cart.js'), 'utf8'), before, 'round reverted to its start')
  assert.equal(existsSync(join(root, 'src/extra.js')), false, 'files created in the round are removed')
  const s = state(root)
  assert.equal(s.status, 'active')
  assert.equal(s.ledger.findings.F1.status, 'confirmed')
  assert.equal(s.ledger.findings.F1.attempts, 1)
})

test('skipping a test to get green is caught as weakening and reverted', () => {
  const root = buggyProject()
  qlOk(root, ['start', '--mode', 'review'])
  qlOk(root, ['round', 'begin'])
  ingest(root, [FINDING], 'correctness')
  finishReview(root)
  confirm(root, 'F1')
  writeFiles(root, { 'test/cart.test.js': CART_TEST.replace("test('sums", "test.skip('sums") })
  qlOk(root, ['mark', 'F1', 'fixed', '--reason', 'sure'])
  const end = qlOk(root, ['round', 'end'])
  assert.match(end, /WEAKENING: skip-added test\/cart\.test\.js/)
  assert.match(end, /REVERTED/)
  assert.doesNotMatch(readFileSync(join(root, 'test/cart.test.js'), 'utf8'), /test\.skip/)
})

test('the round cap stops the loop and asks to reconsider; only the user can extend', () => {
  const root = buggyProject()
  qlOk(root, ['init'])
  const cfgPath = join(root, '.quality-loop/config.json')
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, loop: { maxRounds: 1, maxAttemptsPerFinding: 5 } }))
  qlOk(root, ['start', '--mode', 'review'])
  qlOk(root, ['round', 'begin'])
  ingest(root, [FINDING], 'correctness')
  finishReview(root)
  confirm(root, 'F1')
  const end = qlOk(root, ['round', 'end'])
  assert.match(end, /decision: CAPPED/)
  assert.match(end, /reconsider the approach/)
  assert.equal(ql(root, ['round', 'begin']).code, 1, 'no more rounds once capped')

  // the guard refuses `extend` when the agent runs it through Bash
  const hook = qlOk(root, ['hook', 'pre-tool-use'], JSON.stringify({ cwd: root, tool_name: 'Bash', tool_input: { command: `node ${QL} extend` } }))
  assert.match(hook, /only the user may extend/)
  // the user can, from the prompt
  assert.match(qlOk(root, ['extend', '--rounds', '1']), /extended to 2 rounds/)
  assert.equal(state(root).status, 'active')
})

test('debug mode: refuses a repro that already passes; done once the repro passes', () => {
  const root = buggyProject()
  const passing = ql(root, ['start', '--mode', 'debug', '--repro', 'true'])
  assert.match(passing.out, /does not reproduce/)
  assert.equal(state(root).status, 'paused')

  const repro = `node -e "import('./src/cart.js').then(m => { if (m.total([{price:1}]) !== 1 || /<=/.test(require('fs').readFileSync('src/cart.js','utf8'))) process.exit(1) })"`
  qlOk(root, ['start', '--mode', 'debug', '--repro', repro, '--force'])
  assert.match(qlOk(root, ['round', 'begin']), /round 1/)
  assert.match(qlOk(root, ['next']), /Debug round/)
  writeFiles(root, { 'src/cart.js': CART })
  qlOk(root, ['ingest', '--none', '--lens', 'correctness'])
  const end = qlOk(root, ['round', 'end'])
  assert.match(end, /PASS repro/)
  assert.match(end, /decision: DONE/)
})

test('hooks: stop continues an active loop a bounded number of times; context survives compaction', () => {
  const root = buggyProject()
  qlOk(root, ['init'])
  const cfgPath = join(root, '.quality-loop/config.json')
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, loop: { maxStopNudges: 2 } }))
  qlOk(root, ['start', '--mode', 'review'])
  const stop = () => qlOk(root, ['hook', 'stop'], JSON.stringify({ cwd: root, stop_hook_active: false }))
  assert.equal(JSON.parse(stop()).decision, 'block')
  assert.match(JSON.parse(stop()).reason, /continuation 2 of 2/)
  assert.equal(stop(), '', 'nudges are capped')
  // waiting on background agents is not stopping early
  qlOk(root, ['round', 'begin'])
  assert.equal(qlOk(root, ['hook', 'stop'], JSON.stringify({ cwd: root, background_tasks: [{ id: 'a' }] })), '')

  const ctx = JSON.parse(qlOk(root, ['hook', 'session-start'], JSON.stringify({ cwd: root, source: 'compact' })))
  assert.match(ctx.hookSpecificOutput.additionalContext, /Goal \(finish line\)/)
  const prompt = JSON.parse(qlOk(root, ['hook', 'user-prompt-submit'], JSON.stringify({ cwd: root, prompt: 'hi' })))
  assert.match(prompt.hookSpecificOutput.additionalContext, /round 1\/3/)

  const deny = JSON.parse(qlOk(root, ['hook', 'pre-tool-use'], JSON.stringify({ cwd: root, tool_name: 'Edit', tool_input: { file_path: join(root, '.quality-loop/config.json') } })))
  assert.equal(deny.hookSpecificOutput.permissionDecision, 'deny')

  qlOk(root, ['pause', '--reason', 'need the product decision on rounding'])
  assert.equal(stop(), '', 'a paused loop may stop')
  // hooks outside any loop say nothing, and never fail
  assert.equal(qlOk(root, ['hook', 'stop'], 'not json'), '')
})

test('review-only: verified findings exported for the grader, then finished', () => {
  const root = buggyProject()
  qlOk(root, ['start', '--mode', 'review', '--review-only'])
  qlOk(root, ['round', 'begin'])
  ingest(root, [FINDING], 'correctness')
  finishReview(root)
  confirm(root, 'F1')
  assert.match(qlOk(root, ['next']), /ql export/)
  qlOk(root, ['export', '--out', 'out.json'])
  const exported = JSON.parse(readFileSync(join(root, 'out.json'), 'utf8'))
  assert.equal(exported.length, 1)
  assert.equal(exported[0].file, 'src/cart.js')
  qlOk(root, ['finish'])
  assert.equal(state(root).status, 'done')
})

test('ql refuses commands out of phase and explains what to do', () => {
  const root = buggyProject()
  qlOk(root, ['start', '--mode', 'review'])
  const r = ql(root, ['vote', '-'], '[]')
  assert.equal(r.code, 1)
  assert.match(r.err, /cannot record votes in phase "begin"/)
  const again = ql(root, ['start', '--mode', 'review'])
  assert.match(again.err, /already active/)
})

test('evals: fake runner graded per split; compare decides; leakcheck and hillclimb guard', () => {
  const root = makeRepo({ 'README.md': 'x\n' })
  qlOk(root, ['init'])
  const mk = (/** @type {string} */ id, /** @type {'bug'|'clean'} */ kind, /** @type {any[]} */ bugs) => {
    writeFiles(root, {
      [`.quality-loop/evals/cases/${id}/case.json`]: JSON.stringify({ id, kind, status: 'confirmed', source: { type: 'files' } }),
      [`.quality-loop/evals/cases/${id}/expected.json`]: JSON.stringify({ bugs }),
      [`.quality-loop/evals/cases/${id}/before/src/a.js`]: 'let a = 1\n',
      [`.quality-loop/evals/cases/${id}/after/src/a.js`]: 'let a = 1\nlet b = a / 0\n',
    })
  }
  for (const i of [1, 2, 3, 4]) mk(`bug${i}`, 'bug', [{ file: 'src/a.js', line: 2, description: 'the division by zero yields infinity silently' }])
  for (const i of [1, 2]) mk(`clean${i}`, 'clean', [])
  // The fake reviewer reports line 2 when REVIEW.md says "division", else nothing.
  writeFileSync(
    join(root, 'runner.sh'),
    `#!/bin/sh
test -n "$QL_BASE" || exit 3
test "$CLAUDE_CODE_AUTO_COMPACT_WINDOW" = 300000 || exit 5
git diff --quiet "$QL_BASE" HEAD && exit 4
if grep -q division .quality-loop/REVIEW.md && [ "\${QL_CASE_ID#bug}" != "$QL_CASE_ID" ]; then
  echo '[{"file":"src/a.js","line":2,"severity":"important"}]' > "$QL_OUTPUT"
else
  echo '[]' > "$QL_OUTPUT"
fi
`,
  )
  const runner = `sh ${join(root, 'runner.sh')}`
  qlOk(root, ['eval', 'split'])
  const base = qlOk(root, ['eval', 'run', '--label', 'base', '--runner', runner, '--repeats', '1'])
  assert.match(base, /all\s+pass 33\.3%/)
  writeFileSync(join(root, '.quality-loop/REVIEW.md'), 'Flag division by a value that can be zero.\n')
  const cand = qlOk(root, ['eval', 'run', '--label', 'cand', '--runner', runner, '--repeats', '2'])
  assert.match(cand, /all\s+pass 100\.0%/)
  assert.match(cand, /HEADROOM WARNING/)
  assert.match(qlOk(root, ['eval', 'compare', 'base', 'cand']), /decision: KEEP/)

  const broken = qlOk(root, ['eval', 'run', '--label', 'broken', '--runner', 'exit 9', '--repeats', '1', '--cases', 'bug1'])
  assert.match(broken, /INFRA ERROR/)

  writeFileSync(join(root, '.quality-loop/REVIEW.md'), 'Check the division by zero yields infinity silently.\n')
  const leak = ql(root, ['eval', 'leakcheck'])
  assert.equal(leak.code, 1)
  assert.match(leak.out, /LEAK \(phrase\)/)

  qlOk(root, ['eval', 'hillclimb', 'start'])
  const deny = qlOk(
    root,
    ['hook', 'pre-tool-use'],
    JSON.stringify({ cwd: root, tool_name: 'Write', tool_input: { file_path: join(root, '.quality-loop/evals/cases/bug1/expected.json') } }),
  )
  assert.match(deny, /deny/)
  qlOk(root, ['eval', 'hillclimb', 'stop'])
})

test('harvest drafts cases from a revert and a fix, plus clean cases', () => {
  const root = makeRepo({ 'src/a.js': 'export const rate = 1\n' })
  const git = (/** @type {string[]} */ args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  const commit = (/** @type {string} */ msg) => {
    git(['add', '-A'])
    git(['commit', '-qm', msg])
    return git(['rev-parse', 'HEAD']).stdout.trim()
  }
  writeFiles(root, { 'src/b.js': 'export function f(x) {\n  return x.y.z\n}\n' })
  const bad = commit('add f')
  writeFiles(root, { 'src/b.js': 'export function f(x) {\n  return x?.y?.z\n}\n' })
  commit('fix: crash when y is missing')
  writeFiles(root, { 'src/c.js': 'export const c = eval(input)\n' })
  const reverted = commit('add c')
  git(['revert', '--no-edit', reverted])
  for (let i = 0; i < 22; i++) {
    writeFiles(root, { [`docs/n${i}.md`]: `note ${i}\n` })
    commit(`docs: note ${i}`)
  }
  qlOk(root, ['init'])
  const out = qlOk(root, ['eval', 'harvest', '--clean', '1'])
  assert.match(out, /drafted 3 case/)
  const fixCase = JSON.parse(readFileSync(join(root, `.quality-loop/evals/cases/${out.match(/fix-[0-9a-f]+/)?.[0]}/case.json`), 'utf8'))
  assert.equal(fixCase.source.head, bad, 'blame found the commit that introduced the crash')
  const exp = JSON.parse(readFileSync(join(root, `.quality-loop/evals/cases/${out.match(/fix-[0-9a-f]+/)?.[0]}/expected.json`), 'utf8'))
  assert.deepEqual(exp.bugs.map((/** @type {any} */ b) => [b.file, b.line]), [['src/b.js', 2]])
  assert.match(out, /revert-/)
  assert.match(qlOk(root, ['eval', 'cases']), /0 confirmed/)
})

test('--depth picks the preset lenses and voting; round begin prints each lens focus', () => {
  const root = buggyProject()
  qlOk(root, ['start', '--mode', 'review', '--depth', 'deep'])
  const s = state(root)
  assert.equal(s.config.review.lenses.length, 6)
  assert.equal(s.config.review.verifiers, 5)
  assert.equal(s.config.review.quorum, 3)
  const begun = qlOk(root, ['round', 'begin'])
  assert.match(begun, /security: Injection/)
  assert.match(begun, /concurrency-and-resources: Races/)
  assert.equal(ql(root, ['start', '--mode', 'review', '--depth', 'huge', '--force']).code, 1)
})

test('hooks.json wires every classic hook to a ql hook event that exists', () => {
  const hooks = JSON.parse(readFileSync(resolve(import.meta.dirname, '../plugins/quality-loop/hooks/hooks.json'), 'utf8'))
  const events = Object.values(hooks.hooks).flatMap((/** @type {any} */ groups) => groups.flatMap((/** @type {any} */ g) => g.hooks.map((/** @type {any} */ h) => h.command)))
  assert.equal(events.length, 4)
  const root = makeRepo({ 'a.txt': 'x\n' })
  for (const cmd of events) {
    const event = /hook (\S+)$/.exec(cmd)?.[1]
    assert.ok(event, cmd)
    // outside any loop every hook answers nothing and exits 0
    assert.equal(qlOk(root, ['hook', event], JSON.stringify({ cwd: root })), '')
  }
})

test('vote accepts one vote object per file, and several files at once', () => {
  const root = buggyProject()
  qlOk(root, ['start', '--mode', 'review', '--review-only'])
  qlOk(root, ['round', 'begin'])
  ingest(root, [FINDING], 'correctness')
  const v = (/** @type {string} */ voter) => JSON.stringify({ id: 'F1', verdict: 'confirm', voter, reason: 'reproduced', severity: 'important' })
  writeFileSync(join(root, 'v1.json'), v('reproduce-F1'))
  writeFileSync(join(root, 'v2.json'), v('trace-F1'))
  writeFileSync(join(root, 'v3.json'), v('intent-F1'))
  const out = qlOk(root, ['vote', 'v1.json', 'v2.json', 'v3.json'])
  assert.match(out, /F1: confirmed/)
  assert.doesNotMatch(out, /invalid/)
  assert.equal(state(root).ledger.findings.F1.votes.length, 3)
})

test('the review phase waits for every lens before moving on (seen live)', () => {
  const root = buggyProject()
  qlOk(root, ['start', '--mode', 'review'])
  qlOk(root, ['round', 'begin'])
  ingest(root, [FINDING], 'correctness')
  const next = qlOk(root, ['next'])
  assert.match(next, /1 of 4 lenses/)
  assert.match(next, /security/)
  // verifying what is already in, while other hunters run, is allowed
  assert.match(confirm(root, 'F1'), /F1: confirmed/)
  for (const lens of ['security', 'regressions-and-edge-cases', 'conventions']) qlOk(root, ['ingest', '--none', '--lens', lens])
  assert.match(qlOk(root, ['next']), /^Fix/)
})

test('an empty scope closes the review with one --none ingest', () => {
  const root = makeRepo({ 'a.txt': 'x\n' })
  qlOk(root, ['start', '--mode', 'review'])
  assert.match(qlOk(root, ['round', 'begin']), /scope is empty/)
  qlOk(root, ['ingest', '--none', '--lens', 'scope'])
  assert.match(qlOk(root, ['next']), /^Validate/)
})

test('the context cap: init and start lower the auto-compact window to loop.maxContextTokens', () => {
  const root = buggyProject()
  assert.match(qlOk(root, ['init']), /context cap: auto-compact at 300000 tokens/)
  const settings = join(root, '.claude/settings.local.json')
  assert.equal(JSON.parse(readFileSync(settings, 'utf8')).autoCompactWindow, 300000)
  const cfgPath = join(root, '.quality-loop/config.json')
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, loop: { maxContextTokens: 200000 } }))
  assert.match(qlOk(root, ['start', '--mode', 'review']), /context cap: auto-compact at 200000 tokens/)
  assert.equal(JSON.parse(readFileSync(settings, 'utf8')).autoCompactWindow, 200000)
  assert.equal(spawnSync('git', ['status', '--porcelain', '--', '.claude'], { cwd: root, encoding: 'utf8' }).stdout, '', 'kept out of git')
})

test('the context cap: null leaves Claude Code settings untouched', () => {
  const root = buggyProject()
  writeFiles(root, { '.quality-loop/config.json': JSON.stringify({ version: 1, checks: [], loop: { maxContextTokens: null } }) })
  assert.doesNotMatch(qlOk(root, ['start', '--mode', 'review']), /context cap/)
  assert.equal(existsSync(join(root, '.claude/settings.local.json')), false)
})
