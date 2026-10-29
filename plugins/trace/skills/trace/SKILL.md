---
name: trace
description: The trace, the pipeline every change in a traced repository follows (Read → Track → Branch → Implement → Review → Update → Close). Use when starting, resuming or finishing a change, or when a trace hook denies an action.
---

# The trace

Every change, code or docs or config, ties to one GitHub issue from start to finish. In a traced repository (one with `.claude/trace.json`), hooks refuse actions that break the chain, and each refusal names the step to go back to.

| Step | Do it with | Done when |
|---|---|---|
| **Read** | the related docs: `GLOSSARY.md`, every active ADR (one with `applies-to:` for an edit of the paths it names, every one at a commit), and, once you are on its branch, the linked issue with its comments and the `docs/` files it links | no gate lists a doc as unread or stale for this agent: its own full reads, made since its last compaction (the band shows the main session's) |
| **Track** | `gh issue create` with an `## Acceptance criteria` section; `mattpocock-skills:grilling` first when the change is unclear. To split larger work, ask the human to run `/to-spec` and `/to-tickets` | an open issue states what to build and how to verify it |
| **Branch** | `gh issue develop <n> --checkout`, with `--base <blocker's branch>` while the blocker's PR awaits merge | you are on `<n>-<slug>` |
| **Implement** | `mattpocock-skills:tdd`; `mattpocock-skills:diagnosing-bugs` for a hard bug. The human may run `/implement <n>` instead | every acceptance criterion passes and every commit message carries `#<n>` |
| **Review** | `/code-review` for bugs, and `mattpocock-skills:code-review` since the branch's base (the default branch, or the blocker's branch while stacked) for standards and spec, with `GLOSSARY.md` and the active ADRs among its standards; then `mattpocock-skills:pr` for the body | a PR whose body says `Closes #<n>` |
| **Update** | `gh issue comment <n>` | the issue shows this round's progress, decisions and verification |
| **Close** | the human merges | the issue is closed by its PR, or closed with a state reason and a comment |

Review and fix run in rounds. Answer every finding with a fix or, in the progress comment, a reason. Fix the finding's whole class. After the first round, review only the new diff. After three rounds, step back: reconsider the approach and ask the human before a fourth.

The issue is the source of truth across compaction, resumes and subagents: when memory and the issue disagree, reread the issue.

Merging is the human's step. Your work is done when the PR is ready for review.

Only the human can switch the trace off, by launching Claude Code with `TRACE_BYPASS=1`. When GitHub cannot be reached, say so and ask.
