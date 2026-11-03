// Codex exec usage is per completed turn: cached input is a subset of input;
// reasoning is a subset of output. Never add hook diagnostics to these totals.
/** @param {any} raw @returns {Record<string, any> | null} */
export function codexUsage(raw) {
  if (!raw || !['input_tokens', 'output_tokens'].every(k => Number.isFinite(raw[k]) && raw[k] >= 0)) return null;
  const cached = raw.cached_input_tokens;
  if (cached != null && (!Number.isFinite(cached) || cached < 0 || cached > raw.input_tokens)) return null;
  return { input_tokens: raw.input_tokens - (cached ?? 0), output_tokens: raw.output_tokens,
    cache_read_input_tokens: cached ?? 0, cache_creation_input_tokens: 0,
    coverage: cached == null ? 'cache_breakdown_missing' : 'cache_write_breakdown_missing',
    ...(Number.isFinite(raw.reasoning_output_tokens) ? { reasoning_output_tokens: raw.reasoning_output_tokens } : {}) };
}
/** @param {Array<Record<string, any> | null | undefined>} usages @returns {Record<string, any> | null} */
export function sumUsage(usages) {
  if (!usages.length || usages.some(u => !u)) return null;
  /** @type {Record<string, any>} */
  const out = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, coverage: 'cache_write_breakdown_missing' };
  for (const u of usages) for (const k of Object.keys(out)) if (typeof out[k] === 'number') out[k] += u?.[k] ?? 0;
  return out;
}

/** @param {any[]} events @param {RegExp} [leak] @param {RegExp} [seen] */
export function codexDigest(events, leak = /$^/, seen = /$^/) {
  const items = new Map(), completed = new Set(), usages = [], served = new Set(), leaks = [], turns = [], material = [];
  let failed = false, terminal = false, lastType = null, malformed = false;
  /** @param {RegExp} re @param {string} text */
  const test = (re, text) => { re.lastIndex = 0; return re.test(text); };
  // Scan updates too: a later completed item must not erase an earlier leak.
  for (const e of events) {
    if (e.type === 'unparsed') malformed = true;
    if (e.type === 'turn.started') { terminal = false; lastType = 'started'; }
    if (['turn.failed', 'error'].includes(e.type)) { failed = true; lastType = 'failed'; }
    if (e.type === 'turn.completed') {
      terminal = true; lastType = 'completed';
      const key = e.turn_id ?? `anonymous-${usages.length}`;
      if (!completed.has(key)) { completed.add(key); usages.push(codexUsage(e.usage)); }
      if (typeof e.model === 'string') served.add(e.model);
    }
    if (e.type === 'response.completed' && typeof e.response?.model === 'string') served.add(e.response.model);
    if (e.item && e.type?.startsWith('item.')) {
      const raw = JSON.stringify(e.item);
      // Owner names legitimately occur in replay authorship. Like the Claude
      // digest, apply the broad reach-for-key rule only to tool inputs; output
      // and feedback use the source-repository evidence rule.
      const input = e.item.command ?? e.item.arguments ?? e.item.input ?? e.item.query ?? e.item.changes;
      if (e.item.type !== 'reasoning' && ((input != null && test(leak, JSON.stringify(input))) || test(seen, raw))) leaks.push(raw.slice(0, 500));
      if (e.item.id) items.set(e.item.id, e.item);
      else malformed = true;
    }
  }
  const tools = new Set(['command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'tool_call']);
  for (const item of items.values()) {
    if (item.type === 'agent_message') { turns.push({ role: 'assistant', content: item.text ?? '' }); material.push(item.text ?? ''); }
    else if (item.type !== 'reasoning') turns.push({ role: 'tool_result', name: item.type, content: JSON.stringify(item) });
  }
  return { turns, material, leaks, servedMain: [...served], usage: sumUsage(usages), raw_usage: events.filter(e => e.type === 'turn.completed').map(e => e.usage),
    complete: terminal && lastType === 'completed' && !failed && !malformed, malformed,
    counts: { tool_calls: [...items.values()].filter(i => tools.has(i.type)).length, hook_denials: null, refusals: null, max_tokens_hits: null,
      bug_reviews: 0, std_reviews: 0 },
    final: [...items.values()].filter(i => i.type === 'agent_message').at(-1)?.text ?? null };
}
