#!/usr/bin/env node
// Offline preregistration writer. It cannot write human approvals or call a model.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha, schedule } from './calibrate.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const privateRoot = realpathSync(process.argv[2]);
assert.equal(statSync(privateRoot).mode & 0o077, 0, 'private bundle requires mode 700');
assert.ok(!privateRoot.startsWith(root + '/') && privateRoot !== root);
const json = (/** @type {string} */ p) => JSON.parse(readFileSync(p, 'utf8'));
const stable = (/** @type {any} */ v) => JSON.stringify(v, (_, x) => x && !Array.isArray(x) && typeof x === 'object' ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x);
const original = json(join(root, 'docs/research/codex-hillclimb-44/harness-files.json'));
const prerequisites = json(join(root, 'docs/research/codex-hillclimb-44/prerequisites.json'));
const bundle = json(join(privateRoot, 'bundle.json'));
const runtimePaths = new Set([
  ...original.files.map((/** @type {any} */ f) => f.path),
  'package.json', 'evals/review/selftest.mjs',
  ...readdirSync(join(root, 'evals/review/calibration')).map(name => `evals/review/calibration/${name}`),
  ...readdirSync(join(root, 'test')).filter(name => /^eval-.*\.test\.mjs$/.test(name)).map(name => `test/${name}`),
  ...['verify.mjs', 'harness-files.json', 'artifact-inventory.json', 'prerequisites.json'].map(name => `docs/research/codex-hillclimb-44/${name}`),
]);
const files = [...runtimePaths].sort().map(path => ({ path, sha256: sha(readFileSync(join(root, path))) }));
const privatePaths = ['bundle.json', 'build-v1.py', ...['sources', 'inputs'].flatMap(dir => readdirSync(join(privateRoot, dir)).sort().map(name => `${dir}/${name}`))];
const private_files = privatePaths.sort().map(path => ({ path, bytes: statSync(join(privateRoot, path)).size, sha256: sha(readFileSync(join(privateRoot, path))) }));
const units = bundle.units.map((/** @type {any} */ u) => ({ id: u.id, presentations: u.presentations, control_of: u.control_of ?? null }));
const preregistration = {
  version: 'astra-calibration-v1', issue: 46,
  historical_harness_sha256: original.harness_sha,
  source_archive_sha256: 'ada8cad455f614aadb10f7b2e2d1789c2fc5aafe3b3ab88709463b74b57d10ce',
  runtime: { sha256: sha(stable(files)), files },
  environment: { node_version: process.version, node_sha256: sha(readFileSync(realpathSync(process.execPath))), codex_runtime_files: prerequisites.codex_runtime_files,
    operating_system: 'Linux; system libraries and kernel are external prerequisites, not claimed hermetic artifacts',
    system_tools: ['/usr/bin/flock', '/usr/bin/bwrap'].map(path => ({ path, sha256: sha(readFileSync(realpathSync(path))) })) },
  private_files, units, scheduled_grades: schedule(bundle).length, expected_judge_requests: 138,
  retention: 'Restricted preregistration-v1 bundle outside public git; see retention.json. The bundle includes exact inputs, evidence-cited expected labels, scoped source snapshots and its reproducible builder.',
  approval: { status: 'required', reason: 'New driver/runtime/protocol. Historical #44 approvals do not cover this calibration experiment. No human approval supplied.' },
  results: { live_calls: 0, selection: 'BLOCK', reason: 'Live calibration and probes await exact human approval; no grades exist.' },
};
const output = join(root, 'docs/research/codex-hillclimb-46/preregistration.json');
writeFileSync(output, JSON.stringify(preregistration, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ runtime_sha256: preregistration.runtime.sha256, preregistration_sha256: sha(readFileSync(output)), private_files: private_files.length, scheduled_grades: preregistration.scheduled_grades }, null, 2));
