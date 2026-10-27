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

`ql start` creates `.quality-loop/` on first use with checks detected from the repository, runs them once as the **baseline**, and prints one line per check (a failing one with its last lines and the path of its full log). Read it:

- Checks already failing at baseline are pre-existing: the loop holds them steady and does not count them against the change.
- `WARNING: no checks are configured` means regressions cannot be caught. Continue, and put this first in the final report under Blocked on me, with the checks you would add.
- A loop already active: `ql status` and continue it rather than starting over.

## 2. Run rounds

Each round: begin, review with one bug hunter per lens in parallel, verify each candidate by independent voters, fix one bug class per fixer, then `ql round end`, which validates, reverts on regression and decides. The round protocol comes one step file at a time: when a `ql` command prints `step: <path>`, read that step file then and follow it (`ql next` names the current one again).

A custom finish line that asks for more than ql's criterion (nits fixed, a coverage target) widens each round's fix step: do that work inside the round, before `ql round end`, because a `DONE` ends the loop and takes no further round.

Keep going round after round without asking: put a one-line status note in the same message as your next action. The loop itself enforces the limits (round cap, stall and oscillation detection, attempts per finding), so you never need to judge whether to stop early. Stop and ask the user only when you cannot continue without them, and first record it: `ql pause --reason "<what you need>"`.

Done when: `ql round end` reports `DONE`, `CAPPED` or `STALLED` and you have done what its decision table (`decisions.md`) says.

## 3. Check the finish line

`CAPPED` or `STALLED` leaves any finish line unmet, and `DONE` meets the default one: go to step 4.

With a custom finish line and `DONE`, check each of its criteria against evidence you can cite (`ql status`, `ql export --all`, check output, a command you run). Put each unmet criterion first under **Blocked on me**, with the open findings that keep it unmet (from `ql export --all`) and what would close it. Another loop spends a new round budget, which only the user grants: offer it as their decision, naming the arguments to rerun with (`/quality-loop:improve` with the same finish line, `--base` and `--depth`).

Done when: every criterion of the finish line is recorded as met or unmet, each with its evidence.

## 4. Report

Run `ql report` and present it: the count line, then **Blocked on me**, **Changed**, **Found**. **Blocked on me** opens with what steps 1 and 3 put there (the no-checks warning, each unmet finish-line criterion), in place of a `Nothing.`; the rest of the report stays as written. Add the verification you did of the fixers' evidence, and mark anything you could not confirm as unconfirmed, saying where you looked.

Done when: every unmet criterion from step 3 appears under **Blocked on me**.
