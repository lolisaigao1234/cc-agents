// Turns `claude -p --output-format stream-json` events into the report's
// transcript shape, the review material the judge reads, and the per-case counts.

const CLIP = 20_000;
const clip = (s, n = CLIP) => (s.length > n ? `${s.slice(0, n / 2)}\n[... ${s.length - n} chars cut ...]\n${s.slice(-n / 2)}` : s);

const textOf = c => typeof c === 'string' ? c
  : Array.isArray(c) ? c.map(b => b?.type === 'text' ? b.text : b?.type === 'tool_reference' ? `[tool ${b.tool_name}]` : '').join('\n')
  : JSON.stringify(c);

// A bug review is Claude Code's /code-review; Matt's skill reviews standards and spec.
const isBugReview = input => /^\/?code-review\b/.test(String(input?.skill ?? input?.command ?? '').trim());
const isStdReview = input => /mattpocock-skills:code-review/.test(String(input?.skill ?? input?.command ?? ''));
const HOOK_DENY = /PreToolUse:\S+ hook|hook (error|denied|blocking)|blocked by .*hook/i;

/** @param {any[]} events @param {RegExp} leak */
export function digest(events, leak) {
  const turns = [];
  const material = [];
  const servedMain = new Set();
  const counts = { tool_calls: 0, hook_denials: 0, refusals: 0, max_tokens_hits: 0, bug_reviews: 0, std_reviews: 0 };
  const leaks = [];
  const toolNames = new Map();
  let result = null, init = null;

  for (const ev of events) {
    const sub = ev.parent_tool_use_id != null;
    const tag = sub ? 'sub:' : '';
    if (ev.type === 'system' && ev.subtype === 'init') {
      init = ev;
      turns.push({ role: 'system', content: `model ${ev.model}; plugins ${JSON.stringify(ev.plugins ?? [])}; skills ${JSON.stringify(ev.skills ?? [])}` });
    } else if (ev.type === 'assistant') {
      const m = ev.message ?? {};
      if (!sub && m.model) servedMain.add(m.model);
      if (m.stop_reason === 'refusal') counts.refusals++;
      if (m.stop_reason === 'max_tokens') counts.max_tokens_hits++;
      for (const b of m.content ?? []) {
        if (b.type === 'text' && b.text?.trim()) {
          turns.push({ role: 'assistant', content: sub ? `[subagent] ${b.text}` : b.text });
          material.push(`${sub ? '[subagent] ' : ''}${b.text}`);
        } else if (b.type === 'tool_use') {
          counts.tool_calls++;
          toolNames.set(b.id, b.name);
          const input = JSON.stringify(b.input ?? {}, null, 2);
          if (leak.test(input)) leaks.push(`${b.name}: ${input.slice(0, 300)}`);
          if (b.name === 'Skill' && isBugReview(b.input)) {
            counts.bug_reviews++;
            material.push(`=== REVIEW ROUND ${counts.bug_reviews} (/code-review) ===`);
          } else if (b.name === 'Skill' && isStdReview(b.input)) {
            counts.std_reviews++;
            material.push(`=== standards and spec review (${counts.std_reviews}) ===`);
          } else if (b.name === 'Bash' && /\bgh\b.*\b(comment|review|pr (create|edit))\b/.test(b.input?.command ?? '')) {
            material.push(`[agent posts to GitHub]\n${clip(b.input.command, 8000)}`);
          }
          turns.push({ role: 'tool_call', name: `${tag}${b.name}`, content: clip(input, 8000) });
        }
      }
    } else if (ev.type === 'user') {
      const c = ev.message?.content;
      if (typeof c === 'string') { turns.push({ role: 'user', content: c }); continue; }
      for (const b of c ?? []) {
        if (b.type === 'text') turns.push({ role: 'user', content: b.text });
        if (b.type !== 'tool_result') continue;
        const body = textOf(b.content);
        if (b.is_error && HOOK_DENY.test(body)) counts.hook_denials++;
        const name = toolNames.get(b.tool_use_id);
        // Subagent reports and skill output carry the findings.
        if (name === 'Agent' || name === 'Task' || name === 'Skill') material.push(`[${name} result]\n${clip(body, 12_000)}`);
        turns.push({ role: 'tool_result', content: clip(body) });
      }
    } else if (ev.type === 'result') {
      result = ev;
      if (ev.result) turns.push({ role: 'assistant', content: `[final] ${ev.result}` });
    }
  }
  return { turns, material, servedMain: [...servedMain], counts, leaks, result, init };
}

export { clip };
