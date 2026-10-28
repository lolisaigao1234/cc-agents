// full-send's side of ql (ADR 0004): reads the PR through `gh`, keeps the
// ship state in `.quality-loop/runs/ship.json`, stages the change without
// the review's artifacts, and merges only a head the gate passed, pinned
// with `--match-head-commit`. Never `--admin`. The decisions are in gate.mjs.

import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

import { isArtifact } from './artifacts.mjs'
import { decideGate, pickMergeMethod } from './gate.mjs'
import { changedPaths, git, revParse, snapshotTree } from './git.mjs'
import { LoopError, loadConfig, loadState } from './loop.mjs'
import { paths, readJson, writeJson } from './store.mjs'

const PR_FIELDS = 'number,url,state,isDraft,mergeable,mergeStateStatus,headRefOid,headRefName,baseRefName,statusCheckRollup,mergeCommit'
// git's empty tree: the base for a repository with no commit yet.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/** @param {string} root @param {string[]} args */
function gh(root, args) {
  const r = spawnSync('gh', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.error) throw new LoopError(`gh is not available (${r.error.message}): full send needs an authenticated GitHub CLI`)
  if (r.status !== 0) throw new LoopError(`gh ${args.join(' ')} failed (${r.status}): ${r.stderr.trim()}`)
  return r.stdout
}

/** @param {string} root @param {string} pr */
function viewPr(root, pr) {
  return JSON.parse(gh(root, ['pr', 'view', pr, '--json', PR_FIELDS]))
}

/** @param {string} root */
const shipPath = root => join(paths(root).runs, 'ship.json')

/** @param {string} root */
function loadShip(root) {
  const s = readJson(shipPath(root))
  if (!s) throw new LoopError('no ship in progress: `ql ship start <pr>` once the PR is open')
  return s
}

/**
 * The `gh repo view` selector for a PR URL: OWNER/REPO, or HOST/OWNER/REPO
 * off github.com.
 *
 * @param {string} url
 */
function repoOf(url) {
  const u = new URL(url)
  const [owner, repo] = u.pathname.split('/').filter(Boolean)
  return `${u.host === 'github.com' ? '' : `${u.host}/`}${owner}/${repo}`
}

/**
 * Whether the base branch's recent first-parent history has merge commits
 * (null when the base is not fetched here).
 *
 * @param {string} root
 * @param {string} base
 */
function mergeHistory(root, base) {
  const r = git(['rev-list', '--first-parent', '--parents', '-n', '20', `origin/${base}`, '--'], { cwd: root, allowFail: true })
  if (!r.ok) return null
  return r.stdout.split('\n').some(l => l.trim().split(' ').length > 2)
}

/**
 * Starts following a PR: a fresh ship state.
 *
 * @param {string} root
 * @param {string} pr a PR number or URL
 */
export function start(root, pr) {
  const view = viewPr(root, pr)
  const ship = { pr: view.url ?? pr, startedAt: new Date().toISOString(), failedHeads: [], headSeenAt: {}, merging: null }
  writeJson(shipPath(root), ship)
  return { ship, pr: view }
}

/**
 * The gate's verdict on the PR as GitHub reports it now (see gate.mjs).
 *
 * @param {string} root
 * @param {number} [now]
 */
export function gate(root, now = Date.now()) {
  const ship = loadShip(root)
  const pr = viewPr(root, ship.pr)
  ship.headSeenAt[pr.headRefOid] ??= now
  const d = decideGate({ pr, localHead: revParse(root, 'HEAD'), ship, now, config: loadConfig(root).ship })
  ship.failedHeads = d.failedHeads
  ship.last = { verdict: d.verdict, head: pr.headRefOid, at: new Date(now).toISOString() }
  writeJson(shipPath(root), ship)
  return { ...d, pr }
}

/**
 * Gates until the verdict is no longer WAIT, or the timeout passes.
 *
 * @param {string} root
 * @param {{ timeoutSec: number, intervalSec: number }} opts
 */
export function wait(root, opts) {
  const until = Date.now() + opts.timeoutSec * 1000
  for (;;) {
    const g = gate(root)
    if (g.verdict !== 'WAIT' || Date.now() + opts.intervalSec * 1000 > until) return g
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, opts.intervalSec * 1000)
  }
}

/**
 * Merges the PR when, and only when, the gate says MERGE on the head it
 * just read.
 *
 * @param {string} root
 */
export function merge(root) {
  const g = gate(root)
  if (g.verdict !== 'MERGE') throw new LoopError(`not merging: the gate says ${g.verdict}: ${g.reasons.join('; ')}`)
  const ship = loadShip(root)
  const allowed = JSON.parse(gh(root, ['repo', 'view', repoOf(g.pr.url), '--json', 'mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed']))
  const configured = loadConfig(root).ship.mergeMethod
  const method = pickMergeMethod(
    { squash: !!allowed.squashMergeAllowed, merge: !!allowed.mergeCommitAllowed, rebase: !!allowed.rebaseMergeAllowed },
    configured,
    mergeHistory(root, g.pr.baseRefName),
  )
  if (!method) throw new LoopError(`not merging: ship.mergeMethod "${configured}" is not a method this repository allows`)
  gh(root, ['pr', 'merge', ship.pr, `--${method}`, '--match-head-commit', g.pr.headRefOid])
  ship.merging = g.pr.headRefOid
  writeJson(shipPath(root), ship)
  const after = viewPr(root, ship.pr)
  return { method, url: g.pr.url, merged: String(after.state).toUpperCase() === 'MERGED', mergeCommit: after.mergeCommit?.oid ?? null }
}

/**
 * Stages the change for its commit: every path that differs from HEAD in
 * the working tree, without the review's artifacts and the loop's own
 * directory.
 *
 * @param {string} root
 */
export function stage(root) {
  const artifacts = /** @type {string[]} */ (loadState(root)?.artifacts ?? [])
  const changed = changedPaths(root, revParse(root, 'HEAD') ?? EMPTY_TREE, snapshotTree(root))
  const files = changed.filter(p => !isArtifact(p, artifacts))
  const leftOut = artifacts.filter(a => changed.some(p => isArtifact(p, [a])))
  if (files.length) {
    git(['--literal-pathspecs', 'add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], { cwd: root, input: files.join('\0') })
  }
  return { files, leftOut }
}
