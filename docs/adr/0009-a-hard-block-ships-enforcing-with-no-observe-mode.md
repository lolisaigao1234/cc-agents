---
status: accepted
date: 2026-11-27
issue: "#60"
---

# 0009: A hard block ships enforcing; there is no observe mode

The trace has no observe mode: no setting under which a gate, the guard or the archive block records what it would have refused and lets the call through. A new hard block is proved before it ships, by its tests and by the `verify` skill (`.claude/skills/verify`), which drives the real hooks the way Claude Code calls them. Then it ships enforcing, or it does not ship. This follows ADR 0006, which rejected notices instead of blocks: a refusal that is only recorded is a notice that not even the model sees.

## Considered options

- **An observe mode for a new hard block**, recording its would-be refusals for the human to read before it starts refusing: rejected by the human (#60). While it observes, the calls it exists to refuse go through.

## Consequences

- Every hard block the hooks have stays enforcing.
- A new hard block's proof is its tests and the calls it adds to `CALLS` in the verify skill's `drive-hooks.mjs`: what it refuses and what it lets through, as the real hooks return them.
- A refusal its tests and the verify skill did not foresee is found after it ships, and fixed through the trace like any other bug. Until then, the human's way past a gate is the bypass (ADR 0006); the guard and the archive block hold under it, so past the guard the human runs the command themselves, and the archive the human works in alone (ADR 0008).
