// Runs the agent under test in GitHub Copilot CLI (`copilot -p`) instead of
// Claude Code, with the same plugin variant, Matt's skills and egress guard.
// Copilot CLI has no sandbox of its own, so bwrap stands in for Claude Code's:
// the human's home and the eval's work root are empty tmpfs mounts, and only
// the replay clone, the agent's throwaway home and TMPDIR, the plugin copies
// and the Copilot install are mounted back. Unlike Claude Code's sandbox, the
// network is not narrowed; the egress guard and the runner's leak scan cover it.
//
// Copilot authenticates with the human's own Copilot login (a copy of
// ~/.copilot/config.json), since the eval org's token has no Copilot access;
// gh and git in the agent's shell use the eval token through hosts.yml. GH_TOKEN
// stays unset, because Copilot would take it over its own login.

import { copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { claude } from './cli.mjs';

const GUARD = join(dirname(fileURLToPath(import.meta.url)), 'egress-guard.mjs');
const COPILOT_CONFIG = join(homedir(), '.copilot/config.json');

// `copilot` resolved on the runner's PATH (or COPILOT_BIN), then followed to
// its real install, which is mounted back into the sandbox.
let copilotBin = '';
export function resolveCopilot() {
  if (copilotBin) return copilotBin;
  let bin = process.env.COPILOT_BIN;
  if (!bin) {
    const r = spawnSync('sh', ['-c', 'command -v copilot'], { encoding: 'utf8' });
    bin = r.status === 0 ? r.stdout.trim() : '';
  }
  if (!bin) throw new Error('copilot CLI not found: put it on PATH or set COPILOT_BIN');
  copilotBin = realpathSync(bin);
  return copilotBin;
}

/** The directory to mount for a resolved binary: its npm package root when it has one. */
function installRoot(bin) {
  // A standalone npm prefix (<root>/npm/lib/node_modules/...): mount <root>.
  const j = bin.lastIndexOf('/npm/');
  if (j >= 0) return bin.slice(0, j);
  const i = bin.lastIndexOf('/node_modules/');
  return i >= 0 ? bin.slice(0, i) : dirname(bin);
}

/** @param {string} home @param {string} ghToken @param {string} ghUser */
function writeHome(home, ghToken, ghUser) {
  for (const d of ['.copilot/hooks', '.config/gh']) mkdirSync(join(home, d), { recursive: true });
  writeFileSync(join(home, '.gitconfig'), [
    '[user]', '\tname = eval agent', '\temail = agent@example.invalid',
    '[credential "https://github.com"]', '\thelper =', '\thelper = !gh auth git-credential', '',
  ].join('\n'));
  writeFileSync(join(home, '.config/gh/config.yml'), 'version: "1"\n');
  // gh 2.4x's multi-account layout; without `user` it tries to migrate the file.
  writeFileSync(join(home, '.config/gh/hosts.yml'), [
    'github.com:', `    oauth_token: ${ghToken}`, `    user: ${ghUser}`, '    git_protocol: https',
    '    users:', `        ${ghUser}:`, `            oauth_token: ${ghToken}`, '',
  ].join('\n'), { mode: 0o600 });
  // Copied as bytes: the file is JSONC that Copilot manages.
  copyFileSync(COPILOT_CONFIG, join(home, '.copilot/config.json'));
}

/**
 * @param {{dir: string, home: string, tmp: string, model: string, effort: string, prompt: string, pluginDirs: string[],
 *   denyReadTool: string[], limitS: number, ghToken: string, ghUser: string, slug: string, workRoot: string, sourceOwner: string}} o
 */
export async function runCopilot({ dir, home, tmp, model, effort, prompt, pluginDirs, denyReadTool, limitS, ghToken, ghUser, slug, workRoot, sourceOwner }) {
  const bin = resolveCopilot();
  writeHome(home, ghToken, ghUser);
  // The repo's code is hidden from the sandbox, so the guard runs from the agent's home.
  const guard = join(home, 'egress-guard.mjs');
  copyFileSync(GUARD, guard);
  writeFileSync(join(home, '.copilot/hooks/egress.json'), JSON.stringify({ version: 1, hooks: { PreToolUse: [{
    type: 'command', matcher: 'Bash', timeoutSec: 10,
    bash: ['node', guard, slug, ...denyReadTool].map(a => JSON.stringify(a)).join(' '),
  }] } }, null, 2));
  const usageFile = join(tmp, 'copilot-usage.json');

  const copilotArgs = [
    '-p', prompt, '--model', model, '--reasoning-effort', effort,
    '--allow-all', '--autopilot', '--max-autopilot-continues', '20', '--no-ask-user',
    '--no-auto-update', '--disable-builtin-mcps',
    '--excluded-tools', 'web_fetch', 'web_search',
    '--deny-url', `github.com/${sourceOwner}`,
    '--output-format', 'json', '--usage-output-file', usageFile,
    ...pluginDirs.flatMap(p => ['--plugin-dir', p]),
  ];
  const root = installRoot(bin);
  const bwrap = [
    '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc',
    '--tmpfs', homedir(), '--tmpfs', workRoot,
    '--ro-bind', root, root,
    '--bind', dir, dir, '--bind', home, home, '--bind', tmp, tmp,
    ...pluginDirs.flatMap(p => ['--ro-bind', p, p]),
    '--chdir', dir, '--die-with-parent', '--clearenv',
    '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin', '--setenv', 'HOME', home,
    '--setenv', 'COPILOT_HOME', join(home, '.copilot'), '--setenv', 'GH_CONFIG_DIR', join(home, '.config/gh'),
    '--setenv', 'TMPDIR', tmp, '--setenv', 'COPILOT_AUTO_UPDATE', 'false',
    '--setenv', 'GH_PROMPT_DISABLED', '1', '--setenv', 'GIT_TERMINAL_PROMPT', '0',
    '--setenv', 'LANG', 'C.UTF-8', '--setenv', 'TERM', 'dumb',
    '--', bin, ...copilotArgs,
  ];
  const events = [];
  const r = await claude({
    bin: 'bwrap', args: bwrap, cwd: dir, env: { PATH: '/usr/local/bin:/usr/bin:/bin' }, limitS,
    onLine: line => {
      if (!line.trim()) return;
      try { events.push(JSON.parse(line)); } catch { events.push({ type: 'unparsed', line: line.slice(0, 2000) }); }
    },
  });
  let usage = null;
  try { usage = JSON.parse(readFileSync(usageFile, 'utf8')); } catch {}
  return { events, code: r.code, stderr: r.stderr, timedOut: r.timedOut, usage };
}
