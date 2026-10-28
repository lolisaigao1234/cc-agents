import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { archiveBlock } from '../plugins/trace/scripts/lib/archive.mjs'

const HOOK = fileURLToPath(new URL('../plugins/trace/scripts/hook.mjs', import.meta.url))

/** A repository with an archive, look-alike paths and a symlink into the archive. */
function fixture() {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'archive-block-')))
  for (const d of ['.git', 'archive/docs', 'archived', 'docs', 'src/archive']) mkdirSync(join(repo, d), { recursive: true })
  for (const f of ['archive/old.md', 'archive/docs/older.md', 'archived/x.md', 'docs/a.md', 'docs/archive.md', 'src/archive/x.js']) writeFileSync(join(repo, f), 'x\n')
  symlinkSync(join(repo, 'archive'), join(repo, 'link'))
  return repo
}

const repo = fixture()
const at = (/** @type {string} */ p) => join(repo, p)
const bash = (/** @type {string} */ command, cwd = repo) => archiveBlock('Bash', { command }, cwd)

test('file tools are denied inside the archive', () => {
  for (const [tool, input] of /** @type {[string, Record<string, string>][]} */ ([
    ['Read', { file_path: at('archive/old.md') }],
    ['Read', { file_path: 'archive/old.md' }],
    ['Read', { file_path: at('docs/../archive/old.md') }],
    ['Read', { file_path: at('link/old.md') }],
    ['Edit', { file_path: at('archive/old.md') }],
    ['Write', { file_path: at('archive/new.md') }],
    ['MultiEdit', { file_path: at('archive/docs/older.md') }],
    ['NotebookEdit', { notebook_path: at('archive/n.ipynb') }],
    ['Grep', { pattern: 'x', path: at('archive') }],
    ['Grep', { pattern: 'x' }],
    ['Grep', { pattern: 'x', path: repo }],
    ['Glob', { pattern: '**/*.md' }],
    ['Glob', { pattern: 'archive/*' }],
    ['Glob', { pattern: '*.md', path: at('archive') }],
    ['LS', { path: at('archive') }],
  ])) {
    const why = archiveBlock(tool, input, repo)
    assert.ok(why, `${tool} ${JSON.stringify(input)}`)
    assert.match(/** @type {string} */ (why), /human/)
  }
})

test('file tools are allowed outside the archive, look-alikes included', () => {
  for (const [tool, input] of /** @type {[string, Record<string, string>][]} */ ([
    ['Read', { file_path: at('docs/a.md') }],
    ['Read', { file_path: at('archived/x.md') }],
    ['Read', { file_path: at('docs/archive.md') }],
    ['Read', { file_path: at('src/archive/x.js') }],
    ['Write', { file_path: at('docs/new.md') }],
    ['Grep', { pattern: 'archive', path: at('docs') }],
    ['Grep', { pattern: 'x', glob: '!archive/**' }],
    ['Glob', { pattern: 'docs/**/*.md' }],
    ['Glob', { pattern: '*.md' }],
    ['LS', { path: repo }],
  ])) {
    assert.equal(archiveBlock(tool, input, repo), null, `${tool} ${JSON.stringify(input)}`)
  }
})

const DENIED = [
  // reading by path
  'cat archive/old.md',
  'cat ./archive/old.md',
  'head -5 archive/old.md',
  'less < archive/old.md',
  'sed -n 1p archive/old.md',
  'cat link/old.md',
  'cd docs && cat ../archive/old.md',
  'cd archive && cat old.md',
  'bash -c "cat archive/old.md"',
  'echo $(cat archive/old.md)',
  'cat ar*/old.md',
  'cat */old.md',
  'cat a[r]chive/old.md',
  'cat **/*.md',
  // listing and searching into it
  'ls archive',
  'ls archive/',
  'rg foo archive',
  'rg -n foo',
  'rg --files',
  'grep -rn foo .',
  'grep -r foo',
  'find . -name "*.md"',
  'find .',
  'tree',
  'du -a',
  'ls -R',
  'git grep foo',
  'git ls-files',
  'git -C archive log',
  // history
  'git show HEAD:archive/old.md',
  'git cat-file -p HEAD:archive/old.md',
  'git log -p -- archive',
  // writing, deleting, copying or moving out
  'echo hi > archive/new.md',
  'cp docs/a.md archive/',
  'rm archive/old.md',
  'git rm archive/old.md',
  'cp archive/old.md docs/',
  'mv archive/old.md docs/',
  'git mv archive/old.md docs/',
  'mv archive/old.md archive/renamed.md',
  'tar czf x.tgz .',
  'cp -r . /tmp/x',
  'zip -r x.zip .',
  'rsync -a . /tmp/x',
]

const ALLOWED = [
  'cat docs/a.md',
  'cat archived/x.md',
  'cat docs/archive.md',
  'cat src/archive/x.js',
  'cat docs/*.md',
  'ls',
  'ls docs',
  'git status',
  'git diff',
  'rg foo docs',
  'rg -n "archive" docs',
  'rg -e archive/ src',
  'grep -n archive docs/a.md',
  'find docs -name "*.md"',
  'echo archive',
  'git commit -m "archive/: move the old ADRs in"',
  // moving in
  'mv docs/a.md archive/',
  'mv docs/a.md archive/docs/a.md',
  'git mv docs/a.md archive/docs/a.md',
  'mv -t archive docs/a.md',
  'mkdir -p archive/docs/research',
  // searches that exclude the archive
  "rg foo -g '!archive'",
  "rg foo -g '!archive/**'",
  'grep -rn foo --exclude-dir=archive .',
  "git grep foo -- ':!archive'",
  "git ls-files ':!archive'",
  'find . -path ./archive -prune -o -name "*.md" -print',
  'tar czf x.tgz --exclude=archive .',
]

test('Bash commands that reach into the archive are denied', () => {
  for (const c of DENIED) assert.ok(bash(c), c)
})

test('Bash commands that stay out of the archive, or move files into it, are allowed', () => {
  for (const c of ALLOWED) assert.equal(bash(c), null, c)
})

test('a root .ignore that lists the archive lets rg and fd search the repository', () => {
  const r = fixture()
  writeFileSync(join(r, '.ignore'), 'node_modules/\n/archive/\n')
  assert.equal(bash('rg foo', r), null)
  assert.equal(bash('rg --files', r), null)
  assert.equal(bash('fd md', r), null)
  for (const c of ['rg -u foo', 'rg --no-ignore foo', 'rg -uu foo', 'grep -r foo', 'git grep foo']) assert.ok(bash(c, r), c)
})

test('an archive anywhere but a repository root is not the archive', () => {
  const plain = realpathSync(mkdtempSync(join(tmpdir(), 'no-repo-')))
  mkdirSync(join(plain, 'archive'))
  assert.equal(bash('cat archive/x', plain), null)
  assert.equal(archiveBlock('Read', { file_path: join(plain, 'archive/x') }, plain), null)
})

test('the hook denies a Read of the archive, and lets other reads through', () => {
  const run = (/** @type {object} */ input) =>
    spawnSync(process.execPath, [HOOK, 'pre-tool-use'], { input: JSON.stringify(input), encoding: 'utf8' })
  const denied = run({ tool_name: 'Read', tool_input: { file_path: at('archive/old.md') }, cwd: repo })
  const out = JSON.parse(denied.stdout).hookSpecificOutput
  assert.equal(out.permissionDecision, 'deny')
  assert.match(out.permissionDecisionReason, /archive/)
  assert.equal(run({ tool_name: 'Read', tool_input: { file_path: at('docs/a.md') }, cwd: repo }).stdout, '')
  const cat = JSON.parse(run({ tool_name: 'Bash', tool_input: { command: 'cat archive/old.md' }, cwd: repo }).stdout)
  assert.equal(cat.hookSpecificOutput.permissionDecision, 'deny')
})
