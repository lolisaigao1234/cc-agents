---
name: improve
description: Quality loop that reviews the current change with parallel bug-hunter subagents, keeps only quorum-verified findings, fixes them test-first, reverts any round that regresses the checks, and repeats until the finish line is met or progress stalls. Use when asked to review and fix a change, get a branch ready for a PR, or "keep going until it's clean".
argument-hint: "[finish line] [--base REF] [--depth quick|standard|deep]"
---

# Improve: review → verify → fix → validate, until done

`ql` in this skill means `"${CLAUDE_PLUGIN_ROOT}/bin/ql"`: write that full path in every command (a shell variable holding it is lost between commands and does not split under zsh). Run it from the repository root.

Arguments: `$ARGUMENTS`

## 1. Set the finish line

The finish line is what "done" means for this run. Take it from the arguments when they state one; otherwise the default holds: every required check passes with no new failures, and no important finding introduced by the change remains open. Pass `--base` and `--depth` through when given.

```
ql start --mode review [--goal "<finish line>"] [--base <ref>] [--depth <depth>]
```

`ql start` creates `.quality-loop/` on first use with checks detected from the repository, runs them once as the **baseline**, and prints their output. Read it:

- Checks already failing at baseline are pre-existing: the loop holds them steady and does not count them against the change.
- `WARNING: no checks are configured` means regressions cannot be caught. Continue, and put this first in the final report under Blocked on me, with the checks you would add.
- A loop already active: `ql status` and continue it rather than starting over.

## 2. Run rounds

Follow `${CLAUDE_PLUGIN_ROOT}/references/round-protocol.md` — read it now, in full. Each round: begin, review with one bug hunter per lens in parallel, verify each candidate by independent voters, fix one bug class per fixer, then `ql round end`, which validates, reverts on regression and decides.

Keep going round after round without asking: put a one-line status note in the same message as your next action. The loop itself enforces the limits (round cap, stall and oscillation detection, attempts per finding), so you never need to judge whether to stop early. Stop and ask the user only when you cannot continue without them, and first record it: `ql pause --reason "<what you need>"`.

Done when: `ql round end` reports `DONE`, `CAPPED` or `STALLED` and you have done what the protocol's decision table says.

## 3. Report

Run `ql report` and present it as written: the count line, then **Blocked on me**, **Changed**, **Found**. Add the verification you did of the fixers' evidence, and mark anything you could not confirm as unconfirmed, saying where you looked.
