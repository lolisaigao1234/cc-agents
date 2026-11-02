import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copilotDigest } from '../evals/review/lib/transcript.mjs'
import { priceOf, costOf, apiUsage, agentCost } from '../evals/review/lib/prices.mjs'

const leak = /lolisaigao1234/
const seen = /ANSWER-KEY/
const msg = (content, extra = {}) => ({ type: 'assistant.message', data: { model: 'claude-opus-5.5', content, ...extra } })
const start = (id, toolName, args, extra = {}) => ({ type: 'tool.execution_start', data: { toolCallId: id, toolName, arguments: args, ...extra } })
const done = (id, data) => ({ type: 'tool.execution_complete', data: { toolCallId: id, ...data } })
const result = (exitCode = 0) => ({ type: 'result', exitCode, usage: { premiumRequests: 15 } })
const usage = {
  totalPremiumRequestCost: 15,
  modelMetrics: { 'claude-opus-5.5': { usage: { inputTokens: 128681, outputTokens: 618, cacheReadTokens: 102704, cacheWriteTokens: 25965 } } },
}

test('a session that calls task_complete scores as a success with its summary', () => {
  const d = copilotDigest([
    { type: 'session.tools_updated', ephemeral: true, data: { model: 'claude-opus-5.5' } },
    { type: 'user.message', data: { content: 'review it' } },
    { type: 'assistant.turn_start', data: {} },
    msg('Looking.'),
    start('t1', 'task_complete', { summary: 'done' }),
    done('t1', { success: true, result: { content: 'ok' } }),
    { type: 'session.task_complete', data: { summary: 'All done.', success: true } },
    result(),
  ], leak, seen, [], { usage })
  assert.equal(d.result.is_error, false)
  assert.equal(d.result.subtype, 'success')
  assert.equal(d.result.result, 'All done.')
  assert.equal(d.result.num_turns, 1)
  assert.equal(d.result.premium_requests, 15)
  assert.deepEqual(d.servedMain, ['claude-opus-5.5'])
  assert.equal(d.init.model, 'claude-opus-5.5')
  assert.equal(d.counts.tool_calls, 1)
})

test('a nonzero exit is an error, and no result line means no result', () => {
  assert.equal(copilotDigest([result(1)], leak, seen).result.is_error, true)
  assert.equal(copilotDigest([msg('hi')], leak, seen).result, null)
})

test('hook denials, standards reviews, and GitHub posts are counted', () => {
  const d = copilotDigest([
    start('a', 'bash', { command: 'git reset --hard HEAD' }),
    done('a', { success: false, error: { code: 'denied', message: 'Denied by preToolUse hook' } }),
    start('b', 'skill', { skill: 'code-review' }),
    done('b', { success: true, result: { content: 'skill body' } }),
    start('c', 'bash', { command: 'gh pr comment 3 --body x' }),
    done('c', { success: true, result: { content: '' } }),
    result(),
  ], leak, seen)
  assert.equal(d.counts.hook_denials, 1)
  assert.equal(d.counts.std_reviews, 1)
  assert.equal(d.counts.bug_reviews, 0)
  assert.ok(d.material.some(m => m.startsWith('[agent posts to GitHub]')))
  assert.ok(d.material.some(m => m.startsWith('[skill result]')))
})

test('a round workflow named in a tool call counts as a bug review', () => {
  const d = copilotDigest([start('a', 'task', { prompt: 'run trace-review-round now' }), result()], leak, seen, ['trace-review-round'])
  assert.equal(d.counts.bug_reviews, 1)
})

test('reaching for the source repository, or reading the answer key, is a leak', () => {
  assert.equal(copilotDigest([start('a', 'bash', { command: 'gh issue view -R lolisaigao1234/cc-agents 9' })], leak, seen).leaks.length, 1)
  assert.equal(copilotDigest([start('a', 'bash', { command: 'cat x' }), done('a', { success: true, result: { content: 'ANSWER-KEY here' } })], leak, seen).leaks.length, 1)
})

test('subagent messages are tagged and never count as the served main model', () => {
  const d = copilotDigest([msg('sub says', { parentToolCallId: 'p', model: 'claude-haiku-4.5' }), result()], leak, seen)
  assert.deepEqual(d.servedMain, [])
  assert.ok(d.turns.some(t => t.content === '[subagent] sub says'))
})

test('usage splits cache tokens out of inputTokens and prices the dotted model name', () => {
  const d = copilotDigest([result()], leak, seen, [], { usage })
  const u = apiUsage(d.result.modelUsage['claude-opus-5.5'])
  assert.equal(u.input_tokens, 128681 - 102704 - 25965)
  assert.equal(u.cache_read_input_tokens, 102704)
  assert.equal(u.cache_creation_input_tokens, 25965)
  assert.equal(u.output_tokens, 618)
  assert.deepEqual(priceOf('claude-opus-5.5'), priceOf('claude-opus-5-5'))
  assert.ok(costOf('claude-opus-5.5', u) > 0)
})

test('an unpriced sub-agent model is named, and the priced models are still costed', () => {
  const d = copilotDigest([result()], leak, seen, [], { usage: {
    ...usage, totalNanoAiu: 4200000000,
    modelMetrics: { ...usage.modelMetrics, 'gpt-5.6-luna': { usage: { inputTokens: 5000, outputTokens: 200 } } },
  } })
  assert.equal(d.result.nano_aiu, 4200000000)
  const mu = Object.fromEntries(Object.entries(d.result.modelUsage).map(([k, v]) => [k, apiUsage(v)]))
  const { usd, unpriced } = agentCost(mu)
  assert.deepEqual(unpriced, ['gpt-5.6-luna'])
  assert.equal(usd, costOf('claude-opus-5.5', mu['claude-opus-5.5']))
  assert.ok(usd > 0)
})
