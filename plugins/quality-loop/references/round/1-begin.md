# Round step 1: Begin

`ql round begin`. It checkpoints the working tree and prints the review **scope** in short: the diff file, how many files changed, and the lens names. Round 1 reviews the whole change against the base; later rounds review only what changed since the last kept round (diff-only re-review), so old code is not re-litigated every round.

Done when: the round number and scope are printed.
