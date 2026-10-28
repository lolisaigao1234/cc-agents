# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root.
- **Every active ADR in `docs/adr/`**. This is not a judgement call: in this repo the trace plugin refuses edits until each related ADR has been read in full (ADR 0007). An ADR with an `Applies to:` line of globs is related only to edits of matching paths.
- **The linked issue with its comments**, and every `docs/` file it links.

`archive/` holds superseded docs. It is human-only: don't read, search or link into it (ADR 0008).

## File structure

```
/
├── GLOSSARY.md
├── docs/adr/        ← active decisions
├── archive/         ← superseded docs, human-only
└── plugins/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `GLOSSARY.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (forced reads), but worth reopening because…_
