// `ql ship`: full-send's gate, wait, merge and stage against a fake `gh`
// on PATH, so no test touches the network.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { makeRepo, writeFiles } from './helpers.mjs'

const QL = resolve(import.meta.dirname, '../plugins/quality-loop/scripts/ql.mjs')
const URL = 'https://github.com/acme/shop/pull/7'

// Serves `pr.json` (one snapshot, or an array served in turn, the last one
// repeating) and `repo.json`; `pr merge` merges unless a `queue` file
// exists. Every call is logged to calls.log.
const FAKE_GH = `#!/usr/bin/env node
const fs = require('fs')
const dir = process.env.FAKE_GH
const args = process.argv.slice(2)
fs.appendFileSync(dir + '/calls.log', JSON.stringify(args) + '\\n')
const at = f => dir + '/' + f
if (args[0] === 'pr' && args[1] === 'view') {
  const seq = JSON.parse(fs.readFileSync(at('pr.json'), 'utf8'))
  const list = Array.isArray(seq) ? seq : [seq]
  const n = fs.existsSync(at('n')) ? Number(fs.readFileSync(at('n'), 'utf8')) : 0
  fs.writeFileSync(at('n'), String(n + 1))
  let pr = list[Math.min(n, list.length - 1)]
  if (fs.existsSync(at('merged'))) pr = { ...pr, state: 'MERGED', mergeCommit: { oid: 'f'.repeat(40) } }
  process.stdout.write(JSON.stringify(pr))
} else if (args[0] === 'repo' && args[1] === 'view') {
  process.stdout.write(fs.readFileSync(at('repo.json'), 'utf8'))
} else if (args[0] === 'pr' && args[1] === 'merge') {
  if (!fs.existsSync(at('queue'))) fs.writeFileSync(at('merged'), '')
} else {
  process.stderr.write('fake gh: unexpected ' + args.join(' '))
  process.exit(1)
}
`

/** A repository and a fake gh serving `prs` for its HEAD. @param {(head: string) => object | object[]} prs */
function setup(prs) {
  const root = makeRepo({ 'src/a.js': 'export const a = 1\n' })
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim()
  const bin = mkdtempSync(join(tmpdir(), 'fake-gh-'))
  writeFileSync(join(bin, 'gh'), FAKE_GH)
  chmodSync(join(bin, 'gh'), 0o755)
  writeFileSync(join(bin, 'pr.json'), JSON.stringify(prs(head)))
  writeFileSync(join(bin, 'repo.json'), JSON.stringify({ mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: false }))
  /** @param {string[]} args */
  const ql = args => {
    const r = spawnSync(process.execPath, [QL, ...args], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '', PATH: `${bin}:${process.env.PATH}`, FAKE_GH: bin },
    })
    return { code: r.status, out: r.stdout, err: r.stderr }
  }
  const calls = () =>
    existsSync(join(bin, 'calls.log'))
      ? readFileSync(join(bin, 'calls.log'), 'utf8').trim().split('\n').map(l => /** @type {string[]} */ (JSON.parse(l)))
      : []
  return { root, head, bin, ql, calls }
}

/** @param {string} head @param {Record<string, unknown>} [o] */
const pr = (head, o = {}) => ({
  number: 7,
  url: URL,
  state: 'OPEN',
  isDraft: false,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  headRefOid: head,
  baseRefName: 'main',
  statusCheckRollup: [
    { __typename: 'CheckRun', name: 'test', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://ci/test' },
    { __typename: 'StatusContext', context: 'pipeline', state: 'SUCCESS', targetUrl: 'https://ci/pipeline' },
  ],
  ...o,
})
const RED = {
  statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', workflowName: 'CI', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://ci/test/1' }],
}

test('ship: a green PR gates MERGE and merges exactly the gated head, with the repository\'s method and never --admin', () => {
  const { ql, head, calls } = setup(h => pr(h))
  assert.equal(ql(['ship', 'start', URL]).code, 0)
  const g = ql(['ship', 'gate'])
  assert.equal(g.code, 0, g.err)
  assert.match(g.out, /^gate: MERGE · https:\/\/github\.com\/acme\/shop\/pull\/7/m)
  assert.match(g.out, /^PASS CI \/ test/m)
  assert.match(g.out, /^next: .*`ql ship merge`/m)
  const m = ql(['ship', 'merge'])
  assert.equal(m.code, 0, m.err)
  assert.match(m.out, /^merged https:\/\/github\.com\/acme\/shop\/pull\/7 by squash · merge commit f{12}/m)
  const merge = calls().find(c => c[0] === 'pr' && c[1] === 'merge')
  assert.deepEqual(merge, ['pr', 'merge', URL, '--squash', '--match-head-commit', head])
  assert.ok(calls().every(c => !c.includes('--admin')))
  assert.deepEqual(calls().find(c => c[0] === 'repo'), ['repo', 'view', 'acme/shop', '--json', 'mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed'])
  assert.match(ql(['ship', 'gate']).out, /^gate: MERGED/m)
})

test('ship: a failed check gates FIX with its link, and merge refuses', () => {
  const { ql, calls } = setup(h => pr(h, RED))
  ql(['ship', 'start', URL])
  const g = ql(['ship', 'gate'])
  assert.match(g.out, /^gate: FIX/m)
  assert.match(g.out, /^FAIL CI \/ test · failure · https:\/\/ci\/test\/1$/m)
  const m = ql(['ship', 'merge'])
  assert.equal(m.code, 1)
  assert.match(m.err, /not merging: the gate says FIX/)
  assert.ok(!calls().some(c => c[1] === 'merge'))
})

test('ship: wait gates again until the verdict is no longer WAIT', () => {
  const pending = { statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'IN_PROGRESS', conclusion: '' }] }
  const { ql } = setup(h => [pr(h, pending), pr(h, pending), pr(h)])
  ql(['ship', 'start', URL]) // the first snapshot
  const w = ql(['ship', 'wait', '--interval', '0', '--timeout', '60'])
  assert.equal(w.code, 0, w.err)
  assert.match(w.out, /^gate: MERGE/m)
})

test('ship: a merge that GitHub queues is WAIT until it lands, and never merged twice', () => {
  const { ql, bin, calls } = setup(h => pr(h))
  writeFileSync(join(bin, 'queue'), '')
  ql(['ship', 'start', URL])
  const m = ql(['ship', 'merge'])
  assert.equal(m.code, 0, m.err)
  assert.match(m.out, /merge requested, not merged yet/)
  assert.match(ql(['ship', 'gate']).out, /^gate: WAIT/m)
  assert.equal(ql(['ship', 'merge']).code, 1, 'a second merge is refused while one is pending')
  writeFileSync(join(bin, 'merged'), '')
  assert.match(ql(['ship', 'gate']).out, /^gate: MERGED/m)
  assert.equal(calls().filter(c => c[1] === 'merge').length, 1)
})

test('ship: stage stages the change, never the review\'s artifacts or the loop\'s own files', () => {
  const { root, ql } = setup(h => pr(h))
  writeFiles(root, { 'src/a.js': 'export const a = 2\n', 'src/b.js': 'export const b = 1\n', 'coverage/lcov.info': 'x\n' })
  assert.equal(ql(['start', '--mode', 'review', '--review-only']).code, 0)
  const statePath = join(root, '.quality-loop/state.json')
  const s = JSON.parse(readFileSync(statePath, 'utf8'))
  writeFileSync(statePath, JSON.stringify({ ...s, artifacts: ['coverage/'] }))
  const st = ql(['ship', 'stage'])
  assert.equal(st.code, 0, st.err)
  const staged = spawnSync('git', ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf8' }).stdout.trim().split('\n')
  assert.deepEqual(staged, ['src/a.js', 'src/b.js'])
  assert.match(st.out, /^left out \(artifacts\): coverage\/$/m)
})
