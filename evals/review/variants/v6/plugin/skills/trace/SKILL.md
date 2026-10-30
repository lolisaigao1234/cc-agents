---
name: trace
description: The trace, the pipeline every change in a traced repository follows (Read → Track → Branch → Implement → Review → Update → Close). Use when starting, resuming or finishing a change, or when a trace hook denies an action or halts the session.
---

# The trace

Every change, code or docs or config, ties to one GitHub issue from start to finish. In a traced repository (one with `.claude/trace.json`), hooks refuse actions that break the chain, and each refusal names the step to go back to.

| Step | Do it with | Done when |
|---|---|---|
| **Read** | the related docs: `GLOSSARY.md`, every active ADR under `docs/adr/`, and, on the issue's branch, the issue with its comments and the `docs/` files it links. Read each in full yourself, in every agent and after every compaction | no gate lists a doc as unread or stale for this agent (the band shows the main session's reads) |
| **Track** | `gh issue create` with an `## Acceptance criteria` section; `mattpocock-skills:grilling` first when the change is unclear. To split larger work, ask the human to run `/to-spec` and `/to-tickets` | an open issue states what to build and how to verify it |
| **Branch** | `gh issue develop <n> --checkout`, with `--base <blocker's branch>` while the blocker's PR awaits merge | you are on `<n>-<slug>` |
| **Implement** | `mattpocock-skills:tdd`; `mattpocock-skills:diagnosing-bugs` for a hard bug. The human may run `/implement <n>` instead | every acceptance criterion passes and every commit message carries `#<n>` |
| **Review** | `/code-review` for bugs, and `mattpocock-skills:code-review` since the branch's base (the default branch, or the blocker's branch while stacked) for standards and spec, with `GLOSSARY.md` and the active ADRs among its standards; then `mattpocock-skills:pr` for the body | a PR whose body says `Closes #<n>` |
| **Update** | `gh issue comment <n>` | the issue shows this round's progress, decisions and verification |
| **Close** | the human merges | the issue is closed by its PR, or closed with a state reason and a comment |

Review and fix run in rounds. Answer every finding with a fix or, in the progress comment, a reason. Fix the finding's whole class. One round is the default: review again after fixes only when the change is high risk (a miss would make a hook block, halt or let through the wrong thing, or lose work) or a fix answered a real bug rather than a nit. Rounds one and two review the whole PR diff; later rounds review only the diff since the last reviewed commit. After three rounds, step back and reconsider the approach: a hook refuses a fourth round until the human replies.

Keep the findings in one PR comment (`gh pr comment <pr> --edit-last --create-if-none`), each marked open, cleared or answered (with the reason). Your own fix does not clear a finding: after fixing, and before each re-review, a fresh subagent checks every open finding against the new HEAD and clears only those it finds gone. Give each re-review the answered findings in its arguments and ask it not to repeat them unless it shows an answer was wrong. Do not raise again a finding already posted and answered, unless the new round shows the answer was wrong.

A review covers the commit it ran on. Commits after the last review leave the PR unreviewed: review them, or say in the progress comment why they need none. A hook reminds you once per commit.

The issue is the source of truth across compaction, resumes and subagents: when memory and the issue disagree, reread the issue.

Merging is the human's step. Your work is done when the PR is ready for review.

Only the human can switch the trace off, by launching Claude Code with `TRACE_BYPASS=1`.

When git or GitHub cannot answer, a hook halts the session: every call stops until the halt is lifted (ADR 0006). Tell the human what failed, in the halt's own words, and what to restore (`git status`, `gh auth status`, the network), then wait: while the halt stands, every call halts. Do not work around it; do not retry it in a subagent or suggest the bypass. When the halt names a form of the command that asks git nothing, use that form once the human replies, if git is still not back.
