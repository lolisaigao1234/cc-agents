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
  assert.match(review, /`ql scope --json`/, 'the review step refreshes the scope after the fix')
  assert.match(review, /steps 2–4 of `\$\{CLAUDE_PLUGIN_ROOT\}\/references\/round-protocol\.md`/)

  // The protocol step the debug skill runs on the fix: the refresh comes
  // before the empty-scope rule and before any hunter is briefed.
  const step2 = section(read('references/round-protocol.md'), /^## 2\./)
  const scopeRefresh = step2.search(/Run `ql scope --json`/)
  assert.ok(scopeRefresh >= 0, 'protocol step 2 runs `ql scope --json`')
  assert.ok(scopeRefresh < step2.search(/Empty scope/), 'the protocol decides "empty" from a fresh `ql scope --json`')
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
  ql(root, ['ingest', '--none', '--lens', 'scope'])
  const end = ql(root, ['round', 'end'])
  assert.match(end, /REVERTED round 1: restored 1 file/)
  assert.equal(readFileSync(join(root, 'calc.js'), 'utf8'), CALC)
})

test('improve skill: a custom finish line is checked by the orchestrator, not assumed met by ql DONE', () => {
  const improve = read('skills/improve/SKILL.md')
  const protocol = read('references/round-protocol.md')
  const doneRow = protocol.split('\n').find(l => l.startsWith('| `DONE`'))
  assert.ok(doneRow)
  assert.doesNotMatch(doneRow, /finish line is met/, 'ql DONE does not evaluate --goal')
  assert.match(improve, /does not (read|evaluate|check) `--goal`/, 'the skill says ql ignores --goal when deciding DONE')
  const check = section(improve, /Check the finish line/i)
  assert.match(check, /`DONE`/)
  assert.match(check, /unmet/i, 'the skill says what to do when the custom finish line is unmet')
  assert.match(improve, /Blocked on me/)
})
