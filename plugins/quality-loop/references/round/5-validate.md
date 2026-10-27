# Round step 5: Validate and decide

`ql round end`. It runs every configured check, re-runs a newly failing one once to rule out flakiness, compares against the round's start, scans the round's own diff for weakened tests (skips, `.only`, deleted test files, dropped assertions), and **reverts the round to its checkpoint** on any regression.

It prints one line per check; a failing check also shows its last lines and the path of its full log. Read the failures, and the log when the last lines do not explain them.

Then act on the decision: a plain `CONTINUE` starts the next round from step 1. Any other decision (`REVERTED`, `DONE`, `CAPPED`, `STALLED`, `PAUSED`) comes with `step: …/decisions.md`: read that file and do what the decision's row says.

Done when: `ql round end` has printed a decision and you have acted on it.
