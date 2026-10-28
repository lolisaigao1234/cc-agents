# Round step 4: Fix one bug class at a time

`ql brief fix --all` writes one brief per open bug class (confirmed findings grouped by class). Each brief holds every finding of the class (all instances get fixed, not one line) with the verifiers' evidence, the repository's check commands, and the output path `.quality-loop/work/round-<n>/fix-<class>.json`. Each printed line names a wave: classes in one wave touch different files and run in parallel; waves run one after another. Spawn one `fixer` subagent per line, prompted `Brief: <brief path>`. `ql brief fix <class>` rewrites one class's brief, for a retry.

Each brief's Size section says how big the change is; `ql round end` warns when the loop's fixes have grown it past `loop.maxGrowth`. After such a warning, cut first: before briefing fixers, remove what earlier fixes added that their findings did not need (guards for cases no finding names, new helpers, options, caches or locks), keeping every test and assertion.

**Check the evidence before you accept it.** For each finding the fixer claims in its output file, read the diff (`git diff`) at the cited place and the test it added, and confirm the command output it quotes. Cut what the fix added beyond its findings. Then:

- `ql mark <id> fixed --reason "<what changed; regression test name; command and result>"`
- `ql mark <id> wontfix --reason "<why>"` only when the behaviour is intended (REVIEW.md, CLAUDE.md or the user says so) or out of the change's scope. Getting to green is never a reason.

A finding the fixer could not fix stays confirmed; the loop counts its attempts and escalates it as stuck. Pass a fixer's `outside` lines on to the user with the report: they are defects beyond its class that it left alone.

Done when: every confirmed finding is marked or explicitly left for the next attempt.
