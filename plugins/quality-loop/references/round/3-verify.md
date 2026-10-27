# Round step 3: Verify by quorum vote

`ql brief verifiers` writes one brief for every vote a candidate still needs (`verifiers` votes per finding, `quorum` to confirm). Each voter on a finding gets a **different stance**, cycling `reproduce`, `trace`, `intent`, `counterexample`, `blast-radius`. Each brief holds the finding's full JSON, its stance, the voter name `<stance>-<id>`, and the output path `.quality-loop/work/round-<n>/vote-<id>-<stance>.json`.

Spawn one `finding-verifier` subagent per printed line, all in one message (batch past ten), each prompted `Brief: <brief path>`.

Record the vote files with `ql vote <file> [file ...]`; several at once is fine (`ql vote .quality-loop/work/round-<n>/vote-*.json`), and votes arriving after a finding settled are kept and change nothing. It prints one line per finding: the outcome and the tally. A candidate left `undecided` (a verifier failed or wrote nothing) gets its missing votes re-spawned with new stances: run `ql brief verifiers` again.

`ql pending` lists the candidates still waiting, one line each; the full JSON is in the file it names.

Done when: `ql pending` shows no candidates.
