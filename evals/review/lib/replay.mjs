// Replays one case as a real pull request in a fresh private repository in the
// eval org: one squashed commit for the base, one for the change, an issue that
// states what to build, and a PR that closes it. Nothing from the source
// repository's history, comments or PR bodies is carried over, since those name
// the bugs.

import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const AUTHOR = {
  GIT_AUTHOR_NAME: 'eval', GIT_AUTHOR_EMAIL: 'eval@example.invalid',
  GIT_COMMITTER_NAME: 'eval', GIT_COMMITTER_EMAIL: 'eval@example.invalid',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};

// Pushes authenticate through an inline helper reading the env, so the token
// never sits in argv or in the clone's config.
const CRED = ['-c', 'credential.helper=', '-c',
  'credential.helper=!f() { echo username=x-access-token; echo "password=$EVAL_GH_TOKEN"; }; f'];

function run(cmd, args, { cwd, env, input } = {}) {
  const r = spawnSync(cmd, args, {
    cwd, input, env: { ...process.env, ...env }, encoding: input instanceof Buffer ? undefined : 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    const e = new Error(`${cmd} ${args.filter(a => !a.startsWith('credential')).join(' ')} failed (${r.status}): ${String(r.stderr).slice(0, 500)}`);
    // @ts-ignore
    e.failure_class = 'harness';
    throw e;
  }
  return r.stdout;
}

export function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60).replace(/-$/, '');
}

// Lays the tree at `sha` into `dir`, minus the human-only archive (ADR 0008).
function extract(sourceRoot, sha, dir) {
  const tar = spawnSync('git', ['archive', '--format=tar', sha, '--', '.', ':(exclude)archive'],
    { cwd: sourceRoot, maxBuffer: 512 * 1024 * 1024 });
  if (tar.status !== 0) throw new Error(`git archive ${sha}: ${tar.stderr}`);
  run('tar', ['-x', '-C', dir], { input: tar.stdout });
}

// The source repository's slug points at its public issues, which hold the
// answers; every copy names the replay repository instead.
function rewriteSlugs(dir, from, to) {
  const walk = d => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      if (ent.name === '.git' || ent.name === 'node_modules') continue;
      const p = join(d, ent.name);
      if (ent.isDirectory()) { walk(p); continue; }
      if (!ent.isFile()) continue;
      const buf = readFileSync(p);
      if (buf.includes(0)) continue;
      const text = buf.toString('utf8');
      if (!text.includes(from.owner)) continue;
      writeFileSync(p, text.replaceAll(`${from.owner}/${from.repo}`, to).replaceAll(from.owner, to.split('/')[0]));
    }
  };
  walk(dir);
}

// A variant's repository files (a REVIEW.md, lines for CLAUDE.md, a workflow
// script) go into both trees, so they are part of the repository the PR is
// made against and never part of its diff.
export function overlayRepo(dir, overlay) {
  if (overlay?.replace && existsSync(overlay.replace)) cpSync(overlay.replace, dir, { recursive: true });
  if (!overlay?.append || !existsSync(overlay.append)) return;
  const walk = d => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, ent.name);
      if (ent.isDirectory()) { walk(p); continue; }
      const to = join(dir, relative(overlay.append, p));
      mkdirSync(dirname(to), { recursive: true });
      const before = existsSync(to) ? readFileSync(to, 'utf8') : '';
      appendFileSync(to, `${before && !before.endsWith('\n') ? '\n' : ''}${before ? '\n' : ''}${readFileSync(p, 'utf8')}`);
    }
  };
  walk(overlay.append);
}

function layTree(sourceRoot, sha, dir, source, slug, overlay) {
  extract(sourceRoot, sha, dir);
  rewriteSlugs(dir, source, slug);
  overlayRepo(dir, overlay);
  // The plugin under test acts only in traced repositories.
  mkdirSync(join(dir, '.claude'), { recursive: true });
  if (!existsSync(join(dir, '.claude/trace.json'))) writeFileSync(join(dir, '.claude/trace.json'), '{}\n');
}

/**
 * @param {{gh: any, token: string, org: string, source: {owner: string, repo: string, root: string},
 *   c: any, issue: {title: string, body: string}, work: string, name: string,
 *   overlay?: {replace?: string, append?: string}}} o
 */
export async function buildReplay({ gh, token, org, source, c, issue, work, name, overlay }) {
  const slug = `${org}/${name}`;
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  const env = { ...AUTHOR, EVAL_GH_TOKEN: token };
  const remote = `https://github.com/${slug}.git`;

  await gh.call('POST', `/orgs/${org}/repos`, { name, private: true, has_wiki: false, has_projects: false });
  const replay = { slug, dir, name };
  try {
    run('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    layTree(source.root, c.base, dir, source, slug, overlay);
    run('git', ['add', '-A'], { cwd: dir });
    run('git', ['commit', '-q', '-m', 'Initial state'], { cwd: dir, env });
    run('git', ['remote', 'add', 'origin', remote], { cwd: dir });
    run('git', [...CRED, 'push', '-q', '-u', 'origin', 'main'], { cwd: dir, env });

    const iss = await gh.call('POST', `/repos/${slug}/issues`, { title: issue.title, body: issue.body });
    const branch = `${iss.number}-${slugify(issue.title)}`;
    run('git', ['checkout', '-q', '-b', branch], { cwd: dir });
    run('git', ['rm', '-r', '-q', '-f', '.'], { cwd: dir });
    layTree(source.root, c.head, dir, source, slug, overlay);
    run('git', ['add', '-A'], { cwd: dir });
    run('git', ['commit', '-q', '--allow-empty', '-m', `${c.title} (#${iss.number})`], { cwd: dir, env });
    run('git', [...CRED, 'push', '-q', '-u', 'origin', branch], { cwd: dir, env });
    const pr = await gh.call('POST', `/repos/${slug}/pulls`,
      { title: c.title, head: branch, base: 'main', body: `Closes #${iss.number}` });

    Object.assign(replay, {
      issue: iss.number, pr: pr.number, branch,
      baseSha: run('git', ['rev-parse', 'main'], { cwd: dir }).trim(),
      headSha: run('git', ['rev-parse', 'HEAD'], { cwd: dir }).trim(),
    });
    if (existsSync(join(dir, 'package-lock.json')))
      run('npm', ['ci', '--no-audit', '--no-fund', '--ignore-scripts', '--loglevel=error'], { cwd: dir });
    return replay;
  } catch (e) {
    // @ts-ignore
    e.replay = replay;
    throw e;
  }
}

export async function deleteReplay(gh, replay) {
  await gh.call('DELETE', `/repos/${replay.slug}`, undefined, { ok: [204, 404] });
}

export { run };
