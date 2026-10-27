---
name: improve
description: Quality loop that reviews the current change with parallel bug-hunter subagents, keeps only quorum-verified findings, fixes them test-first, reverts any round that regresses the checks, and repeats until the finish line is met or progress stalls. Use when asked to review and fix a change, get a branch ready for a PR, or "keep going until it's clean".
argument-hint: "[finish line] [--base REF] [--depth quick|standard|deep]"
---

# Improve: review → verify → fix → validate, until done

`ql` in this skill means `"${CLAUDE_PLUGIN_ROOT}/bin/ql"`: write that full path in every command (a shell variable holding it is lost between commands and does not split under zsh). Run it from the repository root.

Arguments: `$ARGUMENTS`

## 1. Set the finish line

The finish line is what "done" means for this run. `ql round end` decides `DONE` by its own criterion, which is the default finish line: every required check passes with no new failures, and no important finding introduced by the change remains open. When the arguments state a different finish line, pass it as `--goal`. ql records and displays it but does not evaluate `--goal`; you check it in step 3. Pass `--base` and `--depth` through when given.

```
ql start --mode review [--goal "<finish line>"] [--base <ref>] [--depth <depth>]
```

`ql start` creates `.quality-loop/` on first use with checks detected from the repository, runs them once as the **baseline**, and prints their output. Read it:

- Checks already failing at baseline are pre-existing: the loop holds them steady and does not count them against the change.
- `WARNING: no checks are configured` means regressions cannot be caught. Continue, and put this first in the final report under Blocked on me, with the checks you would add.
- A loop already active: `ql status` and continue it rather than starting over.

## 2. Run rounds

Follow `${CLAUDE_PLUGIN_ROOT}/references/round-protocol.md` — read it now, in full. Each round: begin, review with one bug hunter per lens in parallel, verify each candidate by independent voters, fix one bug class per fixer, then `ql round end`, which validates, reverts on regression and decides.

A custom finish line that asks for more than ql's criterion (nits fixed, a coverage target) widens each round's fix step to cover it.

Keep going round after round without asking: put a one-line status note in the same message as your next action. The loop itself enforces the limits (round cap, stall and oscillation detection, attempts per finding), so you never need to judge whether to stop early. Stop and ask the user only when you cannot continue without them, and first record it: `ql pause --reason "<what you need>"`.

Done when: `ql round end` reports `DONE`, `CAPPED` or `STALLED` and you have done what the protocol's decision table says.

## 3. Check the finish line

`CAPPED` or `STALLED` leaves any finish line unmet, and `DONE` meets the default one: go to step 4.

With a custom finish line and `DONE`, check each of its criteria against evidence you can cite (`ql status`, `ql export --all`, check output, a command you run):

- All met: step 4.
- Unmet, and more rounds can close the gap (open nits, a check to make pass): save `ql report --out .quality-loop/work/loop-1-report.md`, then start one follow-up loop with `ql start --mode review --goal "<the same finish line>"` and run step 2 again. It starts a fresh ledger and round count from the current tree.
- Unmet after a follow-up loop, or beyond what rounds can do: step 4, with each unmet criterion first under **Blocked on me**.

Done when: every criterion of the finish line is recorded as met or unmet, each with its evidence.

## 4. Report

Run `ql report` and present it as written: the count line, then **Blocked on me**, **Changed**, **Found**. Include the saved report of a first loop when a follow-up ran. Add the verification you did of the fixers' evidence and the finish-line check from step 3, and mark anything you could not confirm as unconfirmed, saying where you looked.
