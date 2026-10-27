import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { handleHook } from '../plugins/quality-loop/scripts/lib/hooks.mjs'
import * as loop from '../plugins/quality-loop/scripts/lib/loop.mjs'
import { makeRepo } from './helpers.mjs'

/** @param {string} root */
const state = root => JSON.parse(readFileSync(join(root, '.quality-loop/state.json'), 'utf8'))

/** @param {string} root @param {Record<string, any>} patch */
function patchState(root, patch) {
  const p = join(root, '.quality-loop/state.json')
  writeFileSync(p, JSON.stringify({ ...state(root), ...patch }))
}

/** @param {string} event @param {Record<string, any>} input */
function hook(event, input) {
  const { stdout } = handleHook(event, input)
  return stdout ? JSON.parse(stdout) : null
}

/** @param {string} root @param {string} command @param {string} [session_id] */
const bash = (root, command, session_id) => hook('pre-tool-use', { cwd: root, session_id, tool_name: 'Bash', tool_input: { command } })

/** A repository with a loop started in it (no checks configured, so start is quick). */
async function started(opts = {}) {
  const root = makeRepo({ 'README.md': 'x\n' })
  await loop.start(root, { mode: 'review', ...opts })
  return root
}

// --- n16 / n22: a capped, stalled, paused or aborted loop is restarted only by the user

test('ql start refuses to start over a loop that spent rounds without finishing; --force (user only) does (n16, n22)', async () => {
  for (const status of ['capped', 'stalled', 'paused', 'aborted']) {
    const root = await started()
    patchState(root, { status, round: 3 })
    await assert.rejects(loop.start(root, { mode: 'review' }), /only the user/, status)
    assert.equal(state(root).status, status, 'the old loop is left in place')
    // the guard keeps --force out of the agent's hands, in any flag order
    assert.equal(bash(root, 'node "$P/scripts/ql.mjs" --force start --mode review')?.hookSpecificOutput.permissionDecision, 'deny', status)
    // the user, running it from the prompt, can
    const s = await loop.start(root, { mode: 'review', force: true })
    assert.equal(s.status, 'active')
    assert.equal(s.round, 0)
  }
})

test('abort or pause mid-loop, then start, does not reset the round cap (n16, n22)', async () => {
  const root = await started()
  loop.beginRound(root)
  // the guard lets the chain through: ql itself refuses the restart
  assert.equal(bash(root, 'ql abort --reason x && ql start --mode review'), null)
  loop.abort(root, 'x')
  await assert.rejects(loop.start(root, { mode: 'review' }), /only the user/)

  const root2 = await started()
  loop.beginRound(root2)
  loop.pause(root2, 'x')
  await assert.rejects(loop.start(root2, { mode: 'review' }), /ql resume/)
})

test('first starts, starts after DONE and restarts before any round still work (n16, n22)', async () => {
  const root = await started()
  patchState(root, { status: 'done', round: 2 })
  assert.equal((await loop.start(root, { mode: 'review' })).status, 'active')
  // a debug loop paused at round 0 (the repro did not reproduce) may be started again
  patchState(root, { status: 'paused', round: 0 })
  assert.equal((await loop.start(root, { mode: 'review' })).status, 'active')
  // and so may one aborted before its first round
  loop.abort(root, 'wrong base')
  assert.equal((await loop.start(root, { mode: 'review' })).status, 'active')
})

// --- n23: the Edit/Write guard through the hook, with the OS's own paths

test('the hook denies edits to protected files through un-normalised and symlinked paths (n23)', async () => {
  const root = await started()
  const real = realpathSync(root)
  const deny = (/** @type {string} */ cwd, /** @type {string} */ file_path) =>
    hook('pre-tool-use', { cwd, tool_name: 'Write', tool_input: { file_path, content: '{}' } })?.hookSpecificOutput.permissionDecision
  for (const file_path of [
    join(root, '.quality-loop/state.json'),
    `${root}/src/../.quality-loop/state.json`,
    `${root}/.quality-loop//state.json`,
    `${real}/.quality-loop/config.json`,
  ]) {
    assert.equal(deny(root, file_path), 'deny', file_path)
    assert.equal(deny(real, file_path), 'deny', `from the real cwd: ${file_path}`)
  }
  if (process.platform === 'darwin') assert.equal(deny(root, `${root}/.QUALITY-LOOP/STATE.JSON`), 'deny')
  assert.equal(deny(root, join(root, 'README.md')), undefined)
})

// --- n25: the Stop hook acts only in the session that runs the loop

test('the session that runs `ql start` owns the loop; other sessions are not held or steered (n25)', async () => {
  const root = makeRepo({ 'README.md': 'x\n' })
  assert.equal(bash(root, '"$P/bin/ql" start --mode review --goal "g"', 'A'), null)
  await loop.start(root, { mode: 'review' })

  const stopB = hook('stop', { cwd: join(root, 'sub'), session_id: 'B', stop_hook_active: false })
  assert.equal(stopB, null, 'an unrelated session may stop')
  assert.equal(state(root).stopNudges, 0, "and does not use up the loop's nudges")
  assert.equal(state(root).sessionId, 'A')

  const promptB = hook('user-prompt-submit', { cwd: root, session_id: 'B', prompt: 'what does foo do?' })
  assert.doesNotMatch(promptB?.hookSpecificOutput.additionalContext ?? '', /Next:|Goal:/)
  assert.ok((promptB?.hookSpecificOutput.additionalContext ?? '').split('\n').length <= 1)
  const resumedB = hook('session-start', { cwd: root, session_id: 'B', source: 'resume' })
  assert.doesNotMatch(resumedB?.hookSpecificOutput.additionalContext ?? '', /Goal \(finish line\)/)

  assert.equal(hook('stop', { cwd: root, session_id: 'A', stop_hook_active: false })?.decision, 'block')
  assert.match(hook('user-prompt-submit', { cwd: root, session_id: 'A', prompt: 'go' })?.hookSpecificOutput.additionalContext, /Next:/)

  // B trying to start its own loop over A's does not claim it
  assert.equal(bash(root, 'ql start --mode review', 'B'), null)
  assert.equal(hook('stop', { cwd: root, session_id: 'B' }), null)

  // the guard still protects the loop from every session
  assert.equal(bash(root, 'git reset --hard', 'B')?.hookSpecificOutput.permissionDecision, 'deny')

  // a session that takes over driving the loop with ql becomes its owner
  assert.equal(bash(root, 'ql round begin', 'C'), null)
  assert.equal(state(root).sessionId, 'C')
  assert.equal(hook('stop', { cwd: root, session_id: 'A' }), null)
  assert.equal(hook('stop', { cwd: root, session_id: 'C' })?.decision, 'block')
})

test('a loop started outside any hook is bound to the first session that reports in (n25)', async () => {
  const root = await started()
  assert.equal(hook('stop', { cwd: root, session_id: 'X' })?.decision, 'block')
  assert.equal(state(root).sessionId, 'X')
  assert.equal(hook('stop', { cwd: root, session_id: 'Y' }), null)
  // hooks without a session id keep the old behaviour
  assert.equal(hook('stop', { cwd: root })?.decision, 'block')
})

// --- n27: maxStopNudges that is not a whole number

test('a non-numeric loop.maxStopNudges cannot make Stop block forever (n27)', async () => {
  for (const bad of ['unlimited', undefined, null, -1, 2.5, '3']) {
    const root = await started()
    const s = state(root)
    s.config.loop.maxStopNudges = bad
    writeFileSync(join(root, '.quality-loop/state.json'), JSON.stringify(s))
    let blocks = 0
    for (let i = 0; i < 30; i++) if (hook('stop', { cwd: root, stop_hook_active: true })?.decision === 'block') blocks++
    assert.ok(blocks <= 8, `${String(bad)}: blocked ${blocks} times`)
  }
  // a corrupt nudge counter fails open too
  const root = await started()
  patchState(root, { stopNudges: 'many' })
  assert.equal(hook('stop', { cwd: root }), null)
})

test('ql start rejects a config whose loop.maxStopNudges is not a whole number (n27)', async () => {
  const root = makeRepo({ 'README.md': 'x\n' })
  loop.init(root)
  const cfg = join(root, '.quality-loop/config.json')
  writeFileSync(cfg, JSON.stringify({ ...JSON.parse(readFileSync(cfg, 'utf8')), loop: { maxStopNudges: 'unlimited' } }))
  await assert.rejects(loop.start(root, { mode: 'review' }), /maxStopNudges/)
})
