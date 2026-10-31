# v7: family G, change shape and timing, all on

Every idea in `G-change-shape-and-timing` switched on together, for the first family screen. Two ideas are implemented; one needs harness support the replay does not have.

Files:
- `plugin/skills/trace/SKILL.md`: a copy of `plugins/trace/skills/trace/SKILL.md` with one clause added to the Implement row and two paragraphs added before "Review and fix run in rounds". Every other byte is unchanged.
- `plugin/hooks/hooks.json`: a copy of `plugins/trace/hooks/hooks.json` with every entry kept and two entries added: a PostToolUse entry (matcher `Bash`), and a SessionStart entry that runs the same script with `seed`.
- `plugin/scripts/variant/commit-review.mjs`: the script for both hooks.
- No `repo/`, no `repo-append/`, and no extra prompt text.

## continuous-review-per-commit: implemented

> "more like spellcheck while you write"

The post: "review runs continuously, more like spellcheck while you write. Most changes have been reviewed and fixed by Claude at least once before a human is asked to look."

**On, as chosen.** The switch's own setting: a PostToolUse hook, after a Bash call that ran `git commit`, asks the agent to run `/code-review` on that commit. The end-of-branch Review step stays, as the post keeps a review on every PR before a person looks.

- **Hook** (`commit-review.mjs`). It fires when all of these hold:
  - the command runs `git … commit` as a command: at the start of the line or after a separator (`;`, `&`, `|`, `(`, a newline, a backtick or `$(`), past any `VAR=value` prefixes. A `git commit` inside quoted text, such as an `echo` or a comment body, does not count;
  - the repository is traced (`.claude/trace.json` at the root);
  - HEAD's newest reflog entry is a commit made in the last 10 minutes;
  - this session has not been asked about that commit before, and the commit is not HEAD as the session found it.

  It then returns `{"decision":"block","reason":…}`. The reason names the commit and asks for `/code-review` on that commit alone, before moving on. It also says the review is part of the current round, so the three-round cap keeps its meaning, and that a commit whose review finds nothing ends the chain. It honours `TRACE_BYPASS=1`.
- **Skill text.** One paragraph tells the agent the hook exists and when the chain ends.
- **Fail safe.** It is a nudge, not a gate. With no git, no repository, unparseable input or an unwritable record, it says nothing or asks once more. It never halts and never throws out of the process.
- **Session seed.** At SessionStart, `commit-review.mjs seed` records the session's starting HEAD as already seen, and prints nothing. Without the seed, the hook would misfire in the replay. The runner makes the PR commit in the agent's own clone just before `npm ci` (`replay.mjs` `buildReplay`), so that commit is HEAD's newest reflog entry and falls inside the 10-minute window. A command that matched without making a commit (for example `git diff --quiet || git commit …`) would then have been told "you just committed" the whole replayed PR.
- **What it covers in this harness.** The hook fires only on the agent's own fix commits. Those are where later bugs and the `reintroduced` metric come from. The first commit gets the ordinary Review step.
- **Tested** by piping crafted JSON into the script in a scratch traced repo with a replay-like PR commit, each session seeded first. Silent: a commit that made nothing, a skipped commit in a `||` chain, `echo '… git commit …'`, a `gh issue comment --body '… git commit …'` (also after a real, unseen commit), a repeat, garbage, empty, `null`, missing `tool_input`, and `seed` with bad input or a cwd outside any repository. Asks: a real commit, `git -c … commit`, `VAR=x git commit`, a newline-separated `git commit` and `git add -A && git commit`. `node --check` passes.
- **Level.** `/code-review` runs at its default level. This variant does not pick a lighter one, so that depth does not get mixed into the timing arm.

## raise-direction-early: implemented

> "raise a different direction in the thread early"

The post: "The trick is to raise a different direction in the thread early, not as a blocking comment on a finished PR", and closing cheap agent-written work "doesn't feel like a loss".

**On, as chosen.** The switch's setting: review the approach (plan or first commit) against the ADRs before full implementation.

- **Implement row.** It now says to review the approach after the first commit, before building the rest. This is faithful to the switch, but this harness never runs Implement.
- **New paragraph.** It asks for the same check "after the first commit, and before the first review round looks at lines". The questions are: should the change exist in this shape, does it go against an earlier decision, is there a simpler route. Where the issue and the ADRs settle it, the agent reshapes or drops the work now. Where they do not, it raises it on the issue (the thread) as a question for the human, then carries on with the review. It ends with "Closing cheap work is no loss."
- **Not blocking.** The post rules out a blocking comment ("not as a blocking comment on a finished PR"), so an unsettled direction is raised in the thread and the review goes on. The round-3 step-back stays the only point that waits on the human. Had this step waited too, the runner's prompt ("where the trace says to ask the human, say so in your final message and stop") would have ended the run before any line review. Recall would then fall for a reason the post argues against, and that would confound the screen.
- **Why this applies in the replay.** The replayed PR commit *is* the first commit, so its approach is checked before line review starts. Today that only happens at the round-3 step-back. The paragraph names no module, case or bug.

## small-changes: not implemented (deferred)

> "Changes are small"

The switch: split any diff over N lines into stacked PRs before Review, and compare split against whole replay. The task rules name a case split into stacked PRs as something not to fake.

The harness cannot run it:
- `buildReplay` makes one branch and one PR.
- `gitHubMaterial` collects comments only from that issue and that PR.
- `changes` is the clone's working tree diffed against the replayed head, whichever branch the agent ends on.

If the agent split the PR itself, findings posted on the other PRs would be lost. The final diff would also be measured against the wrong tip.

**Harness support it needs:**
1. A replay mode that lays a case down as a stack of PRs: each slice is a branch based on the previous one, with its own `Closes`/`Part of` link to the issue. The split points come from the case data (for example, by module or by historical sub-commit), or from an agent's split that the runner then replays.
2. Grading that gathers findings and comments from every PR in the stack, and diffs the stack's tip against the case head.
3. Paired runs of the same case as one PR and as a stack, so recall per changed line and rounds-to-pass can be compared. The coverage note says this counterfactual is missing today.

A weaker form was considered and rejected: "keep each fix commit small". It is not the switch, and it would confound the per-commit review arm, because the number of commits drives how often that hook fires.

## Conflicts

None between the two implemented ideas:
- The approach check runs once, at the start of the Review step.
- The per-commit review runs on each later fix commit.

The approach check comes first because a reshaped approach makes earlier line findings moot.
