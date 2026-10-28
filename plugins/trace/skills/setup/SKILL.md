---
name: setup
description: Opt this repository in to the trace and check what it relies on.
disable-model-invocation: true
---

# Set up the trace

Report each check as ok or missing, and fix only what this skill says to fix.

1. **GitHub.** `gh auth status` succeeds and `gh repo view` finds the repository. If either fails, stop: a repository without a GitHub remote cannot be traced.
2. **Matt's skills.** `docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md` and `docs/agents/domain.md` exist. If any is missing, tell the human to run `/setup-matt-pocock-skills` first, and stop.
3. **Triage labels.** Every label in `docs/agents/triage-labels.md` appears in `gh label list`. Offer to create the missing ones with `gh label create`.
4. **Docs.** Report whether `GLOSSARY.md` and `docs/adr/` exist. `domain-modeling` creates them when the first term or decision lands.
5. **Opt in, traced.** Open an issue "Opt in to the trace" and `gh issue develop <n> --checkout`. Then:
   - add `"Read(./archive/**)"` to `permissions.deny` in `.claude/settings.json`, keeping every existing setting;
   - write `.claude/trace.json` containing `{}`;
   - commit both with `#<n>`, push, and open a PR with `Closes #<n>`.

Done when the PR is open and every check is reported. The trace is live on the opt-in branch at once, and on the default branch once the human merges.
