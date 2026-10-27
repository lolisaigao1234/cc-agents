# Round step 4: Fix one bug class at a time

`ql brief fix --all` writes one brief per open bug class (confirmed findings grouped by class). Each brief holds every finding of the class (all instances get fixed, not one line) with the verifiers' evidence, the repository's check commands, and the output path `.quality-loop/work/round-<n>/fix-<class>.json`. Each printed line names a wave: classes in one wave touch different files and run in parallel; waves run one after another. Spawn one `fixer` subagent per line, prompted `Brief: <brief path>`. `ql brief fix <class>` rewrites one class's brief, for a retry.

**Check the evidence before you accept it.** For each finding the fixer claims in its output file, read the diff (`git diff`) at the cited place and the test it added, and confirm the command output it quotes. Then:

- `ql mark <id> fixed --reason "<what changed; regression test name; command and result>"`
- `ql mark <id> wontfix --reason "<why>"` only when the behaviour is intended (REVIEW.md, CLAUDE.md or the user says so) or out of the change's scope. Getting to green is never a reason.

A finding the fixer could not fix stays confirmed; the loop counts its attempts and escalates it as stuck. A fixer's `outside` lines are defects beyond its class that it left alone: pass them on to the user with the report.

Done when: every confirmed finding is marked or explicitly left for the next attempt.
