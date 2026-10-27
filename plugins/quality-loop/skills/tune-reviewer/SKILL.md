---
name: tune-reviewer
description: Build an eval set from this repository's past incidents and hill-climb REVIEW.md against it, keeping only changes that improve the held-out test split.
disable-model-invocation: true
argument-hint: "[--runner CMD] [--rounds N]"
---

# Tune the reviewer: incidents → evals → hill climbing

`ql` in this skill means `"${CLAUDE_PLUGIN_ROOT}/bin/ql"`: write that full path in every command (a shell variable holding it is lost between commands and does not split under zsh). Run it from the repository root. Arguments: `$ARGUMENTS`

The reviewer is `/quality-loop:review` run headlessly on each case by the runner (default `${CLAUDE_PLUGIN_ROOT}/scripts/runners/claude-review.sh`; `QL_MODEL` picks its model). The surface being tuned is `.quality-loop/REVIEW.md`: text, cheap to change and revert, and directly attributable.

## Part A: build the eval

### A1. Gather cases

`ql eval harvest --limit 20 --clean 5` drafts cases from history: reverted commits, fix commits (blame finds the commit that introduced the fixed lines), and should-not-fire commits that shipped cleanly. Add five to ten hand-written cases for failure modes the history lacks: a case is `.quality-loop/evals/cases/<id>/` with `case.json` (`kind`, `status`, `intent`, `whyHard`, `source`), `expected.json` (`bugs: [{ file, line, endLine?, description }]`) and either a git `source` (`base`, `head`) or `before/` and `after/` folders. See `ql eval cases`.

Every draft is a guess until a human confirms it. For each, narrow `expected.json` to the lines of the actual defect, write `whyHard` (a case you cannot say is hard for a reason is not worth keeping), and choose cases a human judges hard, not cases today's reviewer happens to fail. Two experts must be able to agree on the verdict from what the case states.

**Checkpoint:** present every case in one table (id, kind, intent, expected bugs, why hard) and wait for the user to confirm, edit or drop each. Then set `"status": "confirmed"` on the confirmed ones.

### A2. Baseline, grader, noise

`ql eval split`, then report the set size (cases × repeats) and run the baseline:

```
ql eval run --label base --repeats 3 [--runner CMD]
```

Before trusting the numbers:

- **Plumbing:** every `infra` line (timeout, crash, no output) is noise, not a model failure. Read those transcripts and fix the cause.
- **Grader:** read the transcripts of three passed and three failed trials. Show the user the grader's verdict next to the reviewer's findings and ask whether they would have scored any differently; a grader or an `expected.json` that disagrees with a careful human gets fixed now.
- **Noise:** a `NOISE WARNING` means the run-to-run spread exceeds the smallest change worth acting on (`eval.minDelta`). Add repeats or cases before climbing.
- **Headroom:** a `HEADROOM WARNING` (≥ 95%) means this eval cannot show improvement: add harder cases, or climb cost at parity (`QL_MODEL`, `--depth quick`) instead.

Done when: the baseline has no infra errors, the user agrees with the grader, and noise is below `minDelta`.

## Part B: hill climb

`ql eval hillclimb start` — from now on the eval cases and answer keys are locked against edits. Copy `REVIEW.md` to `.quality-loop/work/REVIEW.best.md`. Up to N rounds (default 5):

1. Read the **train** failures only: `ql eval show <current-best> --json`, the transcripts of failing train trials. Never open test-split transcripts or test cases.
2. Propose **one** change to `REVIEW.md` that addresses a root cause shared by several failures — a missing rule, a section that misleads — big enough to show above noise. Describe the general failure mode; copying a case's file names, code or wording into the surface is overfitting.
3. `ql eval leakcheck`: any leak, rewrite the change in general terms.
4. `ql eval run --label r<k> --repeats 3`, then `ql eval compare <current-best> r<k>`:
   - `KEEP` (test improved): copy `REVIEW.md` to `REVIEW.best.md`; `r<k>` is the new best.
   - `REVERT-OVERFIT`, `REVERT-REGRESSION`, `NO-CHANGE`: restore `REVIEW.md` from `REVIEW.best.md`.

**Stall:** after two rounds in a row without `KEEP`, stop editing and bucket every remaining train failure by root cause: ambiguous case, grader error, harness bug, variance, genuine reviewer miss. Fix or drop flawed cases with the user (the lock lifts with `ql eval hillclimb stop`, and goes back on after). Only genuine misses go into further rounds.

Done when: N rounds have run, or a stall analysis leaves no genuine misses.

## Part C: report

`ql eval hillclimb stop`. `REVIEW.md` stays at the best test-split version. Report baseline vs best on the **test** split with the 95% intervals from `ql eval compare`, the changes kept and why, and the cases fixed or dropped. If the gain is within noise, say so and recommend against adopting the change. Suggest re-running this eval whenever the review prompts, agents or model change.
