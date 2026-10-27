# Techniques from the four source posts, and where each lives

The quality-loop plugin is built from four claude.dev posts. This file lists the techniques each one teaches and where the plugin implements them, so a change to the plugin can be checked against its sources. Paths are relative to `plugins/quality-loop/`.

Sources, read 2026-10-27:

1. [Solving Code Review at Anthropic](https://claude.dev/blog/solving-code-review-at-anthropic/)
2. [Automating Eval Design and Hill Climbing](https://claude.dev/blog/automating-eval-design-and-hillclimbing/)
3. [Getting the Most Out of Opus 5.5](https://claude.dev/blog/getting-the-most-out-of-opus-5-5/)
4. [Getting Started with Claude Code Mods](https://claude.dev/blog/getting-started-with-claude-code-mods/)

## 1. Solving Code Review at Anthropic

| Technique | Implementation |
|---|---|
| Verification before review: run tests/build/lint and **show the output**, not a claim | `scripts/lib/checks.mjs` runs every check; `ql` prints the tail of each failure and keeps full logs |
| A subagent reviews the diff in a **fresh context** | `agents/bug-hunter.md`, spawned per lens with only the brief |
| Multiple agents hunt in parallel; a **separate group votes**; post only above quorum | `references/round/2-review.md` and `3-verify.md`; `tallyVotes` / `recordVotes` in `scripts/lib/findings.mjs` |
| Drop style/cleanup findings; cap nits | `review.dropCategories`, `review.maxNitsPerRound` in `scripts/lib/config.mjs`; enforced at ingest |
| Require **file and line as evidence**, not a guess from a name | `checkEvidence`: the quoted code must be at (or near) the cited line or the finding is discarded |
| Severity tags **Important / Nit / Pre-existing** so inherited bugs aren't blamed on the author | `origin` from the diff in `ingestFindings`; tags in `report.mjs` and the review skill's output |
| Every finding answered: fixed or resolved **with a reason** | `ql mark <id> fixed\|wontfix --reason` refuses an empty reason |
| `REVIEW.md` written by code owners: failure modes, skip paths, never-flag list | `.quality-loop/REVIEW.md` template (`loop.mjs`), drafted by `skills/setup` |
| Per-repo depth: Quick / Standard / Deep | `DEPTHS` in `config.mjs`; `--depth` on `ql start` |
| Bug fixes reviewed for **root cause** | `agents/bug-hunter.md`; the debug skill's root-cause step |
| Convergence: **round cap** (3), then ask the author to reconsider | `loop.maxRounds`; `decideRound` returns `capped` with "reconsider the approach" |
| **Diff-only re-review** after the first passes | `scope()` in `loop.mjs`, `loop.diffOnlyAfterRound` |
| **Flag the bug class** so every instance gets fixed | `bugClass` on findings; `ql open` groups by class; one fixer per class |
| **No repeats** of already-posted findings | Known findings are tracked through the diff to where their code is now (ADR 0002); rejected/wontfix findings are never re-raised (`ingestFindings`) |
| Agent approval never counts as a person's; humans own risky decisions | The loop posts findings and fixes, never approves; only the user can `extend` a capped loop (guard) |
| Incidents become evals; rescore on every prompt/tool/model change | `ql eval harvest` (reverts and blamed fixes); `skills/tune-reviewer` |
| Measure noise: run on known-clean changes | Should-not-fire `clean` cases; false positives counted by `gradeCase` |
| Merge queue / everything reversible | Per-round checkpoints and automatic revert (`git.mjs` `snapshotTree` / `restoreTree`) |

## 2. Automating Eval Design and Hill Climbing

| Technique | Implementation |
|---|---|
| Tasks mirror production; cases from incidents, bug reports, hand-written, synthesized | `ql eval harvest` + hand-written `files` cases; `skills/tune-reviewer` A1 |
| Pick cases a **human** judges hard; say why before including | Required `whyHard` field; human confirmation checkpoint; drafts don't count |
| Include **should-not-fire** cases | `kind: "clean"`, harvested with `--clean` |
| Cheapest grader that fits: programmatic when outputs are constrained | `gradeCase`: file + line-range matching, one-to-one, duplicates not counted as FPs |
| Validate the grader: read scored transcripts; grade twice | Transcripts per trial; `graderConsistent`; tune-reviewer A2 asks the user to compare |
| Separate **plumbing** errors from model failures | `infraError` (timeout, crash, missing/invalid output) excluded from scores |
| **Headroom** warning at ≥ 95% | `formatEval` in `ql.mjs` |
| Environment leakage (leftover git history hands over the answer) | `materialize()` builds a fresh repo with only base + change; no later history |
| Report set size and runtime before running | `ql eval run` prints cases × repeats first |
| Confidence intervals | Bootstrap over cases (`stats.mjs`), seeded |
| **Train/test split**; never read test transcripts | `splitCases` (stratified, deterministic, stable as cases are added); skill reads train only |
| One change per round, big enough to show above **noise** | tune-reviewer B2; noise check against `eval.minDelta` |
| Keep / revert rule: train up & test flat → revert; regression → revert; both up → keep | `decideHillclimb` in `evals.mjs`; `ql eval compare` |
| **Never paste failures into the prompt** | `leakCheck`: file paths and 6-word phrases from answer keys found in the surface |
| Keep answers structurally out of reach | Guard denies edits to `.quality-loop/evals/**` while `ql eval hillclimb start` is active |
| Stall: bucket failures by root cause, **no edits** | tune-reviewer B "Stall"; the improve loop's `STALLED` row in the protocol |
| Leave the best **test** version; say when the gain is within noise | tune-reviewer C |

## 3. Getting the Most Out of Opus 5.5

| Technique | Implementation |
|---|---|
| Whole task in one message with a **finish line** and a stop condition | `ql start --goal`; every skill states its finish line and "Done when" criteria |
| Remove "think hard" lines | None in any skill or agent prompt |
| Stop rules: keep going when no input is needed; stop only when blocked or destructive | Skills' keep-going rule; Stop hook continues an active loop (bounded by `loop.maxStopNudges`); `ql pause --reason` is the explicit way to stop |
| Keep permission prompts on for destructive commands | Guard hook denies destructive git/rm commands during a loop |
| Split large work across **parallel subagents**; **check their evidence** | One hunter per lens, several verifiers per finding, one fixer per bug class; protocol step 4 makes the orchestrator verify fixer evidence |
| Keep the task list in a **file** that survives summarization | `.quality-loop/LOOP.md` and `state.json`; SessionStart (compact/resume) hook re-injects LOOP.md; `ql next` |
| Compact before attention thins (user rule: past ~300k tokens alignment scatters) | `loop.maxContextTokens` (300k): `ql start` sets `autoCompactWindow` in `.claude/settings.local.json`; agents' `autoCompactWindow` frontmatter; `CLAUDE_CODE_AUTO_COMPACT_WINDOW` for eval trials; the mod compacts between turns past the cap |
| End runs with **Blocked on me / Changed / Found** | `renderReport` in `report.mjs` |
| Review pass listing only merge-blocking problems with file, line, why, how to show it fails | Finding schema: `file`, `line`, `quote`, `failureScenario` |
| Mark unconfirmed claims and where you looked | Report step of each skill |
| Effort: lowest effort can beat high effort on review | `QL_EFFORT` / `QL_MODEL` in the eval runner for cost hill-climbing at parity |

## 4. Getting Started with Claude Code Mods

| Technique | Implementation |
|---|---|
| A mod is a hooks module in a plugin: `register(on, options)`, `($, e, next)` | `hooks/quality-loop.tsx`, named in `hooks/hooks.json` `modules` |
| Draw in the band above the prompt (`AbovePrompt`), yield with `next(e)` when idle | Status band; yields when there is no loop, a survey, or after Hide |
| State in `$.state` (survives hot reload), declared in the **type contract** | `types/index.d.ts`, `atom(..., { shape })` |
| Slash command via `$.command.register` + `command.run` | `/loop-status` |
| Observe tool calls (`tool.call` with `await next(e)`) | Refreshes the band after each `ql` command |
| Toasts | Status transitions (`active → done`) |
| `claude plugin validate` and `claude plugin test` | `npm run validate`, `npm run test:mod`; `tests/quality-loop.test.tsx` |
| Single-width symbols | `◆ ✓ ‖ ■ ×` in the band |
| Mods read command text only, so they are a seatbelt, not a sandbox | Stated in `guard.mjs`; hard enforcement uses classic hooks + permission rules |
