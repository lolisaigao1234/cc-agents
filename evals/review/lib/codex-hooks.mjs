#!/usr/bin/env node
// Trusted eval-only translation. This file runs outside Codex's command sandbox;
// its source, policy, auth, and plugin runtime are denied to model-controlled tools.
import { appendFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verdict } from './egress-guard.mjs';

/** @type {Record<string, string>} */
const events = { PreToolUse: 'pre-tool-use', PostToolUse: 'post-tool-use', SessionStart: 'session-start',
  SubagentStart: 'subagent-start', PostCompact: 'post-compact', UserPromptSubmit: 'user-prompt-submit', Stop: 'stop' };
/** @param {string} reason */
const deny = reason => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
/** @param {string} patch @param {string} cwd */
export function patchPaths(patch, cwd) {
  const paths = [];
  if (!patch.startsWith('*** Begin Patch\n') || !patch.trimEnd().endsWith('*** End Patch')) throw new Error('unrecognized patch format');
  for (const line of patch.split('\n')) {
    const m = /^\*\*\* (?:Update File|Add File|Delete File|Move to): (.+)$/.exec(line);
    if (m) paths.push(resolve(cwd, m[1]));
  }
  if (!paths.length) throw new Error('patch has no recognized file paths');
  return [...new Set(paths)];
}

/** @param {any} input */
export function readInputs(input) {
  // Only a single plain cat of a literal path, with a verified complete model-
  // visible result, earns a file read. head/sed/rg/truncated results earn none.
  const cmd = input.tool_input?.command ?? '';
  const m = /^\s*cat\s+(?:--\s+)?(?:'([^'\n]+)'|"([^"$`\n]+)"|([^\s;&|<>$`"'\\]+))\s*$/.exec(cmd);
  if (!m || input.tool_name !== 'Bash') return [];
  const response = input.tool_response;
  const out = typeof response === 'string' ? response : response?.stdout ?? response?.output ?? '';
  if (typeof out !== 'string' || /(?:truncat(?:ed|ion)|tokens truncated|Output too large)/i.test(out)) return [];
  const path = resolve(input.cwd, m[1] ?? m[2] ?? m[3]);
  let content;
  try { content = readFileSync(path, 'utf8'); } catch { return []; }
  const normalized = content.replace(/\r\n/g, '\n');
  if (out !== content && !out.endsWith(`\n${content}`)) return [];
  const n = normalized.split('\n').length;
  return [{ ...input, tool_name: 'Read', tool_input: { file_path: path },
    tool_response: { file: { filePath: path, content: normalized, startLine: 1, numLines: n, totalLines: n } } }];
}

/** @param {string} event @param {any} input @param {any} policy @param {(event: string, input: any) => any} invoke */
export function handleHook(event, input, policy, invoke) {
  const base = { ...input, agent_id: input.agent_id ?? 'main', session_id: input.session_id ?? input.thread_id,
    cwd: input.cwd ?? policy.dir };
  if (!base.session_id) throw new Error('Codex hook input has no session identity');
  /** @param {string} name @param {any} normalized */
  const trace = (name, normalized) => {
    const out = invoke(name, normalized);
    // Codex rejects Claude's top-level halt fields on PreToolUse. Keep only
    // the supported deny shape, including for each file in a patch.
    return event === 'PreToolUse' && out?.continue === false
      ? deny(String(out.hookSpecificOutput?.permissionDecisionReason ?? out.stopReason ?? 'trace halted')) : out;
  };
  if (event === 'PostModelRequest') return null; // Active slug is diagnostic, never served-model proof.
  if (event === 'PreToolUse') {
    if (policy.role === 'judge') return deny('The eval judge has no tools. Grade only the supplied material.');
    if (base.tool_name === 'Bash') {
      const why = verdict(String(base.tool_input?.command ?? ''), policy.slug, policy.denied);
      if (why) return deny(why);
    } else if (base.tool_name === 'apply_patch') {
      if (policy.role === 'review') return deny('The reviewer inspects code without changing it.');
      for (const path of patchPaths(String(base.tool_input?.command ?? ''), base.cwd)) {
        const rel = relative(policy.dir, path);
        if (rel.startsWith('..') || isAbsolute(rel)) return deny('Patch paths must stay in the replay repository.');
        const out = trace(events[event], { ...base, tool_name: 'Edit', tool_input: { file_path: path } });
        if (out) return out;
      }
      return null;
    }
  }
  if (event === 'PostToolUse' && policy.trace) {
    // Preserve gh/git output evidence in the original trace implementation.
    const r = base.tool_response;
    if (base.tool_name === 'Bash') {
      const shown = typeof r === 'string' ? r : r?.stdout ?? r?.output;
      if (typeof shown === 'string') base.tool_response = { stdout: shown };
    }
    const out = trace(events[event], base);
    for (const read of readInputs({ ...base, tool_response: r })) trace(events[event], read);
    return out;
  }
  return events[event] && policy.trace ? trace(events[event], base) : null;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const event = process.argv[2], policy = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  const input = JSON.parse(readFileSync(0, 'utf8'));
  let out;
  try {
    out = handleHook(event, input, policy, (name, normalized) => {
      const r = spawnSync(process.execPath, [join(policy.trace, 'scripts/hook.mjs'), name], {
        input: JSON.stringify(normalized), encoding: 'utf8', timeout: 25000, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: policy.trace },
      });
      if (r.error || (r.status !== 0 && r.status !== 2) || /trace hook:/.test(r.stderr ?? '')) throw new Error('trace hook could not execute');
      return r.stdout.trim() ? JSON.parse(r.stdout) : null;
    });
    appendFileSync(policy.ledger, JSON.stringify({ event, tool: input.tool_name, input: input.tool_input,
      response: event === 'PostToolUse' ? input.tool_response : undefined,
      active_model: input.model, token_usage: event === 'PostModelRequest' ? input.token_usage : undefined,
      decision: out }) + '\n', { mode: 0o600 });
  } catch (e) {
    appendFileSync(policy.ledger, JSON.stringify({ event, hook_error: String(e instanceof Error ? e.message : e) }) + '\n');
    out = event === 'PreToolUse' ? deny('Eval hook failed; stop this attempt.') : { continue: false, stopReason: 'Eval hook failed; stop this attempt.' };
  }
  if (out) process.stdout.write(JSON.stringify(out));
}
