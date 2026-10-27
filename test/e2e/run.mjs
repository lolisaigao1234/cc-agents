// End-to-end: drives the real plugin with headless Claude on the fixture and
// asserts on outcomes. Slow and billed; run by hand:
//   node test/e2e/run.mjs [review|improve|debug|eval ...] [--model M]
// Transcripts land in <tmp>/ql-e2e-*/<scenario>.jsonl.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { INTENT, makeFixture } from './fixture.mjs'

const PLUGIN = resolve(import.meta.dirname, '../../plugins/quality-loop')
const QL = join(PLUGIN, 'scripts/ql.mjs')
const TOOLS = '--allowedTools=Read,Write,Edit,Bash,Agent,Skill,Glob,Grep'
// The seeded bugs: `qty > 10` (line 15) and `price * 0.1` (line 16).
const BUG_LINES = [15, 16]

const args = process.argv.slice(2)
const modelAt = args.indexOf('--model')
const model = modelAt >= 0 ? args[modelAt + 1] : undefined
const scenarios = args.filter((a, i) => !a.startsWith('--') && (modelAt < 0 || i !== modelAt + 1))
const work = mkdtempSync(join(tmpdir(), 'ql-e2e-'))

/** @param {string} cwd @param {string} prompt @param {string} name */
function claude(cwd, prompt, name) {
  const argv = ['-p', '--plugin-dir', PLUGIN, TOOLS, '--output-format', 'stream-json', '--verbose']
  if (model) argv.push('--model', model)
  argv.push(prompt)
  const r = spawnSync('claude', argv, { cwd, encoding: 'utf8', input: '', maxBuffer: 512 * 1024 * 1024, env: { ...process.env, CLAUDE_CODE_AUTO_COMPACT_WINDOW: '300000', QL_GUARD_LOG: guardLog(name) } })
  writeFileSync(join(work, `${name}.jsonl`), r.stdout)
  return r.status
}

/** Where the guard logs each plugin agent's calls in scenario `name`. @param {string} name */
const guardLog = name => join(work, `${name}.guard.jsonl`)
/**
 * Problems when the guard did not see each of `agents` make calls: a guard
 * that never sees the agents never holds them. Prints its denials.
 *
 * @param {string} name @param {string[]} agents
 */
function guardSaw(name, agents) {
  const calls = existsSync(guardLog(name)) ? readFileSync(guardLog(name), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
  for (const c of calls.filter(c => c.denied)) console.log(`  guard denied ${c.agent} ${c.tool}: ${c.denied}`)
  return agents.filter(a => !calls.some(c => c.agent === a)).map(a => `the guard saw no call by ${a}`)
}

/** @param {string} cwd @param {string[]} a */
const ql = (cwd, a) => spawnSync(process.execPath, [QL, ...a], { cwd, encoding: 'utf8' }).stdout
/** @param {string} cwd */
const tests = cwd => spawnSync('npm', ['test', '--silent'], { cwd, encoding: 'utf8' }).status === 0
// Graded by behaviour, so any correct spelling of the fix passes.
const PROBE = `const { bulkDiscount } = await import('./src/pricing.js')
const price = (qty, p = 100) => bulkDiscount([{ price: p, qty }])[0].price
process.exit(price(9) === 100 && price(10) === 90 && price(20, 1000) === 900 ? 0 : 1)`
/** @param {string} cwd */
const fixedBoth = cwd => spawnSync(process.execPath, ['--input-type=module', '-e', PROBE], { cwd }).status === 0

/** @type {Record<string, () => string[]>} */
const SCENARIOS = {
  review() {
    const root = makeFixture(join(work, 'review'))
    const out = join(root, 'out.json')
    claude(root, `/quality-loop:review --base main --out ${out} ${INTENT}`, 'review')
    const problems = []
    if (!existsSync(out)) return ['no output file']
    const findings = JSON.parse(readFileSync(out, 'utf8'))
    for (const line of BUG_LINES) {
      if (!findings.some((/** @type {any} */ f) => f.file === 'src/pricing.js' && Math.abs(f.line - line) <= 2)) problems.push(`missed the bug at line ${line}`)
    }
    if (spawnSync('git', ['status', '--porcelain', '--', 'src', 'test'], { cwd: root, encoding: 'utf8' }).stdout.trim()) problems.push('review edited source files')
    return [...problems, ...guardSaw('review', ['bug-hunter', 'finding-verifier'])]
  },
  improve() {
    const root = makeFixture(join(work, 'improve'))
    claude(root, '/quality-loop:improve --base main', 'improve')
    const s = JSON.parse(readFileSync(join(root, '.quality-loop/state.json'), 'utf8'))
    const problems = []
    if (s.status !== 'done') problems.push(`loop ended ${s.status}: ${s.statusReasons.join('; ')}`)
    if (!fixedBoth(root)) problems.push('a seeded bug is still in src/pricing.js')
    if (!tests(root)) problems.push('npm test fails')
    if (!/bulkDiscount/.test(readFileSync(join(root, 'test/pricing.test.js'), 'utf8').split('small orders')[1] ?? '')) problems.push('no regression test added')
    return [...problems, ...guardSaw('improve', ['bug-hunter', 'finding-verifier', 'fixer'])]
  },
  debug() {
    const root = makeFixture(join(work, 'debug'))
    claude(root, '/quality-loop:debug A customer ordered 10 units at 100 cents each and was charged 1000 instead of 900. bulkDiscount([{price: 100, qty: 10}]) should give price 90.', 'debug')
    const s = JSON.parse(readFileSync(join(root, '.quality-loop/state.json'), 'utf8'))
    const problems = []
    if (s.mode !== 'debug' || !s.repro) problems.push('no debug loop with a repro')
    if (s.status !== 'done') problems.push(`loop ended ${s.status}: ${s.statusReasons.join('; ')}`)
    if (!fixedBoth(root)) problems.push('root cause not fully fixed')
    if (!tests(root)) problems.push('npm test fails')
    return problems
  },
  eval() {
    // The fixture's bug commit as an eval case, plus its clean base commit.
    const root = makeFixture(join(work, 'eval'))
    ql(root, ['init'])
    const rev = (/** @type {string} */ r) => spawnSync('git', ['rev-parse', r], { cwd: root, encoding: 'utf8' }).stdout.trim()
    const cases = join(root, '.quality-loop/evals/cases')
    mkdirSync(join(cases, 'bulk'), { recursive: true })
    writeFileSync(join(cases, 'bulk/case.json'), JSON.stringify({ id: 'bulk', kind: 'bug', status: 'confirmed', intent: INTENT, whyHard: 'boundary and formula bugs pass the only test', source: { type: 'git', base: rev('main'), head: rev('feature') } }))
    writeFileSync(join(cases, 'bulk/expected.json'), JSON.stringify({ bugs: BUG_LINES.map(line => ({ file: 'src/pricing.js', line })) }))
    // A correct change on top of main: should not fire.
    spawnSync('git', ['checkout', '-q', '-b', 'clean', 'main'], { cwd: root })
    writeFileSync(join(root, 'src/format.js'), '/** Formats integer cents as a dollar string, e.g. 1234 -> "$12.34". */\nexport function formatCents(cents) {\n  const sign = cents < 0 ? "-" : ""\n  const abs = Math.abs(cents)\n  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`\n}\n')
    spawnSync('git', ['add', '-A'], { cwd: root })
    spawnSync('git', ['commit', '-qm', 'Add formatCents helper'], { cwd: root })
    mkdirSync(join(cases, 'clean'), { recursive: true })
    writeFileSync(join(cases, 'clean/case.json'), JSON.stringify({ id: 'clean', kind: 'clean', status: 'confirmed', intent: 'Add formatCents helper', whyHard: 'should-not-fire', source: { type: 'git', base: rev('main'), head: rev('clean') } }))
    writeFileSync(join(cases, 'clean/expected.json'), JSON.stringify({ bugs: [] }))
    const r = spawnSync(process.execPath, [QL, 'eval', 'run', '--label', 'e2e', '--repeats', '1', '--concurrency', '2'], { cwd: root, encoding: 'utf8', env: { ...process.env, ...(model ? { QL_MODEL: model } : {}) } })
    writeFileSync(join(work, 'eval.out'), r.stdout + r.stderr)
    const res = JSON.parse(readFileSync(join(root, '.quality-loop/evals/results/e2e.json'), 'utf8'))
    const problems = []
    for (const t of res.trials) if (t.infraError) problems.push(`${t.caseId}: infra error ${t.infraError} (${t.transcript})`)
    return problems
  },
}

let failed = false
for (const name of scenarios.length ? scenarios : Object.keys(SCENARIOS)) {
  const run = SCENARIOS[name]
  if (!run) throw new Error(`unknown scenario ${name}`)
  const started = Date.now()
  const problems = run()
  failed ||= problems.length > 0
  console.log(`${problems.length ? 'FAIL' : 'PASS'} ${name} (${Math.round((Date.now() - started) / 1000)}s)${problems.map(p => `\n  - ${p}`).join('')}`)
}
console.log(`transcripts: ${work}`)
process.exitCode = failed ? 1 : 0
