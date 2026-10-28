import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { commandVerdict, editVerdict, readRecord } from '../plugins/trace/scripts/lib/trace.mjs'

/** @typedef {import('../plugins/trace/scripts/lib/docs.mjs').Issue} Issue */
/** @typedef {import('../plugins/trace/scripts/lib/docs.mjs').ReadRecord} ReadRecord */

const ADR = '---\nstatus: accepted\n---\n\n# 0001: A decision\n'

/** A traced repository's docs on disk: a glossary and one ADR, plus `files` (null deletes). @param {Record<string, string | null>} [files] */
function docsRepo(files = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'docs-')))
  for (const [path, text] of Object.entries({ 'GLOSSARY.md': '# Terms\n\n**Trace**: the chain.\n', 'docs/adr/0001-a.md': ADR, ...files })) {
    if (text === null) continue
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

const ISSUE = { title: 'Doc authority', body: 'Build it.', comments: [] }

/**
 * In-memory git and GitHub around the repository at `root`, on the branch of
 * open issue #8, for an agent that has read `reads` (null: unknown agent).
 *
 * @param {string} root
 * @param {{ issue?: Issue | null, reads?: (ReadRecord | null)[] | null, changed?: string[] | null }} [o]
 */
function world(root, { issue = ISSUE, reads = [], changed = [] } = {}) {
  return {
    git: {
      root: (/** @type {string} */ p) => (p === root || p.startsWith(`${root}/`) ? root : null),
      traced: () => true,
      branch: () => '8-doc-authority',
      defaultBranch: () => 'main',
      origin: () => 'owner/name',
      ghBase: () => 'owner/name',
      message: () => null,
      config: () => null,
      changed: () => changed,
    },
    github: { issueState: () => /** @type {const} */ ('OPEN'), issue: () => issue, alias: () => null },
    env: {},
    reads: { records: () => reads && /** @type {ReadRecord[]} */ (reads.filter(Boolean)), add() {} },
  }
}

/** The record of a Read tool call that returned lines `from`–`to` of `path` as it is now. @param {string} path @param {number} [from] @param {number} [to] */
function read(path, from = 1, to) {
  const lines = readFileSync(path, 'utf8').split('\n')
  const end = to ?? lines.length
  const content = lines.slice(from - 1, end).join('\n')
  return readRecord({ tool_name: 'Read', tool_input: { file_path: path }, tool_response: { type: 'text', file: { filePath: path, content, numLines: end - from + 1, startLine: from, totalLines: lines.length } } })
}

/** The record of a `gh` command that printed `stdout` in `root`. @param {string} root @param {string} stdout @param {Issue} [issue] */
const printed = (root, stdout, issue = ISSUE, command = 'gh issue view 8') =>
  readRecord({ tool_name: 'Bash', tool_input: { command }, tool_response: { stdout, stderr: '', interrupted: false }, cwd: root }, world(root, { issue }))

/** Everything a fresh agent must read in `root`, read in full. @param {string} root */
const readAll = root => [read(join(root, 'GLOSSARY.md')), read(join(root, 'docs/adr/0001-a.md')), printed(root, `title:\t${ISSUE.title}\n--\n${ISSUE.body}\n`)]

test('an agent that has read nothing is refused, with every related doc and how to read it', () => {
  const root = docsRepo()
  const why = String(editVerdict(join(root, 'src/a.js'), world(root)))
  assert.match(why, /^the related docs are not all read\./)
  assert.match(why, /GLOSSARY\.md/)
  assert.match(why, /docs\/adr\/0001-a\.md/)
  assert.match(why, /issue #8: its title, body \(`gh issue view 8 -R owner\/name`\)/)
  assert.match(why, /Read step: read each file with the Read tool, every line, in this agent; .*; run the gh commands shown for the issue\.$/)
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
  const chunks = [read(glossary, 1, 20), read(glossary, 21, 41)]
  assert.equal(editVerdict(join(root, 'a.js'), world(root, { reads: [...chunks, adr, issue] })), null)
  const why = editVerdict(join(root, 'a.js'), world(root, { reads: [chunks[0] ?? null, adr, issue] }))
  assert.match(String(why), /GLOSSARY\.md \(21 of its 41 lines unread\)/)
})

test('a Read that returned other text than the file holds is no read', () => {
  const root = docsRepo({ 'GLOSSARY.md': `short\n${'x'.repeat(3000)}\nend\n` })
  const path = join(root, 'GLOSSARY.md')
  const file = { filePath: path, content: `short\n${'x'.repeat(2000)}\nend\n`, numLines: 4, startLine: 1, totalLines: 4 }
  const record = (/** @type {object} */ f) => readRecord({ tool_name: 'Read', tool_input: { file_path: path }, tool_response: { type: 'text', file: { ...file, ...f } } })
  assert.equal(record({}), null, 'a truncated line')
  assert.equal(record({ content: `short\n${'x'.repeat(3000)}\nend\n`, totalLines: 9 }), null, 'a different length')
  assert.equal(record({ content: 'short', numLines: 9 }), null, 'more lines claimed than returned')
  assert.notEqual(record({ content: `short\n${'x'.repeat(3000)}\nend\n` }), null)
  for (const response of [null, 'text', { type: 'image', file: { filePath: path } }, { file: { ...file, startLine: '1' } }]) {
    assert.equal(readRecord({ tool_name: 'Read', tool_input: { file_path: path }, tool_response: response }), null, JSON.stringify(response))
  }
})

test('a read goes stale when the file changes, until it is read again', () => {
  const root = docsRepo()
  const reads = readAll(root)
  writeFileSync(join(root, 'docs/adr/0001-a.md'), `${ADR}\nAmended.\n`)
  const why = editVerdict(join(root, 'a.js'), world(root, { reads }))
  assert.match(String(why), /docs\/adr\/0001-a\.md \(changed since this agent read it\)\. Read step: .*do not count\.$/)
  assert.doesNotMatch(String(why), /GLOSSARY/)
  assert.equal(editVerdict(join(root, 'a.js'), world(root, { reads: [...reads, read(join(root, 'docs/adr/0001-a.md'))] })), null)
})

test('an ADR scoped by applies-to is related only to edits of matching paths; an inactive one to none', () => {
  const root = docsRepo({
    'docs/adr/0002-hooks.md': '---\nstatus: accepted\napplies-to:\n  - plugins/**/*.mjs\n  - "hooks.json"\n---\n# 0002\n',
    'docs/adr/0003-docs.md': '---\nstatus: accepted\napplies-to: [docs/, README.md]\n---\n# 0003\n',
    'docs/adr/0004-old.md': '---\nstatus: superseded by 0002\n---\n# 0004\n',
    'docs/adr/0005-unreadable.md': '---\nstatus: accepted\napplies-to:\n---\n# 0005\n',
  })
  const reads = readAll(root)
  const unread = (/** @type {string} */ path) => String(editVerdict(join(root, path), world(root, { reads })))
  assert.match(unread('plugins/trace/x.mjs'), /0002-hooks/)
  assert.doesNotMatch(unread('plugins/trace/x.mjs'), /0003|0004/)
  assert.match(unread('hooks.json'), /0002-hooks/)
  assert.match(unread('docs/guide/a.md'), /0003-docs/)
  assert.match(unread('README.md'), /0003-docs/)
  assert.doesNotMatch(unread('src/a.js'), /0002|0003|0004/)
  for (const path of ['plugins/trace/x.mjs', 'src/a.js']) assert.match(unread(path), /0005-unreadable/, 'an applies-to that cannot be read applies everywhere')
})

test('files under docs/ that the issue body links are related docs', () => {
  const root = docsRepo({ 'docs/agents/domain.md': '# Domain\n', 'docs/guide.md': '# Guide\n', 'archive/old.md': '# Old\n' })
  const issue = {
    title: 'T',
    body: 'Read docs/agents/domain.md, and [the guide](https://github.com/owner/name/blob/main/docs/guide.md). Not docs/missing.md, docs/../archive/old.md or `docs/adr/`.',
    comments: [],
  }
  const reads = [read(join(root, 'GLOSSARY.md')), read(join(root, 'docs/adr/0001-a.md')), printed(root, `title:\tT\n--\n${issue.body}\n`, issue)]
  const why = String(editVerdict(join(root, 'a.js'), world(root, { issue, reads })))
  assert.match(why, /Unread: docs\/agents\/domain\.md; docs\/guide\.md\./)
  assert.equal(editVerdict(join(root, 'a.js'), world(root, { issue, reads: [...reads, read(join(root, 'docs/agents/domain.md')), read(join(root, 'docs/guide.md'))] })), null)
})

test("the issue's comments are read too, as printed or as JSON, and an edited one is unread again", () => {
  const root = docsRepo()
  const [glossary = null, adr = null] = readAll(root)
  const comments = [
    { id: '11', author: 'rocky', body: 'Decision:  keep it\nshort.' },
    { id: '12', author: 'claude', body: 'Progress: done.' },
  ]
  const issue = { ...ISSUE, comments }
  const plain = printed(root, `title:\t${issue.title}\nstate:\tOPEN\n--\n${issue.body}\n`, issue)
  const why = String(editVerdict(join(root, 'a.js'), world(root, { issue, reads: [glossary, adr, plain] })))
  assert.match(why, /issue #8: its comment 11 by rocky, comment 12 by claude \(`gh api repos\/owner\/name\/issues\/comments\/11 --jq \.body`, `gh api repos\/owner\/name\/issues\/comments\/12 --jq \.body`\)/)
  const all = printed(root, JSON.stringify({ title: issue.title, body: issue.body, comments: comments.map(c => ({ author: { login: c.author }, body: c.body })) }), issue, 'gh issue view 8 --json title,body,comments')
  assert.equal(editVerdict(join(root, 'a.js'), world(root, { issue, reads: [glossary, adr, all] })), null)
  const edited = { ...issue, comments: [{ id: '11', author: 'rocky', body: 'Decision: keep it long.' }, ...comments.slice(1)] }
  assert.match(String(editVerdict(join(root, 'a.js'), world(root, { issue: edited, reads: [glossary, adr, all] }))), /its comment 11 by rocky \(/)
  const many = { ...ISSUE, comments: ['1', '2', '3', '4'].map(id => ({ id, author: 'a', body: `c${id}` })) }
  assert.match(String(editVerdict(join(root, 'a.js'), world(root, { issue: many, reads: [glossary, adr, plain] }))), /`gh issue view 8 -R owner\/name --comments`/)
  assert.equal(printed(root, 'https://github.com/owner/name/issues/8#issuecomment-1', issue, 'gh issue comment 8 --body x'), null, 'output without the text reads nothing')
  assert.equal(printed(root, `${issue.title}\n${issue.body}`, issue, 'cat notes.txt'), null, 'only gh output counts')
})

test('when the agent cannot be told apart, or GitHub cannot say what the issue says, the edit is refused', () => {
  const root = docsRepo()
  assert.match(String(editVerdict(join(root, 'a.js'), world(root, { reads: null }))), /does not say which agent this is/)
  assert.match(String(editVerdict(join(root, 'a.js'), world(root, { issue: null, reads: readAll(root) }))), /GitHub could not say what #8, the linked issue, says/)
})

test('a repository with no related docs and an empty issue needs no reads', () => {
  const root = docsRepo({ 'GLOSSARY.md': null, 'docs/adr/0001-a.md': null })
  assert.equal(editVerdict(join(root, 'a.js'), world(root, { issue: { title: '', body: '', comments: [] }, reads: null })), null)
})

test('a commit waits for the related docs of every path it could take', () => {
  const root = docsRepo({ 'docs/adr/0002-hooks.md': '---\nstatus: accepted\napplies-to: plugins/**\n---\n# 0002\n' })
  const commit = 'git commit -m "Gate (#8)"'
  assert.match(String(commandVerdict(commit, root, world(root))), /^the related docs are not all read.*GLOSSARY\.md/)
  assert.equal(commandVerdict(commit, root, world(root, { reads: readAll(root), changed: ['src/a.js'] })), null)
  assert.match(String(commandVerdict(commit, root, world(root, { reads: readAll(root), changed: ['plugins/a.mjs'] }))), /0002-hooks/)
  assert.match(String(commandVerdict(commit, root, world(root, { reads: readAll(root), changed: null }))), /0002-hooks/, 'when git cannot say, every ADR applies')
  assert.equal(commandVerdict('git commit --dry-run -m x', root, world(root)), null)
})
