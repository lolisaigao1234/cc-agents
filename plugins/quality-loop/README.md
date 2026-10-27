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
- `skills/` — the orchestration. `references/round/` is the round, shared by `improve`, `review` and `debug`: `rules.md`, which each of them reads first (single writer, briefs as files, re-anchoring after a compaction), then one small file per step; `ql` names the step file to read when the loop reaches it, so a review-only run never loads the fix or validate steps.
- Context stays lean: `ql brief hunters|verifiers|fix|investigate` writes each subagent's brief to `.quality-loop/work/round-<n>/briefs/` and prints one line per brief, so an Agent prompt is just `Brief: <path>`; agents reply in one line and keep the details in their output file. `ql` prints one line per check, finding or vote by default (`--json` or the file it names for the rest), and `LOOP.md`, re-injected after compaction, lists at most ten open findings.
- `agents/` — `bug-hunter`, `finding-verifier`, `fixer`, `root-cause-investigator`.
- `hooks/hooks.json` — classic hooks: a guard against destructive commands and edits to the loop's state and limits while a loop runs (in the repository the command runs in; from a linked worktree or nested repository inside it, the enclosing loop guards its own files, and destructive commands only when they reach the enclosing repository outside the inner one, through `cd`, `git -C` or a path; a `git init` inside a directory the loop's repository tracks is guarded in full), against edits to its state (not its config) until a loop that stopped short is restarted by the user, and against edits to eval answer keys and thresholds while hill climbing; a Stop hook that keeps an active loop going (bounded); context re-injection after compaction. Plus the mod `hooks/quality-loop.tsx` for the status band, `/loop-status`, toasts and the context-cap backstop.

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

The loop never commits or pushes; it checkpoints with git plumbing and a temporary index. Reverting a round puts the working tree and the index back as they were at its checkpoint, moves files the round created to `.quality-loop/trash/` rather than deleting them, and never removes a file that was ignored at the checkpoint; what it cannot undo (commits made during the round, branches it moved or deleted, changes inside nested repositories) pauses the loop. While a loop runs, the guard denies `git reset --hard`, `git clean -f`, force pushes, `--no-verify`, `rm -rf` and edits to the loop's own limits; while hill climbing, edits to the eval answer keys and `config.json`. The guard also knows which of the plugin's agents makes a call: hunters, verifiers and investigators write nothing in the repository but their files under `.quality-loop/work/` and change nothing with git (a worktree of their own is theirs), and the fixer leaves the rest of `.quality-loop/` to the orchestrator and makes no commits, branch switches or stashes. Only the user may restart a loop that stopped short of its finish line (`! ql start --force`) or extend it (`! ql extend`). `ql start` refuses otherwise. It also reads a record of each loop's status, round count and round budget kept in the git directory (`$(git rev-parse --git-common-dir)/quality-loop/`). ql only ever makes that record stricter: the round never goes down, a capped, stalled or aborted loop stays so, a loop is marked done only when `ql round end` or `ql finish` decides it, and the budget never goes up, except through the user's `ql extend` or `ql start --force`. `ql round begin` goes by the record too: it runs no round for a loop the record holds capped, stalled or aborted, nor for a state put in place of an unfinished loop it records as having spent rounds; `ql round end` caps by the record and refuses such a state as well. So deleting `.quality-loop/`, or editing or replacing its state's status, round, budget, review-only flag or loop id by hand and letting ql save it, neither resets nor raises the round cap, nor runs a round past it. The guard reads command text, so it is a seatbelt, not a sandbox: it catches the usual ways of deleting or rewriting that record and of editing the loop state, not every one. A command that gets past it to delete or rewrite the record resets the cap, and so does one that edits the state's findings, checks or repro command so that `ql round end` decides the loop is done. Keep Claude Code's permission prompts on for anything destructive.
