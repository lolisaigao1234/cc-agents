// Offline handoff verification only: no runner invocation, auth reads or model calls.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const value = flag => {
  const i = args.indexOf(flag);
  if (i < 0) return null;
  assert.ok(args[i + 1] && !args[i + 1].startsWith('--'), `${flag} needs a path`);
  return resolve(args[i + 1]);
};
const root = value('--checkout') ?? process.cwd();
const artifacts = value('--artifacts');
assert.ok(args.every((a, i) => i % 2 ? !a.startsWith('--') : ['--checkout', '--artifacts'].includes(a)),
  'usage: node docs/research/codex-hillclimb-44/verify.mjs [--checkout DIR] [--artifacts EXTRACTED_DIR]');
const json = p => JSON.parse(readFileSync(p, 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const inventory = json(join(here, 'artifact-inventory.json'));
const frozen = json(join(here, 'harness-files.json'));

// Same path/byte framing and git-visible directory enumeration as run.mjs.
const paths = new Set([join(root, 'evals/review/run.mjs')]);
for (const d of [join(root, 'evals/review'), root]) {
  for (const lock of ['package-lock.json', 'bun.lock', 'bun.lockb', 'yarn.lock', 'pnpm-lock.yaml']) {
    if (existsSync(join(d, lock))) paths.add(join(d, lock));
  }
}
for (const p of frozen.harness_paths) {
  const absolute = resolve(root, p);
  if (!statSync(absolute).isDirectory()) { paths.add(absolute); continue; }
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'],
    { cwd: absolute, encoding: 'utf8' }).split('\0').filter(Boolean);
  assert.ok(files.length, `empty harness directory: ${p}`);
  for (const file of files) paths.add(join(absolute, file));
}
const hash = createHash('sha256');
for (const path of [...paths].sort()) hash.update(relative(root, path)).update('\0').update(readFileSync(path)).update('\0');
const computed = hash.digest('hex');
if (computed !== inventory.pilot_harness_sha || computed !== inventory.deferred_opus_harness_sha) {
  console.error(`STOP: HUMAN approval required for a changed harness. Pinned ${inventory.deferred_opus_harness_sha}; computed ${computed}.`);
  process.exit(2);
}
assert.equal(paths.size, frozen.files.length);
console.log(`Harness matches both historical pilot approvals: ${computed} (${paths.size} files).`);

if (artifacts) {
  for (const file of inventory.files) {
    assert.ok(!file.path.startsWith('/') && !file.path.split('/').includes('..'), 'invalid artifact path');
    const bytes = readFileSync(join(artifacts, file.path));
    assert.equal(bytes.length, file.bytes, file.path);
    assert.equal(sha256(bytes), file.sha256, file.path);
  }
  for (const flow of ['review-codex-sol-astra', 'review-opus-astra']) {
    assert.equal(json(join(artifacts, flow, '_state.json')).harness_sha, computed, flow);
  }
  const lines = filename => readFileSync(join(artifacts, 'review-codex-sol-astra/baseline', filename), 'utf8')
    .match(/[^\n]*\n/g) ?? [];
  const scored = lines('results.jsonl');
  const failed = lines('errors.jsonl');
  assert.equal(scored.length, 5);
  assert.equal(failed.length, 8);
  const keys = new Set();
  for (const item of inventory.scored) {
    const line = scored[item.results_line - 1];
    assert.equal(sha256(line), item.line_sha256);
    const row = JSON.parse(line);
    assert.equal(row.prompt_id, item.case);
    assert.equal(row.rep, item.rep);
    assert.equal(row.status, 'ok');
    keys.add(`${row.prompt_id}/${row.rep}`);
  }
  assert.equal(keys.size, 5);
  for (const item of inventory.failed_attempts) {
    const line = failed[item.errors_line - 1];
    assert.equal(sha256(line), item.line_sha256);
    const row = JSON.parse(line);
    assert.equal(row.prompt_id, item.case);
    assert.equal(row.rep, item.rep);
    assert.equal(row.failure_class, item.recorded_failure_class);
  }
  console.log(`Verified ${inventory.files.length} artifact hashes, five unique scored keys and eight failed attempts.`);
}
