import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { commandVerdict, editVerdict, readRecord } from '../plugins/trace/scripts/lib/trace.mjs'

/** @typedef {import('../plugins/trace/scripts/lib/docs.mjs').Issue} Issue */
/** @typedef {import('../plugins/trace/scripts/lib/docs.mjs').ReadRecord} ReadRecord */
/** @typedef {import('../plugins/trace/scripts/lib/docs.mjs').HeadDocs} HeadDocs */

const ADR = '---\nstatus: accepted\n---\n\n# 0001: A decision\n'

/** A traced repository's docs on disk: a glossary and one ADR, plus `files` (null deletes). @param {Record<string, string | Buffer | null>} [files] */
function docsRepo(files = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'docs-')))
  for (const [path, text] of Object.entries({ 'GLOSSARY.md': '# Terms\n\n**Trace**: the chain.\n', 'docs/adr/0001-a.md': ADR, ...files })) {
    if (text === null) continue
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

/** @param {string} root @returns {Record<string, string>} the glossary and ADRs as they are now, as if committed */
const committed = root => ({ 'GLOSSARY.md': readFileSync(join(root, 'GLOSSARY.md'), 'utf8'), 'docs/adr/0001-a.md': readFileSync(join(root, 'docs/adr/0001-a.md'), 'utf8') })

const ISSUE = { title: 'Doc authority', body: 'Build it.', comments: [] }

/**
 * In-memory git and GitHub around the repository at `root`, on the branch of
 * open issue #8, for an agent that has read `reads` (null: unknown agent).
 *
 * @param {string} root
 * @param {{ issue?: Issue | null, reads?: ReadRecord[] | null, head?: HeadDocs, branch?: string }} [o]
 */
function world(root, { issue = ISSUE, reads = [], head = {}, branch = '8-doc-authority' } = {}) {
  return {
    git: {
      root: (/** @type {string} */ p) => (p === root || p.startsWith(`${root}/`) ? root : null),
      traced: () => true,
      branch: () => branch,
      defaultBranch: () => 'main',
      origin: () => 'owner/name',
      ghBase: () => 'owner/name',
      message: () => null,
      config: () => null,
      headDocs: () => head,
    },
    github: { issueState: () => /** @type {const} */ ('OPEN'), issue: () => issue, alias: () => null },
    env: {},
    reads: { records: () => reads, add() {} },
  }
}

/** The records of a Read tool call that returned lines `from`–`to` of `path` as it is now. @param {string} path @param {number} [from] @param {number} [to] */
function read(path, from = 1, to) {
  const lines = readFileSync(path, 'utf8').replace(/\r\n/g, '\n').split('\n')
  const end = to ?? lines.length
  const content = lines.slice(from - 1, end).join('\n')
  return readRecord({ tool_name: 'Read', tool_input: { file_path: path }, tool_response: { type: 'text', file: { filePath: path, content, numLines: end - from + 1, startLine: from, totalLines: lines.length } } })
}

/**
 * The records of a Bash command that printed `stdout` in `root`.
 *
 * @param {string} root @param {string} stdout
 * @param {{ issue?: Issue, head?: HeadDocs, command?: string, persisted?: boolean }} [o]
 */
const printed = (root, stdout, { issue = ISSUE, head = {}, command = 'gh issue view 8', persisted = false } = {}) =>
  readRecord(
    { tool_name: 'Bash', tool_input: { command }, tool_response: { stdout, stderr: '', interrupted: false, ...(persisted ? { persistedOutputPath: '/tmp/out.txt' } : {}) }, cwd: root },
    world(root, { issue, head }),
  )

/** Everything a fresh agent must read in `root`, read in full. @param {string} root */
const readAll = root => [...read(join(root, 'GLOSSARY.md')), ...read(join(root, 'docs/adr/0001-a.md')), ...printed(root, `title:\t${ISSUE.title}\n--\n${ISSUE.body}\n`)]

/** @param {string} root @param {Parameters<typeof world>[1]} [o] */
const edit = (root, o) => String(editVerdict(join(root, 'src/a.js'), world(root, o)))

test('an agent that has read nothing is refused, with every related doc and how to read it', () => {
  const root = docsRepo()
  const why = edit(root)
  assert.match(why, /^the related docs are not all read\. Unread: GLOSSARY\.md; docs\/adr\/0001-a\.md; issue #8: its title, body \(`gh issue view 8 -R owner\/name` for the title and body\)\./)
  assert.match(why, /Read step: read each file with the Read tool, every line, and run the commands shown, in this agent; reads by its parent or another agent do not count\.$/)
})

test('an agent that has read every related doc in full may edit', () => {
  const root = docsRepo()
  assert.equal(editVerdict(join(root, 'src/a.js'), world(root, { reads: readAll(root) })), null)
})

test('reads in chunks add up to a full read; a part of the file does not', () => {
  const long = Array.from({ length: 40 }, (_, i) => `term ${i + 1}`).join('\n') + '\n'
  const root = docsRepo({ 'GLOSSARY.md': long })
  const [, adr, issue] = readAll(root)
  const glossary = join(root, 'GLOSSARY.md')
  const chunks = [...read(glossary, 1, 20), ...read(glossary, 21, 41)]
  assert.equal(edit(root, { reads: [...chunks, adr, issue].filter(r => r !== undefined) }), 'null')
  assert.match(edit(root, { reads: [chunks[0], adr, issue].filter(r => r !== undefined) }), /Unread: GLOSSARY\.md \(21 of its 41 lines unread\)\. Read step: read each file with the Read tool, every line, in this agent/)
})

test('a Read that returned other text than the file holds is no read; a file that is no doc is not read back', () => {
  const root = docsRepo({ 'GLOSSARY.md': `short\n${'x'.repeat(3000)}\nend\n`, 'src/big.log': 'log\n' })
  const path = join(root, 'GLOSSARY.md')
  const file = { filePath: path, content: `short\n${'x'.repeat(2000)}\nend\n`, numLines: 4, startLine: 1, totalLines: 4 }
  const record = (/** @type {object} */ f) => readRecord({ tool_name: 'Read', tool_input: { file_path: path }, tool_response: { type: 'text', file: { ...file, ...f } } })
  assert.deepEqual(record({}), [], 'a truncated line')
  assert.deepEqual(record({ content: `short\n${'x'.repeat(3000)}\nend\n`, totalLines: 9 }), [], 'a different length')
  assert.deepEqual(record({ content: 'short', numLines: 9 }), [], 'more lines claimed than returned')
  assert.equal(record({ content: `short\n${'x'.repeat(3000)}\nend\n` }).length, 1)
  for (const response of [null, 'text', { type: 'image', file: { filePath: path } }, { file: { ...file, startLine: '1' } }]) {
    assert.deepEqual(readRecord({ tool_name: 'Read', tool_input: { file_path: path }, tool_response: response }), [], JSON.stringify(response))
  }
  assert.deepEqual(read(join(root, 'src/big.log')), [])
})

test('a read goes stale when the file changes, until it is read again', () => {
  const root = docsRepo()
  const reads = readAll(root)
  writeFileSync(join(root, 'docs/adr/0001-a.md'), `${ADR}\nAmended.\n`)
  assert.match(edit(root, { reads }), /Unread: docs\/adr\/0001-a\.md \(stale: changed since this agent read it\)\. Read step: read each file with the Read tool, every line, in this agent; reads by its parent or another agent do not count\.$/)
  assert.equal(edit(root, { reads: [...reads, ...read(join(root, 'docs/adr/0001-a.md'))] }), 'null')
})

test('docs read through a symlink, with CRLF, a lone CR, a BOM or in UTF-16 count once read', () => {
  const root = docsRepo({ 'shared/terms.md': '# Terms\n', 'docs/adr/0002-crlf.md': '# 0002\r\nCRLF\r\n', 'docs/adr/0003-cr.md': '# 0003\rCR\n', 'docs/adr/0004-bom.md': '﻿# 0004\n' })
  writeFileSync(join(root, 'docs/adr/0005-wide.md'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('# 0005\nwide\n', 'utf16le')]))
  writeFileSync(join(root, 'GLOSSARY.md'), '')
  symlinkSync(join(root, 'shared/terms.md'), join(root, 'docs/adr/0006-link.md'))
  /** @param {string} name @param {string} content */
  const as = (name, content) => {
    const lines = content.split('\n').length
    return readRecord({ tool_name: 'Read', tool_input: {}, tool_response: { type: 'text', file: { filePath: join(root, name), content, numLines: lines, startLine: 1, totalLines: lines } } })
  }
  const reads = [
    ...read(join(root, 'docs/adr/0001-a.md')),
    ...printed(root, `title:\t${ISSUE.title}\n--\n${ISSUE.body}\n`),
    ...as('docs/adr/0002-crlf.md', '# 0002\nCRLF\n'),
    ...as('docs/adr/0003-cr.md', '# 0003\rCR\n'),
    ...as('docs/adr/0004-bom.md', '# 0004\n'),
    ...as('docs/adr/0005-wide.md', '# 0005\nwide\n'),
    ...as('docs/adr/0006-link.md', '# Terms\n'),
  ]
  assert.equal(reads.length, 7)
  assert.equal(edit(root, { reads }), 'null')
})

test('an ADR scoped by applies-to is related only to edits of matching paths; an inactive one to none', () => {
  const root = docsRepo({
    'docs/adr/0002-hooks.md': '---\nstatus: accepted\napplies-to:\n  - plugins/**/*.mjs  # the scripts\n  - "hooks.json"\n---\n# 0002\n',
    'docs/adr/0003-docs.md': '---\nstatus: accepted\napplies-to: [docs/, README.md]\n---\n# 0003\n',
    'docs/adr/0004-old.md': '---\nstatus: superseded by 0002\n---\n# 0004\n',
    'docs/adr/0005-unreadable.md': '---\nstatus: accepted\napplies-to:\n---\n# 0005\n',
    'docs/adr/0006-brace.md': '---\nstatus: accepted\napplies-to: [lib/{a,b}.js]\n---\n# 0006\n',
    'docs/adr/0007-dir.md': '---\nstatus: accepted\napplies-to: src # sources\n---\n# 0007\n',
    'docs/adr/2026/0008-nested.MD': '# 0008\n',
    'docs/adr/README.md': '# Index\n',
    'docs/adr/template.md': '---\nstatus: {proposed | accepted}\n---\n',
  })
  const reads = readAll(root)
  const unread = (/** @type {string} */ path) => String(editVerdict(join(root, path), world(root, { reads })))
  assert.match(unread('plugins/trace/x.mjs'), /0002-hooks/)
  assert.doesNotMatch(unread('plugins/trace/x.mjs'), /0003|0004|0007/)
  assert.match(unread('hooks.json'), /0002-hooks/)
  assert.match(unread('docs/guide/a.md'), /0003-docs/)
  assert.match(unread('README.md'), /0003-docs/)
  assert.match(unread('src/a.js'), /0007-dir/)
  assert.doesNotMatch(unread('src/a.js'), /0002|0003|0004|README|template/)
  for (const path of ['plugins/trace/x.mjs', 'src/a.js']) {
    assert.match(unread(path), /0005-unreadable.*0006-brace.*2026\/0008-nested/, 'globs it cannot read apply everywhere, and nested ADRs count')
  }
})

test('files under docs/ that the issue body links are related docs; binary or missing ones are not', () => {
  const root = docsRepo({ 'docs/agents/domain.md': '# Domain\n', 'docs/guide.md': '# Guide\n', 'docs/flow.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]), 'archive/old.md': '# Old\n' })
  const issue = {
    title: 'T',
    body: 'Read docs/agents/domain.md, and [the guide](https://github.com/owner/name/blob/main/docs/guide.md). See docs/flow.png. Not docs/missing.md, docs/50%-plan, docs/../archive/old.md or `docs/adr/`.',
    comments: [],
  }
  const reads = [...read(join(root, 'GLOSSARY.md')), ...read(join(root, 'docs/adr/0001-a.md')), ...printed(root, `title:\tT\n--\n${issue.body}\n`, { issue })]
  assert.match(edit(root, { issue, reads }), /Unread: docs\/agents\/domain\.md; docs\/guide\.md\. /)
  assert.equal(edit(root, { issue, reads: [...reads, ...read(join(root, 'docs/agents/domain.md')), ...read(join(root, 'docs/guide.md'))] }), 'null')
})

test("the issue's comments are read too, as printed, as JSON, or as posted, and an edited one is unread again", () => {
  const root = docsRepo()
  const files = [...read(join(root, 'GLOSSARY.md')), ...read(join(root, 'docs/adr/0001-a.md'))]
  const comments = [
    { id: '11', author: 'rocky', body: 'Decision:  keep it\nshort.' },
    { id: '12', author: 'claude', body: 'Progress: done.' },
  ]
  const issue = { ...ISSUE, comments }
  const plain = printed(root, `title:\t${issue.title}\nstate:\tOPEN\n--\n${issue.body}\n`, { issue })
  const why = edit(root, { issue, reads: [...files, ...plain] })
  assert.match(why, /Unread: issue #8: its comment 11 by rocky, comment 12 by claude \(`gh api repos\/owner\/name\/issues\/comments\/<id> --jq \.body` for each comment\)\. Read step: run the commands shown, in this agent;/)
  const json = JSON.stringify({ title: issue.title, body: issue.body, comments: comments.map(c => ({ author: { login: c.author }, body: c.body })) })
  const all = printed(root, json, { issue, command: 'gh issue view 8 --json title,body,comments' })
  assert.equal(edit(root, { issue, reads: [...files, ...all] }), 'null')
  const edited = { ...issue, comments: [{ id: '11', author: 'rocky', body: 'Decision: keep it long.' }, ...comments.slice(1)] }
  assert.match(edit(root, { issue: edited, reads: [...files, ...all] }), /its comment 11 by rocky \(/)
  const posted = printed(root, 'https://github.com/owner/name/issues/8#issuecomment-12\n', { issue, command: 'gh issue comment 8 --body "Progress: done."' })
  assert.equal(edit(root, { issue, reads: [...files, ...plain, ...posted, ...printed(root, 'Decision: keep it short.', { issue, command: 'gh api repos/owner/name/issues/comments/11 --jq .body' })] }), 'null')
  assert.deepEqual(printed(root, `${issue.title}\n${issue.body}`, { issue, command: 'cat notes.txt' }), [], 'only gh and git show output counts')
})

test('output too long to show counts only for its preview', () => {
  const root = docsRepo()
  const padded = `${'x'.repeat(3000)}\ntitle:\t${ISSUE.title}\n--\n${ISSUE.body}\n`
  assert.deepEqual(printed(root, padded, { persisted: true }), [])
  assert.deepEqual(printed(root, padded + 'y'.repeat(30_000)), [])
  assert.equal(printed(root, `title:\t${ISSUE.title}\n--\n${ISSUE.body}\n${'y'.repeat(30_000)}`).length, 1)
})

test('a doc moved, emptied, re-marked or made unreadable in the working tree is still related', () => {
  const root = docsRepo()
  const head = committed(root)
  const reads = readAll(root)
  writeFileSync(join(root, 'docs/adr/0001-a.md'), '---\nstatus: superseded\n---\n# 0001\n')
  assert.match(edit(root, { head, reads }), /Unread: docs\/adr\/0001-a\.md \(stale/, "HEAD's status still counts")
  renameSync(join(root, 'docs/adr/0001-a.md'), join(root, 'moved.md'))
  writeFileSync(join(root, 'GLOSSARY.md'), '')
  const fresh = printed(root, `title:\t${ISSUE.title}\n--\n${ISSUE.body}\n`)
  assert.match(edit(root, { head, reads: fresh }), /Unread: GLOSSARY\.md \(gone or empty in the working tree, but in HEAD: `git show HEAD:GLOSSARY\.md`\); docs\/adr\/0001-a\.md \(gone or empty .*`git show HEAD:docs\/adr\/0001-a\.md`\)\. Read step: run the commands shown/)
  assert.equal(edit(root, { head, reads }), 'null', 'what it read before they went still counts')
  const shown = [...printed(root, head['GLOSSARY.md'] ?? '', { head, command: 'git show HEAD:GLOSSARY.md' }), ...printed(root, head['docs/adr/0001-a.md'] ?? '', { head, command: 'git show HEAD:docs/adr/0001-a.md' })]
  assert.equal(shown.length, 2)
  assert.equal(edit(root, { head, reads: [...fresh, ...shown] }), 'null')
  if (process.getuid?.() !== 0) {
    writeFileSync(join(root, 'GLOSSARY.md'), '# Terms\n')
    chmodSync(join(root, 'GLOSSARY.md'), 0o000)
    assert.match(edit(root, { head, reads }), /GLOSSARY\.md \(cannot be read as text; make it readable\)/)
  }
})

test('when the agent cannot be told apart, or GitHub cannot say what the issue says, the change is refused', () => {
  const root = docsRepo()
  assert.match(edit(root, { reads: null }), /^the trace cannot tell which agent this is, so not what it has read\. Read step: .*TRACE_BYPASS=1/)
  assert.match(String(commandVerdict('git commit -m "x (#8)"', root, world(root, { reads: null }))), /^the trace cannot tell which agent/)
  assert.match(edit(root, { issue: null, reads: readAll(root) }), /GitHub could not say what #8, the linked issue, says.*Read step:/)
})

test('a repository with no related docs and an empty issue needs no reads', () => {
  const root = docsRepo({ 'GLOSSARY.md': null, 'docs/adr/0001-a.md': null })
  assert.equal(edit(root, { issue: { title: '', body: '', comments: [] }, reads: null }), 'null')
})

test('a commit, or any git command that makes or moves commits, waits for every active ADR', () => {
  const root = docsRepo({ 'docs/adr/0002-hooks.md': '---\nstatus: accepted\napplies-to: plugins/**\n---\n# 0002\n' })
  const commit = (/** @type {string} */ c, /** @type {Parameters<typeof world>[1]} */ o = {}) => String(commandVerdict(c, root, world(root, o)))
  assert.match(commit('git commit -m "Gate (#8)"'), /^the related docs are not all read.*GLOSSARY\.md/)
  assert.match(commit('git commit -m "Gate (#8)"', { reads: readAll(root) }), /Unread: docs\/adr\/0002-hooks\.md\./, 'what a commit takes cannot be told from its text')
  const reads = [...readAll(root), ...read(join(root, 'docs/adr/0002-hooks.md'))]
  assert.equal(commit('git commit -m "Gate (#8)"', { reads }), 'null')
  for (const c of ['git update-ref HEAD $(git commit-tree $(git write-tree) -p HEAD -m "x (#8)")', 'git merge --squash topic', 'git cherry-pick abc', 'git revert HEAD', 'git am < p.patch', 'git rebase main', 'git pull']) {
    assert.match(commit(c), /related docs are not all read/, c)
    assert.equal(commit(c, { reads }), 'null', c)
    assert.equal(commit(c, { branch: 'main' }), 'null', `${c} on the default branch is no change to an issue`)
  }
  assert.equal(commit('git commit --dry-run -m x'), 'null')
})
