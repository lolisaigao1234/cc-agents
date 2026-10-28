# Domain Docs

How the engineering skills should consume this repo's domain documentation.

## Before changing anything, read these

Read the **related docs** in full: `GLOSSARY.md`, the linked issue with its comments, and the ADRs in `docs/adr/` (ADR 0007 decides which ones apply; that is not a judgement call).

Superseded docs are in the archive, which is human-only (ADR 0008). The active ADRs in `docs/adr/` replace everything there.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `GLOSSARY.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (forced reads), but worth reopening because…_
