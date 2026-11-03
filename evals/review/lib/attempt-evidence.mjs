// Restricted evidence retention at the runner/grader boundary, before cleanup.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** @param {string} path @param {any} value */
function write(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
/** @param {any} e */
export function failureEvidence(e) {
  return { message: String(e?.message ?? e), failure_class: e?.failure_class ?? 'error',
    model: e?.model, requested_model: e?.requested_model, usage: e?.usage, raw_usage: e?.raw_usage,
    judge_model: e?.judge_model, judge_requested_model: e?.judge_requested_model, judge_usage: e?.judge_usage,
    events: e?.events, audit: e?.audit, transcript: e?.transcript, judge_calls: e?.judge_calls };
}
/** @param {string} source @param {string} dest */
function copyEvidence(source, dest) {
  const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    assert.ok(st.isFile() && st.nlink === 1, 'evidence must be a regular single-link file');
    writeFileSync(dest, readFileSync(fd), { flag: 'wx', mode: 0o600 });
  } finally { closeSync(fd); }
}
/** Only session evidence, never auth, environment, personal config or policy.
 * @param {string} home @param {string} dest */
export function retainCalls(home, dest) {
  const control = join(home, 'eval-control');
  if (!existsSync(control)) return;
  assert.ok(lstatSync(control).isDirectory(), 'call control cannot be a symlink');
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  for (const call of readdirSync(control).filter(name => /^[a-z0-9-]+-\d+$/.test(name))) {
    assert.ok(lstatSync(join(control, call)).isDirectory(), 'call directory cannot be a symlink');
    const target = join(dest, call); mkdirSync(target, { mode: 0o700 });
    for (const name of ['request.json', 'prompt.txt', 'schema.json', 'events.jsonl', 'hooks.jsonl', 'stderr.txt', 'final.txt']) {
      const source = join(control, call, name);
      if (existsSync(source)) copyEvidence(source, join(target, name));
    }
  }
}
/** @param {string} root @param {string} [prefix] @returns {{path:string,sha256:string}[]} */
function inventory(root, prefix = '') {
  return readdirSync(join(root, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(e => {
    const path = join(prefix, e.name);
    return e.isDirectory() ? inventory(root, path) : [{ path, sha256: createHash('sha256').update(readFileSync(join(root, path))).digest('hex') }];
  });
}
/** Retain every separate attempt, including failures followed by successful retries.
 * Callers supply model execution (or a fake) and cleanup; no scoring occurs here.
 * @param {{root:string,label:string,request:any,execute:()=>Promise<any>,homes?:string[],cleanup?:()=>any}} o */
export async function retainAttempt({ root, label, request, execute, homes = [], cleanup }) {
  assert.equal(realpathSync(root), resolve(root), 'evidence root must not contain symlinks');
  assert.match(label, /^[a-z-]+$/);
  const attempt = mkdtempSync(join(root, `${label}-`));
  write(join(attempt, 'request.json'), request);
  try {
    const result = await execute();
    write(join(attempt, 'result.json'), result);
    return result;
  } catch (error) {
    write(join(attempt, 'failure.json'), failureEvidence(error));
    if (error && typeof error === 'object') Object.assign(error, { evidence_path: attempt });
    throw error;
  } finally {
    try {
      for (const [i, home] of homes.entries()) retainCalls(home, join(attempt, 'calls', String(i)));
      write(join(attempt, 'index.json'), { files: inventory(attempt) });
    } catch (error) {
      // Retention must finish before deleting originals. Remove copied auth if
      // retention fails, but leave all original call evidence for recovery.
      for (const home of homes) rmSync(join(home, '.codex/auth.json'), { force: true });
      throw error;
    }
    await cleanup?.();
  }
}
