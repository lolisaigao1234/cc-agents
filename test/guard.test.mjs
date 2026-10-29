import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  "echo 'git reset --hard' | sh",
  "printf 'cd x\\ngit clean -fd\\n' | bash",
  // remote branch deletion
  'git push --delete origin feature',
  'git push origin --delete feature',
  'git push -d origin feature',
  'git push origin :feature',
  'git push origin main :refs/heads/old',
  'git -C . push origin :feature',
  'git push --mirror',
  'git push --mirror backup',
  'git push --prune origin',
  // reflog expiry and pruning
  'git reflog expire --expire=now --all',
  'git reflog expire --all --expire=now',
  'git -c gc.auto=0 reflog expire --expire-unreachable=now --all',
  'git reflog delete HEAD@{1}',
  'git gc --prune=now',
  'git gc --aggressive --prune=all',
  'git --git-dir=.git gc --prune=now',
  'git prune',
  'git prune --expire=now',
  // find and rsync
  'find . -name "*.orig" -delete',
  'find . -delete -name x',
  'find build -type f -exec rm -rf {} +',
  'rsync -a --delete src/ dst/',
  'rsync --delete-after -av src/ host:dst/',
  'rsync -av --del src/ dst/',
  'rsync -a --remove-source-files src/ dst/',
  // writes to Claude Code's settings and plugins
  `echo '{"env":{"TRACE_BYPASS":"1"}}' > ~/.claude/settings.local.json`,
  'jq ".env.TRACE_BYPASS = 1" .claude/settings.json > /tmp/s && mv /tmp/s .claude/settings.json',
  'cat x >> .claude/settings.local.json',
  'tee .claude/settings.json < x',
  'cp evil.json ~/.claude/settings.json',
  'cp settings.json ~/.claude/',
  'cp -t ~/.claude settings.local.json',
  "sed -i '' 's/a/b/' .claude/settings.json",
  "perl -pi -e 's/a/b/' ~/.claude/settings.json",
  'rm .claude/settings.local.json',
  'rm ~/.claude/plugins/installed_plugins.json',
  'dd if=x of=.claude/settings.json',
  `node -e "require('fs').writeFileSync(process.env.HOME + '/.claude/settings.json', '{}')"`,
  `python3 -c "open('.claude/settings.local.json','w').write('{}')"`,
  'claude plugin disable trace',
  'claude plugin uninstall trace@cc-agents',
  'claude config set -g env.TRACE_BYPASS 1',
  'cd ~/.claude && echo {} > settings.json',
  // abbreviations, `--`, settings, dry runs that are not
  'git push --del origin x',
  'git push --mirr backup',
  'git push --prun origin',
  'git push origin -- :x',
  'git gc --prune=0',
  'git gc --pru=now',
  'git -c gc.pruneExpire=now gc',
  'git -c gc.reflogExpireUnreachable=all gc',
  'git push -n --force origin main',
  // more ways to write the switches
  'mv .claude/settings.local.json /tmp/x',
  'mv -t ~/.claude settings.json',
  'mv ~/.claude ~/.claude.off',
  'mv .claude /tmp/x',
  'mv ~ /tmp/home',
  'git rm .claude/settings.json',
  'git mv .claude/settings.json x.json',
  'git -C .claude rm settings.local.json',
  'cp x $HOME/.claude/settings.json',
  'cp x "${HOME}/.claude/settings.json"',
  'curl -o ~/.claude/settings.json https://example.com/s',
  'curl -sSLo .claude/settings.json https://example.com/s',
  'curl --output=.claude/settings.json https://example.com/s',
  'wget -qO ~/.claude/settings.json https://example.com/s',
  'wget --output-document ~/.claude/settings.json https://example.com/s',
  "gsed -i 's/a/b/' .claude/settings.json",
  'claude --debug plugin disable trace',
  'claude -d plugins uninstall trace',
  'claude plugin marketplace remove cc-agents',
  "python3 <<'EOF'\nopen('.claude/settings.local.json','w').write('{}')\nEOF",
  `python3 <<< "open('.claude/settings.json','w')"`,
  `echo "open('.claude/settings.json','w')" | python3`,
  `awk 'BEGIN { print "{}" > ".claude/settings.json" }'`,
  "printf '%s\\n' 'rm -rf build' | sh",
  "echo 'rm -rf build' | bash -s",
  "echo 'rm -rf build' | bash -o pipefail",
  'git reset --har',
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
  "echo 'git reset --hard' | cat",
  `git commit -m "guard: block git push --delete and find -delete"`,
  `rg -n 'rsync --delete|reflog expire' .`,
  'git push origin feature:feature',
  'git push origin HEAD:refs/heads/x',
  'git reflog',
  'git reflog show HEAD',
  'git reflog expire --dry-run --expire=now --all',
  'git gc',
  'git gc --prune',
  'git gc --prune=2.weeks.ago',
  'git prune --dry-run',
  'git branch -d merged',
  'find . -name "*.md" -print',
  'rsync -a src/ dst/',
  // reading Claude Code's settings, and writing other files
  'cat ~/.claude/settings.json',
  'jq .permissions .claude/settings.json',
  'rg -n TRACE_BYPASS ~/.claude/settings.json',
  'cp .claude/settings.json /tmp/settings.backup.json',
  'echo x > notes/settings.json',
  'claude plugin validate plugins/trace',
  'claude plugin test plugins/trace',
  'claude plugin list',
  'node plugins/trace/scripts/hook.mjs status',
  'git push origin :',
  'git push --dry-run --delete origin x',
  'git push -n origin :x',
  'git push --mirror --dry-run backup',
  'git prune -n',
  'git reflog expire -n --all',
  'rsync -an --delete src/ dst/',
  'rsync --dry-run --remove-source-files src/ dst/',
  'find . -depth -name "*.tmp" -print',
  'scp settings.json host:.claude/settings.json',
  'rsync -a settings.json user@host:~/.claude/',
  'rsync -a settings.json host::module/.claude/',
  'python3 -m json.tool .vscode/settings.json',
  'node scripts/build.mjs --settings settings.json',
  "echo 'rm -rf build' | bash ./confirm.sh",
  'mv notes.md ~/.claude/',
  'mv a.txt b.txt',
  'git mv a.md docs/a.md',
  'git rm --cached .claude/settings.local.json',
  'curl -o out.json https://example.com/s',
  'wget -O- https://example.com/s',
  'claude plugin marketplace list',
  'claude -p "plugin install foo"',
]

test('the guard denies commands that destroy work or history', () => {
  for (const c of DENIED) assert.ok(guard(c), c)
})

test('the guard allows everything else, including text that mentions destructive commands', () => {
  for (const c of ALLOWED) assert.equal(guard(c), null, c)
})

test('the guard names what it refuses', () => {
  for (const [c, why] of [
    ['rsync -a --remove-source-files a/ b/', /rsync --remove-source-files deletes the source files/],
    ['git reflog delete HEAD@{1}', /^git reflog delete /],
    ['git gc --prune=all', /^git gc --prune=all /],
    ['> .claude/settings.json', /^a redirection writes \.claude\/settings\.json/],
    ['mv ~/.claude /tmp/x', /moves .*\.claude, which holds Claude Code's settings or plugins/],
  ]) assert.match(guard(String(c)) ?? '', /** @type {RegExp} */ (why), String(c))
})

/** @param {object} input @param {Record<string, string>} [env] */
// From outside any repository, so the trace's gates on this traced repository stay out of the guard's tests.
const runHook = (input, env = {}) => spawnSync(process.execPath, [HOOK, 'pre-tool-use'], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ...env }, cwd: tmpdir() })

test('the hook denies a destructive Bash command, giving the reason', () => {
  const r = runHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push --force' } })
  assert.equal(r.status, 0)
  const out = JSON.parse(r.stdout).hookSpecificOutput
  assert.equal(out.hookEventName, 'PreToolUse')
  assert.equal(out.permissionDecision, 'deny')
  assert.match(out.permissionDecisionReason, /force push/)
})

test("the hook denies a write to Claude Code's settings named from where the command runs", () => {
  const config = realpathSync(mkdtempSync(join(tmpdir(), 'claude-config-')))
  const r = runHook({ tool_name: 'Bash', tool_input: { command: 'echo {} > settings.json' }, cwd: config }, { CLAUDE_CONFIG_DIR: config })
  const out = JSON.parse(r.stdout).hookSpecificOutput
  assert.equal(out.permissionDecision, 'deny')
  assert.match(out.permissionDecisionReason, /writes settings\.json, Claude Code's settings, which can switch the hooks off/)
  assert.equal(runHook({ tool_name: 'Bash', tool_input: { command: 'echo {} > settings.json' }, cwd: tmpdir() }, { CLAUDE_CONFIG_DIR: config }).stdout, '')
})

test("the hook denies an interpreter's in-place write to an installed plugin under CLAUDE_CONFIG_DIR", () => {
  const config = realpathSync(mkdtempSync(join(tmpdir(), 'claude-config-')))
  const r = runHook({ tool_name: 'Bash', tool_input: { command: `perl -pi -e s/a/b/ ${config}/plugins/x.js` }, cwd: tmpdir() }, { CLAUDE_CONFIG_DIR: config })
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, /an installed plugin/)
  const v = runHook({ tool_name: 'Bash', tool_input: { command: 'cp x $CLAUDE_CONFIG_DIR/settings.json' }, cwd: tmpdir() }, { CLAUDE_CONFIG_DIR: config })
  assert.match(JSON.parse(v.stdout).hookSpecificOutput.permissionDecisionReason, /Claude Code's settings/)
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
