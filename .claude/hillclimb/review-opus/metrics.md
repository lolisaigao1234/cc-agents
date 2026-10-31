# Review-step eval metrics (#39)

**Goal.** An arm wins only if `recall` rises past the noise floor, `harmful` on clean cases does not rise, and `reviews` (rounds) does not grow.

| Metric | Better | Cases | What it measures |
|---|---|---|---|
| `recall` | higher | bug cases, and convergence cases with bugs present at their head | Share of the known bugs present in the diff that a review finding matches, per the judge (`claude-fable-5-1`). The headline. |
| `harmful` | lower | all, read on clean cases | Findings the judge rules wrong and that the agent acted on, or that would make the code worse if acted on. |
| `noise` | lower | all | Findings the judge rules neither a known bug nor a valid other problem. |
| `precision` | higher | all with findings | Matched or valid findings over all findings. |
| `fixed` | higher | cases with known bugs | Share of the known bugs gone at the final head. |
| `reintroduced` | lower | convergence cases | Share of the bugs a historical fix round later introduced that the agent's own fixes recreate. |
| `passed` | higher | all | 1 when a review round came back with nothing left to fix. Declared `float` in `_state.json` only so the report headlines `recall`. |
| `reviews` | lower | all | Review rounds the agent ran (`/code-review` calls, plus a variant's `round_workflows`). |
| `five_plus` | lower | all | 1 when the loop needed 5 or more review rounds. |
| `broke_tests` | lower | cases with a test script | 1 when the tests passed before the agent and fail after. |

**Failure classes** (in `errors.jsonl`, never scored): `answer_key_leak`, `sandbox_unavailable`, `harness`, `timeout`, `serving`, `serving_substitution`, `judge_refusal`, `grader`.

**Cost** is API-equivalent: agent plus judge, from each row's model × usage at the prices in `_state.json`. The runs themselves are on the subscription.
