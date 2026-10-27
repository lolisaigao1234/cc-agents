---
name: debug
description: Repro-first debugging loop. Builds a command that goes red on the bug, tests competing root-cause hypotheses with parallel investigator subagents, fixes the root cause test-first, reviews the fix with verified bug hunters, and stops when the repro is green with no regressions. Use when something is broken, throwing, failing, flaky or wrong and the cause is unknown.
argument-hint: "<symptom, error message, or failing command>"
---

# Debug: red repro → hypotheses → root-cause fix → green

`ql` in this skill means `"${CLAUDE_PLUGIN_ROOT}/bin/ql"`: write that full path in every command (a shell variable holding it is lost between commands and does not split under zsh). Run it from the repository root.

Symptom: `$ARGUMENTS`

## 1. Make it red

Build a **repro**: the narrowest shell command that exits non-zero while the bug exists and zero once it is fixed. Best is one new failing test in the repository's own suite, run on its own (the runner's file argument or name filter, e.g. `node --test --test-name-pattern="bulk discount"`, `pytest tests/test_x.py::test_y`); the whole suite is too wide, since any unrelated failure would read as the bug. A short script is next best. Run it three times: it must fail the same way every time. A repro that passes now means you have not reproduced the bug — keep looking (different input, environment, ordering, concurrency) and only when you are out of options ask the user for what is missing.

```
ql start --mode debug --repro "<command>" --goal "<symptom> no longer happens; repro passes; no check regresses"
ql round begin
```

`ql start` refuses to proceed (status `paused`) if the repro already passes.

Done when: the loop is active and the repro is red in the baseline output.

## 2. Find the root cause

When reading the failing path already shows the cause and the repro confirms it, record that one hypothesis with its evidence in the file below and go to step 3. Otherwise write three to five **falsifiable** hypotheses, most likely first, to `.quality-loop/work/round-<n>/hypotheses.md`: each with what you would observe if it is true. Spawn one `root-cause-investigator` subagent per hypothesis, all in one message. Each brief holds the symptom, the repro command, its hypothesis, and the output path `.quality-loop/work/round-<n>/hypothesis-<k>.json`.

Check each report's evidence yourself before you accept it: rerun the command it quotes, read the lines it cites. A root cause is established when one hypothesis is `supported` with evidence you reproduced. When none is, write a new batch from what the refutations taught you; after two batches with nothing supported, `ql pause --reason "<what you learned and what would settle it>"` and ask the user.

## 3. Fix it

Turn the repro into a regression test in the repository's test suite if it is not one already. Fix the **root cause**, not the symptom — the place where the wrong value is created, not where it is noticed. Use a `fixer` subagent for a fix that spans many files, briefing it with the root cause as a single bug class; otherwise make the change yourself. Run the repro: green.

## 4. Review the fix, then validate

Run steps 2–4 of `${CLAUDE_PLUGIN_ROOT}/references/round-protocol.md` (read it now) on the fix: bug hunters on the scope, verification, fixes for anything confirmed. Then `ql round end`, which runs every check plus the repro and reverts the round on any regression. Follow the protocol's decision table; another round starts from step 2 of this skill if the repro is still red, or from the protocol's step 1 if review findings remain.

Done when: `ql round end` reports `DONE` (repro green, no regressions, nothing important open), `CAPPED` or `STALLED`.

## 5. Report

`ql report`, and above it in two or three sentences: the root cause (file:line), why it produced the symptom, and how the fix removes it. Name the regression test.
