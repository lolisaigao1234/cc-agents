// Public runner preflight only: empty HOME, no token, no models or answer keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { CODEX_JUDGE, executionConfig } from '../evals/review/lib/config.mjs';

const runner = fileURLToPath(new URL('../evals/review/run.mjs', import.meta.url));
const args = { agent: 'codex', model: 'gpt-6.1-sol', variant: 'baseline', concurrency: 1 };
const state = { ...args, effort: 'high', service_tier: 'fast', judge: CODEX_JUDGE, model_verification: 'configured_only', harness_sha: '0'.repeat(64) };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'codex-runner-'));
  mkdirSync(join(dir, 'flow')); mkdirSync(join(dir, 'home'));
  return dir;
}

/** @param {string} dir @param {string} variant @param {any} [extraState] */
function run(dir, variant, extraState = {}) {
  writeFileSync(join(dir, 'flow/_state.json'), JSON.stringify({ ...state, ...extraState }));
  return spawnSync(process.execPath, [runner, '--flow', 'flow', '--agent', 'codex', '--model', args.model,
    '--variant', variant, '--concurrency', '1', '--dry-run'], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: join(dir, 'home') } });
}

test('runner rejects unknown variants and Claude requirements before auth/setup or a paid call', () => {
  const dir = fixture();
  try {
    for (const variant of ['v5', 'v12', 'v14']) assert.match(run(dir, variant).stderr, /unsupported Codex variant/);
    for (const variant of ['baseline', 'v13']) {
      assert.match(run(dir, variant, { requirements: { workflow: 'Workflow' } }).stderr, /unsupported Claude Workflow\/slash-command requirements/);
      assert.match(run(dir, variant).stderr, /harness changed/); // accepted, still gated
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('resume checks both arms and rejects cross-arm evidence before setup without rewriting failed attempts', () => {
  const dir = fixture();
  const harness_sha = createHash('sha256').update(relative(dir, runner)).update('\0').update(readFileSync(runner)).update('\0').digest('hex');
  try {
    for (const variant of ['baseline', 'v13']) {
      mkdirSync(join(dir, 'flow', variant), { recursive: true });
      const errors = join(dir, 'flow', variant, 'errors.jsonl');
      writeFileSync(errors, '{"failure_class":"harness","prompt_id":"synthetic","rep":0}\n');
      const priorErrors = readFileSync(errors, 'utf8');
      const result = join(dir, 'flow', variant, 'results.jsonl');
      const config = executionConfig(state, { ...args, variant });
      const row = { prompt_id: 'synthetic', rep: 0, meta: { execution_config: config, judge_config: CODEX_JUDGE,
        codex: { effort: 'high', service_tier: 'fast', variant: executionConfig(state, { ...args, variant: variant === 'baseline' ? 'v13' : 'baseline' }).variant } } };
      writeFileSync(result, JSON.stringify(row) + '\n');
      assert.match(run(dir, variant, { harness_sha }).stderr, /different Codex variant/);
      row.meta.codex.variant = config.variant;
      writeFileSync(result, JSON.stringify(row) + '\n');
      assert.match(run(dir, variant, { harness_sha }).stderr, /gh-token/); // valid resume passes to setup, with no credentials
      assert.equal(readFileSync(errors, 'utf8'), priorErrors);
      assert.equal(readFileSync(result, 'utf8'), JSON.stringify(row) + '\n');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
