# v6: F-convergence, all on

Every idea in the F-convergence family switched on together. The post's case: an agent author and an agent reviewer "can keep each other busy indefinitely"; about 59% of what a reviewer kept flagging was code there since its first pass. The post's fixes are a round cap, diff-only re-review after the first few passes, no repeats, findings that clear on their own, and extra rounds only on risky changes. Its measured effect: one-round pass rate 65% to 78%, mean reviews to pass 2.08 to 1.32.

Files:

- `plugin/skills/trace/SKILL.md`: a copy of `plugins/trace/skills/trace/SKILL.md`. The rounds paragraph (line 20) is rewritten and two short paragraphs follow it. Every other line is byte-identical.
- `plugin/hooks/hooks.json`: a copy of `plugins/trace/hooks/hooks.json` with every entry kept. It adds three entries for `scripts/variant/rounds.mjs`: PreToolUse (matcher `Skill|Bash`), UserPromptSubmit and Stop.
- `plugin/scripts/variant/rounds.mjs`: the round cap and the review bound to its commit (see below). It is plain Node ESM with no dependencies. It acts only in traced repositories and not under `TRACE_BYPASS=1`, and it fails open.
- No `repo/`, `repo-append/` or `prompt`: the agent needs nothing it would read as a file.

## Ideas

### round-cap: implemented

- Quote: "A round cap. After three rounds, the reviewer asks the author to step back and reconsider the approach."
- On: the cap is 3, as the post recommends, and a hook enforces it (the switch's variant). Today the cap is prose only.
- Skill text: "After three rounds, step back and reconsider the approach: a hook refuses a fourth round until the human replies."
- Hook (`rounds.mjs pre-tool-use`):
  - A review round is a Skill call to Claude Code's `/code-review`, matched as `/^\/?code-review\b/`, the same rule the grader counts by. Matt's `mattpocock-skills:code-review` is not a round.
  - The hook counts rounds per session and repository, across the main agent and its subagents.
  - It denies the fourth `/code-review`. The reason says to step back, reconsider the approach, answer the open findings, and ask the human if another round is still needed.
  - A human prompt lifts the cap (`rounds.mjs user-prompt-submit`). A background agent's `<task-notification>` prompt does not. The session's opening prompt comes before any round, so it lifts nothing.
- Choice: the post has the reviewer ask the *author* to step back. Here the author is the agent, which today ran past the prose cap (five rounds). So the hook makes the cap hard, and only the human can lift it. With no human in the replay, the agent stops at three rounds.

### diff-only-rereview-timing: implemented

- Quote: "Diff-only re-review after the first few passes."
- On: diff-only from round 3. Rounds 1 and 2 review the whole PR diff. Of the switch's values (every round full; diff-only after round 1, the current one; after round 2; after round 3), "after round 2" is the reading of "the first few" that still has an effect under a 3-round cap. With "after round 3", every capped round would be a full review.
- Skill text: "Rounds one and two review the whole PR diff; later rounds review only the diff since the last reviewed commit." This replaces today's "After the first round, review only the new diff."

### no-repeat-findings: implemented

- Quote: "No repeats of findings already posted."
- On: the switch's reviewer-side setting. Each re-review gets the earlier findings and their answers in its arguments, with "do not repeat answered findings". `/code-review` runs as a forked skill that would otherwise start blind every round, and the free text the agent puts in its arguments reaches the reviewer. The agent also drops a repeat that gets through anyway, as the backstop (the switch's "dedupe after review"). The exception is a finding that shows the answer was wrong: a careful owner keeps that door open, since the arm's own downside case is a repeated finding that was real.
- Skill text: findings go in one PR comment (`gh pr comment <pr> --edit-last --create-if-none`), each marked open, cleared or answered with its reason. "Give each re-review the answered findings in its arguments and ask it not to repeat them unless it shows an answer was wrong. Do not raise again a finding already posted and answered, unless the new round shows the answer was wrong."
- Why a PR comment: the post's findings are posted on the PR. A record on GitHub survives compaction and is visible to the human (ADR 0006). A local file would land in the diff, or be the local task file ADR 0006 rejected.

### finding-auto-clears-when-fixed: implemented (agent-side)

- Quote: "If a later commit fixes the issue, the finding clears on its own."
- On: the switch's "each re-review gets the open findings and checks each against the new HEAD, closing resolved ones in the findings record". In the post, "on its own" means the author's claim does not clear a finding; the system's re-check does. The agent-side analogue is a check in fresh context.
- Skill text: "Your own fix does not clear a finding: after fixing, and before each re-review, a fresh subagent checks every open finding against the new HEAD and clears only those it finds gone."
- "After fixing" is there so the check also runs on a one-round PR (see the next idea), where no re-review follows. Otherwise its findings would never clear.

### extra-rounds-only-on-risky: implemented

- Quote: "We'd gotten used to running several rounds by default ... This can be worthwhile on a risky change, but not on every PR."
- On: the switch's "one review round by default; re-review after fixes only when the tier is High or an Important finding was fixed".
- Skill text: "One round is the default: review again after fixes only when the change is high risk (a miss would make a hook block, halt or let through the wrong thing, or lose work) or a fix answered a real bug rather than a nit."
- Choice: the trace has no tier table (that is family H). "High risk" is defined inline by blast radius, in role terms from this repo's own purpose (ADR 0005: the plugin is guardrails). "Important" becomes "a real bug rather than a nit", since `/code-review`'s severity labels are not something the skill can rely on.

### review-bound-to-commit: implemented, as a nudge

- Quote: "An approval covers one specific commit. If new commits land that the system can't vouch for, like an agent's push ..., the approval has to be given again."
- On: the switch's hook. Each `/code-review` round records the HEAD it ran on. When HEAD has moved since the last review:
  - `gh pr ready` is denied (`rounds.mjs pre-tool-use`), also with gh flags before `pr` (`gh -R <repo> pr ready`).
  - Stopping is blocked (`rounds.mjs stop`).
  - Either reason names the unreviewed commits and says to review them or to say in the progress comment why they need none.
- Skill text: "A review covers the commit it ran on. Commits after the last review leave the PR unreviewed: review them, or say in the progress comment why they need none. A hook reminds you once per commit."
- Stop is the gate that matters here. The replay opens its PR as ready for review, not as a draft, so `gh pr ready` almost never runs. The agent's final stop is when it hands the PR to the human.
- A session with no recorded review is not nudged. Stop fires at the end of every turn, and an Implement-only session must not be told to review.
- Conflicts, and why this is a nudge rather than a hard refusal. Each refusal applies once per HEAD, which also bounds the Stop loop: every further block needs a new commit. The Stop block does not yield to `stop_hook_active`. In `claude -p` that flag stays true once any Stop hook has blocked (the trace's own progress-comment nudge included), so yielding to it would leave every commit after the first nudge unflagged.
  - With **extra-rounds-only-on-risky**: a low-risk PR is meant to get one round, and its fix commits then land after that round. A hard refusal would force a second round on every PR that got a fix, and switch the other idea off. The nudge makes the stale review visible and lets the agent answer it with a reason.
  - With **round-cap**: fixes for round 3's findings land after the last allowed round. A hard refusal would deadlock against the cap. The Stop reason says so when the cap stands: name those commits as unreviewed in the progress comment and ask the human for another round.
- Out of scope: the human-approval half of the idea (dismissing approvals on new commits). ideas.json already marks it untestable here.

## Not implemented

None. Each idea has an agent-side form this harness can run. Two limits of the form chosen:

- The cap and the review record live per Claude Code session, in `$TMPDIR/trace-variant-rounds/`. A real loop spread over several sessions would need them keyed by branch and kept across sessions. The replay runs one session per case, so this does not bite here.
- "Clears on its own" is done by a fresh subagent the agent is told to run, not by a system outside the agent. A check outside the agent would need CI on the replay repository to re-run review on each push, which the harness does not set up.

## Hook tests

`rounds.mjs` was run on crafted JSON in a scratch traced git repository, and `node --check` passed:

- Rounds 1 to 3 pass and round 4 is denied. Matt's code-review is not counted.
- A `<task-notification>` prompt leaves the cap in place, and a human prompt lifts it.
- Stop:
  - With HEAD unchanged, stopping passes.
  - With HEAD moved, stopping is blocked once, with the cap note when the cap stands. A second stop at the same HEAD passes.
  - With `stop_hook_active: true`, a stop is still blocked once for each new HEAD: after a fix commit, and again after a second one.
- `gh pr ready` is denied once per HEAD, then passes, written plain, as `gh -R o/r pr ready 2`, `gh --repo=o/r pr ready`, and after `cd x &&`. `--undo` and `gh -R o/r pr view` are ignored. A command of 3000 flags runs in about 60 ms (no backtracking blow-up).
- Sessions are counted separately.
- These inputs pass silently with exit 0: `TRACE_BYPASS=1`, an untraced repository, a directory outside any repository, a missing cwd, an empty repository, garbage, empty or non-object stdin, wrong field types, and a corrupt state file.
