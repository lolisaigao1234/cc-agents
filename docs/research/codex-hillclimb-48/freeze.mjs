// Offline v3 preparation; historical v2 is reproduced only at its frozen commit.
import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha, deriveV2Split } from './protocol.mjs';
import { selectMattPlugin } from '../../../evals/review/lib/matt-plugin.mjs';
import { executionConfig } from '../../../evals/review/lib/config.mjs';
import { verifySnapshot, verifyEnvironment } from '../../../evals/review/calibration/snapshot.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const DIR = 'docs/research/codex-hillclimb-48';
export const PRIVATE_V5 = '/home/ubuntu/cc-agents-artifacts/issue-48/correction-v3-calibration-v5';
export const V2_COMMIT = 'b1dc97f18d46f2a54c2b1cf0a79f7a2143339f60';
export const atV2 = (root, name) => execFileSync('git', ['show', `${V2_COMMIT}:${DIR}/${name}`], { cwd: root });
export const json = path => JSON.parse(readFileSync(path, 'utf8'));
const derived = new Set(['experiment-manifest.json', 'approval.md', 'plan.json', 'handoff.md']);
export const V1_COMMIT = '36c1081983b93114073a9e334ae443f98633fbfe';
const V1_MANIFEST_SHA = 'dc42cc18e8192fbe5f7635dcf174e8dd64a17d981e55543f5a50d581815c288a';
const atV1 = (root, name) => execFileSync('git', ['show', `${V1_COMMIT}:${DIR}/${name}`], { cwd: root });

export function inputNames(root) {
  return readdirSync(join(root, DIR)).filter(name => !derived.has(name) && !['checks','checks-v2','checks-v3'].includes(name)).sort();
}

// Hash only known non-secret dependency trees. Preserve symlink identities too.
export function treeInventory(root, prefix = '') {
  return readdirSync(join(root, prefix), { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name)).flatMap(entry => {
    assert.notEqual(entry.name, 'archive', 'human-only archive cannot be inventoried');
    const path = join(prefix, entry.name), full = join(root, path), st = lstatSync(full);
    if (st.isDirectory()) return treeInventory(root, path);
    const real = realpathSync(full);
    assert.ok(real.startsWith(realpathSync(root) + '/'), 'dependency symlink escapes inventory root');
    assert.ok(st.isSymbolicLink() || (st.isFile() && st.nlink === 1), 'nonregular dependency');
    return [{ path, sha256: sha(readFileSync(full)), ...(st.isSymbolicLink() ? { target: relative(root, real) } : {}) }];
  });
}

export function verifyBoundFiles(root, files) {
  assert.deepEqual(inputNames(root), files.map(f => f.path.slice(DIR.length + 1)).sort(), 'changed experiment input membership');
  for (const f of files) {
    assert.ok(f.path.startsWith(DIR + '/') && !f.path.split('/').includes('..'));
    const path = join(root, f.path), st = lstatSync(path);
    assert.ok(st.isFile() && st.nlink === 1 && realpathSync(path) === path, 'experiment input must be a regular single-link file');
    assert.equal(sha(readFileSync(path)), f.sha256, `changed experiment input ${f.path}`);
  }
}

export function verifyExperiment(root = ROOT) {
  const m = json(join(root, DIR, 'experiment-manifest.json'));
  verifyBoundFiles(root, m.inputs);
  const protocol = json(join(root, DIR, 'protocol.json'));
  assert.equal(m.version, 'codex-hillclimb-48-v3');
  assert.equal(protocol.version, m.version);
  assert.equal(sha(atV1(root, 'experiment-manifest.json')), V1_MANIFEST_SHA, 'immutable v1 manifest');
  const prior = JSON.parse(atV1(root, 'protocol.json'));
  const split = deriveV2Split(json(join(root, DIR, 'cases.metadata.json')), prior);
  assert.deepEqual(protocol.screen, split.screen, 'v2 screen must follow metadata rule');
  assert.deepEqual(protocol.holdout, split.holdout, 'v2 holdout must follow metadata rule');
  assert.deepEqual(protocol.pilot_ids, prior.pilot_ids, 'all pilot membership retained');
  assert.equal(protocol.split_revision.moved_cluster, split.moved_cluster);
  const review = json(join(root, DIR, 'review-provenance.json'));
  assert.equal(sha(readFileSync(join(root, DIR, 'exposure-review.md'))), review.exposure.public_sha256);
  assert.equal(sha(readFileSync(join(root, DIR, 'methods-review.md'))), review.methods.public_sha256);

  const v2 = JSON.parse(atV2(root, 'protocol.json'));
  for (const key of ['screen','holdout','repetitions','pilot_ids','exclusions','identity','limits','stages','analysis','split_revision'])
    assert.deepEqual(protocol[key], v2[key], `v3 must preserve v2 ${key}`);

  const v5path = join(root, 'docs/research/codex-hillclimb-46/preregistration-v5.json');
  assert.equal(sha(readFileSync(v5path)), m.calibration.preregistration_sha256, 'changed v5 preregistration');
  const v5 = json(v5path);
  verifySnapshot(root, PRIVATE_V5, v5); verifyEnvironment(v5.environment, root);
  assert.equal(sha(readFileSync(join(root, 'evals/review/calibration/protocol-v5.json'))), m.calibration.protocol_sha256);
  const env = json(join(root, DIR, 'environment-files.json'));
  for (const t of env.trees) assert.deepEqual(treeInventory(t.scope === 'repository' ? join(root, t.root) : t.root), t.files, `changed environment tree ${t.root}`);
  for (const f of env.files) assert.equal(sha(readFileSync(realpathSync(f.path))), f.sha256, `changed external tool ${f.path}`);
  const state = json(join(root, DIR, 'flow-state.template.json'));
  assert.equal(state.harness_sha, null, 'preparation must not contain native approval');
  assert.deepEqual(state.matt_plugin, env.matt_plugin, 'state/environment pin mismatch');
  assert.equal(protocol.environment_variables.CC_AGENTS_MATT_PLUGIN_DIR, env.matt_plugin.directory);
  selectMattPlugin(state, protocol.environment_variables);
  if (Object.hasOwn(process.env, 'CC_AGENTS_MATT_PLUGIN_DIR'))
    assert.equal(process.env.CC_AGENTS_MATT_PLUGIN_DIR, env.matt_plugin.directory, 'changed Matt pin env');
  assert.equal(process.env.TMPDIR ?? '/tmp', m.variables.TMPDIR, 'changed TMPDIR');
  for (const key of ['CODEX_BIN', 'CODEX_EVAL_HOME']) if (process.env[key]) assert.equal(process.env[key], m.variables[key], `changed ${key}`);
  return { manifest: m, protocol,
    current: { manifest_sha256: sha(readFileSync(join(root, DIR, 'experiment-manifest.json'))),
      protocol_sha256: sha(readFileSync(join(root, DIR, 'protocol.json'))) } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv[2], '--write-v3-preparation', 'explicit v3 preparation-only freezer flag required');
  assert.equal(sha(readFileSync(join(ROOT, DIR, 'experiment-manifest.json'))), sha(atV2(ROOT, 'experiment-manifest.json')),
    'only exact historical v2 manifest may advance; never overwrite v3');
  const protocol = json(join(ROOT, DIR, 'protocol.json'));
  const v5path = join(ROOT, 'docs/research/codex-hillclimb-46/preregistration-v5.json');
  const v5 = json(v5path);
  verifySnapshot(ROOT, PRIVATE_V5, v5); verifyEnvironment(v5.environment, ROOT);
  const state = json(join(ROOT, DIR, 'flow-state.template.json'));
  const manifest = { version: protocol.version, status: 'UNAPPROVED_PREPARATION', parent_commit: protocol.parent_commit,
    history: { v1_commit: V1_COMMIT, v2_commit: V2_COMMIT, v2_actual_commit: 'daa5f4bf581775c5214dc8228aedfbfdd5518136',
      v2_manifest_sha256: sha(atV2(ROOT, 'experiment-manifest.json')), outcomes_inherited: false, approvals_inherited: false },
    inputs: inputNames(ROOT).map(name => ({ path: `${DIR}/${name}`, sha256: sha(readFileSync(join(ROOT, DIR, name))) })),
    variables: protocol.environment_variables,
    expected_execution: Object.fromEntries(['baseline','v13'].map(variant => [variant, executionConfig(state,
      { agent: 'codex', model: 'gpt-6.1-sol', variant, concurrency: 1 })])),
    calibration: { version: 'astra-calibration-v5', private_root: PRIVATE_V5,
      required_run: '/home/ubuntu/cc-agents-artifacts/issue-48/correction-v3-calibration-v5-run',
      required_selection: 'PASS', required_grades: 75, expected_judge_requests: 138,
      protected_harness_sha256: v5.protected_harness.sha256, runtime_sha256: v5.runtime.sha256,
      protocol_sha256: v5.protocol_sha256, preregistration_sha256: sha(readFileSync(v5path)) },
    source_objects: [...protocol.screen, ...protocol.holdout].map(c => ({ id: c.id,
      base: execFileSync('git', ['rev-parse', `${c.base}^{commit}`], { cwd: ROOT, encoding: 'utf8' }).trim(),
      head: execFileSync('git', ['rev-parse', `${c.head}^{commit}`], { cwd: ROOT, encoding: 'utf8' }).trim() })),
    permission: 'None. New calibration-only and baseline-only approvals are distinct. Actual v5 PASS, review, exact human stage approval and fresh explicit native-first-flag delegation required before baseline auth/models. No inherited approval, results or conditional PASS.' };
  writeFileSync(join(ROOT, DIR, 'experiment-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify(verifyExperiment().current, null, 2));
}
