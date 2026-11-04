import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, lstatSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareCodex, codexBwrap } from '../evals/review/lib/codex.mjs';
/** @param {string|Buffer} b */
const sha = b => createHash('sha256').update(b).digest('hex');
const runner = fileURLToPath(new URL('../evals/review/run.mjs', import.meta.url));

/** @param {string} root */
function fixture(root) {
  const pin = join(root, 'pin'); mkdirSync(join(pin, 'skills/demo'), { recursive: true });
  for (const [path, text, mode] of /** @type {[string,string,number][]} */ ([['CLAUDE.md', 'instructions', 0o400], ['skills/demo/SKILL.md', 'frozen skill', 0o400], ['skills/demo/run.sh', '#!/bin/sh\ntrue\n', 0o500]])) {
    writeFileSync(join(pin, path), text); chmodSync(join(pin, path), mode);
  }
  symlinkSync('CLAUDE.md', join(pin, 'AGENTS.md'));
  const files = ['AGENTS.md', 'CLAUDE.md', 'skills/demo/SKILL.md', 'skills/demo/run.sh'].map(path => path === 'AGENTS.md'
    ? { path, kind: 'symlink', target: 'CLAUDE.md', resolved_target: 'CLAUDE.md', sha256: sha('instructions') }
    : { path, kind: 'file', mode: path.endsWith('.sh') ? 0o500 : 0o400, sha256: sha(readFileSync(join(pin, path))) });
  const directories = ['', 'skills', 'skills/demo'].map(path => ({ path, mode: 0o500 }));
  for (const d of [...directories].reverse()) chmodSync(join(pin, d.path), d.mode);
  const manifest = join(root, 'manifest.json');
  writeFileSync(manifest, JSON.stringify({ version: 'cc-agents-matt-pin-v1', policy: 'sealed-relative-links-v1', files, directories }));
  return { directory: pin, manifest_path: manifest, manifest_sha256: sha(readFileSync(manifest)) };
}
/** @param {string} root */
function cleanup(root) {
  if (!existsSync(root) || !lstatSync(root).isDirectory()) return;
  chmodSync(root, 0o700);
  for (const name of readdirSync(root)) if (lstatSync(join(root, name)).isDirectory()) cleanup(join(root, name));
}
/** @param {string} root */
function editable(root) { for (const d of ['', 'skills', 'skills/demo']) chmodSync(join(root, d), 0o700); }

// Dynamic import keeps the first run red until the production helper exists.
test('bound pin survives mutable installed-cache changes and is copied with relative links at native config seam', async () => {
  const { selectMattPlugin, copyMattPlugin } = await import('../evals/review/lib/matt-plugin.mjs');
  const root = mkdtempSync(join(tmpdir(), 'matt-pin-'));
  try {
    const pin = fixture(root), env = { CC_AGENTS_MATT_PLUGIN_DIR: pin.directory };
    const cache = join(root, 'cache/1.3.2'); mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, 'skill'), 'mutable source');
    const selected = selectMattPlugin({ matt_plugin: pin }, env);
    writeFileSync(join(cache, 'skill'), 'changed source'); mkdirSync(join(cache, '.in_use')); writeFileSync(join(cache, '.in_use/123'), 'lease');
    mkdirSync(join(root, 'cache/9.0.0')); rmSync(join(root, 'cache'), { recursive: true });
    const copy = join(root, 'copy'); copyMattPlugin(selected, copy);
    assert.equal(readlinkSync(join(copy, 'AGENTS.md')), 'CLAUDE.md');
    assert.equal(readFileSync(join(copy, 'skills/demo/SKILL.md'), 'utf8'), 'frozen skill');
    const auth = join(root, 'auth'); mkdirSync(auth); writeFileSync(join(auth, 'auth.json'), '{"synthetic":true}');
    mkdirSync(join(root, 'replay'));
    const runtime = prepareCodex({ dir: join(root, 'replay'), home: join(root, 'home'), tmp: join(root, 'tmp'), auth: { home: auth, auth: join(auth, 'auth.json') }, pluginDirs: [copy] });
    assert.equal(readFileSync(join(runtime.home, '.agents/skills/plugin-0/demo/SKILL.md'), 'utf8'), 'frozen skill');
    assert.ok(codexBwrap({ ...runtime, bin: '/bin/true', pluginDirs: [copy], args: [], env: {} }).includes(copy));
    assert.throws(() => selectMattPlugin({ matt_plugin: pin }, {}), /Matt pin/);
    assert.throws(() => selectMattPlugin({ matt_plugin: pin }, { CC_AGENTS_MATT_PLUGIN_DIR: '' }), /Matt pin/);
    assert.throws(() => selectMattPlugin({}, env), /Matt pin/);
    assert.equal(selectMattPlugin({}, {}), null); // unchanged legacy selection
  } finally { cleanup(root); rmSync(root, { recursive: true, force: true }); }
});

test('native preflight rejects pin drift before auth; exact pin reaches the existing no-token stop', async () => {
  const root = mkdtempSync(join(tmpdir(), 'matt-runner-pin-'));
  try {
    let pin = fixture(root); mkdirSync(join(root, 'flow')); mkdirSync(join(root, 'home'));
    // With no harness_paths the runner binds its own relative filename and bytes.
    const { relative } = await import('node:path');
    const harness_sha = createHash('sha256').update(relative(root, runner)).update('\0').update(readFileSync(runner)).update('\0').digest('hex');
    writeFileSync(join(root, 'flow/_state.json'), JSON.stringify({ agent: 'codex', model: 'gpt-6.1-sol', effort: 'high', service_tier: 'fast',
      model_verification: 'configured_only', harness_sha, matt_plugin: pin }));
    const run = () => spawnSync(process.execPath, [runner, '--flow', 'flow', '--agent', 'codex', '--model', 'gpt-6.1-sol', '--variant', 'baseline', '--concurrency', '1', '--dry-run'],
      { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: join(root, 'home'), CC_AGENTS_MATT_PLUGIN_DIR: pin.directory } });
    assert.match(run().stderr, /gh-token/);
    for (const mutate of [
      () => writeFileSync(join(pin.directory, '.extra'), 'lease'),
      () => rmSync(join(pin.directory, 'CLAUDE.md')),
      () => { chmodSync(join(pin.directory, 'CLAUDE.md'), 0o600); writeFileSync(join(pin.directory, 'CLAUDE.md'), 'changed'); },
      () => { rmSync(join(pin.directory, 'AGENTS.md')); symlinkSync('../../escape', join(pin.directory, 'AGENTS.md')); },
      () => { rmSync(join(pin.directory, 'CLAUDE.md')); linkSync(join(pin.directory, 'skills/demo/SKILL.md'), join(pin.directory, 'CLAUDE.md')); },
      () => chmodSync(join(pin.directory, 'CLAUDE.md'), 0o777),
    ]) {
      chmodSync(pin.directory, 0o700); mutate(); chmodSync(pin.directory, 0o500);
      const r = run(); assert.match(r.stderr, /Matt pin/); assert.doesNotMatch(r.stderr, /gh-token/);
      cleanup(pin.directory); rmSync(pin.directory, { recursive: true });
      pin = fixture(root);
    }
    assert.equal(existsSync(join(root, 'home/.codex')), false);
  } finally { cleanup(root); rmSync(root, { recursive: true, force: true }); }
});

test('pin identity refuses unbound paths/manifests, root indirection and unsafe member kinds', async () => {
  const { selectMattPlugin } = await import('../evals/review/lib/matt-plugin.mjs');
  const root = mkdtempSync(join(tmpdir(), 'matt-policy-'));
  try {
    const pin = fixture(root), env = { CC_AGENTS_MATT_PLUGIN_DIR: pin.directory };
    for (const changed of [{ ...pin, manifest_sha256: '0'.repeat(64) }, { ...pin, directory: '' }, { ...pin, manifest_path: join(pin.directory, 'CLAUDE.md') }])
      assert.throws(() => selectMattPlugin({ matt_plugin: changed }, env), /Matt pin/);
    symlinkSync(pin.directory, join(root, 'alias'));
    assert.throws(() => selectMattPlugin({ matt_plugin: { ...pin, directory: join(root, 'alias') } }, { CC_AGENTS_MATT_PLUGIN_DIR: join(root, 'alias') }), /Matt pin/);
    chmodSync(pin.directory, 0o700);
    mkdirSync(join(pin.directory, '.in_use')); writeFileSync(join(pin.directory, '.in_use/456'), 'new pinned member'); chmodSync(pin.directory, 0o500);
    assert.throws(() => selectMattPlugin({ matt_plugin: pin }, env), /Matt pin/);
  } finally { cleanup(root); rmSync(root, { recursive: true, force: true }); }
});
