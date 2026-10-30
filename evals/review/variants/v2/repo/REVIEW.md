# Review guide

What matters when reviewing a change here, part by part. `CLAUDE.md` says what the project is. The ADRs in `docs/adr/` are the authority: where this file and an active ADR disagree, the ADR wins.

## Every change

Read the diff against the issue it closes and against the code around it, not on its own. Ask whether it solves the issue's problem, fits how the rest of the system works, and leaves every caller and every doc true.

## Hooks and the trace gates

The gates ask git and GitHub (the branch, the issue, the repository) before each verdict. The ADRs and the plugin's README say exactly what is refused and what is allowed.

Failure looks like:
- a call let through that the docs say to refuse;
- a call refused that they allow;
- git or GitHub giving no answer, and the hook treating that as an answer (most often, as "allowed") instead of doing what the docs require;
- a deny the agent cannot act on, because it does not say what to do next.

## The guard

Failure looks like a command that destroys work or history getting through, or an ordinary command refused.

## The archive block

Failure looks like any route for an agent to read, search, list or copy out of `archive/` that its ADR says is closed; or a refusal of a command that never reaches the archive.

## The band and the `/trace` command

Failure looks like a view that shows a state the trace is not in.

## Skills and docs

`SKILL.md` files, the READMEs, the glossary, the ADRs, `CLAUDE.md` and this file.

Failure looks like a doc that lies: a line the change makes untrue, a term used against its glossary meaning, a rule or step that no longer matches what the code does. Flag every such line, including in docs the diff does not touch.

## Tests

Failure looks like a test that would still pass if the behaviour it names broke.
