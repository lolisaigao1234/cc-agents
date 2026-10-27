import { test } from 'node:test'
import assert from 'node:assert/strict'

import { evaluateGuard } from '../plugins/quality-loop/scripts/lib/guard.mjs'

/** @param {Partial<import('../plugins/quality-loop/scripts/lib/guard.mjs').GuardInput>} o */
const g = o =>
  evaluateGuard({
    tool: 'Bash',
    input: {},
    root: '/repo',
    loopStatus: 'active',
    protectedPaths: ['.quality-loop/config.json', '.quality-loop/state.json'],
    blockDestructive: true,
    hillclimbActive: false,
    ...o,
  })

const bash = (/** @type {string} */ command, o = {}) => g({ input: { command }, ...o })

test('destructive git and rm commands are denied while a loop is active', () => {
  for (const c of [
    'git reset --hard HEAD',
    'git clean -fd',
    'git checkout .',
    'git checkout -- src/a.js',
    'git restore src/a.js',
    'git restore --staged --worktree a.js',
    'git push --force origin main',
    'git push -f',
    'git stash drop',
    'git branch -D feature',
    'git commit --no-verify -m x',
    'rm -rf build',
    'cd x && rm -fr y',
  ]) {
    assert.ok(bash(c), c)
  }
})

test('ordinary commands pass', () => {
  for (const c of ['git status', 'git diff', 'git restore --staged a.js', 'npm test', 'rm file.txt', 'git checkout -b feature', 'cat .quality-loop/state.json']) {
    assert.equal(bash(c), null, c)
  }
})

test('nothing is blocked when no loop is active, except extending', () => {
  assert.equal(bash('git reset --hard', { loopStatus: null }), null)
  assert.equal(bash('git reset --hard', { loopStatus: 'done' }), null)
  assert.ok(bash('node ql.mjs extend 2', { loopStatus: 'capped' }))
})

test('restarting over an active loop is denied', () => {
  assert.ok(bash('node "$P/scripts/ql.mjs" start --mode review --force'))
  assert.equal(bash('node ql.mjs start --mode review --force', { loopStatus: 'done' }), null)
})

test('protected files: edits and shell writes denied, reads allowed', () => {
  assert.ok(g({ tool: 'Edit', input: { file_path: '/repo/.quality-loop/config.json' } }))
  assert.ok(g({ tool: 'Write', input: { file_path: '.quality-loop/state.json' } }))
  assert.equal(g({ tool: 'Edit', input: { file_path: '/repo/src/a.js' } }), null)
  assert.ok(bash(`echo '{}' > .quality-loop/config.json`))
  assert.ok(bash(`sed -i '' s/3/9/ .quality-loop/config.json`))
})

test('eval answer keys are protected only while hill climbing', () => {
  const edit = { tool: 'Write', input: { file_path: '/repo/.quality-loop/evals/cases/c1/expected.json' } }
  assert.equal(g({ ...edit, loopStatus: null }), null)
  assert.ok(g({ ...edit, loopStatus: null, hillclimbActive: true }))
  assert.equal(g({ tool: 'Edit', input: { file_path: '/repo/.quality-loop/REVIEW.md' }, loopStatus: null, hillclimbActive: true }), null)
})

test('reading protected files is allowed even with arrows and redirects elsewhere (seen live)', () => {
  for (const c of [
    `node -e 'const s=require("./.quality-loop/state.json"); Object.values(s.ledger.findings).map(f => f.id)'`,
    'cat .quality-loop/state.json 2>&1 | head -20',
    'jq .status .quality-loop/state.json > /tmp/out.json',
  ]) {
    assert.equal(bash(c), null, c)
  }
})

test('writing protected files through scripts and redirects is denied', () => {
  for (const c of [
    `node -e 'require("fs").writeFileSync(".quality-loop/state.json", "{}")'`,
    `python3 -c "open('.quality-loop/config.json','w').write('{}')"`,
    'echo {} >> .quality-loop/state.json',
    'cp /tmp/x.json .quality-loop/config.json',
    'tee .quality-loop/state.json < x',
    'rm .quality-loop/state.json',
  ]) {
    assert.ok(bash(c), c)
  }
})
