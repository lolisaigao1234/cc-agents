---
name: review
description: Verified code review of the current change without editing it. Parallel bug-hunter subagents each take one lens, independent verifiers vote on every finding, and only findings that reach quorum with file-and-line evidence are reported, tagged Important, Nit or Pre-existing. Use when asked to review a diff, branch or PR and report problems rather than fix them.
argument-hint: "[--base REF] [--depth quick|standard|deep] [--out FILE] [intent of the change]"
---

# Review: verified findings, no edits

`ql` in this skill means `"${CLAUDE_PLUGIN_ROOT}/bin/ql"`: write that full path in every command (a shell variable holding it is lost between commands and does not split under zsh). Run it from the repository root.

Arguments: `$ARGUMENTS`

This review changes no source file. It runs one round of the quality loop in review-only mode: no checks, no fixes.

## 1. Start

```
ql start --mode review --review-only [--base <ref>] [--depth <depth>]
ql round begin
```

The intent of the change is whatever the arguments say beyond the flags; otherwise the commit messages since the base (`git log --format=%s%n%b <base>..HEAD`) and any PR description.

## 2. Review and verify

Do steps 2 and 3 of `${CLAUDE_PLUGIN_ROOT}/references/round-protocol.md` — read that file now. Hunters in parallel, one per lens; then independent verifiers with distinct stances on every candidate until `ql pending` shows none.

Done when: `ql next` says the review is complete.

## 3. Report

With `--out FILE` in the arguments, write the verified findings there: `ql export --out FILE`. Then `ql finish`.

Present the findings, most severe first, counts on the first line ("3 findings: 1 Important, 1 Nit, 1 Pre-existing" — or "No findings: nothing to fix." when none survived). For each: the tag, `file:line`, what is wrong, the concrete failure scenario, and the fix you would suggest. Pre-existing findings are listed last so inherited bugs are not blamed on the change. Then one line on what was filtered: how many candidates verification rejected and how many the evidence check discarded.
