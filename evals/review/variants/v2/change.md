# v2: family B-reviewer-context, all on

Every idea in family `B-reviewer-context` switched on together. The reviewers get more context than the diff: what the project is and is not for (`CLAUDE.md`), what matters and what failure looks like in each part of the code (`REVIEW.md`), the change's stated intent (the issue's whole body), and an explainer of the code the diff touches. They are also asked to flag doc lines the diff makes untrue.

## How the context reaches each reviewer

- **`CLAUDE.md`** is loaded by every Claude Code agent in the replay repo, including the subagents of `/code-review` and of Matt's `code-review`.
- **The `SubagentStart` hook** (`plugin/scripts/variant/review-context.mjs`) adds to every subagent, as quoted text, the issue's body, `REVIEW.md` and `.review/explainer.md`. Workflow agents get `SubagentStart` context too: this repo's own trace hook reaches them that way. The trace's own `SubagentStart` hook already gives only the issue's title, acceptance criteria and latest comment.
- **The skill's Review row** has the main agent read `REVIEW.md` and write the explainer before reviewing, so both are in its own context as well. `/code-review` runs as a fork of the main conversation (ADR 0008), so this is the route that carries them to it.

## Ideas

### claude-md-goals-nongoals: implemented
- Quote: "the goals and the non-goals".
- On: `CLAUDE.md` in both replay trees gains a short "What this project is" section, written from the ADRs and the README:
  - the stack;
  - goals: hard blocks rather than notices; never guess or let a call through when git or GitHub gives no answer; reuse existing skills; the human merges;
  - non-goals: not a sandbox; no parsing of every Bash command for writes; no merge automation or local state; no reimplemented review loops;
  - pointers to the READMEs, the ADRs and `REVIEW.md`.
- It defers to the active ADRs where they disagree. The same text is laid over every snapshot, and the oldest snapshots (the quality-loop era) had different ADRs (see Risks).
- The stack line says "a Claude Code mod, where the plugin has one, in TSX", because the band does not exist in the earlier trace snapshots.
- The project's checks are deliberately left out. Listing them is `claude-md-lists-checks`, in family A.
- Files: `repo-append/CLAUDE.md`.

### flag-convention-breaks: already on in baseline
- Quote: "flags code that breaks a convention".
- Not listed under `ideas` in `variant.json`, since this variant implements nothing for it.
- The switch is an ablation: "On" is today's Review row, which already names `GLOSSARY.md` and the active ADRs among Matt's `code-review` standards. That text is unchanged, and this variant only adds `CLAUDE.md` and `REVIEW.md` to the list.
- `CLAUDE.md`'s last paragraph restates the post's sentence: a review flags code that breaks a convention in these docs.
- Files: none for this idea.

### flag-stale-doc-lines: implemented
- Quote: "make a line in it out of date".
- On: the review is asked to flag any doc line the diff makes untrue, in three places:
  - the skill's Review row ("flags any doc line the diff makes untrue");
  - the `REVIEW.md` "Skills and docs" section, which names `SKILL.md`, the READMEs, the glossary, the ADRs, `CLAUDE.md` and `REVIEW.md` itself, including docs the diff does not touch;
  - the last paragraph of `CLAUDE.md`.
- Files: `plugin/skills/trace/SKILL.md`, `repo/REVIEW.md`, `repo-append/CLAUDE.md`.

### review-md-owner-guidance: implemented
- Quote: "tells the reviewer what matters in their part of the code".
- On: a short `REVIEW.md` at the root of both replay trees. It has one section per part, named by role: every change, the hooks and trace gates, the guard, the archive block, the band and the `/trace` command, skills and docs, tests.
- It is named among Matt's `code-review` standards in the skill, and the hook gives it to every subagent, which includes `/code-review`'s agents.
- It was written only from the docs as they stood at the end of the training slice (pr14..pr18, the tree at the last pr18 round's head): `GLOSSARY.md`, ADRs 0005-0008, the root and plugin READMEs and the trace `SKILL.md`. Nothing from later docs, the cases or the bugs went in. So the guard's failure is "a command that destroys work or history getting through, or an ordinary command refused", the glossary's guard of that time; the hooks section points at "the ADRs and the plugin's README" for what is refused, since the plugin's README then held the refusal rules.
- As `ideas.json` asks, this arm is scored on the test side, pr19..pr38, only. Its pr14..pr18 cases are the training slice and must be left out of this arm's result.
- Length: short, as the post recommends ("The good ones are short"). The optional short-versus-long sub-arm is not run here.
- The `REVIEW.md` line arms of other families are kept out: `cap-nits`, `skip-paths`, `file-line-evidence` and `count-first-summary` (D), and `sensitive-paths-always-deep` (H).
- Files: `repo/REVIEW.md`, `plugin/skills/trace/SKILL.md`, `plugin/scripts/variant/review-context.mjs`, `plugin/hooks/hooks.json`.

### define-failure: implemented
- Quote: "They say what failure looks like in that repo".
- On: each `REVIEW.md` section says what failure looks like in that part:
  - hooks: a call let through that the docs (the ADRs and the plugin's README) refuse; a call refused that they allow; a git or GitHub non-answer treated as an answer; a deny that does not say what to do next (ADR 0006's "every deny names the pipeline step");
  - the guard: a command that destroys work or history getting through, or an ordinary command refused;
  - the archive block: a route the ADR says is closed, or a refusal of a command that never reaches the archive;
  - the band and the `/trace` command (ADR 0005's view of the trace): they show a state the trace is not in;
  - docs: "it lies", the post's own example;
  - tests: a test that would pass whether or not the behaviour holds.
- Files: `repo/REVIEW.md`.

### reviewer-reads-intent: implemented
- Quote: "the PR's stated intent".
- On: the issue's whole body is passed to `/code-review`'s agents, and to every other subagent, through the `SubagentStart` hook. The hook runs `gh issue view <n> --json title,body` for the branch's `<n>-`, cuts the body at 6,000 characters and quotes it like the trace's own context. It then asks: does the change solve the issue's problem, fit the system, or break something else?
- The skill's Review row says each review weighs the diff against the issue's intent and the whole repository. `REVIEW.md`'s "Every change" section says the same.
- At review time the PR body is only `Closes #<n>`, so the issue is the PR's stated intent. The replay issue is the harness's stripped original body (`data/issues/`), so nothing beyond what the agent already sees is passed.
- Files: `plugin/scripts/variant/review-context.mjs`, `plugin/hooks/hooks.json`, `plugin/skills/trace/SKILL.md`, `repo/REVIEW.md`.

### agent-explainer-before-review: implemented
- Quote: "write an explainer for exactly that slice".
- On: before each round's reviews, the main agent writes `.review/explainer.md`: an explainer of exactly the code this round's diff touches. It is in the main agent's own context, which `/code-review`'s fork shares, and the hook gives it, cut at 12,000 characters, to every subagent, including Matt's reviewers.
- `repo-append/.gitignore` adds `/.review/` to both trees. The explainer therefore never enters the PR's diff or the grader's `git add -A --intent-to-add` view of the agent's changes.
- The blog's explainer-for-humans half is a separate idea (`explainer-for-humans`, X-team-culture), and is not in this family.
- Files: `plugin/skills/trace/SKILL.md`, `plugin/scripts/variant/review-context.mjs`, `repo-append/.gitignore`.

## Not implemented

None. Every idea in the family runs in this harness.

## Files

- `plugin/skills/trace/SKILL.md`: a copy of the trace skill with only the Review row changed.
- `plugin/hooks/hooks.json`: a copy with every entry kept, plus a second `SubagentStart` entry for `scripts/variant/review-context.mjs`.
- `plugin/scripts/variant/review-context.mjs`: the `SubagentStart` hook.
  - It runs only in a traced repository (`.claude/trace.json` at the git root) and not under `TRACE_BYPASS=1`.
  - It never denies or halts. Bad input, no git, `gh` failing, timing out after 15 s or returning non-JSON, and missing files all leave out the part concerned or print nothing, and it exits 0.
- `repo/REVIEW.md`: the code owners' review guide.
- `repo-append/CLAUDE.md`: the "What this project is" section.
- `repo-append/.gitignore`: `/.review/`.

## Risks

- The context goes to every subagent, not only reviewers: Explore and fix agents get it too. That costs tokens on each subagent start, at most about 26 KB.
- `/code-review` runs as a fork of the main conversation (ADR 0008), so it gets `REVIEW.md`, the explainer and the issue from the main agent's own reads in the skill's Review row. The hook reaches Matt's code-review subagents and any Workflow agents.
- `CLAUDE.md`'s non-goals contradict the plugin under review in the quality-loop era: snapshots whose plugin is quality-loop and whose ADRs predate 0005, where the plugin is a review/fix loop with its own local state. There the "ADR wins" clause does not help, since those ADRs say nothing about it, and a reviewer may flag the design itself, or flag `CLAUDE.md` as untrue (the variant asks for untrue doc lines to be flagged anywhere). Report this family's results both with and without the quality-loop-era cases.
- `CLAUDE.md` and `REVIEW.md` are the same text in every snapshot. A reviewer may flag one of their lines as untrue for an older snapshot; such a finding is caused by the overlay, not by the idea, and should be read that way.
