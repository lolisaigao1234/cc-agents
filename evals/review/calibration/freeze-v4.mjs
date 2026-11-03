#!/usr/bin/env node
// Exclusive new integrated preregistration; never approval and never model calls.
import assert from 'node:assert/strict';
import { readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { sha, stable } from './utils.mjs';
import { schedule } from './calibrate.mjs';
import { runtimeInventory, protectedInventory, privateInventory } from './snapshot.mjs';
import { resolveCodex } from '../lib/codex.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const privateRoot = realpathSync(process.argv[2]);
assert.ok(privateRoot !== root && !privateRoot.startsWith(root + '/'), 'private bundle must be outside public git');
assert.notEqual(spawnSync('git', ['-C', privateRoot, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' }).stdout.trim(), 'true');
assert.equal(statSync(privateRoot).mode & 0o077, 0, 'private bundle requires mode 700');
const bundle = JSON.parse(readFileSync(join(privateRoot, 'bundle.json'), 'utf8'));
assert.equal(bundle.version, 'astra-calibration-v4');
assert.equal(schedule(bundle).length, 75);
const bin = resolveCodex();
const files = runtimeInventory(root);
const protocol = readFileSync(join(root, 'evals/review/calibration/protocol-v4.json'));
const preregistration = {
  version: 'astra-calibration-v4', issue: 46,
  previous_version: 'astra-calibration-v3',
  historical_harness_sha256: 'e2c423eb214f4e68d95cc36f9903edfcb74e6c1d4d70bfed8637ed980747c612',
  source_archive_sha256: 'ada8cad455f614aadb10f7b2e2d1789c2fc5aafe3b3ab88709463b74b57d10ce',
  protected_harness: protectedInventory(root), runtime: { sha256: sha(stable(files)), files },
  protocol_sha256: sha(protocol),
  environment: { platform: process.platform, arch: process.arch, node_version: process.version,
    node_sha256: sha(readFileSync(realpathSync(process.execPath))),
    codex_runtime_files: ['codex', 'codex-code-mode-host', 'codex-exec-server'].map(name => ({ name, path: realpathSync(join(dirname(bin), name)), sha256: sha(readFileSync(join(dirname(bin), name))) })),
    operating_system: 'Linux; shared libraries, kernel, network/DNS and subscription availability are external prerequisites, not hermetic artifacts',
    system_tools: ['/usr/bin/flock', '/usr/bin/bwrap', '/usr/bin/git', '/usr/bin/sh'].map(path => ({ path, sha256: sha(readFileSync(realpathSync(path))) })) },
  private_files: privateInventory(privateRoot),
  units: bundle.units.map((/** @type {any} */ u) => ({ id: u.id, presentations: u.presentations, control_of: u.control_of ?? null })),
  scheduled_grades: 75, expected_judge_requests: 138,
  migration: 'All 30 v3 input/source files, substantive expectations, citations, exclusions, case selection and schedule unchanged. Bundle and builder version/output filename change. System instruction explicitly forbids tools and limits judgment to supplied frozen evidence with honest uncertainty. Changes grading now includes the already-frozen original PR diff and issue. Schemas, categories, metrics and acceptance unchanged. Whole fresh calibration required; never pool or repair v3.',
  retention: 'Separate restricted preregistration-v4 directory and unpublished maintainer-only draft release; see retention-v4.json. Preserve all prior versions, approvals and failed v3 evidence.',
  approval: { status: 'required', reason: 'Exact integrated calibration only. A real explicit human response may be faithfully transcribed by an agent into a bound record; agents cannot invent the decision or extend it to changed hashes. No approval exists.' },
  results: { live_calls: 0, selection: 'BLOCK', reason: '75 grades and 138 expected requests await exact human approval; no live results exist.' },
};
const output = join(root, 'docs/research/codex-hillclimb-46/preregistration-v4.json');
writeFileSync(output, JSON.stringify(preregistration, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ runtime_sha256: preregistration.runtime.sha256, protocol_sha256: preregistration.protocol_sha256,
  preregistration_sha256: sha(readFileSync(output)), protected_harness_sha256: preregistration.protected_harness.sha256,
  runtime_files: files.length, private_files: preregistration.private_files.length, scheduled_grades: 75, expected_judge_requests: 138 }, null, 2));
