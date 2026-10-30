// Every model call in the eval goes through `claude -p` on the human's
// subscription, authenticated by a long-lived token from `claude setup-token`.

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const OAUTH_PATH = join(homedir(), '.config/trace-eval/oauth-token');

export function readOAuth() {
  return readFileSync(OAUTH_PATH, 'utf8').trim();
}

// Only what a run needs: no credential of the human's leaks in.
export function baseEnv(home, oauth) {
  const tmp = join(home, 'tmp');
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(tmp, { recursive: true });
  return {
    PATH: process.env.PATH ?? '', LANG: process.env.LANG ?? 'en_US.UTF-8', TERM: 'dumb',
    HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), TMPDIR: tmp,
    CLAUDE_CODE_OAUTH_TOKEN: oauth,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
  };
}

/**
 * Spawns `claude` and collects its stdout. Kills it after `limitS` seconds.
 * @param {{args: string[], cwd: string, env: Record<string, string>, input?: string, limitS: number,
 *   onLine?: (line: string) => void}} o
 */
export function claude({ args, cwd, env, input, limitS, onLine }) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd, env, stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let out = '', buf = '', stderr = '', timedOut = false;
    child.stdout.on('data', d => {
      if (!onLine) { out += d; return; }
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-20_000); });
    if (input != null) child.stdin?.end(input);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 15_000).unref();
    }, limitS * 1000);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (onLine && buf.trim()) onLine(buf);
      resolve({ out, code, stderr, timedOut });
    });
  });
}
