# v9: family I, cross-case learning, all on

This variant switches on every idea in `I-cross-case-learning` together, for the first family screen. **Neither idea can be run in this harness, so v9 implements nothing.** Both ideas are about what one review teaches the next PR, and every case here runs alone, starting from a reset. The variant directory holds only this file and `variant.json` (`"ideas": []`). There is no `plugin/`, `repo/`, `repo-append/` or prompt text.

**Do not spend a screen run on v9.** Its plugin, repository and prompt are byte-for-byte the baseline's. A run would therefore be an A/A comparison. Any gap from the baseline would be noise, so it would at most help measure the noise floor. It would say nothing about this family.

## fix-recurring-findings-at-source: not implemented (deferred)

> "When the automated reviewer keeps flagging the same thing, we fix it at the source: in the skill, with a lint rule, or with updates to instructional files such as `CLAUDE.md` [and] `REVIEW.md`". Under Adopt: "Add a `REVIEW.md`, and move repeated review comments into it."

**The switch.** On: cases replay one after another in history order. Once a finding class has appeared twice, the agent adds a REVIEW.md or CLAUDE.md line, or a test, and that addition carries into later cases. Off: each case resets. The metric is how often finding classes repeat, and how many bugs of the same class escape, in later cases.

**Why the harness cannot run it:**
- `setup()` fixes the repository overlay (`R.repoOverlay`) once per run. `buildReplay` makes a fresh repository for each case from that fixed overlay. Nothing the agent writes in one case reaches another.
- Cases run concurrently (`--concurrency`, default 2). They run in `cases.json` order, not in history order.
- The idea's "Off" setting is today's harness. Its "On" setting needs state carried between cases, which is the example the task rules give of what not to fake.

**Forms considered and rejected:**
- *Within one PR, across review rounds.* Skill text would say: when a class of finding comes back in a later round, add a test, a lint rule or a CLAUDE.md/REVIEW.md line in this PR. This was rejected for three reasons:
  - It is a different, weaker idea, and its payoff (later PRs) is never measured. The arm would record only the costs: a larger diff under review, more rounds, and new files that the judge sees in `changes`.
  - Its useful part already exists. SKILL.md says "Fix the finding's whole class", and the bug-class and no-repeat ideas (`reviewer-flags-bug-class` in C, `no-repeat-findings` in F) test the rest. Adding it here would mix those families into this one.
  - It would still be a stand-in for an idea the harness cannot run.
- *A hook that carries state between cases.* Every case in a run shares the plugin copy, and a hook runs outside the sandbox, so a hook could store notes in the plugin copy and inject them into later sessions. This was rejected:
  - It gets around the harness's case isolation. The sandbox hides other cases' clones because later snapshots hold the fixes to earlier cases' bugs.
  - Cases run in parallel and in no history order, so a lesson could flow from a later case to an earlier one.
  - Reps would contaminate each other.

**Harness support it needs:**
1. **A sequential mode.** It runs one chain with concurrency 1, ordering cases by their head commit's date in the source repository (`git log -1 --format=%ct <head>`). Each rep is its own independent chain. The off arm runs the same order with nothing carried.
2. **A carried store per chain.** After each case, the runner takes from the agent's final tree only the files that count as "the source":
   - REVIEW.md, the CLAUDE.md lines it added, lint configuration, and the skill copy, if the variant lets the agent edit it.
   - Tests the agent added for a class, which are optional. These are carried as a patch applied with `git apply --3way` to the next snapshot. A patch that conflicts is dropped, and the drop is logged.

   The runner lays the store over both trees of the next case, the way `overlayRepo` does now, so the carried files never appear in the next PR's diff. Grading leaves them out of `changes`.
3. **The earlier reviews, visible to the agent.** "Keeps flagging the same thing" needs the agent to see earlier reviews. Two ways to provide them:
   - Carry each earlier case's posted review comments and progress comments into the chain's next replay repository, as closed PRs and issues.
   - Or carry a log file of them in the store.

   Either way, it must hold only what the agent itself wrote in earlier cases of the same chain, never the answer key or the source repository's history.
4. **Leak checks** that run before each lay-down. The store must not name the source repository's owner, and must not quote anything that the replay's slug rewriting would have removed.
5. **Class labels on findings.** The judge labels every finding, matched or not, with a class from a fixed, small class taxonomy. That taxonomy is still to be defined: the free-text `bug_class` values in `bugs.json` (76 distinct values over 155 bugs) would first need normalising into it. Repeat classes and same-class escapes can then be counted over the chain, against the off chain.
6. **More cases.** `ideas.json` coverage says `enough: false`. The arm needs three recurring classes with 2–4 instances each, in time order. Even with the support above, it would be reported as "too few cases to decide" until those cases exist.

## miss-analysis-into-context: not implemented (deferred)

> "When a review misses something, we ask what the model didn't have in front of it and put the fix into a `CLAUDE.md`, a skill or a new check."

**The switch.** On: a loop. For each missed case in the train split, an agent writes the context that was missing. Then the held-out split is rescored. Off: static context. The metrics are held-out recall and noise on held-out clean PRs.

**Why the harness cannot run it:**
- The flow's `_state.json` already accepts `train_ids` and `test_ids`, and `--cases` can pick the held-out cases. But there is no learning phase: no step that reads the baseline's misses on the train split and turns them into context.
- That step is the idea itself. If the variant's author wrote the context by hand, they would do it from `bugs.json` and the baseline's misses, and that is exactly the answer key the fairness rule forbids. It would also be one person's single pass, not the loop the post describes.
- Only one train-split case has a baseline row so far (pr16-r1, from the pilot). A loop needs baseline rows on every train case first.

**Form considered and rejected:**
- *A miss within one session.* Skill text would say: when a later round finds a bug an earlier round missed, ask what the first review lacked, and add it to CLAUDE.md or REVIEW.md in this PR. This was rejected:
  - The context only helps later rounds of the same PR, while the idea's metric is held-out recall.
  - It overlaps with the round-cap and diff-only ideas in F.
  - It adds docs churn to the diff under review.

**Harness support it needs:**
1. **A recorded split.** `_state.json` (or `cases.json`) records the time-ordered split from the coverage note: train is pr14..pr18 (Oct 28–29); held-out is pr19..pr38, with the clean and convergence cases dated after the cut.
2. **Baseline rows on every train case.**
3. **A learning command**, for example `run.mjs --learn --from baseline --split train --to v<N>`. For each train row with a missed bug, it runs one agent that sees:
   - the miss (the bug's description and location from `bugs.json`, which is fair for train cases);
   - the reviewer's transcript and findings from that row;
   - the case's snapshot.

   The agent answers "what didn't the model have in front of it?" with an addition to CLAUDE.md, REVIEW.md, the trace skill or a check script. A final agent merges and de-duplicates the additions, keeping them short. The command writes the result as a generated variant: `repo-append/CLAUDE.md`, `repo/REVIEW.md`, and `plugin/skills/trace/SKILL.md`.
4. **A leak gate on the generated context**, which fails the variant if the text names any case id, PR number, commit sha or bug id, or quotes a held-out bug's description or location.
5. **Held-out scoring.** The new variant and the baseline run on the held-out bug cases and on the held-out clean cases, for noise. Recall and harm are reported on held-out rows only.
6. **Optionally, more passes of the loop.** Each pass learns again from the train misses that remain under the new variant. This is the post's "keep the change if the score goes up".

## Conflicts

None. Both ideas write to the same places (CLAUDE.md, REVIEW.md, a skill or a check), and both need state carried between cases. A harness that supports one would mostly support the other:
- one carried store;
- one rule for what may go into it;
- one leak gate on it.

They differ only in trigger and order. Fix-at-source fires on a class seen twice, in history order. Miss-analysis fires on a miss, with a train/held-out split.
