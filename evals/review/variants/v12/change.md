# v12: K-settlement, all on

Every idea in the K-settlement family switched on together. The family is not from Anthropic's post. It comes from Google's [elephant-goldfish-model](https://github.com/google/elephant-goldfish-model) (EGM), a plugin for reviewing design documents, whose review loop settles findings with three rules trace does not have: an answer must be checkable, fixes that undo each other stop the loop, and one clean round is not the end. EGM reviews documents, not code, and publishes no measurement of these rules, so this arm is the measurement.

Files:

- `plugin/skills/trace/SKILL.md`: a copy of `plugins/trace/skills/trace/SKILL.md`. The rounds paragraph (line 20) is rewritten and one paragraph follows it. Every other line is byte-identical.
- No hooks, scripts, `repo/`, `repo-append/` or `prompt`. All three rules are skill text: each needs a judgment no hook can make (is this evidence, would undoing this fix resolve that finding, is this finding a nit).

## Ideas

### checkable-answers: implemented

- Source: EGM `skills/egm-resolve/SKILL.md`: "A contest must be checkable. 'This was intentional' is not evidence. If you cannot cite evidence the reviewer could read, use ESCALATE or PROPOSE FIX." And: "You wrote the document under review. A wish to contest is not evidence that the reviewer is wrong."
- On: a finding answered with a reason instead of a fix must cite evidence the reviewer could check: a file and line, a test, or a decision recorded in an issue or ADR. Without it, the agent fixes the finding or asks the human (EGM's ESCALATE).
- Skill text: "Answer every finding with a fix or, in the progress comment, a reason that cites evidence the reviewer could check: a file and line, a test, or a decision recorded in an issue or ADR. "It was intentional" is not evidence, and neither is the wish to defend code you wrote. Without such evidence, fix the finding or ask the human."
- Off (baseline): "Answer every finding with a fix or, in the progress comment, a reason." Nothing asks what the reason rests on.
- Expected effect: fewer real findings waved away, so `fixed` rises. The risk is the agent acting on wrong findings it can no longer dismiss, so `harmful` on clean cases may rise.

### churn-stop: implemented

- Source: EGM `skills/egm-review-loop/SKILL.md`: "Churn: A new finding is at the scope of an applied fix, and reverting that fix would resolve it." On churn, the loop lists the open findings and asks the user one question.
- On: when a new finding sits in code an earlier fix in the same PR changed, and undoing that fix would resolve it, the agent stops, records it in the progress comment and asks the human which way to go.
- Skill text: "If a new finding is in code that an earlier fix in this PR changed, and undoing that fix would resolve it, the fixes are going in circles: stop, record it in the progress comment, and ask the human which way to go."
- Off (baseline): only the three-round cap stops a loop.
- Expected effect: `reintroduced` on the convergence cases falls, and so do `reviews` and `five_plus`. `asked_human` rises.

### two-clean-rounds: implemented

- Source: EGM `skills/egm-review-loop/SKILL.md`: "Clean round: A round is clean when no reviewer raises a Blocker or Major finding that is not settled. Nits do not block." And: "Converged: Two consecutive clean rounds. One clean round is not enough, because the next fresh reviewer can find a different gap in the same text."
- On: a round is clean when its review raises no finding, other than a nit, that is not already answered. Review ends after two clean rounds in a row. After a clean round, the next round reviews the whole PR diff again. After a round with fixes, review stays diff-only as in the baseline.
- Skill text: "A round is clean when its review raises no finding, other than a nit, that is not already answered. Review is done after two clean rounds in a row, because a fresh review can find what the last one missed: after a clean round, review the whole PR diff again." The baseline's "After the first round, review only the new diff" becomes "After a round with fixes, review only the new diff".
- Choice: EGM re-reads the whole document every round. Trace re-reviews only the new diff after round one, so a confirming round after a clean one would review an empty diff and always pass. The confirming round therefore reviews the whole PR diff.
- Choice: the three-round cap stays. A loop with one fix round reaches its second clean round at round three. A loop that is still finding things at round three stops at the cap, as in the baseline.
- Expected effect: a second fresh review of the whole diff raises `recall` and `fixed`. The cost is more `reviews` on clean cases, which the goal holds flat. This is the idea most likely to trade rounds for recall.

## Cases (38)

- All 12 convergence cases: the loop rules act there, and `reintroduced` is measured only there.
- The 12 bug cases that are historical fix rounds (`-r1`, `-r2`, `-r3`, `pr38-halt1`, `pr38-halt2`): diffs written to answer findings, where churn and dismissed findings happened.
- All 14 clean cases: what a confirming round and a stricter answer rule cost when there is nothing to find.

The list is in the screen's `cases-v12.txt`.

## Not implemented

- EGM's severity triage (Blocker, Major, Nit) as a field on each finding. Trace has no severity scale, so "other than a nit" is the agent's call.
- A rule that a reviewer which fails or returns nothing makes the round not clean. That is a correctness rule rather than a trade-off, so it goes into trace directly, through its own issue, and not into this arm.
