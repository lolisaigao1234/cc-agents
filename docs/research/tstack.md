# What quality-loop can take from tstack

[t3dotgg/tstack](https://github.com/t3dotgg/tstack) is a set of nine agent skills for Claude Code and Codex. This note goes through each of them, technique by technique: what quality-loop already has, what it lacks, and whether to take it. Read 2026-10-28. Paths are relative to `plugins/quality-loop/`.

| Skill | What it does | How close to quality-loop |
|---|---|---|
| `sol-loop` | A second model (GPT Sol) reviews the change in rounds until both agents agree | Same loop, different reviewer |
| `full-send` | Unattended, from a change to a merged PR: prove, review with `sol-loop`, file, babysit, merge at a gate | The loop plus everything after it |
| `full-stop` | `full-send` that stops with the PR ready for a human to merge | Same |
| `council` | Three models from three providers review until all are satisfied, with scores | A multi-model review |
| `babysit-pr` | Watches a PR through CI and review bots, and fixes real findings | After the loop |
| `file-pr` | A short PR that leads with the problem | After the loop |
| `takeover` | Finishes someone else's PR, branch or agent thread and keeps their credit | Partly |
| `modernize` | Rebases an old PR and decides if it should still exist | Partly |
| `leaving-pr-comments` | Format for comments an agent posts for the user | After the loop |

Where they differ in kind: tstack is prompt-only, while quality-loop puts what must hold every run in `ql` (ADR 0001). So a technique worth taking usually becomes a `ql` rule, not just a sentence in a skill.

## Scope creep: taken

Every tstack skill that reviews or fixes repeats the same warning: review loops grow a change one cheap-looking fix at a time. These are the rules, and where each now lives:

| tstack rule | Where | Now in quality-loop |
|---|---|---|
| "Make the most minimal possible changes … be careful of scope creep and don't be scared to push back" | sol-loop | `references/round/rules.md`: keep the change the size its intent needs; never accept a finding just to end the loop |
| "Do not let repeated reviews result in scope creep. It is your job to fight to keep scope limited" | council | Same rule; the orchestrator owns it |
| "Keep the PR at the size the user's goal needs … decline the rest with a written reason and list them as follow-ups: unneeded tests, guards for edge cases that do not matter, extra integration or compatibility, small performance costs" | babysit-pr | `rules.md`; such defects are nits, and open nits are listed in the report's **Found** |
| "Fix the case that happened, not every case that could" | full-send, sol-loop | `agents/fixer.md`: an instance is code that has the defect now, not a case that could arise. Fixing every instance of a bug class (source post 1) stays |
| "Agree: smallest fix. Prefer delete or narrow over new lock, cache, helper, or option" | sol-loop | `agents/fixer.md` step 3; `agents/bug-hunter.md` for the suggested fix |
| "Add one focused test that fails without the fix" | sol-loop, full-send | `agents/fixer.md` step 2: one focused regression test |
| "Another path, rare case, or small cost is a nit, whatever label it came with" | sol-loop | `agents/bug-hunter.md` and `agents/finding-verifier.md`. The verifiers' majority sets severity, so the rule is in their prompt too. A security hole stays `important` wherever it is |
| "Flag code, tests, or guards the intent does not need" | sol-loop | `agents/bug-hunter.md`: such code is a `nit` in `maintainability`. Tests are left out, since deleting them is weakening and reverts the round |
| "State intent and out-of-scope in 1–2 sentences" / "state the smallest coherent goal … before judging its implementation" | sol-loop, modernize | `references/round/2-review.md`: `--intent` carries both |
| "Re-run … `git diff --shortstat <base>`. If review grew the diff, cut first" | sol-loop | **`ql` size meter** (`scripts/lib/size.mjs`): code and test lines against the base at `ql start` and after every round, shown by `ql round end`, the fix briefs, `LOOP.md` and the report. When the fixes grow the code past `loop.maxGrowth` (50%, at least ten lines), `ql round end` warns, the fix step cuts first (`4-fix.md`), and the report puts it under **Blocked on me**. A debug loop shows the sizes without the warning, since its fix is the whole change |
| "Do not defend an implementation just because another agent already built it" | takeover | `rules.md`: never keep code just because an agent wrote it |
| "Report … diff size before/after" | sol-loop | `ql report` **Changed**: size at start → now |

## sol-loop

| Technique | quality-loop today | Take it? |
|---|---|---|
| A reviewer from **another provider**, read-only, with no subagents of its own | Every hunter and verifier is a Claude subagent. The root README already plans third-party reviewers | **Yes**: proposal 2 |
| **Never substitute a model.** If no route runs the named reviewer, report the blocker | No external reviewer yet | Yes, with 2 |
| **Timeout, error or no reply is not approval** | A hunter whose output is missing or invalid gets one re-run (`2-review.md`); after that, nothing stops `--none` being recorded for its lens | Yes: proposal 4 |
| Round budget 3; later rounds see only changed code and open findings | `loop.maxRounds` 3; diff-only re-review; `known-findings.json` in hunter briefs | Have |
| Extend to 5 by itself for security, auth, data loss or concurrency | Only the user may extend (`ql extend`, guarded) | **No**: conflicts with "only the user may extend" |
| Stop early if a round returns only nits | `DONE` ignores open nits; `maxNitsPerRound` | Have |
| Next round if **approval does not cover the current behaviour diff** | When a round's fixes close the last important finding, `ql round end` says `DONE`, so those fixes are checked but never reviewed (`test/lifecycle.test.mjs`, "an unfixed confirmed nit…") | **Yes**: proposal 1 |
| Answer each finding: agree, disagree with evidence, decline in one line | Quorum voting, `wontfix --reason`, the fixer's `outside` lines | Have, and stricter |
| Disputed twice → show both sides; the user decides | Stuck findings → `STALLED` | Have |
| Keep a ledger; never guess usage | `state.json`; the report says what could not be confirmed | Have |

## full-send and full-stop

| Technique | quality-loop today | Take it? |
|---|---|---|
| **Proof** is evidence seen this session: repro fails → fix → passes; the CI checks; a focused test | `debug`'s red repro; test-first fixers; checks every round, revert on regression | Have |
| Proof and review must cover **the final diff** | Checks do; review does not for the last round's fixes | Proposal 1 |
| **Asking the user** with the question tool, because an ordinary message goes unseen; with no tool, take the safe path and lead with the question | `ql pause --reason`, then a plain-text question | **Yes**: proposal 3 |
| Decide the rest with sensible defaults and **list those decisions** | No place in the report | **Yes**: proposal 5 |
| Stay active to the end | The Stop hook keeps an active loop going (bounded) | Have |
| A "full send" request **overrides project ask-first testing rules** | Guard and permission prompts stay on | **No**: the opposite of this plugin's stance on safety |
| **Merge gate**; full-stop's handoff as Ready / Waiting for approval / Blocked; turn off auto-merge | The loop stops at a clean working tree | Proposal 7 |
| A trigger that fires on a closing "Full stop." | Skills fire on their descriptions | No: an easy trigger for a skill that pushes code is a hazard |

## council

| Technique | quality-loop today | Take it? |
|---|---|---|
| Three strong models from three providers, in parallel, read-only | One provider | With proposal 2 |
| A score out of 10 per delegate per round, as a table in the PR; "no score", never an invented one | Counts of findings; no scores | No: verified findings with evidence say more than a score. Revisit with 2 |
| Loop until every delegate is satisfied | Until checks pass and nothing important is open, within the cap | Have, bounded |

## babysit-pr

| Technique | quality-loop today | Take it? |
|---|---|---|
| Verify every bot finding against the source before changing code; reply with a reason when dismissing | Every finding passes the quote check and a verifier quorum | Have. Proposal 7 could feed review-bot comments into `ql ingest` as their own lens |
| Tell repository failures from infrastructure flakes | A newly failing check is re-run once (`retryFailedChecks`); infra errors in evals | Have |
| One watcher per PR; never your own polling loop; watchers share one rate limit | — | With 7 |
| Act only on checks and comments newer than the latest push | — | With 7 |
| Never merge when BEHIND or DIRTY, or when base commits since the last green run touch the PR's files | The base is fixed at `ql start` | With 7 |
| Nothing changed → end the turn without a message; never "still waiting" | Status notes go with the next action | Have |

## file-pr and leaving-pr-comments

| Technique | quality-loop today | Take it? |
|---|---|---|
| Lead with the problem, not an inventory; a title that says why the change matters | The report's **Changed** is a list of fixes | With 7, for the PR body |
| Check title, body and comments for secrets and private details before posting | — | With 7 |
| A real PR, not a draft, so review bots run | — | With 7, where the repository allows it |
| Agent comments carry an attribution note; lead with the conclusion; cite code; separate facts from judgment | The report marks what it could not confirm | With 7 |
| Resolve a review thread only after its reply is posted | — | With 7 |

## takeover and modernize

| Technique | quality-loop today | Take it? |
|---|---|---|
| Treat a handoff as context, not proof | Hunters start fresh; the orchestrator checks fixers' evidence; after compaction, read `LOOP.md`, not the summary | Have |
| Don't defend an implementation because an agent built it | — | Taken (scope table) |
| State the smallest coherent goal before judging | — | Taken (scope table) |
| A **disposition**: MODERNIZE / REWORK / CLOSE. Be willing to recommend CLOSE; sunk effort is no reason to keep going | `CAPPED` asks the user to reconsider the approach; `STALLED` buckets root causes | **Yes**: proposal 6 |
| Look past textual conflicts: was the same problem solved on the base, did APIs move, would this restore old behaviour? `git range-diff` after a rebase | The base is fixed at `ql start`; a base that moves is out of scope | With 7 |
| Existing worktree changes are the user's; never an unqualified force push | Checkpoints never touch the index, HEAD or stash; the guard denies force pushes | Have |
| Keep authorship and co-author credit | The loop never commits | With 7 |

## What to take next, in order

1. **No `DONE` while fixes are unreviewed.** When a round fixed findings, `ql round end` returns `CONTINUE` for one round that reviews only the fixes (the diff-only scope already does that), unless the cap is reached; `CAPPED` then reports them as checked but not reviewed. Cost: an extra round in most loops.
2. **A lens run by another provider's model.** A runner command (like `scripts/runners/claude-review.sh`, for another provider's CLI) runs as one extra hunter. Its JSON goes through `ql ingest`, so the quote check and verifier quorum apply to it, which is stronger than sol-loop, where the author agent alone judges the other model's findings. Read-only, no subagents, never substitute a model, and no reply never counts as a pass. Needs config (`review.externalLenses`) and an ADR.
3. **Ask with `AskUserQuestion`** after `ql pause --reason`, in `improve`, `debug` and `decisions.md`: the reason, what was tried, the options with the recommended one first. With no answer, the loop stays paused and the report leads with the question.
4. **A lens that never answered is not a clean lens.** After the one re-run, the hunter's lens is reported under **Blocked on me** rather than recorded with `--none`.
5. **"Decided for you"** in `ql report`, from recorded reasons (won't-fix calls, pauses, finish-line checks), or folded into **Blocked on me**.
6. **A disposition at `CAPPED` and `STALLED`**: the report recommends extending, reworking the approach, or dropping the change, with the evidence, and it is free to recommend dropping.
7. **A `ship` stage, full-stop style** (new skill, ADR first). After `DONE`: commit, file the PR, watch CI and review bots, feed bot findings through `ql ingest`, fix through the loop, and stop at full-send's merge gate with a full-stop handoff. Never merge without an explicit grant. The loop itself still never commits or pushes. Needs a watcher: PR activity subscriptions in cloud sessions; locally, Monitor on a poller like tstack's `pr-wait` (Python, so it would need porting to stay dependency-free).

Not taken: the self-granted budget extension, overriding ask-first testing rules, T3 Code's own tools (`delegate_task`, `watch_pull_request`), council scores, and the "Full stop." trigger.
