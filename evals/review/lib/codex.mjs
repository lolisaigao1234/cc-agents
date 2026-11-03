// Subscription-only Codex exec adapter. An explicit eval CODEX_EVAL_HOME is
// required; personal login/config, API keys, MCP servers and memories are never copied.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODEX_VERSION, assertModel } from './config.mjs';
import { codexDigest } from './codex-digest.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const q = JSON.stringify; // TOML quoted strings, never shell quoting.
/** @param {string} s */
const shellQuote = s => `'${String(s).replace(/'/g, `'"'"'`)}'`;
/** @param {string} failure_class @param {string} message @param {Record<string, any>} [extra] */
const fail = (failure_class, message, extra = {}) => Object.assign(new Error(message), { failure_class, ...extra });
export function resolveCodex(version = CODEX_VERSION) {
  const found = process.env.CODEX_BIN ?? spawnSync('sh', ['-c', 'command -v codex'], { encoding: 'utf8' }).stdout?.trim();
  if (!found) throw new Error('Codex not found; set CODEX_BIN to a pinned standalone executable');
  const bin = realpathSync(found);
  // Only standalone installs: mounting an npm prefix could reveal other plugins.
  const magic = Buffer.alloc(4), fd = openSync(bin, 'r');
  try { readSync(fd, magic, 0, 4, 0); } finally { closeSync(fd); }
  if (!magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) throw new Error('Codex eval requires a standalone Linux ELF executable');
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
  if (r.status !== 0 || r.stdout.trim() !== `codex-cli ${version}`) throw new Error(`Codex version must be pinned to ${version}`);
  for (const name of ['codex-code-mode-host', 'codex-exec-server'])
    if (!existsSync(join(dirname(bin), name))) throw new Error(`the pinned Codex installation is missing ${name}`);
  return bin;
}

// Hold one lock for the runner lifetime, including both agent and judge calls.
// Refreshed auth is copied back after each session under that lock.
export function lockCodexAuth(authHome = process.env.CODEX_EVAL_HOME) {
  if (!authHome) throw new Error('set CODEX_EVAL_HOME to a separately provisioned eval-only Codex subscription login directory');
  const home = realpathSync(authHome), auth = join(home, 'auth.json');
  const st = lstatSync(auth);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || (st.mode & 0o077)) throw new Error('eval auth.json must be a private, regular, single-link file (mode 600)');
  const lock = join(home, '.hillclimb.lock');
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch { throw new Error('Codex eval auth is in use; do not run concurrent hillclimbs against one login'); }
  const release = () => rmSync(lock, { recursive: true, force: true });
  process.once('exit', release);
  return { home, auth, release };
}

/** @param {{dir:string,home:string,tmp:string,control:string,bin?:string,denied?:string[],role?:string,model:string,effort?:string,serviceTier?:string}} o */
export function codexConfig({ dir, home, tmp, control, bin, denied = [], role = 'agent', model, effort = 'high', serviceTier = 'fast' }) {
  const judge = role === 'judge', review = role === 'review';
  const paths = new Map(/** @type {[string,string][]} */ ([
    // Outer bwrap already gives this attempt a private /tmp. Denying that
    // ancestor again prevents nested bwrap from mounting read-only deny targets.
    [':root', 'read'], ['/home', 'deny'],
    [dir, judge || review ? 'read' : 'write'],
    [join(dir, '.git'), judge || review ? 'read' : 'write'],
    [home, 'write'], [tmp, 'write'],
    [join(home, '.agents'), 'read'], [join(tmp, 'trace-reads'), 'deny'],
    ...denied.map(p => [p, 'deny']),
    [join(home, '.codex'), 'deny'], [control, 'deny'],
    [join(dir, '.codex'), 'deny'], [join(dir, '.agents'), 'read'],
  ]));
  return [
    `model = ${q(model)}`, `model_reasoning_effort = ${q(effort)}`, `service_tier = ${q(serviceTier)}`,
    'approval_policy = "never"', 'default_permissions = "eval"', 'web_search = "disabled"',
    'cli_auth_credentials_store = "file"', 'project_doc_fallback_filenames = ["CLAUDE.md"]',
    'project_doc_max_bytes = 131072', 'check_for_update_on_startup = false',
    '[features]', 'fast_mode = true', 'network_proxy = true', 'multi_agent = false',
    '[apps._default]', 'enabled = false',
    `[projects.${q(dir)}]`, 'trust_level = "untrusted"',
    '[permissions.eval.filesystem]', ...[...paths].map(([p, access]) => `${q(p)} = ${q(access)}`),
    '[permissions.eval.network]', `enabled = ${!judge}`,
    '[permissions.eval.network.domains]',
    ...(!judge ? ['github.com', 'api.github.com', 'codeload.github.com', '*.githubusercontent.com', 'registry.npmjs.org'].map(d => `${q(d)} = "allow"`) : []), '',
  ].join('\n');
}

// No bind of host /, /home, /tmp or the harness. Only system runtime, the
// pinned Codex runtime, protected hook assets, and this attempt are visible.
/** @param {{bin:string,dir:string,home:string,tmp:string,control:string,pluginDirs?:string[],args:string[],env:Record<string,string>}} o */
export function codexBwrap({ bin, dir, home, tmp, control, pluginDirs = [], args, env }) {
  const mounts = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc'].filter(existsSync).flatMap(p => ['--ro-bind', p, p]);
  const node = realpathSync(process.execPath);
  const resolver = realpathSync('/etc/resolv.conf');
  const companions = ['codex-code-mode-host', 'codex-exec-server']
    .map(name => ({ source: join(dirname(bin), name), target: `/opt/trace-eval/${name}` }))
    .filter(file => existsSync(file.source));
  return ['--unshare-pid', '--new-session', '--die-with-parent', '--proc', '/proc', '--dev', '/dev',
    '--tmpfs', '/tmp', '--tmpfs', '/home', ...mounts,
    ...(resolver !== '/etc/resolv.conf' ? ['--ro-bind', resolver, resolver] : []),
    ...companions.flatMap(file => ['--ro-bind', file.source, file.target]),
    '--ro-bind', bin, '/opt/trace-eval/codex', ...(node.startsWith('/usr/') ? [] : ['--ro-bind', node, node]),
    '--bind', dir, dir, '--bind', home, home, '--bind', tmp, tmp,
    ...pluginDirs.flatMap(p => ['--ro-bind', p, p]),
    '--chdir', dir, '--clearenv',
    ...Object.entries(env).flatMap(([k, v]) => ['--setenv', k, v]),
    '--', '/opt/trace-eval/codex', ...args];
}

/** @param {{dir:string,home:string,tmp:string,pluginDirs?:string[],denied?:string[],auth:{home:string,auth:string}}} o */
export function prepareCodex({ dir, home, tmp, pluginDirs = [], denied = [], auth }) {
  const control = join(home, 'eval-control');
  for (const p of [home, tmp, control, join(tmp, 'trace-reads'), join(dir, '.codex'), join(dir, '.agents'), join(home, '.codex'), join(home, '.agents/skills')]) mkdirSync(p, { recursive: true, mode: 0o700 });
  for (const name of ['codex-hooks.mjs', 'egress-guard.mjs']) copyFileSync(join(HERE, name), join(control, name));
  for (const [i, plugin] of pluginDirs.entries()) {
    const skills = join(plugin, 'skills');
    if (existsSync(skills)) cpSync(skills, join(home, '.agents/skills', `plugin-${i}`), { recursive: true });
  }
  // The plugin's runtime is available to trusted hooks, denied to model tools.
  writeFileSync(join(control, 'policy.json'), JSON.stringify({ dir, control, trace: pluginDirs[0] ?? null,
    denied: [...denied, control, join(home, '.codex')], slug: '', role: 'agent' }));
  writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = eval agent\n\temail = agent@example.invalid\n[credential "https://github.com"]\n\thelper =\n\thelper = !gh auth git-credential\n');
  copyFileSync(auth.auth, join(home, '.codex/auth.json'));
  return { dir, home, tmp, control, pluginDirs, denied, auth };
}

/** @param {any} runtime @param {{model:string,effort?:string,serviceTier?:string,prompt:string,schema?:any,developerInstructions?:string,role?:string,slug?:string,limitS?:number,modelVerification?:string,bin:string,ghToken?:string,phase?:string}} o */
export async function codexExec(runtime, { model, effort = 'high', serviceTier = 'fast', prompt, schema, developerInstructions, role = 'agent', slug = '', limitS = 900,
  modelVerification = 'required', bin, ghToken = '', phase = 'session' }) {
  const { dir, home, tmp, control, pluginDirs, denied, auth } = runtime;
  const call = join(control, `${phase}-${Date.now()}`);
  mkdirSync(call, { mode: 0o700 });
  /** @type {any[]} */ const events = [];
  const raw = join(call, 'events.jsonl'), ledger = join(call, 'hooks.jsonl');
  const policy = { dir, control, trace: pluginDirs[0] ?? null, denied: [...denied, control, join(home, '.codex')], role, slug, ledger };
  writeFileSync(join(control, 'policy.json'), JSON.stringify(policy));
  writeFileSync(join(home, '.codex/config.toml'), codexConfig({ ...runtime, bin, role, model, effort, serviceTier }));
  const hooks = Object.fromEntries(['PreToolUse', 'PostToolUse', 'SessionStart', 'SubagentStart', 'PostCompact', 'UserPromptSubmit', 'Stop', 'PostModelRequest']
    .map(event => [event, [{ hooks: [{ type: 'command', timeout: 30,
      command: [process.execPath, join(control, 'codex-hooks.mjs'), event, join(control, 'policy.json')].map(shellQuote).join(' ') }] }]]));
  writeFileSync(join(home, '.codex/hooks.json'), JSON.stringify({ hooks }));
  const args = ['--ask-for-approval', 'never', '--dangerously-bypass-hook-trust', 'exec', '--strict-config', '--json', '--ephemeral', '--ignore-rules',
    '--skip-git-repo-check', '--cd', dir, '--model', model,
    '-c', `model_reasoning_effort=${q(effort)}`, '-c', `service_tier=${q(serviceTier)}`,
    '-c', 'features.fast_mode=true', '--output-last-message', join(call, 'final.txt')];
  if (developerInstructions) args.push('-c', `developer_instructions=${q(developerInstructions)}`);
  if (schema) { writeFileSync(join(call, 'schema.json'), JSON.stringify(schema)); args.push('--output-schema', join(call, 'schema.json')); }
  args.push('-');
  writeFileSync(join(call, 'prompt.txt'), prompt);
  const env = { HOME: home, CODEX_HOME: join(home, '.codex'), TMPDIR: tmp,
    PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', TERM: 'dumb', GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0',
    ...(ghToken ? { GH_TOKEN: ghToken, GH_CONFIG_DIR: join(home, '.config/gh') } : {}) };
  const launch = codexBwrap({ ...runtime, bin, args, env });
  const r = await spawnCodex(launch, dir, prompt, limitS, line => {
    appendFileSync(raw, line + '\n');
    try { events.push(JSON.parse(line)); } catch { events.push({ type: 'unparsed', line }); }
  });
  writeFileSync(join(call, 'stderr.txt'), r.stderr);
  // Atomic refresh propagation; the parent holds the eval-only auth lock.
  const refreshed = join(auth.home, '.auth-refresh');
  copyFileSync(join(home, '.codex/auth.json'), refreshed); renameSync(refreshed, auth.auth);
  const d = codexDigest(events);
  const records = existsSync(ledger) ? readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s)) : [];
  const billed = { model: null, requested_model: model, usage: d.usage, events, artifacts: call, raw_usage: d.raw_usage, audit: records };
  if (r.timedOut) throw fail('timeout', `Codex ${phase} exceeded ${limitS}s`, billed);
  if (/bwrap:|sandbox.*(?:unavailable|failed)|managed network proxy|Failed to execvp|(?:namespace|seccomp).*(?:denied|permitted)/i.test(r.stderr))
    throw fail('sandbox_unavailable', `Codex sandbox unavailable: ${r.stderr.slice(-400)}`, billed);
  // Nested command sandbox failures arrive in model-visible tool output,
  // rather than the outer CLI's stderr. Fail the phase before any leak scan
  // can mistake an error mentioning a protected path for answer-key access.
  const commandOutputs = events.filter(e => e.type === 'item.completed' && e.item?.type === 'command_execution' && e.item.exit_code !== 0)
    .map(e => e.item.aggregated_output);
  const hookOutputs = records.filter(e => e.event === 'PostToolUse').map(e => typeof e.response === 'string' ? e.response : e.response?.stdout ?? e.response?.output);
  const sandboxError = [...commandOutputs, ...hookOutputs].find(out => typeof out === 'string' && /(?:^|\n)bwrap:/.test(out));
  if (sandboxError) throw fail('sandbox_unavailable', `Codex command sandbox failed: ${sandboxError.slice(-500)}`, billed);
  if (r.code !== 0 || !d.complete) {
    const msg = events.filter(e => ['error', 'turn.failed'].includes(e.type)).map(e => JSON.stringify(e)).join('\n') || r.stderr;
    throw fail(/rate.?limit|usage.?limit|quota|overloaded|429/i.test(msg) ? 'serving' : 'harness', `Codex ${phase} failed: ${msg.slice(-500)}`, billed);
  }
  if (!records.some(x => x.event === 'SessionStart') || !records.some(x => x.event === 'PostModelRequest'))
    throw fail('harness', 'Codex did not execute the required trusted hooks', billed);
  if (records.some(x => x.hook_error)) throw fail('harness', 'Codex trace hook failed; refusing to score', billed);
  let modelServed;
  try { modelServed = assertModel(model, d.servedMain, modelVerification); }
  catch (e) { throw Object.assign(/** @type {Error} */ (e), billed); }
  const final = existsSync(join(call, 'final.txt')) ? readFileSync(join(call, 'final.txt'), 'utf8') : d.final;
  let output = final;
  if (schema) {
    try { output = JSON.parse(final); } catch { throw fail('harness', `Codex ${phase} returned invalid structured output`, billed); }
    try { validateSchema(output, schema); } catch (e) { throw Object.assign(/** @type {Error} */ (e), billed); }
  }
  if (role === 'judge' && (d.counts.tool_calls || records.some(x => x.event === 'PreToolUse')))
    throw fail('grader', 'Codex judge attempted a tool call', billed);
  return { ...d, output, model: modelServed, requested_model: model, events, records, artifacts: call,
    audit: records, provenance: { requested_model: model, served_model: modelServed, model_verification: modelServed ? 'response' : 'configured_only',
      effort, service_tier: serviceTier, observed_service_tier: null, cli_version: runtime.version ?? CODEX_VERSION } };
}

// Small validator for the object/array/primitive/enum schemas owned by this
// harness. Validate before metrics; malformed JSON shapes must never score.
/** @param {any} value @param {any} schema */
export function validateSchema(value, schema) {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  /** @param {string} type */
  const matches = type => type === 'null' ? value === null : type === 'array' ? Array.isArray(value)
    : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
    : type === 'integer' ? Number.isInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === type;
  if (!types.some(matches) || (schema.enum && !schema.enum.includes(value))) throw fail('grader', 'structured output violates its schema');
  if (Array.isArray(value)) for (const x of value) validateSchema(x, schema.items);
  else if (value && typeof value === 'object') {
    if ((schema.required ?? []).some(/** @param {string} k */ k => !Object.hasOwn(value, k))) throw fail('grader', 'structured output is missing a required field');
    for (const [k, v] of Object.entries(value)) {
      if (!schema.properties?.[k]) { if (schema.additionalProperties === false) throw fail('grader', 'unexpected structured output field'); }
      else validateSchema(v, schema.properties[k]);
    }
  }
}

/** @param {string[]} args @param {string} cwd @param {string} input @param {number} limitS @param {(line:string)=>void} onLine @returns {Promise<{code:number|null,stderr:string,timedOut:boolean}>} */
function spawnCodex(args, cwd, input, limitS, onLine) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('bwrap', args, { cwd, env: { PATH: '/usr/local/bin:/usr/bin:/bin' }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '', stderr = '', timedOut = false;
    /** @type {ReturnType<typeof setTimeout> | undefined} */ let hardKill;
    /** @param {NodeJS.Signals} signal */
    const kill = signal => { try { if (child.pid) process.kill(-child.pid, signal); } catch {} };
    const timer = setTimeout(() => { timedOut = true; kill('SIGTERM'); hardKill = setTimeout(() => kill('SIGKILL'), 1500); }, Math.max(1, limitS * 1000));
    child.stdout.on('data', bytes => { buf += bytes; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) onLine(line); } });
    child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-20000); });
    child.stdin.on('error', () => {}); child.stdin.end(input);
    child.on('error', e => { clearTimeout(timer); clearTimeout(hardKill); reject(e); });
    child.on('close', code => { clearTimeout(timer); clearTimeout(hardKill); kill('SIGKILL'); if (buf.trim()) onLine(buf); resolvePromise({ code, stderr, timedOut }); });
  });
}
