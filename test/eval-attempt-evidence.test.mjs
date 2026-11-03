import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

for (const variant of ['baseline', 'v13']) test(`${variant}: a completed review survives a failed judge and a successful retry`, async () => {
  const { retainAttempt } = await import('../evals/review/lib/attempt-evidence.mjs');
  const root = mkdtempSync(join(tmpdir(), 'attempt-evidence-'));
  const home = join(root, 'runtime-home');
  mkdirSync(join(home, 'eval-control/round-1-fix-123'), { recursive: true });
  mkdirSync(join(home, '.codex'));
  writeFileSync(join(home, '.codex/auth.json'), 'SECRET_AUTH_SENTINEL');
  writeFileSync(join(home, 'eval-control/policy.json'), 'unrelated runtime file');
  const raw = '{"type":"unknown.future","original":"bytes"}  \n';
  writeFileSync(join(home, 'eval-control/round-1-fix-123/events.jsonl'), raw);
  writeFileSync(join(home, 'eval-control/round-1-fix-123/prompt.txt'), 'verify before fixing');
  const completed = { transcript: [{ role: 'assistant', content: 'verified; unsupported rejected; human choice unresolved' }],
    material: 'all three findings and dispositions', meta: { variant, codex_events: [{ type: 'unknown.future' }] }, usage: { output_tokens: 8 } };
  try {
    const run = await retainAttempt({ root, label: 'agent', request: { variant }, homes: [home],
      execute: async () => completed, cleanup: () => rmSync(home, { recursive: true }) });
    assert.equal(existsSync(home), false);
    const agent = readdirSync(root).find(n => n.startsWith('agent-'));
    assert.ok(agent);
    assert.deepEqual(JSON.parse(readFileSync(join(root, agent, 'result.json'), 'utf8')), completed);
    assert.equal(readFileSync(join(root, agent, 'calls/0/round-1-fix-123/events.jsonl'), 'utf8'), raw);
    assert.equal(existsSync(join(root, agent, 'calls/0/auth.json')), false);
    await assert.rejects(retainAttempt({ root, label: 'judge', request: { material: run.material }, execute: async () => {
      throw Object.assign(new Error('judge tool rejected'), { failure_class: 'grader', judge_usage: { output_tokens: 3 },
        judge_calls: [{ status: 'failure', events: [{ item: { type: 'tool_call' } }] }] });
    } }), /judge tool rejected/);
    await retainAttempt({ root, label: 'judge', request: { material: run.material }, execute: async () => ({ grade: { recall: 1 } }) });
    const judges = readdirSync(root).filter(n => n.startsWith('judge-'));
    assert.equal(judges.length, 2);
    const failed = judges.map(n => join(root, n, 'failure.json')).find(existsSync);
    assert.ok(failed);
    const failure = JSON.parse(readFileSync(failed, 'utf8'));
    assert.equal(failure.failure_class, 'grader');
    assert.equal(failure.judge_usage.output_tokens, 3);
    assert.equal(failure.judge_calls[0].events[0].item.type, 'tool_call');
    assert.equal(existsSync(join(root, 'results.jsonl')), false);
    assert.ok(readdirSync(root).filter(n => /^(agent|judge)-/.test(n)).every(n => existsSync(join(root, n, 'index.json'))));
    for (const name of readdirSync(root).filter(n => /^(agent|judge)-/.test(n))) {
      const attempt = join(root, name);
      const index = JSON.parse(readFileSync(join(attempt, 'index.json'), 'utf8'));
      for (const file of index.files) assert.doesNotMatch(readFileSync(join(attempt, file.path), 'utf8'), /SECRET_AUTH_SENTINEL|unrelated runtime file/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
