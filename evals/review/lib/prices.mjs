// Per-MTok prices, first-party. Cache writes are 1.25x input; reads as listed.
// Cost is derived from each row's model x usage, never taken from the CLI.
export const PRICES = {
  'claude-fable-5-1': { in: 10, out: 50, cacheRead: 0.25 },
  'claude-opus-5-5': { in: 4, out: 20, cacheRead: 0.2 },
  'claude-sonnet-5-5': { in: 2, out: 10, cacheRead: 0.2 },
  // Haiku 5.5 is $0.10/$0.50 at prompts of 100K tokens or fewer; review subagents stay under that.
  'claude-haiku-5-5': { in: 0.1, out: 0.5, cacheRead: 0.01 },
};

export function priceOf(model) {
  const key = Object.keys(PRICES).find(k => String(model).startsWith(k));
  return key ? PRICES[key] : null;
}

/** usage in API shape: input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens */
export function costOf(model, u) {
  const p = priceOf(model);
  if (!p || !u) return null;
  return ((u.input_tokens ?? 0) * p.in + (u.output_tokens ?? 0) * p.out
    + (u.cache_read_input_tokens ?? 0) * p.cacheRead + (u.cache_creation_input_tokens ?? 0) * p.in * 1.25) / 1e6;
}

// The CLI's result.modelUsage is camelCase per model; convert to API shape.
export function apiUsage(mu) {
  return {
    input_tokens: mu.inputTokens ?? 0, output_tokens: mu.outputTokens ?? 0,
    cache_read_input_tokens: mu.cacheReadInputTokens ?? 0, cache_creation_input_tokens: mu.cacheCreationInputTokens ?? 0,
  };
}
