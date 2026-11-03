import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('integrated snapshot verifies its own membership and rejects changed or added bytes before auth', async () => {
  const { runtimeInventory, protectedInventory, verifySnapshot } = await import('../evals/review/calibration/snapshot.mjs');
  const { sha, stable } = await import('../evals/review/calibration/utils.mjs');
  const root = mkdtempSync(join(tmpdir(), 'snapshot-public-'));
  const privateRoot = mkdtempSync(join(tmpdir(), 'snapshot-private-'));
  /** @param {string} path @param {string} text */
  const put = (path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
  try {
    spawnSync('git', ['init', '-q', root]);
    put('docs/research/codex-hillclimb-44/harness-files.json', JSON.stringify({ harness_paths: ['evals/review/lib', 'evals/review/variants', 'plugins/trace'] }));
    for (const path of ['evals/review/run.mjs', 'evals/review/lib/grade.mjs', 'evals/review/variants/v13/variant.json', 'plugins/trace/plugin.json', 'evals/review/calibration/calibrate.mjs', 'test/eval-calibration.test.mjs', 'package.json']) put(path, '{}');
    writeFileSync(join(privateRoot, 'bundle.json'), '{}');
    const files = runtimeInventory(root), protectedHarness = protectedInventory(root);
    const manifest = { runtime: { files, sha256: sha(stable(files)) }, protected_harness: protectedHarness,
      private_files: [{ path: 'bundle.json', bytes: 2, sha256: sha('{}') }] };
    assert.doesNotThrow(() => verifySnapshot(root, privateRoot, manifest));
    put('evals/review/lib/new-dependency.mjs', 'new dependency');
    assert.throws(() => verifySnapshot(root, privateRoot, manifest), /membership|runtime/);
    rmSync(join(root, 'evals/review/lib/new-dependency.mjs'));
    put('evals/review/lib/grade.mjs', 'changed grade');
    assert.throws(() => verifySnapshot(root, privateRoot, manifest), /runtime|changed bytes/);
    put('evals/review/lib/grade.mjs', '{}');
    writeFileSync(join(privateRoot, 'bundle.json'), 'changed input');
    assert.throws(() => verifySnapshot(root, privateRoot, manifest), /private|changed bytes/);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(privateRoot, { recursive: true, force: true }); }
});

test('actual integrated plan is runnable and CLI gates deny missing/changed approval and changed bytes before auth', async () => {
  const { runtimeInventory } = await import('../evals/review/calibration/snapshot.mjs');
  const { fileURLToPath } = await import('node:url');
  const { copyFileSync, existsSync } = await import('node:fs');
  const source = fileURLToPath(new URL('..', import.meta.url));
  const root = mkdtempSync(join(tmpdir(), 'calibration-cli-public-'));
  const privateRoot = mkdtempSync(join(tmpdir(), 'calibration-cli-private-'));
  const output = join(privateRoot, 'uncreated-run');
  /** @param {string[]} args */
  const invoke = args => spawnSync(process.execPath, [join(root, 'evals/review/calibration/calibrate.mjs'), ...args, '--private', privateRoot],
    { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: root, CODEX_BIN: process.env.CODEX_BIN,
      CODEX_EVAL_HOME: join(privateRoot, 'must-not-access-auth') } });
  try {
    for (const f of runtimeInventory(source)) {
      mkdirSync(dirname(join(root, f.path)), { recursive: true });
      copyFileSync(join(source, f.path), join(root, f.path));
    }
    mkdirSync(join(root, 'docs/research/codex-hillclimb-46'), { recursive: true });
    spawnSync('git', ['init', '-q', root]);
    writeFileSync(join(privateRoot, 'bundle.json'), JSON.stringify({ version: 'astra-calibration-v3',
      units: Array.from({ length: 25 }, (_, i) => ({ id: `synthetic-${i}`, presentations: ['original'], expected: {} })) }));
    const frozen = spawnSync(process.execPath, [join(root, 'evals/review/calibration/freeze-v3.mjs'), privateRoot], { cwd: root, encoding: 'utf8' });
    assert.equal(frozen.status, 0, frozen.stderr);
    const plan = invoke(['plan']);
    assert.equal(plan.status, 0, plan.stderr);
    const current = JSON.parse(plan.stdout);
    assert.equal(current.scheduled_grades, 75);
    const missing = invoke(['run', '--output', output]);
    assert.equal(missing.status, 2); assert.match(missing.stderr, /HUMAN approval/);
    // Synthetic approval only in a disposable fixture, never the real set.
    writeFileSync(join(privateRoot, 'fixture-approval.json'), JSON.stringify({ human_approval: true,
      approved_by: 'SYNTHETIC TEST ONLY', record: 'fixture; no real authorization', approved_at: '2026-11-03T00:00:00Z',
      runtime_sha256: 'changed', protocol_sha256: current.protocol_sha256, preregistration_sha256: current.preregistration_sha256 }));
    // Extra private bytes themselves must be denied before reaching approval/auth.
    const extra = invoke(['plan']);
    assert.equal(extra.status, 2); assert.match(extra.stderr, /private membership/);
    const approval = join(root, 'synthetic-test-approval.json');
    copyFileSync(join(privateRoot, 'fixture-approval.json'), approval);
    rmSync(join(privateRoot, 'fixture-approval.json'));
    const changed = invoke(['run', '--output', output, '--approval', approval]);
    assert.equal(changed.status, 2); assert.match(changed.stderr, /HUMAN approval/);
    writeFileSync(join(root, 'evals/review/lib/grade.mjs'), '// changed runtime');
    const bytesChanged = invoke(['run', '--output', output, '--approval', approval]);
    assert.equal(bytesChanged.status, 2); assert.match(bytesChanged.stderr, /runtime membership or bytes/);
    assert.equal(existsSync(output), false);
    assert.equal(existsSync(join(privateRoot, 'must-not-access-auth')), false);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(privateRoot, { recursive: true, force: true }); }
});
