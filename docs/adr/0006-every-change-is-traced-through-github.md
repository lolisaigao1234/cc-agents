---
status: accepted
date: 2026-10-28
issue: "#3"
---

# 0006: Every change is traced through GitHub, and hooks enforce it

A change that cannot be tied to the reason it was made is how drift and hallucinated work get in. In a traced repository, every change follows one pipeline, the **trace**:

1. **Read**: the related docs (ADR 0007).
2. **Track**: an issue describes the change; tickets come from `to-tickets`.
3. **Branch**: `gh issue develop <n>` creates `<n>-<slug>` from the latest default branch, or from its blocker's branch while the blocker's PR awaits merge.
4. **Implement**: commits reference `#<n>`.
5. **Review**: a PR whose body says `Closes #<n>`.
6. **Update**: a progress comment on the issue after each round, giving progress, decisions and verification results.
7. **Close**: the human merges, and `Closes #<n>` closes the issue. Work that is not merged is closed with GitHub's state reason and a comment.

Hooks hard-block, in the main session and in every subagent:
- an edit on the default branch;
- an edit on a branch whose `<n>-` names no open issue;
- `git commit` without `#<n>`;
- `gh pr create` without `Closes #<n>`.

Next to the hard blocks, the hooks **halt**. Every rule above is an answer from git or GitHub, so when a hook needs one and gets none, it does not guess: it stops the whole session and asks the human to restore git or the connection. Git gets no answer when it is missing or fails to start, times out, is killed, runs past the hook call's deadline, or fails in its own way (a broken repository, `safe.directory`, a held lock). GitHub gets none when `gh` is missing, times out, is not logged in or cannot reach the network. "No such issue" and "no pull request" are answers. The halt is recorded for the session, outside the repository like the agents' reads, so every later hook call in that session halts at once, in the main session and every subagent, until the human's next prompt.

When commits were pushed after the issue's last comment, the Stop hook nudges for a progress comment: it blocks stopping once. Every deny names the pipeline step to go back to.

The issue is also the record that survives compaction. At start, after compaction, on resume and when a subagent starts, hooks inject the issue's title, acceptance criteria and latest progress comment.

## Considered options

- **A local task file** (the old loop's approach): rejected. It is invisible to humans, dies with the worktree, and duplicates the issue.
- **Merge automation on green CI**: rejected. Merging is the human's decision.
- **Notices instead of blocks**: rejected. A model can ignore a notice; it cannot ignore a deny.
- **Refusing only the one tool call when git or GitHub cannot answer, naming the bypass**: rejected by the human. The whole system rests on git, so without it the work stops until git is back, and the bypass is not the remedy.

## Consequences

- The trace applies only in repositories opted in by `/trace:setup`, and only to files inside that repository's working tree. The archive block and the guard apply everywhere. Whether a repository is opted in is itself git's answer, so the halt reaches any repository where the hooks ask git and get none; commands the gates do not judge ask nothing, and do not halt.
- A halt needs a hook that runs to the end. A hook process that itself crashes, or is killed at its timeout, cannot halt, and the tool call goes through.
- The only bypass is an environment variable the human sets when launching Claude Code. Nothing the model can write turns the trace off, so there is no state to defend.
- Because the human merges, a ticket blocked by an unmerged one is built on a stacked branch.
- Repositories without a GitHub remote cannot be traced.
