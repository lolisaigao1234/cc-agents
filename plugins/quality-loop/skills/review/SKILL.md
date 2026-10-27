---
name: review
description: Verified code review of the current change without editing it. Parallel bug-hunter subagents each take one lens, independent verifiers vote on every finding, and only findings that reach quorum with file-and-line evidence are reported, tagged Important, Nit or Pre-existing. Use when asked to review a diff, branch or PR and report problems rather than fix them.
argument-hint: "[--base REF] [--depth quick|standard|deep] [--out FILE] [intent of the change]"
---

# Review: verified findings, no edits

`ql` in this skill means `"${CLAUDE_PLUGIN_ROOT}/bin/ql"`: write that full path in every command (a shell variable holding it is lost between commands and does not split under zsh). Run it from the repository root.

Before step 1, read `${CLAUDE_PLUGIN_ROOT}/references/round/rules.md`: the rules every step follows (single writer, briefs as files, when to read a step file, what to read after a compaction).

Arguments: `$ARGUMENTS`

This review changes no source file. It runs one round of the quality loop in review-only mode: no checks, no fixes.

## 1. Start

```
ql start --mode review --review-only [--base <ref>] [--depth <depth>]
ql round begin
```

The intent of the change is whatever the arguments say beyond the flags; otherwise the commit messages since the base (`git log --format=%s%n%b <base>..HEAD`) and any PR description.

## 2. Review and verify

Do round steps 2 and 3: hunters in parallel, one per lens; then independent verifiers with distinct stances on every candidate until `ql pending` shows none. Each comes as a step file: when a `ql` command prints `step: <path>`, read that step file then and follow it (`ql round begin` names step 2; `ql next` names the current one again). Pass the intent to the hunters with `ql brief hunters --intent "<intent>"`.

Done when: `ql next` says the review is complete.

## 3. Report

With `--out FILE` in the arguments, write the verified findings there: `ql export --out FILE`. Then `ql finish`.

Present the findings, most severe first, counts on the first line ("3 findings: 1 Important, 1 Nit, 1 Pre-existing" — or "No findings: nothing to fix." when none survived). For each: the tag, `file:line`, what is wrong, the concrete failure scenario, and the fix you would suggest. Pre-existing findings are listed last so inherited bugs are not blamed on the change. Then one line on what was filtered: how many candidates verification rejected and how many the evidence check discarded.
