# v4: D-finding-filters, all on

Every idea in the family is switched on at once. The post puts these filters between the finders and the author: "a separate group votes on each finding... Findings that are only about style, diagnostics, or cleanup get dropped... What's left shows up as inline comments sorted by severity. Each is tagged Important, Nit, or Pre-existing". It puts the rest in `REVIEW.md`, which should "cap the nits, list paths to skip, and ask for a file and line as evidence instead of a guess from a name. They also ask for a summary that starts with a count and says plainly when there's nothing to fix."

So the variant has two layers:

1. **`REVIEW.md`**, which the reviewers follow, so filtered findings are less likely to be raised in the first place.
2. **A vote**, `.claude/workflows/verify-findings.js`, run on the union of both reviews' findings. It filters, tags, sorts, caps and counts what reaches the author.

ADR 0005 reserves voting for a `workflows/` script, so the vote is one.

## Files

| File | What it does |
|---|---|
| `repo/REVIEW.md` | The review rules: report defects only (no style, diagnostics or cleanup), cite a file and line plus the failing input, tag each finding Important, Nit or Pre-existing, at most 2 Nits, sort by severity, open with a count or "Nothing to fix.", and skip `vendor/`, `package-lock.json` and `node_modules/`. It holds only this family's lines: no per-area priorities and no definition of failure (both are B-reviewer-context). |
| `repo-append/CLAUDE.md` | One line: every review, `/code-review` and `mattpocock-skills:code-review` and the agents they start, follows `REVIEW.md`. CLAUDE.md reaches the `/code-review` fork and subagents, and the agent cannot read a plugin file, so the rules have to live in the repository. |
| `repo/.claude/workflows/verify-findings.js` | The vote (details below). |
| `plugin/skills/trace/SKILL.md` | Two lines changed, the rest byte-identical. The Review row adds `REVIEW.md` to the standards and adds "then the vote on their findings". The rounds paragraph says how to call the vote and how to answer each tag. |

### The vote (`verify-findings.js`)

The script takes `args: {base, findings}`, where each finding is `{title, file, line, failure, source}`. It also accepts `location: "path:line"`, `args` or `findings` as a JSON string, a bare array, a single finding object, or the array under another key. `base` must look like a git ref, or it falls back to `main`, since it is quoted into the verifiers' commands. It works in this order:

0. **Input.** Bad input never reads as a clean round. When no findings array can be found (no `args`, unparseable JSON, `findings: null`), the result asks the agent to call again with the right shape, and says to pass `findings: []` when both reviews found nothing. A finding with no title is titled from its failure or its `file:line`, not skipped.
1. **Before the vote, in plain code, with no agent:**
   - It drops a finding that has no file and line, or no failing input.
   - It drops a finding on a skipped path (`vendor/` anywhere in the path, `node_modules/`, `package-lock.json`).
2. **The vote.** Three verifiers judge each remaining finding independently, with a refute-leaning prompt: "if you are unsure, it is false". Each verifier reads `REVIEW.md`, the cited code and the code it calls, and `git diff base...HEAD -- <cited file>`, reading the rest of the diff only where the cited code calls into it and never the skipped paths. Verifiers run at once in the agent's one working tree, so each is told not to edit a file or change the checked-out branch. Each returns `{real, style_only, tag, severity, reason}`. A finding survives when **2 of 3** verifiers judge it real and not style-only.
3. **Tag.** The finding gets the tag most verifiers gave it. A tie goes Important, then Nit, then Pre-existing, so a tie leaves the author responsible. To tag a finding Pre-existing, a verifier must check that the same failure happens on the base, with `git show base:<file>` or `git diff base...HEAD -- <file>`, not by switching branches or stashing (the guard allows both, and a tree left on the default branch would hard-block the author's next fix).
4. **Severity.** The finding gets the median severity of its verifiers. When two verifiers judged it, it gets the higher of their two.
5. **Sort.** Survivors are sorted by severity. At equal severity, Important comes before Nit, and Nit before Pre-existing.
6. **Nit cap.** At most 2 Nits are kept: the most severe.
7. **Summary.** The result opens with one of:
   - `"N findings: a Important, b Nit, c Pre-existing."`
   - `"0 findings to fix yet: k dropped for missing evidence."` (with `, c Pre-existing` when there are some) when a finding was dropped for no file and line or no failing input. Such a finding may have lost its evidence when the agent merged the two reviews, so this round is not called clean, and the summary asks the agent to re-send each one whose review gave the evidence and to leave out one whose review gave none.
   - `"Nothing to fix in this branch; c Pre-existing findings to file as new issues."`
   - `"Nothing to fix."`

   After the opener it counts the dropped findings by reason (`Dropped: 2 × confirmed by 1 of 3 verifiers; 1 × skipped path (REVIEW.md).`), and the result lists each dropped finding with its reason, so nothing is dropped silently. Only the last two openers make a round clean (SKILL.md: "When the vote says nothing to fix").
8. **Fail-safe.** If fewer than 2 verifiers answer, the vote cannot be held. A failed vote drops nothing. The finding is passed on, tagged Important and marked `unverified`.

## Ideas

| Idea | Quote | "On" setting chosen | Status | Files |
|---|---|---|---|---|
| `verifier-vote` | "a separate group votes on each finding" | A 2-of-3 vote in a Workflow script on the union of `/code-review`'s and `mattpocock-skills:code-review`'s findings. The post gives no number of voters and no threshold. 2 of 3 is the switch's own example and the smallest real majority. | implemented | `verify-findings.js`, SKILL.md rounds paragraph |
| `drop-style-findings` | "only about style, diagnostics, or cleanup get dropped" | Both layers. `REVIEW.md` tells the reviewers not to report these findings. A verifier's `style_only` vote then drops what is raised anyway. Matt's smell baseline is still in his skill, which cannot be changed. His skill says "the repo overrides", so `REVIEW.md`'s rule overrides the baseline. "Diagnostics" means linter and type-checker warnings that leave the build and tests passing: a type error that fails `npm run check` is a broken build, a defect. The filter has no carve-out for doc and skill text: whether it costs recall there is what the screen measures (the switch's metric says "recall (must hold)"); a guard such as B's "for docs, it lies" is a D+B interaction for the single-arm stage. | implemented | `REVIEW.md`, `verify-findings.js` |
| `cap-nits` | "cap the nits" | `REVIEW.md` says "at most 2 Nits", and the script keeps at most 2 Nits after the vote. I did not use `/code-review --max-findings N`: it caps every finding, not only Nits, and could cut recall. | implemented | `REVIEW.md`, `verify-findings.js` |
| `skip-paths` | "list paths to skip" | `REVIEW.md` skips `vendor/` (declarations Claude Code writes), `package-lock.json` and `node_modules/`. The script drops findings on those paths before the vote. `plugins/trace/types/` is hand-written, so it is not skipped. `archive/` is already unreachable through its hook. | implemented | `REVIEW.md`, `verify-findings.js` |
| `file-line-evidence` | "ask for a file and line as evidence instead of a guess from a name" | `REVIEW.md` asks for it. The script mechanically drops a finding with no file and line or no failing input. Each verifier must confirm that the cited line shows the defect. | implemented | `REVIEW.md`, `verify-findings.js`, SKILL.md (the `{title, file, line, failure, source}` shape) |
| `count-first-summary` | "a summary that starts with a count and says plainly when there's nothing to fix" | `REVIEW.md` asks reviewers for it. The vote's result opens with the count or "Nothing to fix.", and never with "Nothing to fix" when the input was malformed or a finding was dropped for missing evidence. SKILL.md opens the progress comment's review section with that count. A round where the vote says nothing to fix is clean: nothing is changed for it. | implemented | `REVIEW.md`, `verify-findings.js`, SKILL.md |
| `severity-sorted-findings` | "sorted by severity" | One merged list from both reviews, ranked by severity, which the author works in order. | implemented (the ranking half; see below) | `verify-findings.js`, SKILL.md ("Work that list in order") |
| `tag-important-nit-preexisting` | "tagged Important, Nit, or Pre-existing" | Reviewers tag findings (`REVIEW.md`), and the verifiers' majority sets the final tag. SKILL.md handles each tag as follows. Important: fix it and its whole class. Nit: fix it or decline it with a reason. Pre-existing: do not fix it in the branch; open a new issue for it with `gh issue create` in the replay repository, and list it in the progress comment. The progress comment is part of the grader's material; a new issue is not. | implemented | `REVIEW.md`, `verify-findings.js`, SKILL.md |

There are no ablations in this family: every switch's "off" is today's baseline, so every idea needed a change.

## Conflicts and choices

- **`drop-style-findings` and `cap-nits`.** Once style is dropped, a Nit means a real but minor defect, not a style point. The cap applies to those.
- **`tag-important-nit-preexisting` and the baseline rules.** The baseline says "Answer every finding... Fix the finding's whole class", which is E's `answer-every-finding`, already on.
  - The tag switch narrows "fix the whole class" to Important findings. "Fix a Nit or decline it with a reason" comes from the tag idea's own switch text. It overlaps E's `decline-nits-agent-author`, which this variant does not otherwise adopt (it does not say "fix only bugs").
  - "Answer every finding" now means every finding the vote passes on. The post's dropped findings never reach the author.
- **`/code-review --comment` (inline PR comments) was not used.** This repo keeps findings in progress comments on the issue, not in PR threads.

## Not implemented

- The **"inline comments"** half of `severity-sorted-findings`. It needs findings posted as PR review threads, and an Update step that resolves threads instead of writing a progress comment. The repo does not work that way, and the grader would need to read resolved threads. The ranking half is implemented.

## Notes for the eval (not part of the variant)

- **The grader counts dropped findings as raised.** The judge lists "every distinct finding the review raised" across all review material. That includes the raw `/code-review` and Matt's outputs, which still hold whatever the vote later drops. So the vote can only lower `harmful`/`noise` through `REVIEW.md` (findings that are never raised) and through what the agent acts on (`fixed`, `broke_tests`, rounds). The post's metric is what reaches the author. Measuring the vote itself would need the grader to read the Workflow result, or a marked "surfaced findings" record, and to score that alongside the raw findings.
- **Workflow tool results are not added to `material`.** `transcript.mjs` keeps only Agent, Task and Skill results. The agent's own text and the progress comment repeat the vote's list, so the vote's output reaches the judge that way.
- **Cost (estimated, not measured).** The vote runs 3 verifier agents per finding at the session's effort. The baseline pilot raised about 12 to 25 findings per case across its 2 or 3 rounds (the judge's harmful plus noise counts), so a case would start about 36 to 75 verifier sessions in all, not per round. Each verifier reads `REVIEW.md`, the cited file and that file's diff. At an assumed $0.15 to $0.40 per verifier session, the vote adds about $5 to $30 per case to the baseline's median $4.28, and about $170 to $930 to the screen for v4's 31 covered cases at 1 rep, on top of the plan's $1.8k. The `$40` per-case budget (`run.mjs`) should hold on most cases but may bind on the noisiest; a budget hit ends the case early. Before the screen, run v4 once on a noisy case (`clean-pr33`, 25 raised findings at baseline) to measure the vote's cost, and check that the Workflow agents' usage reaches the run's `total_cost_usd`.
- **Script syntax.** `node --check` on the raw script fails with "Illegal return statement". The Workflow format requires `export const meta` followed by a top-level `return`, which no Node module type accepts. The body was syntax-checked wrapped in an async function, and run against mocked `agent`/`parallel`/`pipeline` on 25 inputs: the normal shape, each accepted variant shape, missing and unparseable args, `findings: []`, findings with no title or no evidence, a vendored path, unsafe and stacked bases, all-refuted, Pre-existing-only, verifiers that throw, and Nits over the cap.
