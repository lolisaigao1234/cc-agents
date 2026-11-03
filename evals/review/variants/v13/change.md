# v13: Codex evidence before fix, version 1

Protocol: `codex-evidence-before-fix-v1`. This is the only supported Codex treatment alongside `baseline` (`codex-baseline-v1`). The numeric slot keeps the existing hillclimb report compatible. The exact manifest bytes have a SHA256 in execution configuration, every workflow record and the #47 freeze record. Runtime/schema code is frozen by the harness fingerprint and git revision together with those bytes.

## Actual delta

The current Codex baseline already asks bug reviewers for concrete failure paths and asks its fixer to resolve or explicitly reject every finding with evidence, run tests and commit. It passes accumulated outputs to a fresh Update session. v13 keeps both independent reviewers' prompts, their isolation, one fixer session per nonempty round, incremental pre-fix HEAD boundaries, one clean round stopping condition, the three-round ceiling and Update.

Inside that existing fixer session, **before editing for each finding**, v13 requires a check against a failure path, targeted test or explicit linked-issue/active-ADR requirement. The response identifies the source, check and observed result. Each supplied finding gets a round/reviewer-local id and exactly one structured disposition:

- `fixed`: supporting evidence and post-fix test commands/results.
- `rejected`: checkable contradictory evidence, retaining the original allegation.
- `needs_human`: inconclusive evidence, the unresolved question and `asked_human: true`.

The adapter rejects missing, duplicate, foreign or inconsistent dispositions, empty evidence and fixes without reported tests as failed attempts with retained outputs. A material human decision stops further review and Update must preserve `asked_human`. These checks validate completeness, not whether a claim is true or a test actually ran before an edit. The prompt directs the ordering; raw tool events make it auditable and the existing judge assesses the findings and changes. The deterministic probe actually executes its failure check before editing and its verification after editing; it does not establish that a model follows the protocol.

For both arms, raw responses, hook evidence, actual call phases, variant identity, pre-fix SHA and complete structured outputs reach saved traces and judge material. Codex material is no longer clipped at 400,000 characters, so rejected or unresolved allegations cannot be silently cut out of grading. Oversized model requests can still fail explicitly and remain failed attempts. These shared evidence-retention changes are part of the new harness revision, not the treatment delta.

## Against the existing Claude concepts

v5 already answers every finding, and adds a findings hook/ledger, PR-readiness and Stop gates, nit declines, PR sections and checks-gap review guidance. v13 imports none of those hooks, readiness rules, nit rules, templates or extra reviews. Its narrow addition is pre-edit verification with complete structured evidence/dispositions in the existing Codex fixer.

v12 asks for checkable reasons when declining a finding, plus churn stops and two clean rounds (including confirming rounds outside the original ceiling). v13 overlaps only in citing checkable evidence; it requires checking **before fixing as well as rejecting**. It adds neither churn detection nor confirming rounds and never exceeds three review rounds.

This is eval-only under ADR 0005. It adds no product review engine, Claude adapter, model, review round, reset redemption, rubric change or quality claim. Unknown Codex variants, overlays and unsupported Claude Workflow/slash requirements are rejected before model execution.
