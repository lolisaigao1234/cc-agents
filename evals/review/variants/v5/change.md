# v5: family E-author-response, all on

How the author (the agent) answers the review: every finding answered, no PR ready over an open finding, nits declined rather than fixed, a PR body with Testing, Risk and How to revert, and evidence that says what the checks would miss.

Files:
- `plugin/skills/trace/SKILL.md`: a copy of `plugins/trace/skills/trace/SKILL.md` with the Review row, the Update row and the rounds paragraph changed, and one paragraph added after it. Every other line is byte-identical.
- `plugin/hooks/hooks.json`: a copy of `plugins/trace/hooks/hooks.json` with every existing entry kept and three added (PreToolUse `Bash`, PostToolUse `Skill|ReportFindings`, Stop), all running `scripts/variant/findings.mjs`.
- `plugin/scripts/variant/findings.mjs`: the findings hook (new).
- No `repo/` or `repo-append/`: nothing here needs a file in the replay repository. No `prompt`.

## answer-every-finding: already on in baseline

- Quote: "Every finding has to be answered." ("You either fix it or resolve the thread with a reason.")
- Switch: an ablation. Its "on" is today's line, "Answer every finding with a fix or, in the progress comment, a reason."
- That line is kept unchanged in SKILL.md. Nothing else changes for this idea.

## open-findings-block-pr: implemented (hook)

- Quote: "A PR can't merge while any finding from the bug review or the security review is still open. You either fix it or close the thread with a short reason, which is how you clear a false positive."
- On, as chosen: a hook refuses `gh pr create`, `gh pr ready` and `gh pr merge` until a findings record gives each finding a fix SHA or a reason. It also blocks the agent's Stop. In this harness the PR is already open and not a draft, so stopping is the moment the PR is declared "ready for the human". Without the Stop gate, the idea would never fire.
- **Record.** PostToolUse on `Skill` and `ReportFindings`. When the skill is `code-review` or `security-review` (Claude Code's bug and security reviews, not Matt's standards/spec review, which the post's rule does not cover), the hook parses the review's JSON findings out of the tool response. It numbers them `F1, F2, …` per branch in a ledger at `<git dir>/trace-findings.json`, with the commit the review ran on (`HEAD`). The ledger sits outside the working tree, so it is never part of the PR's diff. A finding with the same file, line and summary is not added twice. The hook tells the agent the new ids and how to answer them (PostToolUse `additionalContext`).
- **Answer.** A line in any comment on the linked issue (where the trace already puts answers) in the announced format, `F3: fixed in <sha>` or `F3: declined: <reason>`:
  - The line starts with the ids (`F3`, `F3, F4`, `F3 and F4`), after an optional list bullet and bold markers, then a colon or dash.
  - `fixed in <sha>` counts when the SHA is on this branch (an ancestor of `HEAD`) and is not the reviewed commit or one of its ancestors, so it was made after the review that raised the finding. A finding recorded without a reviewed commit keeps the plain on-branch check. When git cannot tell whether the SHA comes after the reviewed commit (that commit is gone), it counts.
  - `declined` counts when a reason with at least one letter or digit follows.
  - Any other prose that mentions an id answers nothing, so a progress comment saying a finding is still open does not clear it.
- **Gate.** PreToolUse on Bash denies `gh pr create|ready|merge` while a finding is open. Stop blocks while a finding is open, once a session, and not when `stop_hook_active` is set, like the trace's own Stop nudge ("blocks stopping once", ADR 0006). Each refusal lists the open findings and names the Review step.
  - Why once: the skill's own rule ("After three rounds, step back: … ask the human before a fourth") and the harness prompt both make stopping with findings open legitimate. Blocking that stop repeatedly would push the agent into a fourth round or into rubber-stamp declines. So the Stop reason also says: "If you are stopping to ask the human instead (the PR is not ready), name the open ids in your final message and stop." The `gh pr create|ready|merge` gate still refuses every time.
- **Fail-safe.** It fails open on any input, git, `gh` or ledger it cannot read. It also does nothing:
  - outside a traced repository,
  - under `TRACE_BYPASS=1`,
  - off an `<n>-` branch.
  - It never halts: halting is the trace's own hooks' job (ADR 0006).
- **SKILL.md** says only that the hook numbers these findings and keeps the PR from being ready while one is unanswered. The hook's own messages teach the answer format.
- Limits:
  - `/security-review` findings are recorded only when it prints JSON findings. Prose findings are not parsed.
  - "If a later commit fixes the issue, the finding clears on its own" is not automated. The agent names the fixing SHA instead. Telling that a commit fixed a finding would need a judge, which a hook should not be.

## decline-nits-agent-author: implemented (skill text)

- Quote: "Noise costs more when the author is an agent. A person can wave off a nit in seconds. An agent fixes it, which means another commit and another round of review."
- On: "Fix bugs, each with its whole class. Decline nits, style and cleanup findings with a one-line reason: for an agent, each one fixed is another commit and another round."
- Choice:
  - The switch's "on" ("fix only bugs") is set against today's "Fix the finding's whole class".
  - The whole-class rule is kept for bugs rather than dropped. It is a separate idea (C-finders `reviewer-flags-bug-class` treats it as the author-side baseline), and dropping it here would mix a second change into this family.
  - "Bugs" stays as plain a word as the post's. A spec gap from Matt's review is a bug against the issue, not a nit, and the agent can judge that.
- A declined nit is answered with its reason, so it also clears the open-findings gate.

## pr-template-testing-risk-revert: implemented (skill text)

- Quote: "add "Testing", "Risk" and "How to revert" to your PR template"; "The PR template asks how the change was tested and how to undo it. Claude can fill that in".
- On: the Review row has `mattpocock-skills:pr` write the body "with `Testing`, `Risk` and `How to revert` sections (its Evidence fits under Testing, its Merge Danger under Risk)". The "Done when" column requires the three sections.
- Choice:
  - The three sections map Matt's Evidence and Merge Danger into them rather than adding three more sections beside them, so the body does not say the same thing twice. Matt's template has no revert section, so How to revert is new.
  - It is prose only, as the switch says ("Review row"). No hook checks the body.
  - The follow-up sub-arm (feed Risk to the reviewer) is not on.

## state-what-checks-miss: implemented (skill text)

- Quote: "Reading the evidence. Test output, the command that ran and what it returned, a screenshot, the reviewer's findings. If you can't say what the checks would miss, ask for a real review rather than a quick approval."
- On:
  - The Update row's progress comment ends "with what those checks would miss".
  - A new paragraph says:
    - when the gap reaches what the hooks decide (the gates, the guard, the halt, the archive block), run one more `/code-review xhigh` on the files behind that gap before the PR is ready;
    - when the agent cannot say what the checks would miss, it tells the human the PR needs a real review, not a quick approval.
- Choices:
  - "Gate code" in the switch is named by role (the gates, the guard, the halt, the archive block), as the fairness rule allows.
  - The extra review is `xhigh`, the deepest level the `code-review` skill allows without an explicit ask (`max` and `ultra` need one).
  - The post's half, asking for a real review, is the final-message line: no human answers during a run.
- Expected cost: since most cases touch the hooks, this adds about one review round per case.

## Not implemented

None. Every idea in the family runs in this harness.

## Interactions

- `decline-nits-agent-author` and `open-findings-block-pr` agree: a decline with a reason is an answer.
- The extra `xhigh` review's findings are recorded and gated like any other.
- `state-what-checks-miss` and the three-round step-back: the extra review is one more round. The "ask the human before a fourth" rule still applies.
- The Stop gate and the trace's own Stop nudge are separate hooks. Either may block a stop, each once.
- The extra `xhigh` round makes stopping at three rounds with findings open more likely; the once-only Stop block and its ask-the-human line leave that stop open.

## Tests run

- `node --check` on `findings.mjs`.
- A scratch traced git repo, with a fake `gh` on PATH serving comment bodies. All checks pass:
  - Recording numbers the findings and skips duplicates. It ignores Matt's review and records `/security-review` JSON and `ReportFindings`.
  - The gate passes other commands and denies `gh pr ready` while a finding is open.
  - Prose does not answer a finding: "F1 is not declined yet, still working on it", "Will fix F1 later; it is not fixed in <fix sha> yet", a bare "F2: declined" and "F3 fixed <sha>" all leave it open.
  - The announced format does, with a bullet and bold (`- **F1**: declined (nit).`, `**F2:** fixed in \`<sha>\``), several ids on one line (`F1, F2 and F3: fixed in <sha>`), a dash separator and lower case. A reason of only punctuation does not.
  - `fixed in` the reviewed commit, the base commit or a fake SHA leaves the finding open. A commit made after the review clears it. A ledger entry without a reviewed commit keeps the plain on-branch check. After an amend, the amended fix commit clears it and the replaced one, no longer on the branch, does not.
  - Stop does nothing when `stop_hook_active` is set, blocks the first stop of a session with the ask-the-human line, and lets the next one through.
  - It fails open when `gh` fails, under the bypass, in an untraced repo and outside git.
  - A corrupt ledger is read as empty.
  - Empty, non-JSON, `null` and wrongly typed inputs on every event produce exit 0 and no output.
- The real `gh api --paginate 'repos/{owner}/{repo}/issues/<n>/comments' --jq '.[].body'` prints raw comment bodies, as the parser expects. This was checked on this repository's own issue, read-only.
- `diff` of the SKILL.md copy against the original: only lines 16, 17 and 20 changed, plus the added paragraph after line 20.
