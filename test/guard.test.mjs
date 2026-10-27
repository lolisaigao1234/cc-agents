import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
    caseInsensitive: false,
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

// --- n24: destructive commands in their other common spellings -------------

test('destructive commands are denied with git global options, other flag spellings and forms (n24)', () => {
  for (const c of [
    'git -C . reset --hard HEAD',
    'git -C sub clean -fdx',
    'git --no-pager checkout .',
    'git -c x=y push --force',
    'git -c core.hooksPath=/dev/null commit -m x',
    'git --git-dir=.git --work-tree . reset --hard',
    'rm -Rf build',
    'rm -fR build',
    'rm -r -v -f build',
    'rm --recursive --force build',
    'rm -r dir',
    'sudo rm -rf /tmp/x',
    'find . -name x | xargs rm -rf',
    'git checkout HEAD -- src/a.js',
    'git checkout main src/a.js',
    'git checkout -f main',
    'git switch -f main',
    'git switch --discard-changes main',
    'git push origin +main',
    'git push -fu origin main',
    'git push --force-with-lease=main origin main',
    'git branch --delete --force feature',
    'git branch -df feature',
    'git commit -n -m x',
    'git commit -anm x',
    'git restore --staged a; git restore b',
    'git status && git -C . restore src/a.js',
    'bash -c "git reset --hard"',
    'echo $(git reset --hard)',
    'if true; then rm -rf build; fi',
  ]) {
    assert.ok(bash(c), c)
  }
})

test('non-destructive spellings near the destructive ones still pass (n24)', () => {
  for (const c of [
    'git -C sub status',
    'git checkout main',
    'git checkout -b feature main',
    'git switch -c feature',
    'git push origin main',
    'git push -u origin main',
    'git branch -d merged',
    'git commit -m "fix: n-th item"',
    'git commit -am x',
    'git clean -n',
    'git restore --staged a.js; git restore --staged b.js',
    'rm -f file.txt',
  ]) {
    assert.equal(bash(c), null, c)
  }
})

// --- n26 / n38: text that merely mentions a dangerous command ----------------

test('read-only commands and messages that mention dangerous text are allowed (n26, n38)', () => {
  for (const status of ['active', null, 'capped']) {
    for (const c of [
      `rg -n 'rm -rf' .`,
      `rg -n 'git reset --hard' docs`,
      `git commit -m "guard: block rm -rf and --no-verify"`,
      `git commit -m "docs: ql extend is user only"`,
      `rg -n 'ql extend' references`,
      `rg -n "ql start --force" docs`,
      `grep -rn "git push --force" .`,
      `echo "run ql extend later"`,
      `"$P/bin/ql" mark F1 fixed --reason "items.extend(batch) now copies; test test_batch_copy passes"`,
      `"$P/bin/ql" pause --reason "should the API extend to v2 clients?"`,
      `"$P/bin/ql" pause --reason "extend later"`,
      `cat <<'EOF' > /tmp/notes.md\nrm -rf build\ngit reset --hard\nql extend\nEOF`,
      `cp .quality-loop/config.json /tmp/cfg.bak`,
    ]) {
      assert.equal(bash(c, { loopStatus: status }), null, `${status}: ${c}`)
    }
  }
})

test('an actual ql extend is denied in any spelling, whatever the loop status (n26, n38)', () => {
  for (const status of ['active', 'capped', 'stalled', null]) {
    for (const c of [
      'ql extend',
      '"$ROOT/bin/ql" extend --rounds 2',
      'node "${CLAUDE_PLUGIN_ROOT}/scripts/ql.mjs" extend',
      'cd x && ql extend',
      'ql --rounds 3 extend',
      'env FOO=1 ql extend',
      'sh -c "ql extend"',
    ]) {
      assert.ok(bash(c, { loopStatus: status }), `${status}: ${c}`)
    }
  }
})

// --- n16 / n22: restarting to dodge the cap ----------------------------------

test('the agent cannot force a restart over an unfinished loop, in any flag order (n16, n22)', () => {
  for (const status of ['active', 'paused', 'capped', 'stalled', 'aborted']) {
    for (const c of ['ql start --mode review --force', 'ql --force start --mode review', '"$P/bin/ql" start --force=1', 'ql abort --reason x && ql start --force']) {
      assert.ok(bash(c, { loopStatus: status }), `${status}: ${c}`)
    }
  }
  // a first start, or one after a finished loop, is the agent's to run
  for (const status of [null, 'done']) assert.equal(bash('ql start --mode review --force', { loopStatus: status }), null)
  // a plain start is left to `ql start` itself, which refuses over spent rounds
  for (const status of [null, 'done', 'capped', 'aborted']) assert.equal(bash('ql start --mode review', { loopStatus: status }), null)
})

test('loop state stays protected while a loop is capped, stalled, paused or aborted (n16, n22)', () => {
  for (const status of ['capped', 'stalled', 'paused', 'aborted']) {
    assert.ok(g({ tool: 'Write', input: { file_path: '/repo/.quality-loop/state.json' }, loopStatus: status }), status)
    assert.ok(bash(`echo '{}' > .quality-loop/state.json`, { loopStatus: status }), status)
    assert.ok(bash('rm -r .quality-loop', { loopStatus: status }), status)
    assert.ok(bash('mv .quality-loop/state.json /tmp/s.json', { loopStatus: status }), status)
  }
  assert.equal(g({ tool: 'Write', input: { file_path: '/repo/.quality-loop/state.json' }, loopStatus: 'done' }), null)
})

// --- n23: un-normalised paths ------------------------------------------------

test('protected paths are matched after normalising .., //, ./ and case (n23)', () => {
  for (const file_path of [
    '/repo/src/../.quality-loop/state.json',
    '/repo/.quality-loop//state.json',
    '/repo/./.quality-loop/./config.json',
    '/repo//.quality-loop/state.json',
    'src/../.quality-loop/state.json',
  ]) {
    assert.ok(g({ tool: 'Write', input: { file_path } }), file_path)
  }
  assert.ok(g({ tool: 'Edit', input: { file_path: '/repo/.QUALITY-LOOP/STATE.JSON' }, caseInsensitive: true }))
  assert.equal(g({ tool: 'Edit', input: { file_path: '/repo/.QUALITY-LOOP/STATE.JSON' }, caseInsensitive: false }), null)
  // relative paths resolve against the hook's cwd
  assert.ok(g({ tool: 'Write', input: { file_path: '../.quality-loop/state.json' }, cwd: '/repo/sub' }))
  assert.ok(bash(`echo x > ../.quality-loop/state.json`, { cwd: '/repo/sub' }))
  assert.ok(bash(`cd sub && echo x > ../.quality-loop//state.json`))
  assert.ok(bash(`echo x > "$ROOT/.quality-loop/state.json"`))
  assert.ok(bash(`echo x > /repo/src/../.quality-loop/state.json`))
  assert.equal(g({ tool: 'Write', input: { file_path: '/elsewhere/.quality-loop/state.json' } }), null)
})

test('a symlinked root and its real path are the same place (n23)', () => {
  const real = realpathSync(mkdtempSync(join(tmpdir(), 'ql-guard-')))
  mkdirSync(join(real, '.quality-loop'))
  writeFileSync(join(real, '.quality-loop/state.json'), '{}')
  const link = `${real}-link`
  symlinkSync(real, link)
  assert.ok(g({ tool: 'Write', input: { file_path: join(link, '.quality-loop/state.json') }, root: real, cwd: real }))
  assert.ok(g({ tool: 'Write', input: { file_path: join(real, '.quality-loop/state.json') }, root: link, cwd: link }))
  assert.ok(bash(`echo x > ${join(link, '.quality-loop/state.json')}`, { root: real, cwd: real }))
  // a symlink inside the repository that points at the loop directory
  symlinkSync(join(real, '.quality-loop'), join(real, 'ql-dir'))
  assert.ok(g({ tool: 'Write', input: { file_path: join(real, 'ql-dir/state.json') }, root: real, cwd: real }))
})
