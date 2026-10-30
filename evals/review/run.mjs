#!/usr/bin/env node
// The Review-step eval (#39): replays each case from evals/review/data as a real
// pull request in a fresh private repository in the eval org, runs the trace
// plugin variant's Review step on it with `claude -p`, and grades what the
// review found against the bugs this repository actually shipped.
//
//   node evals/review/run.mjs --flow .claude/hillclimb/review-opus --variant baseline \
//     --model claude-opus-5-5 --reps 1 --cases pr24,clean-pr28
//
// Built on the build-eval runner scaffold, which supplies:
//   - parameterized by --variant / --model / --reps (no hardcoded A/B pair)
//   - rep-aware filenames + resume (traces/<id>_rep<k>.json)
//   - reads _state.json, never writes it, except --approve-harness recording `harness_sha`
//   - refuses to run when the harness (this file + _state.json.harness_paths) has
//     changed since the sha a human last approved with --approve-harness
//   - writes rows as cases complete (crash-safe)
//   - jittered exponential backoff on transient 429/overloaded/5xx errors
//   - hard per-case wall-clock ceiling (--timeout-s)
//   - served-model assertion (response model must match --model)
//   - failed attempts land in errors.jsonl with a failure class and, when the call
//     completed, the billed model/usage (never in results.jsonl)

import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import * as GH from './lib/github.mjs';
import { buildReplay, deleteReplay, run as sh } from './lib/replay.mjs';
import { runAgent } from './lib/agent.mjs';
import { clip, digest } from './lib/transcript.mjs';
import { grade } from './lib/grade.mjs';
import { apiUsage, costOf } from './lib/prices.mjs';
import { readOAuth } from './lib/cli.mjs';
import { createHash } from 'node:crypto';
import { closeSync, constants as FS, existsSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Every output write refuses symlinks: the flow dir is model-influenced, and a
// prompt-injected round can plant `results.jsonl -> ~/.bashrc` where the next
// unattended run would append. POSIX opens O_NOFOLLOW (a symlink fails with
// ELOOP); Windows - where Node leaves O_NOFOLLOW undefined and Bun defines a
// meaningless value - lstat-refuses first. Symlinked parent dirs are
// refused the same way. Same discipline as the report builders' reads.
const WIN = process.platform === 'win32';
const NOFOLLOW = WIN ? 0 : FS.O_NOFOLLOW;
// A guard that cannot tell must refuse: only "no such entry" reads as absent;
// any other lstat failure (EACCES, ENAMETOOLONG, ...) is rethrown, never "no".
const lstatOrNull = p => { try { return lstatSync(p); } catch (e) { if (e?.code === 'ENOENT') return null; throw e; } };
const isSymlink = p => lstatOrNull(p)?.isSymbolicLink() === true;
// Stderr lines interpolate model-influenced bytes (case ids, error text that
// can echo model output, JSON.parse messages). Strip escape sequences and
// control characters, as build-report-lite.mjs's eprint does, so a planted
// OSC/CSI can't retitle the terminal or forge output lines.
const ESC_SEQ = /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]/g;
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g;
const termSafe = s => String(s).replace(ESC_SEQ, '').replace(CONTROL, '');
const eprint = (...a) => console.error(...a.map(termSafe));
// The leaf checks above can't see a symlink on an INTERMEDIATE component
// (lstat and open both resolve those silently), so every open is also bound
// to the flow root: main() captures realpathSync(flow) once, and any path
// whose resolved parent leaves it - e.g. `vdir` or the flow dir itself
// replaced by a directory symlink - is refused when the check sees it.
// Residual, all platforms: the check and the open are separate path lookups
// (Node's sync fs has no openat-style call), so a directory swapped for a
// symlink in between is still followed. This stops a planted link, not a
// writer racing the run.
let flowRealRoot = null;
function assertInFlow(dir, what) {
  if (flowRealRoot == null) throw new Error(`refusing to ${what}: flow root not resolved yet`);
  const dirReal = realpathSync(dir);
  if (dirReal !== flowRealRoot && !dirReal.startsWith(flowRealRoot + (WIN ? '\\' : '/')))
    throw new Error(`refusing to ${what}: ${dir} resolves outside the flow directory`);
}
function openNoFollow(p, flags) {
  if (isSymlink(dirname(p))) throw new Error(`refusing to open through symlinked directory: ${dirname(p)}`);
  assertInFlow(dirname(p), 'open');
  if (WIN && isSymlink(p)) throw new Error(`refusing to open through symlink: ${p}`);
  const fd = openSync(p, flags | NOFOLLOW, 0o644);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`refusing to use non-regular file: ${p}`);
    // O_NOFOLLOW and lstat cannot see a hard link: a second name for a file
    // outside the flow dir opens as an ordinary regular file. Nothing the
    // runner creates has more than one link, so refuse any that does.
    if (st.nlink > 1) throw new Error(`refusing to use ${p}: it has a second hard link (another name for the same file); replace it with a plain copy if it is yours`);
  } catch (e) { closeSync(fd); throw e; }
  return fd;
}
// writeFileSync on the fd loops until every byte lands (a bare writeSync is
// one write(2) that may return short on ENOSPC and silently truncate a
// results row or trace).
// Opened without O_TRUNC and truncated only after openNoFollow's checks, so a
// refused file keeps its bytes.
function writeFileNoFollow(p, data) {
  const fd = openNoFollow(p, FS.O_WRONLY | FS.O_CREAT);
  try { ftruncateSync(fd, 0); writeFileSync(fd, data); } finally { closeSync(fd); }
}
// POSIX appends atomically under O_APPEND with no position. On Windows, Bun
// writes an O_APPEND handle at offset 0 unless given a position, so there the
// write starts at the current size and re-issues any short write.
function appendFileNoFollow(p, data) {
  const fd = openNoFollow(p, FS.O_WRONLY | FS.O_CREAT | FS.O_APPEND);
  try {
    if (!WIN) { writeFileSync(fd, data); return; }
    const buf = Buffer.from(data);
    const start = fstatSync(fd).size;
    for (let off = 0; off < buf.length;) {
      const n = writeSync(fd, buf, off, buf.length - off, start + off);
      if (n <= 0) throw new Error(`append to ${p} made no progress`);
      off += n;
    }
  } finally { closeSync(fd); }
}
// Reads of the frozen pairwise refs get the same discipline as writes (same
// open guard): the flow dir is model-influenced, so `baseline/ref/<id> ->
// ~/.ssh/id_rsa` planted after the startup preflight must not be read into
// the judge prompt. lexists probes with lstat so a planted symlink still
// counts as "present" at the freeze guard (never overwritten - or followed).
const lexists = p => lstatOrNull(p) != null;
function readFileNoFollow(p) {
  const fd = openNoFollow(p, FS.O_RDONLY);
  try { return readFileSync(fd, 'utf8'); } finally { closeSync(fd); }
}
// null when the file is absent; any other failure (a planted link included) throws.
function readIfPresent(p) {
  try { return readFileNoFollow(p); } catch (e) { if (e?.code === 'ENOENT') return null; throw e; }
}
function mkdirNoFollow(dir) {
  if (isSymlink(dir)) throw new Error(`refusing to use symlinked directory: ${dir}`);
  mkdirSync(dir, { recursive: true });
  // Check after creating: mkdirSync(recursive) follows symlinked ancestors,
  // so a dir minted through one resolves outside the flow root and is refused
  // here before any file lands in it.
  assertInFlow(dir, 'create directory');
}
// Frozen pairwise refs may carry an extension; reader and freeze-guard probe
// the same list so a suffixed ref never gets an extensionless shadow.
const REF_EXTS = ['', '.html', '.txt', '.json'];

// --- the eval ----------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const DATA = join(HERE, 'data');
const ORG = 'trace-eval-rocky';
const SOURCE = { owner: 'lolisaigao1234', repo: 'cc-agents', root: REPO_ROOT };
const MATT_CACHE = join(homedir(), '.claude/plugins/cache/mattpocock/mattpocock-skills');

/** Shared for the whole run; filled by setup(). @type {any} */
const R = {};

const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const fail = (cls, msg, extra = {}) => Object.assign(new Error(msg), { failure_class: cls, ...extra });

async function setup(ctx) {
  R.token = GH.readToken();
  R.gh = GH.client(R.token);
  await GH.assertScoped(R.gh, ORG, `${SOURCE.owner}/${SOURCE.repo}`);
  try { R.oauth = readOAuth(); }
  catch { throw new Error('no subscription token: run `claude setup-token` and save it to ~/.config/trace-eval/oauth-token'); }

  R.work = mkdtempSync(join(tmpdir(), `review-eval-${ctx.variant}-`));
  // The plugin under test is this checkout's trace plugin, with the variant's
  // files laid over it. Matt's skills come from the installed copy.
  const trace = join(R.work, 'plugins/trace');
  cpSync(join(REPO_ROOT, 'plugins/trace'), trace, { recursive: true });
  const overlay = join(HERE, 'variants', ctx.variant, 'plugin');
  if (existsSync(overlay)) cpSync(overlay, trace, { recursive: true });
  const mattVersion = readdirSync(MATT_CACHE).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
  const matt = join(R.work, 'plugins/mattpocock-skills');
  cpSync(join(MATT_CACHE, String(mattVersion)), matt, { recursive: true });
  R.pluginDirs = [trace, matt];
  R.variant = JSON.parse(readIfPresentAbs(join(HERE, 'variants', ctx.variant, 'variant.json')) ?? '{}');

  // Paths whose content gives the answers away: this checkout (and its git
  // history), the installed plugins, the eval's credentials and the plugin copy.
  const answerKeys = [REPO_ROOT, join(homedir(), '.claude'), join(homedir(), '.config/trace-eval'), trace];
  R.denyReadTool = answerKeys;
  R.denyRead = [...answerKeys, R.work];
  R.matt = matt;
  R.leak = new RegExp([SOURCE.owner, ...answerKeys].map(escape).join('|'));
  R.bugs = new Map(JSON.parse(readFileSync(join(DATA, 'bugs.json'), 'utf8')).map(b => [b.id, b]));
  eprint(`[setup] eval org ${ORG} reachable, source repo not writable; matt skills ${mattVersion}; work ${R.work}`);
}

function readIfPresentAbs(p) {
  try { return readFileSync(p, 'utf8'); } catch (e) { if (e?.code === 'ENOENT') return null; throw e; }
}

async function loadCases() {
  let cases = JSON.parse(readFileSync(join(DATA, 'cases.json'), 'utf8'));
  // A whole-tree sweep is a different task; only the sweep arm runs it.
  cases = cases.filter(c => c.mode !== 'sweep' || R.variant.sweep);
  if (parsedArgs.kinds) cases = cases.filter(c => parsedArgs.kinds.includes(c.kind));
  if (parsedArgs.cases) {
    const unknown = parsedArgs.cases.filter(id => !cases.some(c => c.id === id));
    if (unknown.length) throw new Error(`unknown case ids: ${unknown.join(', ')}`);
    cases = cases.filter(c => parsedArgs.cases.includes(c.id));
  }
  return cases.map(c => ({
    ...c,
    prompt: `${c.title} (${c.base}..${c.head}, ${c.diff_size})`,
    tags: [c.kind, c.bug_ids.length ? `${c.bug_ids.length} bugs` : 'no bugs', ...(c.issue ? [`issue #${c.issue}`] : [])],
    meta: { base: c.base, head: c.head, bug_ids: c.bug_ids },
  }));
}

function issueFor(c) {
  const text = c.issue != null ? readIfPresentAbs(join(DATA, 'issues', `${c.issue}.md`)) : null;
  if (!text) return { title: c.title, body: `${c.title}.\n\n## Acceptance criteria\n\n- [ ] The change does what its title says, with no regressions.` };
  const [first, ...rest] = text.split('\n');
  return { title: first.replace(/^#\s*/, ''), body: rest.join('\n').trim() };
}

function promptFor(replay) {
  const base = `You are working in ${replay.slug}, a traced repository. You are on branch \`${replay.branch}\` for issue #${replay.issue}, and its pull request #${replay.pr} is open with the implementation. The Implement step is done.

Carry the change through the trace's Review and Update steps until the pull request is ready for the human to review. No human will answer during this session: where the trace says to ask the human, say so in your final message and stop.`;
  return R.variant.prompt ? `${base}\n\n${R.variant.prompt}` : base;
}

function testsPass(dir) {
  const pkg = readIfPresentAbs(join(dir, 'package.json'));
  if (!pkg || !JSON.parse(pkg).scripts?.test) return null;
  const r = spawnSync('npm', ['test', '--silent'], { cwd: dir, timeout: 600_000, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0;
}

// Per-file clip, so one vendored declaration file cannot crowd out the code.
function diffOf(dir, args) {
  const raw = sh('git', ['-c', 'core.quotepath=off', 'diff', '--no-color', ...args], { cwd: dir });
  const files = raw.split(/(?=^diff --git )/m).map(f => clip(f, 40_000));
  return clip(files.join(''), 400_000);
}

async function gitHubMaterial(replay) {
  const { gh } = R, s = replay.slug;
  const [issueC, prC, reviewC, reviews] = await Promise.all([
    gh.all(`/repos/${s}/issues/${replay.issue}/comments`),
    gh.all(`/repos/${s}/issues/${replay.pr}/comments`),
    gh.all(`/repos/${s}/pulls/${replay.pr}/comments`),
    gh.all(`/repos/${s}/pulls/${replay.pr}/reviews`),
  ]);
  return [
    ...issueC.map(x => `[GitHub issue comment]\n${x.body}`),
    ...prC.map(x => `[GitHub PR comment]\n${x.body}`),
    ...reviews.filter(x => x.body).map(x => `[GitHub PR review: ${x.state}]\n${x.body}`),
    ...reviewC.map(x => `[GitHub review comment on ${x.path}:${x.line ?? x.original_line}]\n${x.body}`),
  ];
}

async function runCase(c, ctx) {
  const name = `${ctx.variant}-${ctx.model.replace(/^claude-/, '')}-${c.id}-${ctx.rep}-${randomBytes(3).toString('hex')}`
    .toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 100);
  const issue = issueFor(c);
  const home = join(R.work, `${name}-home`);
  let replay = null;
  try {
    replay = await buildReplay({ gh: R.gh, token: R.token, org: ORG, source: SOURCE, c, issue, work: R.work, name });
    const before = testsPass(replay.dir);
    const limitS = ctx.timeoutS > 0 ? Math.max(60, ctx.timeoutS - 900) : 4 * 3600;
    const a = await runAgent({
      dir: replay.dir, home, model: ctx.model, prompt: promptFor(replay), pluginDirs: R.pluginDirs,
      denyRead: R.denyRead, allowRead: [replay.dir, home, R.matt], denyReadTool: R.denyReadTool,
      limitS, budgetUsd: ctx.budgetUsd, oauth: R.oauth, ghToken: R.token,
    });
    const d = digest(a.events, R.leak);
    const res = d.result;
    const mu = res?.modelUsage ?? {};
    // modelUsage keys can carry a context suffix such as [1m].
    const mainKey = Object.keys(mu).find(k => k.startsWith(ctx.model));
    const billed = { model: ctx.model, usage: mainKey ? apiUsage(mu[mainKey]) : undefined };
    if (d.leaks.length) throw fail('answer_key_leak', `agent reached for the answer key: ${d.leaks[0]}`, billed);
    if (a.timedOut) throw fail('timeout', `agent ran past ${limitS}s`, billed);
    if (!res) throw fail('harness', `claude exited ${a.code} with no result: ${a.stderr.slice(-500)}`);
    if (res.is_error && !/max_turns|max_budget/.test(res.subtype ?? '')) {
      const status = res.api_error_status ?? (/overloaded|rate.?limit/i.test(String(res.result)) ? 529 : undefined);
      throw fail(status ? 'serving' : 'harness', `agent errored (${res.subtype}): ${String(res.result ?? a.stderr).slice(0, 500)}`, { ...billed, status });
    }
    const after = testsPass(replay.dir);
    sh('git', ['add', '-A', '--intent-to-add'], { cwd: replay.dir });
    const served = d.servedMain.map(m => m.replace(/\[.*\]$/, ''));
    const model = served.find(m => !m.startsWith(ctx.model)) ?? served[0] ?? ctx.model;
    const material = [...d.material, ...(await gitHubMaterial(replay))].join('\n\n');
    return {
      name, model, usage: billed.usage, stop_reason: res.subtype, status: 'ok',
      transcript: [{ role: 'user', content: promptFor(replay) }, ...d.turns],
      output: res.result,
      issueText: `${issue.title}\n\n${issue.body}`,
      prDiff: diffOf(replay.dir, [replay.baseSha, replay.headSha]),
      changes: diffOf(replay.dir, [replay.headSha]),
      material: clip(material, 400_000),
      counts: d.counts, tests: { before, after },
      model_usage: Object.fromEntries(Object.entries(mu).map(([k, v]) => [k, apiUsage(v)])),
      turns: res.num_turns, budget_hit: /max_budget/.test(res.subtype ?? '') ? 1 : 0,
      meta: { replay: name, served_main: d.servedMain, segments: res.segments, cli_cost_usd: res.total_cost_usd, tests: { before, after } },
    };
  } finally {
    if (!ctx.keep) {
      if (replay?.slug) await deleteReplay(R.gh, replay).catch(e => eprint(`  could not delete ${replay.slug}: ${e.message}`));
      for (const p of [join(R.work, name), home]) rmSync(p, { recursive: true, force: true });
    }
  }
}

async function gradeCase(c, run, ref, ctx) {
  const work = join(R.work, `judge-${run.name}`);
  try {
    return await grade({ oauth: R.oauth, work, c, bugs: R.bugs, issue: run.issueText, prDiff: run.prDiff,
      changes: run.changes, material: run.material, counts: run.counts, tests: run.tests });
  } finally {
    if (!ctx.keep) rmSync(work, { recursive: true, force: true });
  }
}

function perfFrom(run, g) {
  const agentCosts = Object.entries(run.model_usage ?? {}).map(([m, u]) => costOf(m, u));
  const agent_cost_usd = agentCosts.some(x => x == null) ? null : agentCosts.reduce((a, b) => a + b, 0);
  const judge_cost_usd = costOf(g.judge_model, g.judge_usage);
  const all = Object.values(run.model_usage ?? {});
  return {
    cost_usd: agent_cost_usd == null || judge_cost_usd == null ? null : agent_cost_usd + judge_cost_usd,
    agent_cost_usd, judge_cost_usd,
    in_tokens: all.reduce((a, u) => a + u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens, 0),
    out_tokens: all.reduce((a, u) => a + u.output_tokens, 0),
    tool_calls: run.counts.tool_calls, turns: run.turns,
    rounds: run.counts.bug_reviews, std_reviews: run.counts.std_reviews,
    findings: g.detail.findings.length, reviews_to_pass: g.detail.first_clean_round,
    asked_human: g.detail.asked_human ? 1 : 0, hook_denials: run.counts.hook_denials,
    refusals: run.counts.refusals, max_tokens_hits: run.counts.max_tokens_hits, budget_hit: run.budget_hit,
  };
}

// --- harness (you usually won't need to touch below this line) --------------

function parseArgs(argv) {
  const a = { flow: '.claude/hillclimb/flow', variant: 'baseline',
              model: undefined, reps: 1, concurrency: 2, timeoutS: 5400,
              approveHarness: false, cases: null, kinds: null, keep: false, budgetUsd: 40, dryRun: false };
  // A flag at the end of argv would otherwise consume undefined - which for
  // --model equals the default and silently disables the served-model check.
  const val = (i) => { if (argv[i] === undefined) { eprint(`missing value for ${argv[i - 1]}`); usage(); process.exit(2); } return argv[i]; };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--flow') a.flow = val(++i);
    else if (k === '--variant') a.variant = val(++i);
    else if (k === '--model') a.model = val(++i);
    else if (k === '--reps') a.reps = +val(++i);
    else if (k === '--concurrency') a.concurrency = +val(++i);
    else if (k === '--timeout-s') a.timeoutS = +val(++i);
    else if (k === '--approve-harness') a.approveHarness = true;
    else if (k === '--cases') a.cases = val(++i).split(',').map(x => x.trim()).filter(Boolean);
    else if (k === '--kinds') a.kinds = val(++i).split(',').map(x => x.trim()).filter(Boolean);
    else if (k === '--budget-usd') a.budgetUsd = +val(++i);
    else if (k === '--keep') a.keep = true;
    else if (k === '--dry-run') a.dryRun = true;
    else if (k === '-h' || k === '--help') { usage(); process.exit(0); }
    else { eprint(`unknown argument: ${k}`); usage(); process.exit(2); }
  }
  if (!/^(baseline|v[1-9]\d*)$/.test(a.variant)) {
    // The report only reads directories named 'baseline' or 'v<N>' - any other
    // name runs to completion but spends the pass into a directory the Summary,
    // trajectory, and budget arithmetic never see.
    eprint(`--variant must be 'baseline' or 'v<N>', got '${a.variant}'`);
    usage(); process.exit(2);
  }
  if (!Number.isFinite(a.timeoutS) || a.timeoutS < 0
      || a.timeoutS * 1000 > 2147483647 // setTimeout clamps >2^31-1 ms to 1 ms - the ceiling would fire instantly
      || !Number.isInteger(a.reps) || a.reps < 1
      || !Number.isInteger(a.concurrency) || a.concurrency < 1
      || !(a.budgetUsd > 0)) { usage(); process.exit(2); }
  if (!a.model) { eprint('--model is required (claude-opus-5-5 or claude-sonnet-5-5)'); usage(); process.exit(2); }
  return a;
}
function usage() {
  eprint('usage: node evals/review/run.mjs --flow DIR --variant ID --model ID [--reps N] [--cases id,id] [--kinds bug,clean,convergence]');
  eprint('         [--concurrency N] [--timeout-s N (0 = no ceiling)] [--budget-usd N per case] [--keep] [--approve-harness]');
  eprint('  --keep leaves each replay repository and clone in place for inspection.');
  eprint('  --dry-run checks the setup and lists the (case, rep) pairs it would run, then exits.');
}

// Harness integrity gate. The hillclimb loop gets this runner command
// allowlisted for the session and then runs rounds unattended, while the
// per-round change (proposed by an analyzer fed untrusted transcripts) may
// legitimately edit harness code. Without this gate a round that rewrites the
// runner would execute attacker-chosen code on the next unattended run under
// the user's one-time approval. So: sha256 over this file, any lockfile
// beside it or in the directory the runner is invoked from (dependency drift
// is harness drift too; with neither, a note says so), plus
// every path in `_state.json.harness_paths` (relative to the directory the
// runner is invoked from, i.e. the repo root); compare to
// `_state.json.harness_sha`; refuse on absent/mismatch unless a human passes
// --approve-harness, which records the new sha. That write is the one
// sanctioned exception to "never write _state.json".
//
// Scope, stated plainly: this is a change detector, not a security boundary.
// The sha, the path list and this file all live where the loop agent can
// write, so an agent that is already prompt-injected can forge the record or
// pass --approve-harness itself. What it catches is the common case - a
// round's harness edit reaching an unattended run unreviewed - and what
// actually bounds an unattended run is the permission allowlist the user
// grants the runner command (scope it to this exact command line, not a
// prefix). Installed dependencies beyond the lockfile are outside the digest.
function checkHarness(statePath, st, approve) {
  const self = fileURLToPath(import.meta.url);
  const listed = Array.isArray(st.harness_paths) ? st.harness_paths.map(String) : [];
  const lockfiles = [...new Set([dirname(self), process.cwd()].flatMap(d =>
    ['package-lock.json', 'bun.lock', 'bun.lockb', 'yarn.lock', 'pnpm-lock.yaml'].map(f => join(d, f))))]
    .filter(f => existsSync(f));
  const paths = [...new Set([self, ...lockfiles, ...listed.map(p => resolve(p))])].sort();
  const h = createHash('sha256');
  const hashed = [];
  for (const p of paths) {
    let buf;
    try { buf = readFileSync(p); }
    catch (e) {
      if (p === self) throw e;
      eprint(`warning: harness path '${relative(process.cwd(), p)}' not readable (${e?.code || 'error'}) - skipped`);
      continue;
    }
    h.update(relative(process.cwd(), p)).update('\0').update(buf).update('\0');
    hashed.push(relative(process.cwd(), p));
  }
  const sha = h.digest('hex');
  if (st.harness_sha === sha) return;
  // Said only here, where a person is about to approve or is being refused.
  if (!lockfiles.length) eprint('note: no lockfile beside the runner or in the current directory - dependency changes are outside the harness sha');
  if (approve) {
    st.harness_sha = sha;
    writeFileNoFollow(statePath, JSON.stringify(st, null, 2) + '\n');
    eprint(`harness approved: sha256 ${sha.slice(0, 12)} over ${hashed.length} file(s) recorded in ${statePath}`);
    return;
  }
  if (st.harness_sha == null) {
    eprint(`no approved harness sha in ${statePath} (computed ${sha.slice(0, 12)} over: ${hashed.join(', ')}).`);
    eprint('Review the harness, then run once with --approve-harness to record it.');
  } else {
    eprint(`harness changed since last approved run (files: ${hashed.join(', ')}); `
      + `approved ${String(st.harness_sha).slice(0, 12)}, now ${sha.slice(0, 12)}.`);
    eprint('Re-run with --approve-harness after reviewing the diff.');
  }
  process.exit(2);
}

// Transient provider errors (429 / overloaded / 5xx) retry with jittered
// exponential backoff - a zero-delay retry loop multiplies cost invisibly
// under rate limits and can turn one transient 429 into a torn-down batch.
// The attempt count lands in the row's meta (or the errors sidecar) so retry
// churn is visible in the data, not just the bill.
async function withBackoff(fn, retry, deadline = Infinity, tries = 5) {
  for (let attempt = 0; ; attempt++) {
    // Checked before every attempt, not just before sleeps: once the case's
    // ceiling has passed, an abandoned chain must not issue another call
    // (e.g. a judge call after the app call consumed the whole ceiling).
    if (Date.now() >= deadline) {
      const e = new Error('wall-clock ceiling exceeded before attempt');
      e.failure_class = 'timeout';
      throw e;
    }
    try { return await fn(); } catch (e) {
      const status = e?.status ?? e?.response?.status;
      const transient = status === 429 || status === 529 || (status >= 500 && status < 600)
        || /overloaded|rate.?limit/i.test(String(e?.message ?? ''));
      if (!transient || attempt >= tries - 1) throw e;
      const delay = Math.min(60_000, 1000 * 2 ** attempt) * (0.5 + Math.random());
      // Never start a retry that would outlive the case's wall-clock ceiling - 
      // otherwise an abandoned chain keeps issuing API calls after the case failed.
      if (Date.now() + delay >= deadline) throw e;
      retry.count++;
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// Hard per-case wall-clock ceiling, independent of stream liveness - a hung
// SSE stream can emit keepalives forever, defeating inactivity-based timers.
// The underlying call may keep running; the case fails and the slot is freed.
function withTimeout(promise, seconds, label) {
  if (!(seconds > 0)) return promise;
  let timer;
  const ceiling = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error(`${label}: exceeded ${seconds}s wall-clock ceiling`);
      e.failure_class = 'timeout';
      reject(e);
    }, seconds * 1000);
  });
  return Promise.race([promise, ceiling]).finally(() => clearTimeout(timer));
}

// Case ids appear in file paths AND as the row/file join key the report uses,
// so rows, trace filenames, and frozen refs all carry the same path-safe id.
// When sanitization changes the id, a short content hash keeps distinct ids
// distinct ('case/1' vs 'case_1'); the original rides in meta.original_id.
function pathSafeId(id) {
  const raw = String(id);
  const cleaned = raw.replace(/[^\w.-]/g, '_');
  // Idempotent by construction: anything already path-safe and within the
  // length bound - including this function's own truncated+suffixed output - 
  // passes through unchanged. Long ids (URLs, prompt text as id) truncate to
  // 120 chars plus an 8-hex hash of the full original, so they fail here, not
  // at the trace write after the spend, and distinct ids stay distinct.
  if (cleaned === raw && raw.length <= 129) return raw;
  return `${cleaned.slice(0, 120)}-${createHash('sha256').update(raw).digest('hex').slice(0, 8)}`;
}

/** @type {any} */
let parsedArgs = null;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  parsedArgs = args;
  // lstat("link/") follows the final symlink, so a trailing separator on
  // --flow would blind every leaf isSymlink check below - strip it first.
  // Only Windows treats `\` as a separator; on POSIX it is a filename byte, so
  // splitting on it would walk prefixes that are not real path components.
  args.flow = args.flow.replace(WIN ? /(.)[\\/]+$/ : /(.)\/+$/, '$1');
  const flowSegments = args.flow.split(WIN ? /[\\/]/ : '/');
  // A `.`/`..` segment (e.g. a trailing `/.`) makes isSymlink(args.flow) below
  // resolve a different final component than the named dir - following a
  // planted link at the flow root - while join() collapses it and the absolute
  // branch skips the ancestor walk. Refuse dot segments outright
  // (absolute --flow stays supported).
  if (flowSegments.some(seg => seg === '.' || seg === '..')) {
    eprint(`refusing to run: --flow must not contain '.' or '..' segments, got '${args.flow}'`);
    process.exit(2);
  }
  const vdir = join(args.flow, args.variant);
  // Preflight every output path before the first model call: a planted
  // symlink would otherwise fail each case after its (billed) run.
  for (const p of [args.flow, join(args.flow, 'baseline'), vdir, join(vdir, 'traces'),
                   join(vdir, 'results.jsonl'), join(vdir, 'errors.jsonl'),
                   join(vdir, 'progress.txt'), join(args.flow, 'baseline', 'ref'), join(args.flow, '_state.json')])
    if (isSymlink(p)) { eprint(`refusing to run: ${p} is a symlink (the flow dir must hold regular files)`); process.exit(2); }
  // A relative --flow (the documented `.claude/hillclimb/<name>` layout) is
  // also lstat-walked component by component from the cwd: a pre-planted
  // link at an ancestor (`.claude/hillclimb -> elsewhere`) would otherwise
  // relocate the root capture below - the containment anchor itself - to the
  // attacker's target. An absolute --flow is the caller's own trust decision
  // and is not walked (an absolute ancestor link can be legitimate: /tmp on
  // macOS).
  if (!isAbsolute(args.flow)) {
    let walk = '';
    for (const part of flowSegments.filter(Boolean).slice(0, -1)) {
      walk = walk ? join(walk, part) : part;
      if (isSymlink(walk)) { eprint(`refusing to run: ${walk} is a symlink (ancestor of --flow)`); process.exit(2); }
    }
  }
  // Every later open/mkdir is bound to this resolved root (see assertInFlow):
  // create the flow dir when fresh (the preflight above refused a link at it
  // and, for a relative path, at every ancestor), then capture where it
  // really resolves.
  mkdirSync(args.flow, { recursive: true });
  flowRealRoot = realpathSync(args.flow);
  mkdirNoFollow(join(vdir, 'traces'));
  // _state.json is READ-ONLY here. The orchestrator owns it. Absent is fine
  // (a baseline-only run has no loop state yet), but present-and-unparsable
  // must not let the id-space gate below pass vacuously over a corrupt file.
  const statePath = join(args.flow, '_state.json');
  let st = {};
  // Read through the no-follow opener like every other flow-dir file; the
  // parse message is not echoed (it can quote the file's first bytes).
  const stateText = readIfPresent(statePath);
  if (stateText != null) {
    try { st = JSON.parse(stateText) || {}; }
    catch { eprint(`${statePath} exists but is not valid JSON - fix it before spending a pass`); process.exit(2); }
  }
  checkHarness(statePath, st, args.approveHarness);
  const ctx = { ...args, state: st };
  await setup(ctx);

  // Resume: which (id, rep) pairs already have a row?
  const resultsPath = join(vdir, 'results.jsonl');
  const done = new Set();
  for (const ln of (readIfPresent(resultsPath) ?? '').split('\n')) {
    if (!ln.trim()) continue;
    try { const r = JSON.parse(ln); done.add(`${r.prompt_id}\0${r.rep}`); } catch {}
  }
  // Rows key on the path-safe id (see pathSafeId), so resume must too.

  const cases = await loadCases();
  // Validate the id space before spending anything: duplicate path-safe ids - 
  // including case-insensitive twins, which macOS/Windows filesystems collapse - 
  // would silently overwrite traces and frozen refs; and a _state.json split id
  // that matches no case would silently shrink the scored denominator.
  const seen = new Map();
  for (const c of cases) {
    const k = pathSafeId(c.id).toLowerCase();
    if (seen.has(k)) {
      eprint(`duplicate case id after sanitization: '${c.id}' collides with '${seen.get(k)}'`);
      process.exit(2);
    }
    seen.set(k, c.id);
  }
  const safeIds = new Set(cases.map(c => pathSafeId(c.id)));
  for (const k of ['train_ids', 'val_ids', 'test_ids'])
    if (st[k] != null && !Array.isArray(st[k])) { eprint(`_state.json ${k} must be a list of ids`); process.exit(2); }
  for (const sid of [...(st.train_ids ?? []), ...(st.val_ids ?? []), ...(st.test_ids ?? [])]) {
    const s = String(sid); // the adapter joins with String() on both sides - numeric ids are fine
    if (safeIds.has(s)) continue; // matches a loaded case - definitionally valid
    if (s !== pathSafeId(s)) {
      // Can never match a row: rows key on path-safe ids. This is the silent
      // shrunken-denominator bug - fail before anything is spent.
      eprint(`_state.json split id '${s}' is not a path-safe id - record split ids exactly as they appear in results.jsonl's prompt_id`);
      process.exit(2);
    }
    // Well-formed but absent is legitimate (a trimmed top-K subset run) - note it, don't fail.
    eprint(`note: split id '${s}' matches no loaded case (expected for a trimmed subset run)`);
  }
  const refDir = join(args.flow, 'baseline', 'ref');
  const tasks = [];
  for (const c of cases) for (let rep = 0; rep < args.reps; rep++) {
    if (done.has(`${pathSafeId(c.id)}\0${rep}`)) continue;
    tasks.push({ c, rep });
  }
  eprint(`[${args.variant}] ${tasks.length} of ${cases.length * args.reps} (id,rep) to run`);
  if (args.dryRun) {
    for (const t of tasks) eprint(`  ${t.c.id} rep${t.rep}`);
    rmSync(R.work, { recursive: true, force: true });
    process.exit(0);
  }

  let i = 0, ok = 0, fail = 0;
  const errorsPath = join(vdir, 'errors.jsonl');
  // A hard crash (power loss, ENOSPC) can leave a torn final line with no
  // trailing newline; the next append would merge two rows into one permanently
  // unparseable line. Isolate any fragment before appending anything.
  for (const p of [resultsPath, errorsPath]) {
    const tail = readIfPresent(p);
    if (tail && !tail.endsWith('\n')) appendFileNoFollow(p, '\n');
  }
  async function worker() {
    while (i < tasks.length) {
      const { c, rep } = tasks[i++];
      const safeId = pathSafeId(c.id);
      const t0 = Date.now();
      let lastRun = null;    // survives into the catch - billed spend on a failed attempt
      let rowWritten = false; // set once the results row lands - the attempt is scored
      const deadline = args.timeoutS > 0 ? t0 + args.timeoutS * 1000 : Infinity;
      const appRetry = { count: 0 }, judgeRetry = { count: 0 };
      try {
        // One ceiling over the whole case - app call, identity check, and grading - 
        // so a hung judge stream can't hold the slot either.
        const { run, g, latency_s } = await withTimeout((async () => {
          let tAttempt = t0;
          const run = await withBackoff(() => { tAttempt = Date.now(); return runCase(c, { ...ctx, rep }); },
            appRetry, deadline);
          lastRun = run;
          // latency_s = the final app attempt only; backoff sleeps, failed
          // attempts, and judge time are excluded (retry counts are in meta).
          const latency_s = (Date.now() - tAttempt) / 1000;
          // Serving identity: fail loudly when the response was served by a model
          // other than the one requested. Accept exact match or a documented
          // alias->snapshot resolution - 'foo-latest'/'foo-0'/'foo' served as
          // 'foo-20250101', 'foo@20250101', or 'foo-2025-01-01'. Anything else - 
          // another snapshot of the requested pin, a sibling model, or the bare
          // base id ('foo-latest' served as 'foo', an unversioned echo that can
          // hide snapshot drift across rounds) - fails the attempt. Non-Anthropic
          // id schemes (e.g. Bedrock's 'anthropic.claude-...-v1:0') need their own
          // rule here.
          if (ctx.model && run.model && run.model !== ctx.model) {
            const base = ctx.model.replace(/-latest$|-0$/, '');
            const rest = String(run.model).startsWith(base)
              ? String(run.model).slice(base.length) : null;
            if (!(rest != null && /^[-@](\d{8}|\d{4}-\d{2}-\d{2})$/.test(rest))) {
              const e = new Error(`served model ${run.model} != requested ${ctx.model}`);
              e.failure_class = 'serving_substitution';
              throw e;
            }
          }
          // Frozen pairwise reference (never regenerated): baseline/ref/<id>.*
          let ref = null;
          if (args.variant !== 'baseline') {
            const p = join(refDir, safeId);
            // A planted symlink throws (ELOOP) rather than feeding the judge
            // its target; the case then fails loudly instead of leaking.
            for (const ext of REF_EXTS) {
              try { ref = readFileNoFollow(p + ext); break; }
              catch (e) { if (e?.code !== 'ENOENT') throw e; }
            }
          }
          const g = await withBackoff(() => gradeCase(c, run, ref, ctx), judgeRetry, deadline);
          return { run, g, latency_s };
        })(), args.timeoutS, `${c.id} rep${rep}`);
        const row = {
          prompt_id: safeId, rep, prompt: c.prompt ?? c.input ?? c.id,
          tags: c.tags, attachments: c.attachments,
          meta: { ...(c.meta ?? {}), ...(run.meta ?? {}), grading: g.detail,
                  ...(safeId !== String(c.id) ? { original_id: String(c.id) } : {}),
                  ...(appRetry.count ? { retries: appRetry.count } : {}),
                  ...(judgeRetry.count ? { judge_retries: judgeRetry.count } : {}) },
          model: run.model, usage: run.usage, stop_reason: run.stop_reason,
          // The report keys on `status`, not stop_reason: a clipped answer is
          // counted and shown but kept out of the means. runCase may set
          // run.status to override the max_tokens rule.
          status: run.status ?? (run.stop_reason === 'max_tokens' ? 'truncated' : 'ok'),
          judge_model: g.judge_model ?? run.judge_model,
          judge_usage: g.judge_usage ?? run.judge_usage,
          latency_s, ...perfFrom(run, g),
          grade: g.grade, explanation: g.explanation,
        };
        appendFileNoFollow(resultsPath, JSON.stringify(row) + '\n');
        rowWritten = true; // past this point the attempt is scored - a later throw (trace write, ref freeze) must not also append an error row
        if (run.transcript)
          writeFileNoFollow(join(vdir, 'traces', `${safeId}_rep${rep}.json`),
            JSON.stringify(run.transcript, null, 2));
        // For pairwise: on the baseline run, freeze the reference output once.
        if (args.variant === 'baseline' && run.output != null
            && !REF_EXTS.some(ext => lexists(join(refDir, safeId) + ext))) {
          mkdirNoFollow(refDir);
          writeFileNoFollow(join(refDir, safeId),
            typeof run.output === 'string' ? run.output : JSON.stringify(run.output));
        }
        ok++;
      } catch (e) {
        fail++;
        if (rowWritten) {
          // The attempt scored; only a post-row write (trace, ref) failed. An error
          // row here would double-count the billed usage under the budget rule.
          eprint(`  [${args.variant}] ${c.id} rep${rep} scored, but a post-row write failed: ${e?.message || e}`);
          continue;
        }
        // Failed attempts are data too - but they must not occupy the (case, rep)
        // slot in results.jsonl, or resume would never re-run them.
        appendFileNoFollow(errorsPath, JSON.stringify({
          prompt_id: safeId, rep,
          ...(safeId !== String(c.id) ? { original_id: String(c.id) } : {}),
          failure_class: e?.failure_class ?? 'error',
          error: String(e?.message || e),
          retries: appRetry.count, judge_retries: judgeRetry.count,
          // Billed-but-failed spend stays countable: when the app call completed
          // before the failure (e.g. a served-model mismatch, a judge-stage
          // ceiling), carry its identity and usage on the error row.
          model: lastRun?.model ?? e?.model, usage: lastRun?.usage ?? e?.usage,
          judge_model: e?.judge_model ?? lastRun?.judge_model,
          judge_usage: e?.judge_usage ?? lastRun?.judge_usage,
          latency_s: (Date.now() - t0) / 1000,
        }) + '\n');
        eprint(`  [${args.variant}] ${c.id} rep${rep} FAILED: ${e?.message || e}`);
      }
    }
  }
  // One progress line every 30s (and to <vdir>/progress.txt) so "how far along
  // is it?" is answerable from the background shell's output or one file read,
  // without the orchestrator parsing results.jsonl mid-write. ETA is a plain
  // rate extrapolation from this pass.
  const t0 = Date.now();
  const progress = () => {
    const done = ok + fail, total = tasks.length;
    const el = (Date.now() - t0) / 1000;
    const eta = done ? Math.round((el / done) * (total - done)) : null;
    const line = `[${args.variant}] ${done}/${total} done (${ok} ok, ${fail} failed), `
      + `${Math.round(el)}s elapsed` + (eta != null ? `, ~${eta}s left` : '');
    eprint(line);
    try { writeFileNoFollow(join(vdir, 'progress.txt'), line + '\n'); } catch {}
  };
  const tick = setInterval(progress, 30_000);
  workersStarted = true;
  await Promise.all(Array.from({ length: Math.max(1, args.concurrency) }, worker));
  clearInterval(tick); progress();
  eprint(`[${args.variant}] done - ${ok} ok, ${fail} failed -> ${resultsPath}`);
  if (!args.keep) rmSync(R.work, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}

// Anything main() throws prints as one sanitized line, not a raw stack. Before
// the workers start it is a refusal (a planted link at _state.json or
// results.jsonl, an lstat that fails, an error from loadCases) and exits 2 like
// the preflight refusals. After they start, only a failed errors.jsonl append
// gets here; rows may already be on disk, so say that and exit 1.
let workersStarted = false;
main().catch(e => {
  const m = String(e?.message || e);
  if (workersStarted) { eprint('stopped mid-run (rows already written are kept; re-run to resume): ' + m); process.exit(1); }
  eprint(m.startsWith('refusing to ') ? m : 'refusing to run: ' + m);
  process.exit(2);
});
