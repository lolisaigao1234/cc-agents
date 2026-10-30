# v8: family H, risk scaling, all on

Every idea in `H-risk-scaling` switched on together, for the first family screen. All three are implemented on their testable half. The "needs a person" half of two of them cannot run here (see Not implemented).

Files:
- `plugin/skills/trace/SKILL.md`: a copy of `plugins/trace/skills/trace/SKILL.md` with two lines changed: the Review row, and the rounds paragraph. Every other byte is unchanged.
- `repo/.claude/risk-tiers.md`: the owners' tier table, sensitive paths, escalation rule and what the PR body states. It is laid into both trees of the replay, so the agent and the workflow's agents can read it. The plugin copy is unreadable in the sandbox.
- `repo/.claude/workflows/risk-tier.js`: a Workflow script with two classifier agents.
- No hooks, no `repo-append/`, and no extra prompt text.

The post's own setting is the source for each choice:
- Tier table: "Low: docs, copy, internal-only features, additive changes behind a flag; Medium: ordinary product changes, and changes to sensitive areas such as caching, the auto-updater, or system prompts; High: the highest-risk code, plus a small set of paths that always need two people."
- Depth: "Match review effort to risk: a quick pass on routine changes, a deep one where a missed bug is expensive (Quick, Standard or Deep in Code Review)."
- "Blast radius sets the bar."
- "Write down risk tiers, set from the change rather than the author; start strict and loosen with evidence."

## risk-tier-sets-review-depth: implemented

> "The change sets the tier, not the author."

**On, as chosen.** This is the switch's setting: classify the diff with the blog's tier table, then pick the `/code-review` level, the security pass and the round budget from the tier.

- **Classifier.** At the start of Review, the skill tells the agent to call the Workflow tool with `scriptPath` set to `.claude/workflows/risk-tier.js` and `args` `{"base": …}`.
  - The script's first agent reads `.claude/risk-tiers.md` and the diff (`git diff --name-only` and `git diff <base>...HEAD`). It returns `{changed_paths, tier, reason}` through a JSON schema, with `changed_paths` the `--name-only` output verbatim.
  - It is told to judge from the diff, not from what the issue, the PR or the commits say. That is the "not the author" half. In this harness the author is the replayed PR's description.
  - The tier is a separate agent's call, not the reviewing agent's own.
- **Tier table** (`risk-tiers.md`). It is the blog's three tiers, mapped by role onto this repository:
  - **Low:** docs written for humans (READMEs, code comments, `docs/agents/`), and changes that only add tests.
  - **Medium:** ordinary code changes, plus the blog's "changes to sensitive areas". Here those are the rest of the hook scripts' code (what the gates, the guard, the halt and the archive block call), and text every agent follows the way it follows a system prompt: skills, agent prompts, `CLAUDE.md`, `GLOSSARY.md`, the ADRs. The blog puts "system prompts" in Medium. In this repository the forced-read docs and the skills play that role, so they are not Low "docs".
  - **High:** "the highest-risk code, plus a small set of paths", which is any change that touches a sensitive path (next idea).
  - "Start strict": between two tiers, take the higher.
- **Depth per tier.** Quick, Standard and Deep map to `/code-review low`, `medium` and `xhigh`:
  - The baseline runs `/code-review medium` (seen in the pilot traces), so Medium is today's review.
  - Deep is `xhigh`, not `high`: the post says Deep is "worth it where one missed bug costs more than the extra review time". `max` and `ultra` are left out, since `/code-review` reserves them for an explicit owner request and they start many reviewer agents.
- **Security pass.** `/security-review` runs on High only. The post runs security review on every PR. The switch, though, asks the tier to pick the security pass, and it is the deep tier's extra check.
- **Round budget.** Low gets at most two rounds: one review, and one to check the fixes. Medium and High keep today's three, then "step back and ask the human".
  - The skill's rounds sentence now reads "When the tier's rounds are spent", in place of "After three rounds".
  - High is not given more rounds. The post scales depth and checks with risk, not iteration count, and longer loops are the F family's question.
- **Fallback.** If the workflow cannot run, the agent sets the tier itself from `risk-tiers.md`. If the first classifier returns nothing, an unknown tier or no `changed_paths`, the script starts strict at High and logs why.
- **PR body.** Matt's `pr` body states the tier. Its "Merge Danger / Blast Radius" section is the natural place.

## escalation-classifier: implemented

> "A second classifier asks whether this particular change needs another person"

**On, as chosen.** This is the switch's setting: a second prompt after tiering may escalate to deep review plus security, and flag it to the human in the PR body.

- **Second agent.** The workflow's second agent is a separate classifier. It sees the first one's tier and reason, rereads the diff and `risk-tiers.md`, and answers `{escalate, reason}`. The question is whether this particular change needs more scrutiny than its tier gives, "even when its tier says it doesn't". A yes is the exception: it is told to say yes only when the change carries a risk a review at its tier is likely to miss and a miss would be costly (it changes what runs, not just what is described, or alters behaviour other code or every agent relies on), and otherwise no, since most changes fit their tier.
- **Effect of a yes.** The tier becomes High, so the change gets `xhigh` plus `/security-review`. The skill and `risk-tiers.md` have the PR body state the escalation and its reason. That is the "flag to the human" half, and the closest this harness gets to "another person".
- **When it runs.** Only when the tier is Low or Medium, since nothing sits above High. If it returns nothing, the tier stands, and the script logs that.
- **Today's analogue.** Today the human is asked only after three rounds. That rule is kept, now as the tier's round budget.

## sensitive-paths-always-deep: implemented

> "Some paths always need a person"

The post: "anything owners have listed as sensitive and any CI workflow file", and "auth, billing, CI and release workflows, and installers always need a person".

**On, as chosen.** A list in `risk-tiers.md` forces High (`xhigh` plus `/security-review`), whatever else the change looks like. This is the switch's "REVIEW.md/skill list". It lives in `.claude/risk-tiers.md` rather than `REVIEW.md`, so this family does not switch on the B family's REVIEW.md arm.

The list is the post's "small set of paths": the switch's short list (the gates, the guard, the halt, the archive block, the hook entry, settings), written by role, with globs that hold across the repository's history (the older plugin's layout as well as `plugins/trace`). The rest of the hook scripts' code is a Medium "sensitive area", not on this list.
- **The hook wiring:** `plugins/*/hooks/hooks.json`, `plugins/*/scripts/hook.mjs`, `plugins/*/bin/**`.
- **The gates, the guard, the halt and the archive block:** `plugins/*/scripts/lib/{trace,guard,halt,archive}.mjs`.
- **The switches** (GLOSSARY: Claude Code's settings): `.claude/settings*.json`.
- **The opt-in and the plugin manifests:** `.claude/trace.json`, `.claude-plugin/**`, `plugins/*/.claude-plugin/**`.
- **The installer:** `plugins/*/skills/setup/**`.
- **CI workflows:** `.github/workflows/**`. No snapshot has one, but the post names them.

How it is enforced:
- The first classifier returns the changed paths, verbatim from `git diff --name-only`. A Workflow script has no filesystem or shell, so the paths have to come from an agent.
- The script holds the same list as literal regular expressions, matches the changed paths itself, and raises the tier to High on any match, whatever tier the classifier picked. It also starts at High when the changed paths are missing. A sensitive path is lost only if the classifier misreports `git diff --name-only`, not by its judgement of the tier.
- The escalation agent is skipped then.
- The PR body names the sensitive paths touched.

Expect most code cases to be High still. Matched against `git diff --name-only base head -- . ':!archive'` for all 57 cases, the list hits 48 (the old whole-scripts-tree list hit 50). One of the 48, pr30, touches only `.claude/trace.json`, which the replay writes into both trees, so its replayed diff is empty and the script's empty-path case leaves it to the classifier. Almost every code case touches the gates' module. Not forced High are the 7 README or tooling-only cases (pr24, pr26-r0, conv-pr26, clean-pr26, clean-pr28, clean-pr2, clean-fix-3575482) and the 2 legacy cases that touch only the old plugin's findings and loop code. This matches the coverage note: gate code dominates the case set, and Low cases are few.

## Not implemented

- **The "another person" half** of `escalation-classifier` and `sensitive-paths-always-deep`, and the tier's number of human approvals (none, one, two). The replay has one agent and no human during the session, and the human always merges. Testing it would need the harness to simulate a reviewer who must approve before the PR counts as ready, and to score whether the approval request went where the tier says. The agent-side analogue used here is deeper review plus a flag in the PR body.

## Unsure

- **The `xhigh` level for High.** It raises recall and cost, and also noise on clean PRs. `high` is the cheaper reading of "Deep".
- **Skills and ADRs as Medium.** Putting them in Medium rather than Low is a judgement on the blog's "system prompts" line.
- **The Workflow tool in a headless run.** It is assumed to accept a repository-relative or absolute `scriptPath` in the replay clone. If it does not, the skill's fallback has the agent classify the change itself, which loses the separate-classifier property of the first two ideas.
