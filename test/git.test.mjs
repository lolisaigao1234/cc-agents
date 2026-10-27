import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { diffTrees, git, resolveBase, restoreTree, snapshotTree } from '../plugins/quality-loop/scripts/lib/git.mjs'
import * as loop from '../plugins/quality-loop/scripts/lib/loop.mjs'
import { makeRepo, writeFiles } from './helpers.mjs'

/** git with raw byte input/output, for paths that are not valid UTF-8 */
function gitBytes(/** @type {string} */ root, /** @type {string[]} */ args, /** @type {Buffer} */ input = Buffer.alloc(0)) {
  const r = spawnSync('git', args, { cwd: root, input })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout
}

/** A nested repository with one commit, inside `root`. */
function nestedRepo(/** @type {string} */ root, /** @type {string} */ dir, /** @type {Record<string, string>} */ files) {
  const at = join(root, dir)
  mkdirSync(at, { recursive: true })
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 't@e'], ['config', 'user.name', 't'], ['config', 'commit.gpgsign', 'false']]) {
    git(args, { cwd: at })
  }
  writeFiles(at, files)
  git(['add', '-A'], { cwd: at })
  git(['commit', '-qm', 'one'], { cwd: at })
  return at
}

test('snapshot/restore round-trips edits, new files and deletions without touching the index', () => {
  const root = makeRepo({ 'a.txt': 'one\n', 'b.txt': 'keep\n' })
  writeFileSync(`${root}/a.txt`, 'two\n')
  git(['add', 'a.txt'], { cwd: root })
  const indexBefore = git(['diff', '--cached', '--name-only'], { cwd: root }).stdout
  const cp = snapshotTree(root)

  writeFileSync(`${root}/a.txt`, 'three\n')
  writeFileSync(`${root}/new.txt`, 'created\n')
  mkdirSync(`${root}/.quality-loop`, { recursive: true })
  writeFileSync(`${root}/.quality-loop/state.json`, '{"keep":true}')
  git(['rm', '-q', 'b.txt'], { cwd: root })

  const { restored, deleted } = restoreTree(root, cp)
  assert.equal(readFileSync(`${root}/a.txt`, 'utf8'), 'two\n')
  assert.equal(readFileSync(`${root}/b.txt`, 'utf8'), 'keep\n')
  assert.equal(existsSync(`${root}/new.txt`), false)
  assert.equal(readFileSync(`${root}/.quality-loop/state.json`, 'utf8'), '{"keep":true}', 'loop files untouched')
  assert.deepEqual(restored.sort(), ['a.txt', 'b.txt'])
  assert.deepEqual(deleted, ['new.txt'])
  assert.equal(git(['stash', 'list'], { cwd: root }).stdout, '')
  assert.equal(git(['rev-parse', 'HEAD'], { cwd: root }).ok, true)
  // the snapshot itself did not change what the user had staged
  assert.ok(indexBefore.includes('a.txt'))
})

test('diffTrees shows untracked files against the base and skips loop files', () => {
  const root = makeRepo({ 'a.txt': 'one\n' })
  const base = resolveBase(root, 'auto')
  writeFileSync(`${root}/fresh.js`, 'let x = 1\n')
  mkdirSync(`${root}/.quality-loop`, { recursive: true })
  writeFileSync(`${root}/.quality-loop/x.json`, '{}')
  const d = diffTrees(root, base, snapshotTree(root))
  assert.match(d, /fresh\.js/)
  assert.doesNotMatch(d, /quality-loop/)
})

test('resolveBase auto: merge-base with main when on a feature branch', () => {
  const root = makeRepo({ 'a.txt': 'one\n' })
  const main = git(['rev-parse', 'HEAD'], { cwd: root }).stdout.trim()
  git(['checkout', '-q', '-b', 'feature'], { cwd: root })
  writeFileSync(`${root}/a.txt`, 'two\n')
  git(['commit', '-qam', 'feature work'], { cwd: root })
  assert.equal(resolveBase(root, 'auto'), main)
  assert.throws(() => resolveBase(root, 'nope'), /does not resolve/)
})

test('revert never deletes files that were ignored at checkpoint time, even when the round un-ignores or force-adds them', () => {
  const root = makeRepo({ '.gitignore': '.env\nnode_modules/\n', 'a.txt': 'one\n' })
  writeFiles(root, { '.env': 'SECRET=1\n', 'node_modules/x.js': 'module\n', 'secret.key': 'k\n' })
  writeFileSync(`${root}/.gitignore`, '.env\nnode_modules/\nsecret.key\n')
  const cp = snapshotTree(root)

  // the round empties the ignore rules, force-stages an ignored file and creates a file
  writeFileSync(`${root}/.gitignore`, '')
  git(['add', '-f', 'secret.key'], { cwd: root })
  writeFileSync(`${root}/new.txt`, 'created\n')

  const out = restoreTree(root, cp)
  assert.equal(readFileSync(`${root}/.env`, 'utf8'), 'SECRET=1\n')
  assert.equal(readFileSync(`${root}/node_modules/x.js`, 'utf8'), 'module\n')
  assert.equal(readFileSync(`${root}/secret.key`, 'utf8'), 'k\n')
  assert.equal(readFileSync(`${root}/.gitignore`, 'utf8'), '.env\nnode_modules/\nsecret.key\n')
  assert.deepEqual(out.deleted, ['new.txt'])
  assert.equal(existsSync(`${root}/new.txt`), false)
  // what a revert removes is moved aside, not destroyed
  const trash = join(root, '.quality-loop', 'trash')
  const [batch] = readdirSync(trash).filter(n => n !== '.gitignore')
  assert.equal(readFileSync(join(trash, String(batch), 'new.txt'), 'utf8'), 'created\n')
})

test('revert restores the real index to the round start: staged changes do not survive a reverted round', () => {
  const root = makeRepo({ 'a.txt': 'one\n', 'b.txt': 'b\n' })
  writeFileSync(`${root}/b.txt`, 'staged before the round\n')
  git(['add', 'b.txt'], { cwd: root })
  const cp = snapshotTree(root)

  writeFileSync(`${root}/a.txt`, 'broken\n')
  writeFileSync(`${root}/new.txt`, 'created\n')
  git(['add', '-A'], { cwd: root })

  const out = restoreTree(root, cp)
  assert.deepEqual(out.problems, [])
  assert.equal(git(['status', '--porcelain'], { cwd: root }).stdout, 'M  b.txt\n')
  assert.doesNotMatch(git(['diff', '--cached'], { cwd: root }).stdout, /broken|created/)
})

test('revert after the round committed: index and tree go back, and the moved HEAD is reported', () => {
  const root = makeRepo({ 'a.txt': 'one\n' })
  const start = git(['rev-parse', 'HEAD'], { cwd: root }).stdout.trim()
  const cp = snapshotTree(root)

  writeFileSync(`${root}/a.txt`, 'broken\n')
  writeFileSync(`${root}/new.txt`, 'created\n')
  git(['add', '-A'], { cwd: root })
  git(['commit', '-qm', 'fixer commit'], { cwd: root })

  const out = restoreTree(root, cp)
  assert.equal(out.problems.length, 1)
  assert.match(out.problems[0] ?? '', new RegExp(`HEAD moved.*git reset --soft ${start}`))
  assert.equal(readFileSync(`${root}/a.txt`, 'utf8'), 'one\n')
  // the index matches the round start, so a soft reset is all that is left to do
  assert.equal(git(['diff-index', '--cached', '--name-only', start], { cwd: root }).stdout, '')
  git(['reset', '-q', '--soft', start], { cwd: root })
  assert.equal(git(['status', '--porcelain'], { cwd: root }).stdout, '')
})

test('snapshots and reverts survive an empty nested repo and an unreadable file', { skip: process.getuid?.() === 0 && 'root can read mode 000 files' }, () => {
  const root = makeRepo({ 'a.txt': 'one\n' })
  git(['init', '-q', join(root, 'fixtures/empty-repo')], { cwd: root })
  writeFileSync(`${root}/locked.log`, 'private\n')
  chmodSync(`${root}/locked.log`, 0o000)
  try {
    const cp = snapshotTree(root)
    writeFileSync(`${root}/a.txt`, 'broken\n')
    git(['init', '-q', join(root, 'fixtures/second-empty')], { cwd: root })
    writeFileSync(`${root}/locked2.log`, 'x\n')
    chmodSync(`${root}/locked2.log`, 0o000)
    // the fixer makes the old file readable again: it must still not be deleted
    chmodSync(`${root}/locked.log`, 0o644)
    const out = restoreTree(root, cp)
    assert.equal(readFileSync(`${root}/a.txt`, 'utf8'), 'one\n')
    assert.equal(readFileSync(`${root}/locked.log`, 'utf8'), 'private\n')
    assert.ok(existsSync(`${root}/fixtures/empty-repo/.git`))
    assert.deepEqual(out.deleted, [])
  } finally {
    chmodSync(`${root}/locked.log`, 0o644)
    if (existsSync(`${root}/locked2.log`)) chmodSync(`${root}/locked2.log`, 0o644)
  }
})

test('restore is byte-exact: clean filters and eol normalisation do not rewrite restored files', () => {
  const root = makeRepo({ '.gitattributes': '* text=auto\n*.ipynb filter=strip\n', 'a.txt': 'one\n' })
  git(['config', 'filter.strip.clean', "sed '/outputs/d'"], { cwd: root })
  git(['config', 'filter.strip.smudge', 'cat'], { cwd: root })
  const nb = '{"cell": 1,\n"outputs": [42]\n}\n'
  const win = 'line1\r\nline2\r\n'
  writeFileSync(`${root}/nb.ipynb`, nb)
  writeFileSync(`${root}/win.txt`, win)
  const cp = snapshotTree(root)
  // an unchanged tree still diffs clean against its checkpoint
  assert.equal(diffTrees(root, cp, snapshotTree(root)), '')

  writeFileSync(`${root}/nb.ipynb`, '{}\n')
  writeFileSync(`${root}/win.txt`, 'changed\r\n')
  const out = restoreTree(root, cp)
  assert.deepEqual(out.restored.sort(), ['nb.ipynb', 'win.txt'])
  assert.equal(readFileSync(`${root}/nb.ipynb`, 'utf8'), nb)
  assert.equal(readFileSync(`${root}/win.txt`, 'utf8'), win)
})

test('edits inside nested repositories are reported as not reverted, never claimed or deleted', () => {
  const root = makeRepo({ 'a.txt': 'one\n' })
  const lib = nestedRepo(root, 'vendor/lib', { 'x.txt': 'x\n' })
  const cp = snapshotTree(root)

  writeFileSync(`${root}/a.txt`, 'broken\n')
  writeFileSync(`${lib}/x.txt`, 'broken by fixer\n')
  nestedRepo(root, 'newrepo', { 'n.txt': 'n\n' })

  const out = restoreTree(root, cp)
  assert.deepEqual(out.restored, ['a.txt'])
  assert.deepEqual(out.deleted, [])
  assert.ok(existsSync(`${root}/newrepo/n.txt`), 'a nested repo is never deleted')
  assert.ok(out.problems.some(p => p.includes('vendor/lib')), out.problems.join('\n'))
  assert.ok(out.problems.some(p => p.includes('newrepo')), out.problems.join('\n'))

  // a nested repo whose HEAD moved is reported too, not listed as restored
  const root2 = makeRepo({ 'a.txt': 'one\n' })
  const lib2 = nestedRepo(root2, 'vendor/lib', { 'x.txt': 'x\n' })
  const cp2 = snapshotTree(root2)
  writeFileSync(`${lib2}/x.txt`, 'two\n')
  git(['commit', '-qam', 'two'], { cwd: lib2 })
  const out2 = restoreTree(root2, cp2)
  assert.deepEqual(out2.restored, [])
  assert.ok(out2.problems.some(p => p.includes('vendor/lib')), out2.problems.join('\n'))
})

test('index entries with non-UTF-8 path bytes are restored byte-exact', () => {
  const root = makeRepo({ 'a.txt': 'one\n' })
  const cp = snapshotTree(root)
  const blob = git(['hash-object', '-w', '--stdin'], { cwd: root, input: 'x\n' }).stdout.trim()
  gitBytes(root, ['update-index', '-z', '--index-info'], Buffer.from(`100644 ${blob}\tcaf\xe9.txt\0`, 'latin1'))

  restoreTree(root, cp)
  assert.equal(gitBytes(root, ['ls-files', '-z']).toString('latin1'), 'a.txt\0')
})

test('worktree files with non-UTF-8 names are restored and deleted by their exact bytes', t => {
  const root = makeRepo({ 'a.txt': 'one\n' })
  const name = (/** @type {string} */ s) => Buffer.concat([Buffer.from(`${root}/`), Buffer.from(s, 'latin1')])
  try {
    writeFileSync(name('caf\xe9.txt'), 'v1\n')
  } catch {
    return t.skip('this filesystem rejects non-UTF-8 file names')
  }
  gitBytes(root, ['add', '-A'])
  gitBytes(root, ['commit', '-qm', 'latin1'])
  const cp = snapshotTree(root)
  writeFileSync(name('caf\xe9.txt'), 'v2\n')
  writeFileSync(name('n\xe9w.txt'), 'new\n')
  restoreTree(root, cp)
  assert.equal(readFileSync(name('caf\xe9.txt'), 'utf8'), 'v1\n')
  assert.equal(existsSync(name('n\xe9w.txt')), false)
})

test('a same-size edit in the same second as the index write is still seen by snapshots', () => {
  const root = makeRepo({ 'a.js': 'x\n' })
  // make the race deterministic: entry, file and index share one timestamp, ctime is not consulted
  git(['config', 'core.trustctime', 'false'], { cwd: root })
  const t0 = Math.floor(Date.now() / 1000) - 100
  utimesSync(`${root}/a.js`, t0, t0)
  git(['add', 'a.js'], { cwd: root })
  utimesSync(`${root}/.git/index`, t0, t0)
  writeFileSync(`${root}/a.js`, 'y\n')
  utimesSync(`${root}/a.js`, t0, t0)
  // git itself sees the edit (diff-files does not rewrite the index the way `git status` would)
  assert.equal(git(['diff-files', '--name-only'], { cwd: root }).stdout, 'a.js\n')

  assert.match(diffTrees(root, 'HEAD', snapshotTree(root)), /^\+y$/m)
})

/**
 * A review loop, one round begun, whose one required check passes while
 * status.txt says "good". `untracked` files are written before the loop starts.
 *
 * @param {Record<string, string>} committed
 * @param {Record<string, string>} [untracked]
 */
async function loopWithStatusCheck(committed, untracked = {}) {
  const root = makeRepo({ 'status.txt': 'good\n', ...committed })
  writeFiles(root, {
    ...untracked,
    '.quality-loop/config.json': JSON.stringify({ version: 1, checks: [{ name: 'status', cmd: 'grep -qx good status.txt', required: true }] }),
  })
  await loop.start(root, { mode: 'review', base: 'HEAD' })
  loop.beginRound(root)
  return root
}

test('round end: a reverted round that un-ignored .env leaves the secret file in place', async () => {
  const root = await loopWithStatusCheck({ '.gitignore': '.env\n' }, { '.env': 'SECRET=1\n' })
  writeFileSync(`${root}/status.txt`, 'bad\n')
  writeFileSync(`${root}/.gitignore`, '')
  const out = await loop.endRound(root)
  assert.equal(out.decision.revert, true)
  assert.equal(readFileSync(`${root}/.env`, 'utf8'), 'SECRET=1\n')
  assert.equal(readFileSync(`${root}/.gitignore`, 'utf8'), '.env\n')
  assert.equal(loop.loadState(root).status, 'active')
})

test('round end: a revert that cannot undo the round (HEAD moved) pauses the loop with the reason', async () => {
  const root = await loopWithStatusCheck({})
  writeFileSync(`${root}/status.txt`, 'bad\n')
  git(['commit', '-qam', 'fixer commit'], { cwd: root })
  const out = await loop.endRound(root)
  assert.equal(out.decision.revert, true)
  assert.equal(readFileSync(`${root}/status.txt`, 'utf8'), 'good\n')
  const s = loop.loadState(root)
  assert.equal(s.status, 'paused')
  assert.ok(s.statusReasons.some((/** @type {string} */ r) => /revert incomplete: HEAD moved/.test(r)), s.statusReasons.join('\n'))
})
