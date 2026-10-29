> Superseded by ADR-0005 (2026-10-28, #3). Archived: human-managed, not read by agents.

# 0001: A deterministic core decides what counts; the model decides what is wrong

Date: 2026-10-27 · Status: accepted

## Context

The quality loop must run unattended for many rounds without accepting hallucinated findings, without "fixing" code into regressions, without looping forever and without losing its place when the context is summarised. A loop driven only by prompts leaves every one of those to the model's judgement on every run.

## Decision

Split responsibility:

- **Model (skills + subagents):** find defects, judge them, fix them, investigate root causes. Variable, creative work.
- **`ql` (dependency-free Node CLI):** everything that must behave the same every run — evidence checks (quote at file:line), deduplication by tracking each finding's lines through the diff between snapshot trees (ADR 0002), quorum tallying, regression detection against the round's start, weakened-test detection, checkpoints and automatic revert, round cap, stall/oscillation/divergence detection, eval grading, splits, intervals and keep/revert decisions.
- **Hooks:** enforcement that must hold even when the model forgets — destructive-command and protected-file guard, bounded Stop continuation, context re-injection after compaction. Classic hooks (portable, unit-tested through `ql hook`), not the mod.
- **Mod:** visibility only (status band, `/loop-status`, toasts).

The orchestrating session is the **single writer** of loop state; subagents return JSON files.

## Consequences

- Every safeguard is testable with `node --test` on throwaway git repos, without a model.
- Phases are derived from state (`phaseOf`), so `ql` refuses out-of-order commands and `ql next` can always say what to do.
- The plugin needs Node ≥ 20 on the machine. Claude Code's own install usually provides it.
- Checkpoints use git plumbing with a temporary index, so a repository must be a git repository with at least one commit.
