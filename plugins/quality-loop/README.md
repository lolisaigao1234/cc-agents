# quality-loop

A Claude Code plugin that reviews, fixes and validates code changes in any git repository, and tunes its own reviewer against your repository's past incidents.

It runs **review → verify → fix → validate** rounds until a finish line is met or progress stalls:

- **Review:** parallel `bug-hunter` subagents, one per lens (correctness, security, regressions and edge cases, conventions, …), each in a fresh context.
- **Verify:** every candidate finding must quote the exact code at its file and line (hallucinations are discarded automatically), then independent `finding-verifier` subagents with different stances vote; only findings that reach quorum survive. Duplicates merge; rejected findings never come back.
- **Fix:** one `fixer` per bug class, test-first, every instance of the class.
- **Validate:** your repository's own checks run after every round; any regression, dropped test, skipped/focused test or deleted assertion **reverts the round** to its checkpoint.
- **Stop:** done when checks pass and nothing important is open; otherwise a round cap (3), stall, divergence and oscillation detection and a per-finding attempt limit stop the loop for a human.

## Install

At the prompt of a Claude Code session:

```
/plugin install quality-loop --marketplace lolisaigao1234/cc-agents
```

From a shell: `claude plugin install quality-loop --marketplace lolisaigao1234/cc-agents`. Requires Claude Code 2.1.287 or later (for the mod), Node 20+, and git.

## Use

| Command | What it does |
|---|---|
| `/quality-loop:setup` | Detect your checks, verify they run, draft `.quality-loop/REVIEW.md` |
| `/quality-loop:review [--base REF] [--depth quick\|standard\|deep]` | Verified review of the current change; edits nothing |
| `/quality-loop:improve [finish line]` | The full loop: review, verify, fix, validate, repeat |
| `/quality-loop:debug <symptom>` | Red repro → parallel root-cause hypotheses → fix → review → green |
| `/quality-loop:tune-reviewer` | Build evals from reverts and fixes in history; hill-climb `REVIEW.md` on a held-out split |
| `/loop-status` | Where the loop is and what it does next (from the mod) |

A band above the prompt shows the active loop's round, phase, open findings, checks and context use.

## How it is built

- `scripts/ql.mjs` — the deterministic core (`ql --help`). Evidence checks, dedupe, voting, checkpoints, regression and weakening detection, convergence decisions, eval grading. No dependencies.
- `skills/` — the orchestration. `references/round-protocol.md` is the round, shared by `improve`, `review` and `debug`.
- `agents/` — `bug-hunter`, `finding-verifier`, `fixer`, `root-cause-investigator`.
- `hooks/hooks.json` — classic hooks: a guard against destructive commands and edits to loop state or eval answer keys during a loop; a Stop hook that keeps an active loop going (bounded); context re-injection after compaction. Plus the mod `hooks/quality-loop.tsx` for the status band, `/loop-status`, toasts and the context-cap backstop.

## Configure

`.quality-loop/config.json` in your repository (created on first use; commit it):

```json
{
  "checks": [{ "name": "test", "cmd": "npm test", "required": true, "timeoutSec": 900 }],
  "review": { "depth": "standard", "skipPaths": ["**/dist/**"], "fixPreExisting": false },
  "loop": { "maxRounds": 3, "stallRounds": 2, "maxAttemptsPerFinding": 2, "maxContextTokens": 300000 }
}
```

`ql config` prints every setting with its default. `.quality-loop/REVIEW.md` tells the reviewers what failure looks like in your repository.

## Context cap

Long sessions lose focus well before the model's window is full, so a quality-loop session compacts at `loop.maxContextTokens` (300k by default; `null` turns it off):

- `ql init` and `ql start` lower Claude Code's `autoCompactWindow` to the cap in `.claude/settings.local.json` (personal, kept out of git). This is Claude Code's own auto-compaction, so it fires mid-turn too. It only ever lowers a window you set.
- Every agent compacts its own conversation at 300k (`autoCompactWindow` in its frontmatter).
- Eval trials and the headless runners get `CLAUDE_CODE_AUTO_COMPACT_WINDOW`.
- The mod compacts between turns when the session is still past the cap, with instructions to keep the loop's position; the SessionStart hook then re-injects `LOOP.md`.

## Safety

The loop never commits or pushes; it checkpoints with git plumbing and a temporary index. Reverting a round puts the working tree and the index back as they were at its checkpoint, moves files the round created to `.quality-loop/trash/` rather than deleting them, and never removes a file that was ignored at the checkpoint; what it cannot undo (commits made during the round, changes inside nested repositories) pauses the loop. While a loop runs, the guard denies `git reset --hard`, `git clean -f`, force pushes, `--no-verify`, `rm -rf` and edits to the loop's own limits. The guard reads command text, so it is a seatbelt: keep Claude Code's permission prompts on for anything destructive.
