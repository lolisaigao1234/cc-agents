---
name: trace
description: The trace, the pipeline every change in a traced repository follows (Read → Track → Branch → Implement → Review → Update → Close). Use when starting, resuming or finishing a change, or when a trace hook denies an action.
---

# The trace

Every change, code or docs or config, ties to one GitHub issue from start to finish. In a traced repository (one with `.claude/trace.json`), hooks refuse actions that break the chain, and each refusal names the step to go back to.

| Step | Do it with | Done when |
|---|---|---|
| **Read** | `GLOSSARY.md` and the ADRs the change touches | you can name the decisions that bind the change |
| **Track** | `to-tickets`, or `grilling` then `to-spec` first when the change is unclear | an open issue states what to build and how to verify it |
| **Branch** | `gh issue develop <n> --checkout`, with `--base <blocker's branch>` while the blocker's PR awaits merge | you are on `<n>-<slug>` |
| **Implement** | `implement` and `tdd`; `diagnosing-bugs` for a hard bug | every acceptance criterion passes and every commit message carries `#<n>` |
| **Review** | `/code-review` for bugs, Matt's `code-review` for standards and spec, then `pr` for the body | a PR whose body says `Closes #<n>` |
| **Update** | `gh issue comment <n>` | the issue shows this round's progress, decisions and verification |
| **Close** | the human merges | the issue is closed by its PR, or closed with a state reason and a comment |

The issue is the source of truth across compaction, resumes and subagents: when memory and the issue disagree, reread the issue.

Merging is the human's step. Your work is done when the PR is ready for review.

Only the human can switch the trace off, by launching Claude Code with `TRACE_BYPASS=1`. When GitHub cannot be reached, say so and ask.
