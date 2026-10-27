// The skills are the orchestration: an instruction that sends the agent down
// a path `ql` does not support (a stale scope, an edit outside a round, a DONE
// that ignores the user's finish line) is a defect even though no code is
// wrong. These tests pin the instructions to the paths `ql` does support, and
// walk those paths against the real CLI.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { makeRepo } from './helpers.mjs'

const PLUGIN = resolve(import.meta.dirname, '../plugins/quality-loop')
const QL = join(PLUGIN, 'scripts/ql.mjs')
const read = (/** @type {string} */ p) => readFileSync(join(PLUGIN, p), 'utf8')

/**
 * The body of the `## ` section whose heading matches.
 *
 * @param {string} md
 * @param {RegExp} heading
 */
function section(md, heading) {
  const parts = md.split(/^(?=## )/m)
  const found = parts.find(p => heading.test(p.split('\n')[0]))
  assert.ok(found, `no section ${heading}`)
  return found
}

/** @param {string} text */
const sentences = text => text.replace(/\n(?!\n)/g, ' ').split(/(?<=[.:;])\s+|\n+/)

/** @param {string} cwd @param {string[]} args */
function ql(cwd, args) {
  const r = spawnSync(process.execPath, [QL, ...args], { cwd, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } })
  assert.equal(r.status, 0, `ql ${args.join(' ')} failed:\n${r.stderr}\n${r.stdout}`)
  return r.stdout
}

const CALC = 'export const add = (a, b) => a - b\nexport const mul = (a, b) => a * b\n'

/** A repo whose committed calc.js has the bug, a clean tree, and checks for both functions. */
function committedBug() {
  const root = makeRepo({
    'calc.js': CALC,
    'add.check.mjs': "import { add } from './calc.js'\nprocess.exit(add(2, 3) === 5 ? 0 : 1)\n",
    'mul.check.mjs': "import { mul } from './calc.js'\nprocess.exit(mul(2, 3) === 6 ? 0 : 1)\n",
    '.quality-loop/config.json': JSON.stringify({ checks: [{ name: 'mul', cmd: 'node mul.check.mjs', required: true }] }),
  })
  ql(root, ['start', '--mode', 'debug', '--repro', 'node add.check.mjs'])
  return root
}

test('debug skill: hunters review a scope refreshed after the fix, not the one `ql round begin` wrote before it', () => {
  const debug = read('skills/debug/SKILL.md')
  const review = section(debug, /Review the fix/)
  assert.match(review, /`ql brief hunters`/, 'the review step refreshes the scope after the fix')
  assert.match(review, /round steps 2–4/)
  assert.match(review, /`2-review\.md`/, 'the step file for the review of the fix')

  // The protocol step the debug skill runs on the fix: the refresh comes
  // before the empty-scope rule and before any hunter is briefed.
  const step2 = read('references/round/2-review.md')
  const scopeRefresh = step2.search(/Run `ql brief hunters`/)
  assert.ok(scopeRefresh >= 0, 'protocol step 2 runs `ql brief hunters`, which rewrites the scope')
  assert.ok(scopeRefresh < step2.search(/Empty scope/), 'the protocol decides "empty" from a fresh `ql brief hunters`')
  assert.ok(scopeRefresh < step2.search(/spawn one `bug-hunter`/), 'hunters are briefed from the fresh scope')
})

test('debug flow: a fix made after `ql round begin` is in the refreshed scope', () => {
  const root = committedBug()
  const begun = ql(root, ['round', 'begin'])
  assert.match(begun, /scope is empty/)
  writeFileSync(join(root, 'calc.js'), CALC.replace('a - b', 'b + a + 0'))
  const stale = readFileSync(join(root, '.quality-loop/work/round-1/scope.diff'), 'utf8')
  assert.equal(stale, '', 'the scope round begin wrote predates the fix')
  const fresh = JSON.parse(ql(root, ['scope', '--json']))
  assert.equal(fresh.empty, false)
  assert.match(readFileSync(fresh.diffFile, 'utf8'), /\+export const add = \(a, b\) => b \+ a \+ 0/)
  // `ql brief hunters`, which the protocol's step 2 runs, rewrites the same scope.
  writeFileSync(fresh.diffFile, '')
  assert.match(ql(root, ['brief', 'hunters']), /^bug-hunter /m)
  assert.match(readFileSync(fresh.diffFile, 'utf8'), /\+export const add = \(a, b\) => b \+ a \+ 0/)
})

test('debug skill: every later round starts with `ql round begin`, before any investigation or edit', () => {
  const debug = read('skills/debug/SKILL.md')
  const later = sentences(debug).filter(s => /\b(another|next|later|new) round\b/i.test(s))
  assert.ok(later.length > 0, 'the skill says how a later round starts')
  for (const s of later) {
    assert.match(s, /`ql round begin`/, `a later round must begin with \`ql round begin\`: "${s.trim()}"`)
  }
  assert.doesNotMatch(debug, /starts from step 2 of this skill/)
})

test('debug flow: an edit made inside a round is undone when that round regresses', async () => {
  const root = committedBug()
  ql(root, ['round', 'begin'])
  // The "fix" also breaks mul: made inside the round, so the revert removes it.
  writeFileSync(join(root, 'calc.js'), CALC.replace('a - b', 'b + a + 0').replace('a * b', 'a + b + 0'))
  const { lenses } = JSON.parse(readFileSync(join(root, '.quality-loop/state.json'), 'utf8')).config.review
  for (const lens of lenses) ql(root, ['ingest', '--none', '--lens', lens])
  const end = ql(root, ['round', 'end'])
  assert.match(end, /REVERTED round 1: restored 1 file/)
  assert.equal(readFileSync(join(root, 'calc.js'), 'utf8'), CALC)
})

test('improve skill: a custom finish line is checked by the orchestrator, not assumed met by ql DONE', () => {
  const improve = read('skills/improve/SKILL.md')
  const protocol = read('references/round/decisions.md')
  const doneRow = protocol.split('\n').find(l => l.startsWith('| `DONE`'))
  assert.ok(doneRow)
  assert.doesNotMatch(doneRow, /finish line is met/, 'ql DONE does not evaluate --goal')
  assert.match(improve, /does not (read|evaluate|check) `--goal`/, 'the skill says ql ignores --goal when deciding DONE')
  const check = section(improve, /Check the finish line/i)
  assert.match(check, /`DONE`/)
  assert.match(check, /unmet/i, 'the skill says what to do when the custom finish line is unmet')
  assert.match(check, /`ql export --all`/, 'an unmet criterion is reported with the open findings behind it')
  assert.match(improve, /Blocked on me/)
})

test('improve skill: work toward a custom finish line happens inside a round, before `ql round end`', () => {
  const rounds = section(read('skills/improve/SKILL.md'), /Run rounds/)
  const widen = rounds.split(/\n\n+/).find(p => /custom finish line/i.test(p))
  assert.ok(widen, 'step 2 says how a custom finish line shapes each round')
  assert.match(widen, /before `ql round end`/, 'a DONE ends the loop, so the extra work comes before it')
})

test('improve skill: the agent starts one loop; a further loop and its round budget are the user\'s call', () => {
  const improve = read('skills/improve/SKILL.md')
  const parts = improve.split(/^(?=## )/m)
  const starts = parts.filter(p => /`?ql start\b/.test(p.replace(/`ql start` (creates|refuses)/g, '')) && /^## /.test(p))
  assert.deepEqual(starts.map(p => p.split('\n')[0]), ['## 1. Set the finish line'], 'only step 1 runs `ql start`')
  const check = section(improve, /Check the finish line/i)
  assert.match(check, /user/i, 'the check step hands a further loop to the user')
  assert.doesNotMatch(improve, /follow-up loop/i)
})

test('improve flow: after DONE the loop takes no more rounds, and `ql export --all` still lists the open nit', () => {
  const root = makeRepo({
    'a.js': 'export const x = 1\n',
    '.quality-loop/config.json': JSON.stringify({ checks: [{ name: 'ok', cmd: 'node -e ""', required: true }] }),
  })
  writeFileSync(join(root, 'a.js'), 'export const x = 1 // TODO\n')
  ql(root, ['start', '--mode', 'review', '--goal', 'every finding fixed, nits included'])
  ql(root, ['round', 'begin'])
  const nit = { title: 'Stray TODO', file: 'a.js', line: 1, quote: 'export const x = 1 // TODO', category: 'conventions', severity: 'nit', bugClass: 'stray-todo', explanation: 'Leftover marker.', failureScenario: 'The TODO ships.' }
  writeFileSync(join(root, 'hunter.json'), JSON.stringify([nit]))
  ql(root, ['ingest', 'hunter.json', '--lens', 'conventions'])
  for (const lens of ['correctness', 'security', 'regressions-and-edge-cases']) ql(root, ['ingest', '--none', '--lens', lens])
  const votes = ['a', 'b', 'c'].map(v => ({ id: 'F1', verdict: 'confirm', voter: v, reason: 'seen', severity: 'nit' }))
  writeFileSync(join(root, 'votes.json'), JSON.stringify(votes))
  ql(root, ['vote', 'votes.json'])
  assert.match(ql(root, ['round', 'end']), /DONE/, 'ql DONE ignores the open nit the finish line names')
  const open = JSON.parse(ql(root, ['export', '--all'])).filter((/** @type {any} */ f) => f.status === 'confirmed')
  assert.deepEqual(open.map((/** @type {any} */ f) => f.title), ['Stray TODO'])
  const again = spawnSync(process.execPath, [QL, 'round', 'begin'], { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } })
  assert.notEqual(again.status, 0, 'a DONE loop takes no further round')
})
