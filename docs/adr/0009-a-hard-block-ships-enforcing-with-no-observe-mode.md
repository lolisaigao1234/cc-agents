---
status: accepted
date: 2026-11-27
issue: "#60"
---

# 0009: A hard block ships enforcing; there is no observe mode

The trace has no observe mode: no setting under which a gate, the guard or the archive block records what it would have refused and lets the call through. A new hard block is proved before it ships, by its tests and by the `verify` skill (`.claude/skills/verify`), which drives the real hooks the way Claude Code calls them. Then it ships enforcing, or it does not ship. This follows ADR 0006, which rejected notices instead of blocks: a refusal that is only recorded is a notice that not even the model sees.

## Considered options

- **An observe mode for a new hard block**, recording its would-be refusals for the human to read before it starts refusing: rejected by the human (#60), in line with ADR 0006: a hard block blocks or does not ship. While it observes, the calls it exists to refuse go through.

## Consequences

- Every hard block the hooks have stays enforcing.
- A new hard block's proof is its tests and the calls it adds to `CALLS` in the verify skill's `drive-hooks.mjs`: what it refuses and what it lets through, as the real hooks return them.
- A refusal its tests and the verify skill did not foresee is found after it ships, and fixed through the trace like any other bug. Until then, the human gets past it the way its deny names: the bypass (ADR 0006) for the trace's branch, reference and forced-read rules, and by hand for the rest, which hold under the bypass (the guard, the archive block, which leaves the archive to the human alone (ADR 0008), and the refusals to change Claude Code's settings or the trace's own records).
