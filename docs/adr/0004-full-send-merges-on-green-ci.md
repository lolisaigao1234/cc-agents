# 0004: full-send takes a finished loop to a merged PR, and merges on green CI

Date: 2026-10-28 · Status: accepted

## Context

A quality loop ends at a clean working tree: it never commits or pushes. Someone still has to commit, open the PR, wait for CI, fix what CI finds and merge. tstack's `full-send` does that unattended, and its `full-stop` stops for a human to merge. We want `full-send`: there is no reason to wait for a person unless the PR is broken. It merges into the default branch once the CI/CD and pipeline checks pass.

## Decision

A new skill, `/quality-loop:full-send`, runs after the loop. The loop itself keeps its guarantee: it never commits or pushes. Committing, pushing and merging happen only in this skill, only after the loop is `DONE`, and only when the user asked for a full send.

- **Same split as ADR 0001.** The skill does the judgement work: commit messages, the PR description, reproducing and fixing a CI failure. `ql ship` decides what counts:
  - `ql ship stage` stages the paths to commit: the change, without the review's artifacts or the loop's own directory.
  - `ql ship wait` gates again, every `ship.pollSec`, until the verdict is not `WAIT`.
  - `ql ship gate` reads the PR through `gh` and returns one verdict:
    - `MERGE`: every check on the head passed, GitHub reports the PR mergeable, and the head is the commit we pushed.
    - `WAIT`: checks are running, mergeability is still being computed, or a merge is queued.
    - `FIX`: a check failed, the branch conflicts with or is behind its base, the PR is a draft, or the local and PR heads differ.
    - `BLOCKED`: a person or a rule is needed: branch protection refuses the merge, the PR was closed, no CI ever reported, or CI still fails after `ship.maxFixAttempts` fixes.
    - `MERGED`.
  - `ql ship merge` re-runs the gate and merges only on `MERGE`. It uses `gh pr merge --match-head-commit <sha>`, so a commit pushed after the gate is never merged unchecked.
- **The merge gate is CI, not people.** Every reported check on the head must pass: CI/CD and pipeline alike, required or not. A head with no checks at all is not green. After a grace period (`ship.checksGraceSec`, 300 s) it is `BLOCKED` unless `ship.requireChecks` is `false`. Review bots and human reviewers are not waited for. A branch protection rule that demands an approval is reported as `BLOCKED` and never bypassed: `--admin` is never used.
- **A CI failure goes back through the loop.** On `FIX` for a failed check, the skill reproduces the failing job locally and runs `/quality-loop:debug` with that command as the repro. The fix gets a red repro, a root-cause fix and a review like any other change. It is then committed and pushed, and the gate runs again. An infrastructure failure (runner lost, checkout or install died) gets one re-run of the failed jobs. `ql ship gate` counts the distinct heads that failed CI and stops at `ship.maxFixAttempts` (3).
- **The merge method is the repository's:** `ship.mergeMethod` (`auto` by default) picks the merge commit when the base branch's recent history is made of merges and the repository allows them, else squash, else merge, else rebase, among the methods the repository allows.
- **Asking the user** happens only on `BLOCKED`, or when the loop stops short (`CAPPED`, `STALLED`, `PAUSED`), with the question tool and the full context, as `full-send` does. Everything else is decided with defaults and listed in the final report.

## Consequences

- A user who invokes full-send gives up the review-before-merge pause. The protection that remains is the loop's own review, every CI check, and branch protection, which full-send never bypasses.
- `ql` now shells out to `gh` as it does to `git`. Tests use a fake `gh` on `PATH`, so the gate is tested without the network.
- The loop's "never commits or pushes" stays true. The README says so, and says that `full-send` is the one place that does.
- A repository with no CI cannot be full-sent by default. Setting `ship.requireChecks: false` merges on the loop's local checks alone, and that has to be chosen explicitly.
