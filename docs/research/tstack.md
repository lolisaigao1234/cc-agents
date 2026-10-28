# What quality-loop can take from tstack's full-send, full-stop and sol-loop

[t3dotgg/tstack](https://github.com/t3dotgg/tstack) is a set of agent skills for Claude Code and Codex. Three of them overlap with quality-loop:

- **`sol-loop`**: a second model (GPT Sol) reviews the change in rounds until both agents agree.
- **`full-send`**: unattended, from a change to a merged PR: prove it, review it with `sol-loop`, file it, babysit it, merge at a gate.
- **`full-stop`**: `full-send` that stops with the PR ready for a human to merge.

They lean on `babysit-pr` (watch CI and review bots) and `file-pr`. This note says, technique by technique, what quality-loop already has, what it lacks, and whether to take it. Read 2026-10-28. Paths are relative to `plugins/quality-loop/`.

Where they differ in kind: tstack is prompt-only, while quality-loop puts what must hold every run in `ql` (ADR 0001). So a technique worth taking usually becomes a `ql` rule, not a sentence in a skill.

## sol-loop

| Technique | quality-loop today | Take it? |
|---|---|---|
| A reviewer from **another provider**, read-only, with no subagents of its own | Every hunter and verifier is a Claude subagent. The root README already plans third-party reviewers | **Yes**: see 6 below |
| **Never substitute a model.** If no route runs the named reviewer, report the blocker | No external reviewer exists yet | Yes, with 6 |
| **Timeout, error or no reply is not approval** | A hunter whose output file is missing or invalid gets one re-run (`2-review.md`); after that, nothing stops `--none` being recorded for its lens | Yes: a lens that never answered should block the review or be reported, never read as clean |
| Round budget 3; later rounds see only changed code and open findings | `loop.maxRounds` 3; diff-only re-review; `known-findings.json` in each hunter's brief | Have |
| Extend to 5 by itself for security, auth, data loss or concurrency | Only the user may extend (`ql extend`, guarded) | **No**: conflicts with "only the user may extend". `CAPPED` could still say when a security finding is open |
| Stop early if a round returns only nits; declined nits need no round | `DONE` ignores open nits; `maxNitsPerRound` | Have |
| Next round only if behaviour code changed **or approval does not cover the current behaviour diff** | A round's fixes are reviewed only by the next round. When those fixes close the last important finding, `ql round end` says `DONE`, so the final fixes are validated by the checks but never reviewed (`test/lifecycle.test.mjs`, "an unfixed confirmed nit…": round 2 reviews, then fixes, then `DONE`) | **Yes**: see 1 below |
| **Fight scope creep**: smallest fix; prefer deleting or narrowing over a new lock, cache, helper or option; `git diff --shortstat <base>` each round; "if review grew the diff, cut first" | The fixer is test-first and per class, but no one measures how much the change grew | **Yes**: see 2 below |
| Severity tied to intent: blocker = the intended case is wrong; should = a real bug callers will hit; **another path, a rare case or a small cost is a nit, whatever label it came with** | `important` = breaks behaviour, security, data or a contract; `nit` = minor (`agents/bug-hunter.md`, `agents/finding-verifier.md`) | **Yes**: see 3 below |
| Answer each finding: agree → smallest fix; disagree → evidence; out of scope → decline in one line, list as a follow-up | Quorum voting, `wontfix --reason`, the fixer's `outside` lines | Have, and stricter (independent voters, not the author's word) |
| Ledger fed back to the reviewer: `fixed:` / `disagree:` / `declined:`, plus evidence; the reviewer marks each id resolved or still open | Earlier findings go to hunters as "report only what is new"; rejected and won't-fix findings never return | Mostly have. Hunters are not asked to say whether a fixed finding is really resolved; that falls to the checks and the oscillation counter |
| Disputed twice → stop and show both sides in 2–3 lines; the user decides | Stuck findings (`maxAttemptsPerFinding`) → `STALLED`, stall analysis | Have |
| Don't edit scoped files while review runs | No step tells the orchestrator to edit during review (not enforced); the guard keeps hunters from writing | Have |
| Report: rounds, model, what review changed, **diff size before/after**, fixed and declined with reasons, usage | `ql report`: Blocked on me / Changed / Found | Diff size: yes, with 2 |

## full-send and full-stop

| Technique | quality-loop today | Take it? |
|---|---|---|
| **Proof** is evidence observed this session: repro fails → fix → the same repro passes; the CI checks; one focused test that fails without the fix | `debug` builds a red repro; fixers work test-first; `ql round end` runs the checks and reverts on regression | Have |
| Proof must cover **every change in the diff** | Checks cover what they test; each fixed finding names its regression test in `--reason` | Partly. Item 1 covers the review side |
| **Asking the user**: an ordinary message goes unseen and the thread looks done; use the question tool (`AskUserQuestion`) with the full context and the recommended option first; with no tool, take the safe path and lead the final message with the question | `ql pause --reason`, then "ask the user" in plain text (`skills/improve`, `skills/debug`, `decisions.md`) | **Yes**: see 4 below |
| Decide everything else with sensible defaults, and **list those decisions** in the report | The report has no place for decisions made for the user | **Yes**: see 5 below |
| Stay active until the end; ending a turn while CI is pending stops the work | The Stop hook keeps an active loop going, bounded by `maxStopNudges` | Have for the loop. A PR stage would need a watcher (7) |
| Explicit, scoped grant: merge after the gate, `--force-with-lease` on the PR's own branch, the test methods proof needs | The loop never commits or pushes | See 7 |
| A "full send" request **overrides project ask-first rules** for testing | Guard and permission prompts stay on | **No**: the opposite of this plugin's stance on safety |
| **Merge gate**: proof covers the diff; required checks green; review bots finished, each finding fixed or dismissed with a reason; no changes requested; up to date with base; mergeable | Stops at a clean working tree | See 7 |
| full-stop: never merge; turn off auto-merge and merge queues; re-check the live PR; hand off as **Ready / Waiting for required approval / Blocked** | — | See 7 |
| full-stop: after a rebase or conflict fix, re-check proof and review on the final diff | A moved base is not part of the scope model | With 7 |
| A trigger that fires even on a closing "Full stop." read as emphasis | Skills fire on their descriptions | No: an easy trigger for a skill that pushes code is a hazard |

## What to take, in order

1. **No `DONE` with unreviewed fixes.** When a round has fixed findings, `ql round end` returns `CONTINUE` for one confirmation round that reviews only the fixes (the diff-only scope already does that), unless the cap is reached. Then `CAPPED` reports the fixes as validated but not reviewed. Deterministic and testable in `decide.mjs`. Cost: an extra round in most loops, so the cap of 3 is reached sooner. Worth checking with `tune-reviewer` on cases where a fix itself introduces a bug.
2. **A diff-growth meter.** `ql start` records the change's size against the base (files, insertions, deletions). Each `ql round end` records it again, and the report shows before → after. Past a configurable growth (`loop.maxGrowth`), the next fix brief says "cut first" and the report says so. The fixer prompt gets sol-loop's rule: prefer deleting or narrowing over new locks, caches, helpers or options. This keeps "fix every instance of the bug class" (source post 1) bounded to the change, without adopting sol-loop's "fix only the case that happened".
3. **Severity tied to the change's intent.** Add to `bug-hunter.md` and `finding-verifier.md`: a defect on another path, in a rare case, or a small performance cost is a `nit` unless REVIEW.md says that path matters. Measure it with the `clean` should-not-fire eval cases before and after.
4. **Ask with the question tool.** In `improve`, `debug` and `decisions.md`, after `ql pause --reason`, use `AskUserQuestion` with the reason, what was tried and the options (recommended first). If no answer comes, leave the loop paused and lead the report with the question.
5. **A "Decided for you" section** in `ql report`, filled from the reasons the loop records (`wontfix --reason`, pause reasons, finish-line calls) and from the orchestrator. Or fold it into **Blocked on me** to keep three headings.
6. **A cross-model lens.** A runner command (like `scripts/runners/claude-review.sh`, but for another provider's CLI) runs as one extra hunter. Its JSON goes through the same `ql ingest`, so the quote-at-line evidence check and verifier quorum apply to it like any other lens. That is stronger than sol-loop, where the author agent judges the other model's findings alone. Rules taken from sol-loop: read-only, no subagents, never substitute another model, and no reply never counts as a pass. Needs config (`review.externalLenses`) and an ADR.
7. **A `ship` stage, full-stop style** (a new skill, later). After `improve` reaches `DONE`: commit, file the PR, watch CI and review bots, fix real findings through the loop, and stop at full-send's merge gate with a full-stop handoff (Ready / Waiting for approval / Blocked). Never merge by default; merging only on an explicit grant, like full-send's. The loop itself keeps never committing or pushing; the commits happen outside a loop. A watcher is needed (in cloud sessions, PR activity subscriptions; locally, Monitor on a poller like tstack's `pr-wait`, which is Python and would need porting to keep the plugin dependency-free). This one needs an ADR first.

Not taken: the self-granted budget extension, overriding the repository's ask-first testing rules, T3 Code's own tools (`delegate_task`, `watch_pull_request`), and the council score table (revisit with 6).
