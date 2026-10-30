#!/usr/bin/env node
// PreToolUse hook on the agent's Bash calls, set in the eval's own settings
// (not the plugin under test), so it also runs in subagents and Workflow
// agents. The source repository is public and the agent's GitHub token is the
// human's, so the agent can learn the owner's name from any issue it views.
// This denies the routes from the replay to other repositories' code: GitHub
// search, gh and git aimed at another repo, and curl or wget to GitHub. It
// reads command text, so a determined agent could get past it; the runner's
// scan of tool results is the second layer.
//
//   node egress-guard.mjs <replay owner/name>   (hook JSON on stdin)

import { readFileSync } from 'node:fs';

const slug = String(process.argv[2] ?? '').toLowerCase();

/** @param {string} command @returns {string | null} why the command is denied, or null */
export function verdict(command, allowed) {
  const cmd = command.toLowerCase();
  if (/\bgh\s+search\b/.test(cmd)) return 'GitHub search reaches other repositories';
  if (/\bgh\s+api\b[^\n;&|]*\bsearch\//.test(cmd)) return 'GitHub search reaches other repositories';
  if (/\b(curl|wget)\b[^\n;&|]*github(usercontent)?\.com/.test(cmd)) return 'use gh on this repository instead of fetching GitHub directly';
  if (/\bgh\s+repo\s+(clone|fork|list)\b/.test(cmd)) return 'only this repository is in scope';
  const named = [
    ...cmd.matchAll(/\brepos\/([\w.-]+\/[\w.-]+)/g),
    ...cmd.matchAll(/(?:^|\s)(?:-r|--repo)[=\s]+["']?([\w.-]+\/[\w.-]+)/g),
    ...cmd.matchAll(/\bgh\s+repo\s+\w+\s+["']?([\w.-]+\/[\w.-]+)/g),
    ...cmd.matchAll(/github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?(?=[\s"'/#?]|$)/g),
  ].map(m => m[1].replace(/\.git$/, ''));
  const other = named.find(r => r !== allowed);
  if (other) return `${other} is not this repository (${allowed})`;
  return null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let input = null;
  try { input = JSON.parse(readFileSync(0, 'utf8')); } catch {}
  const command = input?.tool_input?.command;
  const why = typeof command === 'string' && slug ? verdict(command, slug) : null;
  if (why) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny',
      permissionDecisionReason: `Out of scope for this task: ${why}. Work only in this repository.`,
    } }));
  }
  process.exit(0);
}
