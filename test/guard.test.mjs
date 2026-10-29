import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { guard } from '../plugins/trace/scripts/lib/guard.mjs'

const HOOK = fileURLToPath(new URL('../plugins/trace/scripts/hook.mjs', import.meta.url))

const DENIED = [
  'git reset --hard HEAD',
  'git clean -fd',
  'git checkout .',
  'git checkout -- src/a.js',
  'git checkout HEAD -- src/a.js',
  'git checkout main src/a.js',
  'git checkout -f main',
  'git restore src/a.js',
  'git restore --staged --worktree a.js',
  'git switch -f main',
  'git switch --discard-changes main',
  'git push --force origin main',
  'git push -f',
  'git push -fu origin main',
  'git push --force-with-lease=main origin main',
  'git push origin +main',
  'git stash drop',
  'git stash clear',
  'git branch -D feature',
  'git branch --delete --force feature',
  'git branch -df feature',
  'git commit --no-verify -m x',
  'git commit -n -m x',
  'git commit -anm x',
  'git -c core.hooksPath=/dev/null commit -m x',
  // git global options
  'git -C . reset --hard HEAD',
  'git -C sub clean -fdx',
  'git --no-pager checkout .',
  'git -c x=y push --force',
  'git --git-dir=.git --work-tree . reset --hard',
  // rm spellings
  'rm -rf build',
  'rm -Rf build',
  'rm -fR build',
  'rm -r -v -f build',
  'rm --recursive --force build',
  'rm -r dir',
  // wrappers, chains and nested shells
  'cd x && rm -fr y',
  'sudo rm -rf /tmp/x',
  'find . -name x | xargs rm -rf',
  'git restore --staged a; git restore b',
  'git status && git -C . restore src/a.js',
  'bash -c "git reset --hard"',
  'echo $(git reset --hard)',
  'if true; then rm -rf build; fi',
  "bash <<'EOF'\ngit reset --hard\nEOF",
]

const ALLOWED = [
  'git status',
  'git diff',
  'git -C sub status',
  'git checkout main',
  'git checkout -b feature main',
  'git switch -c feature',
  'git restore --staged a.js',
  'git restore --staged a.js; git restore --staged b.js',
  'git push origin main',
  'git push -u origin main',
  'git branch -d merged',
  'git commit -m "fix: n-th item"',
  'git commit -am x',
  'git clean -n',
  'rm file.txt',
  'rm -f file.txt',
  'npm test',
  // text that only mentions a destructive command
  `rg -n 'rm -rf' .`,
  `rg -n 'git reset --hard' docs`,
  `grep -rn "git push --force" .`,
  `git commit -m "guard: block rm -rf and --no-verify"`,
  `echo "never git reset --hard"`,
  "cat <<'EOF' > notes.md\nrm -rf build\ngit reset --hard\nEOF",
]

test('the guard denies commands that destroy work or history', () => {
  for (const c of DENIED) assert.ok(guard(c), c)
})

test('the guard allows everything else, including text that mentions destructive commands', () => {
  for (const c of ALLOWED) assert.equal(guard(c), null, c)
})

/** @param {object} input */
const runHook = input => spawnSync(process.execPath, [HOOK, 'pre-tool-use'], { input: JSON.stringify(input), encoding: 'utf8' })

test('the hook denies a destructive Bash command, giving the reason', () => {
  const r = runHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push --force' } })
  assert.equal(r.status, 0)
  const out = JSON.parse(r.stdout).hookSpecificOutput
  assert.equal(out.hookEventName, 'PreToolUse')
  assert.equal(out.permissionDecision, 'deny')
  assert.match(out.permissionDecisionReason, /force push/)
})

test('the hook says nothing about allowed commands and other tools', () => {
  for (const input of [
    { tool_name: 'Bash', tool_input: { command: 'git status' } },
    { tool_name: 'Edit', tool_input: { file_path: 'a.js' } },
    {},
  ]) {
    const r = runHook(input)
    assert.equal(r.status, 0)
    assert.equal(r.stdout, '')
  }
})

test('the hook ignores input it cannot parse', () => {
  const r = spawnSync(process.execPath, [HOOK, 'pre-tool-use'], { input: 'not json', encoding: 'utf8' })
  assert.equal(r.status, 0)
  assert.equal(r.stdout, '')
})
