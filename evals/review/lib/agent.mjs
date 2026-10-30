// Runs the agent under test: `claude -p` in the replay clone, with the trace
// plugin variant and Matt's skills, under a throwaway HOME and Claude Code's
// sandbox. The sandbox denies reads of this checkout, the installed plugins and
// the plugin copies, which hold the fixes to the bugs being replayed.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { baseEnv, claude } from './cli.mjs';

const NETWORK = ['github.com', 'api.github.com', 'codeload.github.com', '*.githubusercontent.com', 'registry.npmjs.org'];

/**
 * @param {{dir: string, home: string, model: string, prompt: string, pluginDirs: string[],
 *   denyRead: string[], allowRead: string[], denyReadTool: string[], limitS: number, budgetUsd: number, oauth: string, ghToken: string}} o
 */
export async function runAgent({ dir, home, model, prompt, pluginDirs, denyRead, allowRead, denyReadTool, limitS, budgetUsd, oauth, ghToken }) {
  const env = {
    ...baseEnv(home, oauth),
    GH_TOKEN: ghToken, GH_CONFIG_DIR: join(home, '.config/gh'), GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0',
  };
  writeFileSync(join(home, '.gitconfig'), [
    '[user]', '\tname = eval agent', '\temail = agent@example.invalid',
    '[credential "https://github.com"]', '\thelper =', '\thelper = !gh auth git-credential', '',
  ].join('\n'));
  const settings = join(home, 'eval-settings.json');
  writeFileSync(settings, JSON.stringify({
    permissions: {
      // Read rules cannot carve out the agent's own clone, so they name only
      // the answer-key paths; the sandbox below covers Bash more widely.
      deny: ['WebFetch', 'WebSearch', ...denyReadTool.map(p => `Read(/${p}/**)`)],
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      // Writes stay in the clone and the throwaway HOME; the plugin copies and the
      // other cases' clones (later snapshots hold earlier cases' fixes) are unreadable.
      filesystem: { denyRead, allowRead, allowWrite: [dir, home] },
      network: { allowedDomains: NETWORK },
    },
  }, null, 2));

  const args = [
    '-p', prompt, '--model', model,
    '--output-format', 'stream-json', '--verbose',
    '--settings', settings, '--strict-mcp-config', '--no-session-persistence',
    '--permission-mode', 'bypassPermissions',
    '--max-budget-usd', String(budgetUsd),
    ...pluginDirs.flatMap(p => ['--plugin-dir', p]),
  ];
  const events = [];
  const r = await claude({
    args, cwd: dir, env, limitS,
    onLine: line => {
      if (!line.trim()) return;
      try { events.push(JSON.parse(line)); } catch { events.push({ type: 'unparsed', line: line.slice(0, 2000) }); }
    },
  });
  return { events, code: r.code, stderr: r.stderr, timedOut: r.timedOut };
}
