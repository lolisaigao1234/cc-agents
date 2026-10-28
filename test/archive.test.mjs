import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { archiveBlock } from '../plugins/trace/scripts/lib/archive.mjs'

const HOOK = fileURLToPath(new URL('../plugins/trace/scripts/hook.mjs', import.meta.url))

/**
 * A repository with an archive, look-alike paths and a symlink into the
 * archive. Its first commit touches the archive; its second only `docs/`.
 */
function fixture() {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'archive-block-')))
  const git = (/** @type {string[]} */ ...args) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, stdio: 'ignore' })
  git('init', '-q')
  for (const d of ['archive/docs', 'archived', 'docs', 'src/archive']) mkdirSync(join(repo, d), { recursive: true })
  for (const f of ['archive/old.md', 'archive/docs/older.md', 'archived/x.md', 'docs/a.md', 'docs/archive.md', 'src/archive/x.js']) writeFileSync(join(repo, f), 'x\n')
  git('add', '-A')
  git('commit', '-qm', 'first')
  writeFileSync(join(repo, 'docs/a.md'), 'y\n')
  git('commit', '-qam', 'second')
  symlinkSync(join(repo, 'archive'), join(repo, 'link'))
  return repo
}

const repo = fixture()
const at = (/** @type {string} */ p) => join(repo, p)
const bash = (/** @type {string} */ command, cwd = repo) => archiveBlock('Bash', { command }, cwd)
// Directories that do not exist yet, as a clone or a worktree would make them.
const fresh = join(tmpdir(), `archive-block-fresh-${process.pid}`)

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
    ['NotebookRead', { notebook_path: at('archive/n.ipynb') }],
    ['Grep', { pattern: 'x', path: at('archive') }],
    ['Grep', { pattern: 'x' }],
    ['Grep', { pattern: 'x', path: repo }],
    ['Grep', { pattern: 'x', glob: '!archive/old.md' }],
    ['Glob', { pattern: '**/*.md' }],
    ['Glob', { pattern: 'archive/*' }],
    ['Glob', { pattern: '{archive,docs}/*.md' }],
    ['Glob', { pattern: 'ar[c]hive/*.md' }],
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
    ['NotebookRead', { notebook_path: at('docs/n.ipynb') }],
    ['Grep', { pattern: 'archive', path: at('docs') }],
    ['Grep', { pattern: 'x', glob: '!archive/**' }],
    ['Glob', { pattern: 'docs/**/*.md' }],
    ['Glob', { pattern: '*.md' }],
    ['Glob', { pattern: '{docs,src}/**/*' }],
    ['Glob', { pattern: '*' }],
    ['Glob', { pattern: '*/' }],
    ['Write', { file_path: at('src/features/archive/index.ts') }],
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
  // the working directory the shell may really be in
  '(cd docs); cat archive/old.md',
  'cd nowhere; cat archive/old.md',
  'pushd docs; popd; cat archive/old.md',
  `cd ${repo}/docs && cd - && cat archive/old.md`,
  'env -C archive cat old.md',
  'sudo -D archive cat old.md',
  "env -S 'cat archive/old.md'",
  'cd docs && cd - && cat archive/old.md',
  'pushd docs && popd && cat archive/old.md',
  'cd nowhere || cd docs && cat ../archive/old.md',
  'false || cd docs && rg foo',
  '(cd docs && true); cat archive/old.md',
  "find docs -type f -exec sh -c 'cat archive/old.md' \\;",
  'find docs -exec cat archive/old.md \\;',
  "fish -c 'cat archive/old.md'",
  "watch -n1 'cat archive/old.md'",
  'stdbuf -oL rg foo',
  'caffeinate -i rg foo',
  'xargs -a archive/old.md echo',
  `X=x${'{a,b}'.repeat(30)}; cat archive/old.md`,
  `python3 -c "print(open('archive/old.md').read())"`,
  `node -e "require('fs').readFileSync('./archive/old.md')"`,
  // quoting and globs
  "cat $'archive/old.md'",
  'cat $"archive/old.md"',
  "cat $'\\x61rchive/old.md'",
  'cat ar*/old.md',
  'cat */old.md',
  'cat a[r]chive/old.md',
  'cat [[:alpha:]]rchive/old.md',
  'cat ar(c|x)hive/old.md',
  'cat **/*.md',
  'cat ~+/archive/old.md',
  `cat ${repo}/archive/old.md`,
  // values glued to options
  'grep -farchive/old.md docs',
  'sort -oarchive/new docs/a.md',
  'dd if=archive/old.md',
  'tar -Carchive -cf x.tar old.md',
  // listing and searching into it
  'ls archive',
  'ls archive/',
  'rg foo archive',
  'rg -n foo',
  'rg --files',
  'rg foo -g archive',
  'grep -rn foo .',
  'grep -r foo',
  'grep -r --exclude=archive foo .',
  'grep -r --exclude-dir=archive/docs foo .',
  'grep -r --exclude-dir=archive/ foo .',
  'grep -d recurse foo .',
  'grep --directories recurse foo .',
  "rg foo -g '!archive' -g '*'",
  "rg foo -g '!./archive'",
  "rg foo -g '!Archive'",
  'find . -path ./archive -prune -o -name old.md -delete',
  'find . -depth -path ./archive -prune -o -print',
  'find . -path archive -prune -o -print',
  `find ${repo} -path ./archive -prune -o -print`,
  'cd docs && find .. -path ./archive -prune -o -print',
  'ls -R -I archive',
  'tar cf - --exclude=/archive .',
  'zip -r x.zip . -x archive',
  `zip -r x.zip ${repo} -x 'archive/*'`,
  'find . -name "*.md"',
  'find .',
  "find . ! -path './archive/*'",
  'find . -path ./docs -prune -o -print',
  'tree',
  'du -a',
  'ls -R',
  // git: the tree, the index and the history
  'git grep foo',
  'git grep foo HEAD',
  'git ls-files',
  "git ls-files ':!archive/old.md'",
  "git ls-files ':(glob)arch*'",
  "git ls-files ':(icase)ARCHIVE'",
  "git ls-files ':(literal)archive/old.md'",
  "cd docs && git ls-files ':(top)archive'",
  'git ls-tree -r HEAD',
  'git archive HEAD',
  'git -C archive log',
  'git show HEAD:archive/old.md',
  'git show HEAD:./archive/old.md',
  'git show :0:archive/old.md',
  'git show :archive/old.md',
  'git cat-file -p HEAD:archive/old.md',
  'git cat-file --batch <<< HEAD:archive/old.md',
  'git show HEAD~1',
  'git log -L1,1:archive/old.md',
  'git log --binary',
  'git log --compact-summary',
  "git log -p -- ':!ARCHIVE'",
  'git reflog -p',
  'git format-patch -1 --stdout',
  'git diff-tree -p --root HEAD~1',
  'git fast-export HEAD',
  'git rev-list --objects --all',
  'git rev-parse HEAD:archive/old.md',
  `git clone --bare . ${fresh}.git && git -C ${fresh}.git show HEAD:archive/old.md`,
  'git log -p',
  'git log --stat',
  'git log -p -- archive',
  'git diff 4b825dc642cb6eb9a060e54bf8d69288fbee4904 HEAD',
  'git bundle create x.bundle --all',
  'git checkout-index -a',
  `git --work-tree=${fresh} checkout .`,
  `git worktree add ${fresh} && cat ${fresh}/archive/old.md`,
  `git clone . ${fresh} && cat ${fresh}/archive/old.md`,
  // writing, deleting, copying or moving out
  'echo hi > archive/new.md',
  'cp docs/a.md archive/',
  'rm archive/old.md',
  'git rm archive/old.md',
  'git rm -r .',
  'git restore archive/old.md',
  'cp archive/old.md docs/',
  'mv archive/old.md docs/',
  'mv archive docs/',
  'git mv archive/old.md docs/',
  'mv archive/old.md archive/renamed.md',
  'mv docs/a.md archive/old.md',
  'mv -f docs/a.md archive/old.md',
  'git mv -f docs/a.md archive/old.md',
  'tar czf x.tgz .',
  'tar -rf x.tar .',
  'bsdtar -cf x.tar .',
  'pax -w .',
  '7z a x.7z .',
  'cp -r . /tmp/x',
  'ditto . /tmp/x',
  'scp -r . host:x',
  'zip -r x.zip .',
  'rsync -a . /tmp/x',
  'diff -r . /tmp/x',
]

const ALLOWED = [
  'cat docs/a.md',
  'cat archived/x.md',
  'cat docs/archive.md',
  'cat src/archive/x.js',
  'cat docs/*.md',
  'cat src/*/x.js',
  "npx prettier --check 'docs/**/*.md'",
  'ls',
  'ls docs',
  'mkdir -p archive/docs/research',
  'mkdir -p src/features/archive && touch src/features/archive/index.ts',
  'curl -LO https://github.com/o/r/archive/refs/tags/v1.tar.gz',
  'npm install https://github.com/o/r/archive/main.tar.gz',
  'npx vitest -t archive',
  'npm run archive',
  'make archive',
  'node -e "require(\"./src/index.js\")"',
  'node -p "1+(2"',
  `python3 -c "print(open('docs/a.md').read())"`,
  "jq '.[] | select(.path | startswith(\"src/\"))' data.json",
  '[ -d archive ] && echo yes',
  'test -d archive',
  'ls -d */',
  'du -sh *',
  'find . -maxdepth 1',
  'find . -maxdepth 1 -type f',
  'tree -L 1',
  'rg --max-depth 1 foo',
  // text that mentions the archive
  'echo archive',
  'echo archive/old.md',
  "printf '%s' archive/old.md",
  'node --test --test-name-pattern archive',
  "gh issue create --title 'archive block' --label archive --body 'see [x](/archive/)'",
  "gh pr create --title 'archive/: move in' --body 'the archive'",
  // searching elsewhere
  'rg foo docs',
  'cd src && rg foo',
  'cd src && grep -rn foo .',
  'cd src && find . -name "*.js"',
  'cd src && git grep foo',
  'cd docs && ls *',
  'pushd src && rg foo && popd',
  "rg foo -g '!{archive,node_modules}'",
  "rg foo -g '*.md' -g '!archive'",
  "rg foo -g '!/archive'",
  "rg foo -g '!archive/'",
  'rg -n "archive" docs',
  'rg -e archive/ src',
  'rg --files-with-matches archive docs',
  'rg --sort path foo docs',
  'rg --max-columns 100 foo docs',
  "rg --type-add 'web:*.html' foo docs",
  'rg -r x foo docs',
  "rg --glob='**/*.md' foo docs",
  'grep -n archive docs/a.md',
  'find docs -name "*.md"',
  // git that leaves the archive alone
  'git status',
  'git diff',
  'git diff --cached',
  'git diff HEAD~1 HEAD',
  'git diff HEAD~1 -- docs',
  'git log --oneline',
  'git log --grep=archive',
  'git log -S archive',
  'git log --author archive',
  'git log -p -1',
  'git show HEAD',
  'git show HEAD:docs/a.md',
  'git show -s HEAD~1',
  'git show --no-patch --format=%B HEAD~1',
  'git log -L1,1:docs/a.md',
  'git log --format=%H -n 5',
  'git reflog',
  'git diff-tree -p HEAD',
  "git format-patch -1 --stdout -- ':!archive'",
  'git branch archive-old',
  'git checkout -b archive',
  'git switch -c archive',
  'git push origin HEAD:archive',
  'git commit -m "archive/: move the old ADRs in"',
  "git commit -am 'archive the old ADRs'",
  'git commit -m x -- archive/old.md',
  // after moving a file in, it must be staged and committed
  'git add archive/old.md',
  'git add -A',
  'git restore --staged archive/old.md',
  // moving in
  'mv docs/a.md archive/',
  'mv docs/a.md archive/docs/a.md',
  'git mv docs/a.md archive/docs/a.md',
  'mv -t archive docs/a.md',
  // searches that leave the archive out
  "rg foo -g '!archive'",
  "rg foo -g '!archive/**'",
  'grep -rn foo --exclude-dir=archive .',
  "git grep foo -- ':!archive'",
  "git grep foo -- ':(exclude)archive'",
  "git ls-files ':!archive'",
  "git log -p -- ':!archive'",
  'find . -path ./archive -prune -o -name "*.md" -print',
  'find . -name archive -prune -o -print',
  'find . \\( -name node_modules -o -name archive \\) -prune -o -name "*.md" -print',
  'find . -type d \\( -path ./node_modules -o -path ./archive \\) -prune -o -type f -print',
  `find ${repo} -path ${repo}/archive -prune -o -print`,
  'tar czf x.tgz --exclude=archive .',
  "zip -r x.zip . -x 'archive/*'",
]

test('Bash commands that reach into the archive are denied', () => {
  assert.deepEqual(DENIED.filter(c => !bash(c)), [])
})

test('Bash commands that stay out of the archive, or move files into it, are allowed', () => {
  assert.deepEqual(ALLOWED.filter(c => bash(c)).map(c => [c, bash(c)]), [])
})

test('a root .ignore that lists the archive lets rg, fd and Grep search the repository', () => {
  const r = fixture()
  writeFileSync(join(r, '.ignore'), 'node_modules/\n/archive/\n')
  const allowed = ['rg foo', 'rg --files', 'rg --no-ignore-vcs foo', 'rg --no-ignore-messages foo', "rg -g '*.md' foo", 'rg -g "**/*.md" foo',
    'rg --glob=**/*.js foo', 'rg -g "*/*.md" foo', 'rg -g "{docs,src}/**" foo', 'fd md']
  assert.deepEqual(allowed.filter(c => bash(c, r)), [])
  for (const glob of ['*.md', '**/*.md', '**/*.{ts,tsx}']) assert.equal(archiveBlock('Grep', { pattern: 'x', glob }, r), null, glob)
  assert.equal(archiveBlock('Grep', { pattern: 'x' }, r), null)
  // Turning the ignore files off, following symlinks, or globbing the archive back in.
  const denied = ['rg -u foo', 'rg -uu foo', 'rg --no-ignore foo', 'rg --unrestricted foo', 'rg -L foo', 'rg --follow foo', "rg -g '*' foo",
    "rg -g '**' foo", "rg -g 'archive' foo", 'fd -I md', 'fd -L md', 'grep -r foo', 'git grep foo']
  assert.deepEqual(denied.filter(c => !bash(c, r)), [])
  assert.ok(archiveBlock('Grep', { pattern: 'x', glob: '*' }, r))
  // The Glob tool does not honour .ignore.
  assert.ok(archiveBlock('Glob', { pattern: '**/*.md' }, r))
})

test('a search reaches the archive of the repository it searches, wherever the agent is', () => {
  const ignoring = fixture()
  writeFileSync(join(ignoring, '.ignore'), '/archive/\n')
  const other = fixture()
  // The agent's repository ignores its archive; the one it searches does not.
  assert.ok(bash(`rg foo ${other}`, ignoring))
  assert.ok(archiveBlock('Grep', { pattern: 'foo', path: other }, ignoring))
  // A directory outside any repository may hold repositories, each with an archive.
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'repos-')))
  execFileSync('git', ['clone', '-q', other, join(parent, 'one')], { stdio: 'ignore' })
  for (const c of [`rg -uu foo ${parent}`, `grep -r foo ${parent}`, `cp -r ${parent} /tmp/x`, 'find / -name x']) assert.ok(bash(c, ignoring), c)
  assert.ok(archiveBlock('Grep', { pattern: 'foo', path: parent }, ignoring))
  assert.ok(archiveBlock('Glob', { pattern: '**/*.md', path: parent }, ignoring))
  // A bare repository holds the archive in its history.
  const bare = join(parent, 'bare.git')
  execFileSync('git', ['clone', '-q', '--bare', other, bare], { stdio: 'ignore' })
  assert.ok(bash(`git -C ${bare} show HEAD:archive/old.md`, ignoring))
})

test('an ignore file that takes the archive back voids the .ignore exemption', () => {
  const r = fixture()
  writeFileSync(join(r, '.ignore'), '/archive/\n')
  writeFileSync(join(r, '.rgignore'), '!/archive/\n')
  assert.ok(bash('rg foo', r))
  assert.ok(archiveBlock('Grep', { pattern: 'foo' }, r))
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
