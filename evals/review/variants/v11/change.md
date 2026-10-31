# v11: effort scaling check (not a family)

The baseline's plugin and prompt, with the agent at `--effort low` instead of `high`.

**Why.** An eval whose score does not fall when the agent has less to work with is measuring something other than the agent: an ambiguous task or a grader that does not track quality ("Performance scales with capability and effort", in the post on automating eval design and hillclimbing). The pilot's only evidence was Sonnet 5.5 stopping after one round.

**Cases.** The 8 bug cases with the most known bugs (`check_cases`), so recall is fine-grained: pr17-r0 (20), pr21-r0 (16), pr20-r0 (15), pr18-r0 (12), pr15-r0 (10), pr16-r0 (10), pr17-r1 (10), pr19-r0 (9). Chosen by bug count, not by baseline score.

**Gate.** Run once, after the baseline. If mean recall on these cases at `low` is not below the baseline's mean on the same cases, the family screen does not start, and the grader and tasks are examined first.
