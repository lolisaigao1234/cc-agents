// The guard knows which of the plugin's agents makes a call (the hook
// payload's agent_type): the reviewers are read-only in the repository, and
// only the orchestrator writes the loop's state.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { handleHook } from '../plugins/quality-loop/scripts/lib/hooks.mjs'
import { makeRepo } from './helpers.mjs'

/** @param {string} agent_type @param {string} tool_name @param {Record<string, unknown>} tool_input @param {string} cwd */
function denial(agent_type, tool_name, tool_input, cwd) {
  const out = handleHook('pre-tool-use', { cwd, session_id: 's1', agent_id: 'a1', agent_type, tool_name, tool_input }).stdout
  return out ? JSON.parse(out).hookSpecificOutput?.permissionDecisionReason ?? null : null
}

const repo = () => makeRepo({ 'src/a.js': 'export const a = 1\n' })

test('agent guard: a hunter may not edit the repository, but may write its output under .quality-loop/work/', () => {
  const root = repo()
  const edit = denial('quality-loop:bug-hunter', 'Edit', { file_path: join(root, 'src/a.js'), old_string: '1', new_string: '2' }, root)
  assert.match(edit ?? '', /bug-hunter.*read-only/)
  assert.equal(denial('quality-loop:bug-hunter', 'Write', { file_path: join(root, '.quality-loop/work/round-1/hunter-correctness.json'), content: '[]' }, root), null)
})

test('agent guard: a verifier\'s shell writes into the repository are denied; scratch outside it, or under work/, is not', () => {
  const root = repo()
  const v = 'quality-loop:finding-verifier'
  for (const cmd of ['echo x > src/b.js', 'cd src && sed -i s/1/2/ a.js', `tee ${join(root, 'src/c.js')} < /dev/null`, 'rm src/a.js']) {
    assert.match(denial(v, 'Bash', { command: cmd }, root) ?? '', /read-only/, cmd)
  }
  for (const cmd of ['echo x > /tmp/repro.mjs && node /tmp/repro.mjs', 'mkdir -p .quality-loop/work/scratch && echo x > .quality-loop/work/scratch/t.mjs', 'rg -n total src', 'node --test']) {
    assert.equal(denial(v, 'Bash', { command: cmd }, root), null, cmd)
  }
})

test('agent guard: a read-only agent may not change the shared checkout with git, but may work in a worktree of its own', () => {
  const root = repo()
  const inv = 'quality-loop:root-cause-investigator'
  for (const cmd of ['git stash', 'git checkout -- src/a.js', 'git bisect start', 'git switch -c x', 'git add -A']) {
    assert.match(denial(inv, 'Bash', { command: cmd }, root) ?? '', /read-only.*worktree/, cmd)
  }
  for (const cmd of ['git log --oneline -5', 'git diff HEAD', 'git stash list', 'git branch', 'git worktree add /tmp/ql-inv-1 HEAD', 'git -C /tmp/ql-inv-1 bisect start', 'cd /tmp/ql-inv-1 && git checkout HEAD~1']) {
    assert.equal(denial(inv, 'Bash', { command: cmd }, root), null, cmd)
  }
})

test('agent guard: the fixer edits code but not the loop state, and makes no commits or stashes', () => {
  const root = repo()
  const f = 'quality-loop:fixer'
  assert.equal(denial(f, 'Edit', { file_path: join(root, 'src/a.js'), old_string: '1', new_string: '2' }, root), null)
  assert.equal(denial(f, 'Write', { file_path: join(root, '.quality-loop/work/round-1/fix-x.json'), content: '{}' }, root), null)
  assert.match(denial(f, 'Write', { file_path: join(root, '.quality-loop/LOOP.md'), content: '' }, root) ?? '', /one writer of loop state/)
  assert.match(denial(f, 'Bash', { command: 'echo {} > .quality-loop/state.json' }, root) ?? '', /one writer/)
  for (const cmd of ['git commit -am fix', 'git stash', 'git checkout main', 'git reset HEAD~1']) {
    assert.match(denial(f, 'Bash', { command: cmd }, root) ?? '', /no commits/, cmd)
  }
  for (const cmd of ['git diff', 'git checkout -- src/a.js', 'npm test']) assert.equal(denial(f, 'Bash', { command: cmd }, root), null, cmd)
})

test('agent guard: the main session and other agents are not held by it', () => {
  const root = repo()
  const edit = { file_path: join(root, 'src/a.js'), old_string: '1', new_string: '2' }
  for (const agent of [undefined, 'general-purpose', 'other-plugin:bug-hunter']) {
    assert.equal(denial(/** @type {any} */ (agent), 'Edit', edit, root), null, String(agent))
  }
})

test('agent guard: with QL_GUARD_LOG set, each plugin agent call is logged with its decision', () => {
  const root = repo()
  const log = join(root, '.quality-loop/work/guard.jsonl')
  process.env.QL_GUARD_LOG = log
  try {
    denial('quality-loop:bug-hunter', 'Edit', { file_path: join(root, 'src/a.js'), old_string: '1', new_string: '2' }, root)
    denial('quality-loop:bug-hunter', 'Bash', { command: 'rg total' }, root)
    denial(/** @type {any} */ (undefined), 'Bash', { command: 'ls' }, root)
  } finally {
    delete process.env.QL_GUARD_LOG
  }
  const lines = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.deepEqual(lines.map(l => [l.agent, l.tool, !!l.denied]), [['bug-hunter', 'Edit', true], ['bug-hunter', 'Bash', false]])
})
