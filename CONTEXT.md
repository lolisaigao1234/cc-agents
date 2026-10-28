# Context

This repository ships **quality-loop**, a Claude Code plugin that reviews, fixes and validates code changes in any repository, and tunes its own reviewer with evals.

## Glossary

- **Loop** — one run of review → verify → fix → validate rounds toward a finish line. Its state is `.quality-loop/state.json`; its human-readable anchor is `.quality-loop/LOOP.md`.
- **Context cap** — the context size (`loop.maxContextTokens`, 300k) at which a loop's session and its agents compact, so attention stays on the goal; `LOOP.md` carries the loop across each compaction.
- **Finish line** — the loop's stated goal: what "done" means. Set once at `ql start`, immutable during the run.
- **Round** — one pass: begin (checkpoint + scope), review, verify, fix, end (validate + decide).
- **Scope** — the diff a round's reviewers read: the whole change vs the base in round 1, then only what changed since the last kept round (diff-only re-review).
- **Base** — the commit a change is reviewed against (merge-base with the default branch by default).
- **Checkpoint** — a git tree object of the whole working tree taken at round start; a reverted round is restored to it. Never touches the user's index, HEAD or stash.
- **Check** — a repository command (test, lint, typecheck, build) whose exit code the loop trusts. **Required** checks gate the finish line.
- **Baseline** — the checks' results before the loop changes anything. Failures there are pre-existing, held steady, not blamed on the change.
- **Regression** — a required check failing that passed at round start, a drop in passing test count, or **weakening** (skipped/focused/deleted tests, removed assertions). A regression reverts the round.
- **Lens** — one angle a bug hunter reviews from (correctness, security, …).
- **Finding** — a reported defect with evidence: file, line, exact **quote**, failure scenario. Lifecycle: candidate → confirmed | rejected → fixed | wontfix | stuck.
- **Bug class** — the root cause shared by several findings; fixed together.
- **Size** — the change against the base, in lines changed: code apart from tests, without skipped paths. Measured at `ql start` and after every round. **Growth** past `loop.maxGrowth` (50% of the start's code lines, at least ten lines) is put to the user; in debug the sizes are shown without the warning, since the fix is the whole change.
- **Origin** — `introduced` (touches the change) or `pre-existing`. Tags: Important, Nit, Pre-existing.
- **Quorum** — votes needed from independent **verifiers** to confirm a finding.
- **Single writer** — only the orchestrating session runs `ql`; subagents write JSON files.
- **Stall** — no progress for `stallRounds` rounds, a diverging loop, oscillation (a fixed finding reopening twice), or stuck findings. The loop stops for a human.
- **Cap** — the round limit (default 3). Only the user may extend it.
- **Eval case** — a past change with known bugs (or a **clean** should-not-fire change) used to score the reviewer. Drafts count only once a human confirms them.
- **Surface** — the text being hill-climbed: `.quality-loop/REVIEW.md`.
- **Split** — the stable train/test partition of eval cases; the hill climber reads train only.
- **Infra error** — a trial that failed for plumbing reasons (timeout, crash, missing output); excluded from scores.
- **Mod** — the plugin's hooks module (`hooks/quality-loop.tsx`): UI and a slash command. Enforcement lives in the classic hooks.
