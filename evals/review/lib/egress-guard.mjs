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
// It also denies a command that names an answer-key path (the human's home,
// this checkout, the plugin copy), so nothing the sandbox fails to cover runs
// against them (#39, conv-pr38-halt rep 2 ran `HOME=/home/<human> git ...`).
//
//   node egress-guard.mjs <replay owner/name> [answer-key path ...]   (hook JSON on stdin)

import { readFileSync } from 'node:fs';

const slug = String(process.argv[2] ?? '').toLowerCase();
const answerKeys = process.argv.slice(3);

const escape = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @param {string} command @param {string} allowed the replay's owner/name
 * @param {string[]} [keys] absolute paths the agent must not touch
 * @returns {string | null} why the command is denied, or null
 */
export function verdict(command, allowed, keys = []) {
  // A key counts only as a whole path: /home/u matches /home/u and /home/u/x, not /home/u2.
  const key = keys.find(k => k && new RegExp(`${escape(k)}(?![\\w.-])`).test(command));
  if (key) return `${key} is outside this task's sandbox`;
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
  const why = typeof command === 'string' && slug ? verdict(command, slug, answerKeys) : null;
  if (why) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny',
      permissionDecisionReason: `Out of scope for this task: ${why}. Work only in this repository.`,
    } }));
  }
  process.exit(0);
}
