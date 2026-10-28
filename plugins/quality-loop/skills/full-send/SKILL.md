---
name: full-send
description: Takes the current change all the way to a merged PR with nobody watching. The quality loop reviews and fixes it; then it is committed, pushed and opened as a PR, CI failures are fixed through the loop, and it merges into the default branch once every CI check on the PR passes. Use only when the user explicitly asks for a full send ("full send", /quality-loop:full-send).
argument-hint: "[what the change is for]"
---

# Full send: loop → PR → green CI → merged

`ql` in this skill means `"${CLAUDE_PLUGIN_ROOT}/bin/ql"`: write that full path in every command (a shell variable holding it is lost between commands and does not split under zsh). Run it from the repository root.

Before step 1, read `${CLAUDE_PLUGIN_ROOT}/references/round/rules.md`, the rules every step follows.

Goal: `$ARGUMENTS`

The user is not watching: your messages go unread until long after you stop, and the final report is what they read. Asking for a full send gives you permission to commit and push this task's branch, open its PR, re-run failed CI jobs, and merge it into the default branch once `ql ship gate` says `MERGE`. It does not cover another branch, a force push, `--admin` or any other way past branch protection, closing a PR, production systems, or deleting data: those go to the user (Asking the user, below). The merge gate is CI, not people: do not wait for reviewers or review bots, and never try to get past a rule that requires one.

Stay active from step 1 to step 7. Ending your turn while checks run stops the work, because nobody will prompt you again.

## 1. Branch

`gh auth status` must pass; when it does not, ask the user. On the default branch, create a branch for the change first (`git switch -c <short-name>`); uncommitted work comes along.

## 2. Finish and prove the change

Run the quality loop on it: read `${CLAUDE_PLUGIN_ROOT}/skills/improve/SKILL.md` and follow its steps 1 to 3, with the goal above as the finish line. Go on only on `DONE` with every criterion of the finish line met. `CAPPED`, `STALLED`, `PAUSED` or an unmet criterion: ask the user.

## 3. Commit

`ql ship stage` stages the change, leaving out the files the review left behind and `.quality-loop/`. Read `git diff --cached --stat`: it must be the change and nothing else. Commit in the repository's message style (`git log --oneline -20`), with any attribution lines your instructions require.

## 4. Bring in the base

`git fetch origin <default branch>`. When the base has moved, merge it into the branch, or rebase onto it when the repository keeps a linear history. Resolve a conflict by the change's intent and the base's newer behaviour; when both sides changed the same behaviour and either choice loses something, ask the user. After any conflict, `ql checks` must pass before you push.

## 5. Push and open the PR

`git push -u origin <branch>`. When the branch has an open PR, use it. Otherwise `gh pr create`, not as a draft, so CI runs:

- The title says why the change matters, in the repository's style for titles.
- The body opens with the problem, in plain words, then the fix, then one line of proof: the count line of `ql report` and the checks the loop ran.
- Before submitting, check the title and body for secrets and private details.

Then `ql ship start <PR URL>`.

## 6. Drive it to green

`ql ship wait`. It gates again until the verdict is no longer `WAIT`, for up to nine minutes per call, so give the command a ten-minute timeout (or run it in the background and wait for it to finish); run it again while it ends on `WAIT`. Then act on the verdict:

- `MERGE`: step 7.
- `FIX`, by the reason it gives:
  - **A draft:** `gh pr ready <PR URL>`.
  - **The local and PR heads differ:** push. When the PR has commits you do not have, someone else pushed: fetch and merge them, never force-push.
  - **Conflicts, or behind the base:** step 4, then push.
  - **A failed check:** read its log (`gh run view <run id> --log-failed`; the run id is in the check's link).
    - It died before any test ran (runner lost, checkout, install or network): `gh run rerun <run id> --failed`, once per head, then `ql ship wait`.
    - Otherwise, reproduce the failing step locally with the same command. Run `/quality-loop:debug` with that command as the repro (read `${CLAUDE_PLUGIN_ROOT}/skills/debug/SKILL.md` and follow it to `DONE`), then step 3, push, and `ql ship wait`.
    - Never skip, disable or weaken a test to get green.
- `BLOCKED`: ask the user.
- `MERGED`: someone merged it. Go to step 8.

## 7. Merge

`ql ship merge`. It gates once more and merges only the head it gated, with the repository's merge method, never with `--admin`. "merge requested, not merged yet" means a merge queue or a merge in progress: `ql ship wait` until `MERGED`. When it refuses, its message names the verdict: back to step 6.

## 8. Report

Lead with the PR link and the merge commit. Then:

- the proof: the loop's count line and the CI checks that passed on the merged head;
- every decision you made for the user: the branch name, the merge method, re-runs, how conflicts were resolved, findings left as won't-fix and why.

Done when: `ql ship gate` says `MERGED`, or the user has been asked about a blocker, with the PR left open.

## Asking the user

A question in an ordinary message goes unseen, and the thread looks finished. Ask with the question tool (`AskUserQuestion`). Put everything in the question: the PR link, what blocks it (the gate's reasons, or the loop's), what you tried, and the options, your recommendation first. Leave the PR open and unmerged. With no question tool, or no answer, start your final message with the question.

Decide everything else yourself with sensible defaults, and list those decisions in the report.
