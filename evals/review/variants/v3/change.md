# v3: family C-finders, all on

Every idea in the `C-finders` family is switched on together for the first screen. The family is about who looks for bugs, how many of them look, how hard they look, and what they are told to look for.

Files:

| File | What it is |
|---|---|
| `plugin/skills/trace/SKILL.md` | A copy of `plugins/trace/skills/trace/SKILL.md`. The **Review** row is replaced, and one paragraph is added before "Review and fix run in rounds". Every other line is byte-identical. |
| `repo/.claude/workflows/review-finders.js` | A Workflow script laid into both trees of the replay repo. It runs one review round: three `/code-review xhigh` finders and a `/security-review` agent, in parallel, with their findings unioned. |
| `repo-append/CLAUDE.md` | A `## Code review` section appended to the replay repo's `CLAUDE.md`, or creating it. It holds two lines that every reviewer reads: the class of bug, and the root cause on a bug fix. |

## Ideas

### fresh-context-subagent-review: already on in baseline

- Quote: "a subagent reviews the diff with fresh context"
- Switch: "Ablation: the authoring session reviews its own diff inline. On: current."
- The baseline already reviews through the forked `/code-review` and Matt's sub-agents, so nothing changes for this idea. The finders in the workflow are fresh-context agents too.

### parallel-bug-finders: implemented

- Quote: "Several agents look for bugs at the same time."
- Setting chosen: **3** independent `/code-review` finders, unioned before any filter. The switch offers 1, 3 or 5. The post says only "several", so 3 is the middle value. The 5-finder value belongs to the single-arm stage.
- `review-finders.js` starts three finder agents and a security agent with `parallel()`. Each finder calls the Skill tool with `code-review` and `xhigh <target>`. The script returns every finding, each tagged with the finder that raised it. Nothing is voted on, deduplicated or dropped, because voting and filtering belong to family D.
- Each finder keeps `/code-review`'s default findings cap, as the baseline's single run does. "Unioned before any filter" is read as no filter after the finders; a `--max-findings` change belongs to family D (`cap-nits`).
- The Review row tells the agent to call the Workflow tool with `scriptPath: ".claude/workflows/review-finders.js"` and `args: {issue, target}`. The existing line "After the first round, review only the new diff" tells the agent what the target is after round 1. If the Workflow tool is unavailable, the agent runs `/code-review xhigh` and `/security-review` itself.
- The script accepts `args` as an object or as a JSON string of one (a stringified object reaches a workflow script as one string), and a bare value as the target. It logs a missing target and an issue that is not a number.

### review-effort-level: implemented

- Quote: "Quick, Standard, or Deep". The post adds: "Deep is worth it where one missed bug costs more than the extra review time."
- Setting chosen: **Deep**, pinned as `/code-review xhigh` for every finder in every round.
  - This repository ships guardrail hooks, so a missed bypass or fail-open costs more than review time.
  - Deep is pinned as `xhigh`, the deepest value the idea's switch lists. `max` would also be allowed, since skill text can request it, but it is outside the switch and multiplies reviewers on top of the 3 finders. `ultra` runs in the cloud, outside the sandbox's network.
- The level is the constant `LEVEL` in `review-finders.js`, and the Review row names it.

### separate-security-review: implemented

- Quote: "Security gets its own automated review too."
- Setting chosen: `/security-review` runs in every round, alongside the bug finders, as the fourth agent in `review-finders.js`. Its findings join the union, tagged `security review`. `/security-review` takes no target and reviews the whole branch, so when the round has a target the security agent is told to report only findings in those changes, keeping "review only the new diff" true for it too.
- The post's "can block" part, where a PR cannot merge while a finding is open, is already covered by the trace's "Answer every finding with a fix or ... a reason".

### root-cause-on-bug-fix: implemented

- Quote: "On a bug fix, it looks for the root cause."
- Setting chosen: the review prompt line "state the root cause and check the diff removes it".
  - It is in `repo-append/CLAUDE.md`, which every agent's context carries: the `/code-review` and `/security-review` forks, Matt's sub-agents and the workflow agents.
  - The finder prompt in `review-finders.js` repeats it.
  - The finder's schema has a `root_cause` field, which is empty when the issue is not a bug fix. The script returns these under `root_causes`.

### reviewer-flags-bug-class: implemented

- Quote: "Flag the class of bug, so the author fixes every instance, not one line."
- Setting chosen: the reviewer names the class and lists every instance in the repository.
  - It is in `repo-append/CLAUDE.md`, for every reviewer.
  - It is in the finder and security prompts, whose schema requires `bug_class` and `other_instances` on every finding.
- The author-side rule already in SKILL.md, "Fix the finding's whole class", is unchanged.

### what-could-go-wrong-premortem: implemented

- Quote: "what could go wrong with this change, and which check—automated or human—is the right one to catch it?"
- Setting chosen: the switch's own wording. SKILL.md gains this paragraph, placed before "Review and fix run in rounds":
  > Before the first round, list what could go wrong with this change and which check should catch each: a test, the finders, `/security-review`, a live run, or the human. Run those checks, and put the list in the progress comment.
- The list goes in the progress comment so that it reaches the grader's material. Its metric is "share of cases whose real bug matches a listed failure mode".

## Not implemented

### layer-ablation: deferred

- Quote: "Each layer catches some problems and misses others."
- Its switch is "Harness: run with one layer removed at a time, and with security added. Off: all current layers." That is a set of runs, not a setting, and its "on" conflicts with switching the family on as a whole: an all-on variant cannot also remove a layer.
- Its "with security added" half is already in this variant, through separate-security-review.
- Harness support needed:
  - One variant per removed layer: no tests, no `/code-review`, no Matt standards axis, no Matt spec axis. Each would be a SKILL.md Review row without that layer.
  - Bugs labelled with the layer that should catch them (`which-layer-should-have-caught`).
  - A report that computes each layer's marginal recall and overlap from those runs against the all-layers baseline.

## Conflicts and choices

- **Parallel finders and effort level.** Both apply: every one of the 3 finders runs at `xhigh`. This is the costliest combination in the family. Expect several times the baseline's `/code-review` spend per round, against a baseline median of $4.28 per case.
- **Fresh context.** It is already on, and the finders keep it.
- **Matt's code-review**, for standards and spec, is unchanged. It is not a bug finder in this family.
- **Where the script lives.** The script lives in the replay repo only because the harness sandbox denies reads of the plugin copy; if adopted, it ships with the trace plugin (ADR 0005). It does no voting, so it does not touch ADR 0005's condition on a voting review step.
- **Cost of the class search.** Every finder searches the repository for each finding's other instances before anything is deduplicated, so a finding the 3 finders share is searched 3 times. That is the idea as switched on (the reviewer lists all instances); it adds to the spend above and to the risk of hitting the case's wall-clock ceiling.

## Before running v3: a harness change outside this variant

**v3 must not be screened until `evals/review/lib/transcript.mjs` is patched.** Its findings come back as the result of one `Workflow` call, and today's digest neither shows that result to the judge nor counts it as a round:

- Material keeps tool results only for `Agent`, `Task` and `Skill`, so the workflow's findings reach the judge only where the agent restates or posts them.
- `bug_reviews` counts only `Skill` calls to `code-review`, and the judge numbers rounds by the `=== REVIEW ROUND k ===` markers those calls write. A workflow round writes none, so every v3 finding would land in round 0, and recall, rounds and first-clean-round would all be biased against this arm.
- A background task's result arrives as a user prompt whose content is a plain string starting `<task-notification>`, which goes to `turns` only.

The patch (written and tested outside the repo, since a variant may not edit the harness):

1. In the `tool_use` branch, after the `Skill`/`isBugReview` case, count one workflow call as one round:

   ```js
   } else if (b.name === 'Workflow' && /review-finders/.test(JSON.stringify(b.input ?? {}))) {
     counts.bug_reviews++;
     material.push(`=== REVIEW ROUND ${counts.bug_reviews} (/code-review) ===`);
   ```

2. Where a tool result is added to material: `['Agent', 'Task', 'Skill', 'Workflow'].includes(name)`.
3. Where `typeof c === 'string'`: also push `[task notification]` plus the clipped text to material when it starts with `<task-notification>`.

A digest test with a synthetic `Workflow` tool_use and tool_result, a second `Workflow` call to another script, a task notification and a plain prompt passed: 2 rounds (the review-finders call and a later `/code-review` Skill call), the workflow result and the notification in material under the round-1 marker, the plain prompt not in material.

One more check for the first smoke run: line 47 counts a `Skill` call to `code-review` whether or not it comes from a subagent (`parent_tool_use_id`). If the finders' own `/code-review` calls appear in the stream as subagent events, each workflow round would count 4 rounds (the workflow call plus 3 finders). The smoke run should look for them; if present, count `isBugReview` only when `!sub`.

## Caveats for the runner

- **Whether a workflow agent can invoke the `/code-review` skill.** Checked from a workflow subagent whose tools include Skill but no Agent or Task tool, the same position as the finders: `Skill code-review` with `xhigh <path> --max-findings 5` ran as a forked execution and returned 5 substantive findings, so the skill is neither refused nor reduced to the `via: "self"` fallback there. What cannot be seen from outside is whether the fork started its own reviewer subagents at `xhigh`, which is what Deep relies on. Before the screen, a one-case smoke run (for example `clean-pr18` or `pr17-r0`) should read one finder's sub-transcript and confirm it. If the fork does less there, pass `agentType: 'general-purpose'` in the finders' `agent()` options if that type can start subagents, or move the three finders into the main session as parallel `Agent` calls that each run `/code-review xhigh`. Until then, a v3 result measures "3 `/code-review xhigh` runs from workflow agents", which may be less than 3 Deep finders.
- **`via`** still distinguishes a finder that fell back to reviewing by itself (`self`) from one that ran the skill (`code-review`); count both in the smoke run.
