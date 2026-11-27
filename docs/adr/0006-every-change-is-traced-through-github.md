---
status: accepted
date: 2026-10-28
issue: "#3"
---

# 0006: Every change is traced through GitHub, and hooks and GitHub enforce it

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

Next to the hard blocks, the hooks **halt**. Every rule above is an answer from git or GitHub, so when a hook needs one and gets none, it does not guess: it stops the whole session and asks the human to restore git or the connection. Git gets no answer when it is missing or fails to start, times out, is killed, runs past the hook call's deadline, or fails in any way that is not an answer about what was asked (a broken repository, `safe.directory`, a held lock). Of a command the agent wrote, which the archive block asks git about, git not running, timing out, being killed or running past the deadline counts, and of git's own failures only the words for a broken repository do: any other failure may be the command's own mistake, so the command is denied in git's words. A history command too long for the hook to list in its time or its buffer is denied too, not halted: that is the command's size, not git failing. GitHub gets none when `gh` is missing, times out, is not logged in, cannot reach the network, or fails in any other way than "no such issue", "no pull request" or "no aliases", which are answers. The halt is recorded for the session, outside the repository like the agents' reads, so every later hook call in that session halts at once, for every tool, in the main session and every subagent, until it is lifted. Any prompt lifts it except a background agent's report, which arrives as a prompt too; starting, resuming or clearing the session lifts it as well, and a compaction does not.

When commits were pushed after the issue's last comment, the Stop hook nudges for a progress comment: it blocks stopping once. Every deny names the pipeline step to go back to.

The issue is also the record that survives compaction. At start, after compaction, on resume and when a subagent starts, hooks inject the issue's title, acceptance criteria and latest progress comment.

## Where each rule is enforced

Hooks run only where a session runs them, and only on the tool calls they see. A change that reaches GitHub another way, such as a commit and a PR made by a command that runs no tool hooks, meets none of them. So a PR's rules are judged a second time on GitHub, by the **trace check**, and the default branch's protection makes its verdict binding.

| Rule | In a session | On GitHub |
|---|---|---|
| A change is made on the branch of an open issue | hooks hard-block an edit, a commit and a PR on the default branch, or on a branch whose `<n>-` names no open issue | the trace check fails a PR whose branch names no open issue |
| Commits reference `#<n>` | hooks hard-block `git commit` without it | the trace check fails a PR that has a commit without it |
| A PR's body says `Closes #<n>` | hooks hard-block `gh pr create`, and a `gh pr edit` of the body, without it | the trace check fails a PR whose body lacks it, and judges again each time the body is edited |
| The default branch changes only through a PR that passed | hooks hard-block an edit and a commit there; a push is not judged | branch protection, which only the human applies |
| The related docs are read (ADR 0007) | hooks | nowhere: what an agent read is not on GitHub |
| A progress comment follows each round | the Stop hook's nudge | nowhere |

The trace check runs when a PR is opened or reopened, when commits are pushed to it, and when its body or its base branch is edited. GitHub runs the check as the default branch has it, never as the PR has it, so a change cannot alter the check that judges it. It reads a branch's issue, a commit's reference and a body's closing words with the gates' own readers, of the PR as GitHub has it at that moment. Like the hooks, it does not guess: when GitHub does not answer, it fails.

It judges the commits GitHub lists for the PR, which are those its branch has and its base branch does not, whoever made them. A merge is not asked for a reference: `git merge` and GitHub's "Update branch" write a merge's message, and the commit gate does not judge them either. What a merge brings in is judged as its own commits, and the base branch's commits are not the PR's. A stacked branch's PR has its blocker's branch as its base while the blocker's PR awaits merge, so the blocker's commits are not asked for the stacked branch's issue; once the human has merged the blocker, they are on the default branch.

## Considered options

- **A local task file** (the old loop's approach): rejected. It is invisible to humans, dies with the worktree, and duplicates the issue.
- **Merge automation on green CI**: rejected. Merging is the human's decision.
- **Notices instead of blocks**: rejected. A model can ignore a notice; it cannot ignore a deny.
- **Running the trace check as the PR has it** (the `pull_request` event): rejected. A change could then weaken the check in the same PR that needs it to pass. The price is that a change to the check is not run on the PR that makes it; the tests judge it there.
- **Asking GitHub which issues a PR closes, in place of reading its body**: rejected. GitHub links none while a PR's base is not the default branch, which is every stacked branch's PR, and it would read a body otherwise than the PR gate does.
- **Asking a merge for a reference too**: rejected. Merging the default branch into the branch, with `git merge` or "Update branch", would then fail the check, and mending it means rewriting the branch, which the guard refuses.
- **Refusing only the one tool call when git or GitHub cannot answer, naming the bypass**: rejected by the human. The whole system rests on git, so without it the work stops until git is back, and the bypass is not the remedy.

## Consequences

- The trace applies only in repositories opted in by `/trace:setup`, and only to files inside that repository's working tree. The archive block and the guard apply everywhere. Whether a repository is opted in is itself git's answer, so the halt reaches any repository where a hook needs git's answer and gets none. Hooks ask only what judging a call, or telling an agent its issue, needs: a git command neither the gates nor the archive block judge asks nothing and does not halt; every `gh` command asks gh for its aliases, since one may open a PR, so it halts when gh gives no answer where it may run in a traced repository; and recording what an agent read never halts (what it cannot place is not recorded, and the gate asks for it again).
- A halt needs a hook that runs to the end. A hook process that itself crashes, or is killed at its timeout, cannot halt, and the tool call goes through. A halt the hook cannot record for the session still halts its own call.
- The hook cannot tell the human's prompt from one a scheduled task or another session sends, so any of those lifts a halt.
- The only bypass is an environment variable the human sets when launching Claude Code. Nothing the model can write turns the trace off, so there is no state to defend.
- Because the human merges, a ticket blocked by an unmerged one is built on a stacked branch.
- The trace check blocks nothing by itself: it binds only while the default branch's protection requires it, of administrators too. Protection is a repository setting, which the human applies. An agent working under the human's GitHub login can change that setting, and nothing on GitHub stops it.
- A stacked branch relies on its blocker being merged with a merge commit. After a squash or a rebase, the blocker's commits are still on the stacked branch and no longer on the default branch, so the trace check asks them for the stacked branch's issue.
- The trace check runs on `pull_request_target`, which GitHub blocks in public repositories from 2026-12-02 unless an Actions event policy allows it. So it also depends on a policy, another repository setting the human applies, that allows that event for the trace check's workflow alone; without it the check fails every pull request.
- The trace check is this repository's own workflow. `/trace:setup` does not add it to another traced repository.
- Routes that stay open on GitHub:
  - What a merge commit itself changes is not judged, as in a session.
  - A PR can add a workflow of its own whose job reports under the trace check's name. Which of two results of one name GitHub's protection takes is not documented, and not verified here.
- Repositories without a GitHub remote cannot be traced.
