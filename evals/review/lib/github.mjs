// GitHub REST calls for the eval, made with the eval org's token only.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const TOKEN_PATH = join(homedir(), '.config/trace-eval/gh-token');

export function readToken() {
  return readFileSync(TOKEN_PATH, 'utf8').trim();
}

export function client(token) {
  async function call(method, path, body, { ok = [200, 201, 204] } = {}) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`https://api.github.com${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      // Secondary rate limits answer 403/429 with retry-after; repo creation hits them under load.
      const limited = res.status === 429
        || (res.status === 403 && (res.headers.get('retry-after') || res.headers.get('x-ratelimit-remaining') === '0'));
      if (limited && attempt < 5) {
        const wait = Number(res.headers.get('retry-after')) * 1000 || Math.min(60_000, 2000 * 2 ** attempt);
        await new Promise(r => setTimeout(r, wait * (0.5 + Math.random())));
        continue;
      }
      const text = await res.text();
      if (!ok.includes(res.status)) {
        const e = new Error(`GitHub ${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
        // @ts-ignore
        e.status = res.status;
        throw e;
      }
      return text ? JSON.parse(text) : null;
    }
  }
  async function all(path) {
    const out = [];
    for (let page = 1; ; page++) {
      const sep = path.includes('?') ? '&' : '?';
      const batch = await call('GET', `${path}${sep}per_page=100&page=${page}`);
      out.push(...batch);
      if (batch.length < 100) return out;
    }
  }
  return { call, all };
}

// The agent's credential must reach the eval org and nothing else. A write probe
// on the source repository has to fail, or the run refuses to start. The probe
// has no title, so a token that can write gets 422 and nothing is created.
export async function assertScoped(gh, org, sourceRepo) {
  await gh.call('GET', `/orgs/${org}`);
  try {
    await gh.call('POST', `/repos/${sourceRepo}/issues`, {}, { ok: [] });
  } catch (e) {
    if (e.status === 403 || e.status === 404) return;
    if (e.status === 422) throw new Error(`the eval token can write to ${sourceRepo}; give it the eval org only`);
    throw new Error(`token scope probe on ${sourceRepo} failed oddly: ${e.message}`);
  }
  throw new Error(`the eval token can write to ${sourceRepo}; give it the eval org only`);
}
