#!/usr/bin/env node
// Offline one-time construction from the immutable v2 EXPECTED member list.
// Extras in the installed tree are never copied. Installed bytes are read-only.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha } from './protocol.mjs';
import { selectMattPlugin, verifyMattTree } from '../../../evals/review/lib/matt-plugin.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const V2 = 'b1dc97f18d46f2a54c2b1cf0a79f7a2143339f60';
const executables = ['scripts/link-skills.sh', 'scripts/list-skills.sh', 'skills/misc/git-guardrails-claude-code/scripts/block-dangerous-git.sh'];

// git rev-parse outside a worktree exits nonzero; inspect it without treating
// that normal absence as an error or inspecting unrelated filesystem content.
import { spawnSync } from 'node:child_process';
export function createMattPin(parent) {
  parent = realpathSync(parent);
  assert.equal(parent, resolve(parent));
  assert.equal(lstatSync(parent).mode & 0o077, 0, 'private parent required');
  assert.notEqual(spawnSync('git', ['-C', parent, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' }).stdout.trim(), 'true', 'pin must be outside git');
  const prior = execFileSync('git', ['show', `${V2}:docs/research/codex-hillclimb-48/environment-files.json`], { cwd: ROOT });
  const expected = JSON.parse(prior).trees.find(t => t.root.endsWith('/mattpocock-skills/1.3.2'));
  assert.equal(expected.files.length, 176);
  const stage = mkdtempSync(join(parent, '.staging-')), plugin = join(stage, 'plugin'); mkdirSync(plugin, { mode: 0o700 });
  const dirs = new Set(['']);
  const files = expected.files.map(f => {
    assert.ok(f.path && !f.path.startsWith('/') && f.path.split('/').every(p => p && !['.','..','archive'].includes(p)), 'unsafe old member');
    const source = join(expected.root, f.path), st = lstatSync(source);
    const target = join(plugin, f.path);
    for (let d = dirname(f.path); d !== '.'; d = dirname(d)) dirs.add(d);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    // Refuse symlink directory components in the source as well as the leaf.
    assert.equal(realpathSync(dirname(source)), dirname(source));
    if (f.target) {
      assert.equal(f.path, 'AGENTS.md'); assert.ok(st.isSymbolicLink());
      assert.equal(readlinkSync(source), 'CLAUDE.md'); assert.equal(f.target, 'CLAUDE.md');
      assert.equal(realpathSync(source), join(expected.root, 'CLAUDE.md'));
      assert.equal(sha(readFileSync(source)), f.sha256, `changed original member ${f.path}`);
      symlinkSync('CLAUDE.md', target);
      return { path: f.path, kind: 'symlink', target: 'CLAUDE.md', resolved_target: 'CLAUDE.md', sha256: f.sha256 };
    }
    assert.ok(st.isFile() && st.nlink === 1, 'source must be a regular single-link file');
    const executable = executables.includes(f.path);
    assert.equal(st.mode & 0o7777, executable ? 0o775 : 0o664, `changed original mode ${f.path}`);
    assert.equal(sha(readFileSync(source)), f.sha256, `changed original member ${f.path}`);
    copyFileSync(source, target); chmodSync(target, executable ? 0o500 : 0o400);
    return { path: f.path, kind: 'file', mode: executable ? 0o500 : 0o400, sha256: f.sha256 };
  }).sort((a,b) => a.path.localeCompare(b.path));
  assert.equal(files.filter(f => f.kind === 'file').length, 175);
  assert.equal(files.filter(f => f.mode === 0o500).length, 3);
  const directories = [...dirs].sort().map(path => ({ path, mode: 0o500 }));
  for (const d of [...directories].sort((a,b) => b.path.length - a.path.length)) chmodSync(join(plugin, d.path), d.mode);
  const manifest = { version: 'cc-agents-matt-pin-v1', policy: 'sealed-relative-links-v1',
    source: { commit: V2, inventory_path: 'docs/research/codex-hillclimb-48/environment-files.json', inventory_sha256: sha(prior),
      expected_members: 176, construction: 'Only original expected members; bytes/types/relative link/executable modes checked; cache extras are not inputs to this new snapshot.' },
    files, directories };
  verifyMattTree(plugin, manifest);
  const bytes = JSON.stringify(manifest, null, 2) + '\n', digest = sha(bytes), destination = join(parent, digest);
  assert.ok(!existsSync(destination), 'content address already exists; verify and reuse explicitly, never overwrite');
  writeFileSync(join(stage, 'manifest.json'), bytes, { flag: 'wx', mode: 0o400 });
  renameSync(stage, destination);
  const pin = { directory: join(destination, 'plugin'), manifest_path: join(destination, 'manifest.json'), manifest_sha256: digest };
  selectMattPlugin({ matt_plugin: pin }, { CC_AGENTS_MATT_PLUGIN_DIR: pin.directory });
  return pin;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 3, 'usage: pin-matt.mjs PRIVATE_EXISTING_PARENT');
  console.log(JSON.stringify(createMattPin(process.argv[2]), null, 2));
}
