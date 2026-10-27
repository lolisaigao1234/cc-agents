# Round decisions and the report

`ql round end` printed a decision, or `ql next` named this file for a stopped loop. Act on it from this table.

| Decision | What you do |
|---|---|
| `CONTINUE` | Next round from step 1 (`ql round begin`). |
| `REVERTED` (with `CONTINUE`) | The round's edits are gone. Read the reasons; the next attempt takes a different approach — the same fix reverts again. |
| `REVERTED` (with `PAUSED`) | The revert could not undo everything: the `revert incomplete:` reasons say what is still on disk (commits, nested repositories, unreadable files). Make no edits. Show the user those reasons and wait for them. |
| `DONE` | ql's criterion is met: required checks pass and nothing important is open (in debug, the repro passes). Check a custom finish line as the calling skill says, then `ql report` and present it. |
| `CAPPED` | Stop. Report, and ask the user to reconsider the approach. Only the user can extend (`! ql extend`). |
| `STALLED` | Stall analysis: read every remaining open or stuck finding and bucket it by root cause (wrong approach, ambiguous requirement, flaky check, finding that is really a false positive, needs a design decision). Make no edits. Report the buckets. |
| `PAUSED` (by `ql pause`, or the repro passed at start) | Make no edits. Show the user the reason `ql status` gives and wait for their answer; then `ql resume`. A repro that passed before any fix leaves nothing to resume: build one that fails while the bug exists and `ql start` again. |
| `ABORTED` | The loop is over. Make no edits. `ql report`, and present it with the abort reason. |

Done when: you have done what the row for the decision or status says.

## The report

`ql report` writes the final report: a count line first, then **Blocked on me**, **Changed**, **Found**. Present it as written, adding anything you could not confirm, marked as unconfirmed with where you looked.
