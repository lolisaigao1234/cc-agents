# cc-agents

Claude Code agents and mods for code quality, built from four claude.dev posts on code review, eval design and hill climbing, Opus 5.5, and Claude Code mods ([analysis](docs/research/source-techniques.md)).

## quality-loop

A repository-agnostic plugin that reviews a change with parallel subagents, keeps only quorum-verified findings with file-and-line evidence, fixes them test-first, reverts any round that regresses your checks, and repeats until done or stalled. It also builds evals from your repository's reverts and fixes and hill-climbs its own reviewer guidance on a held-out split. See [plugins/quality-loop/README.md](plugins/quality-loop/README.md).

Install, at a Claude Code prompt:

```
/plugin install quality-loop --marketplace lolisaigao1234/cc-agents
```

Answer `y` to add the marketplace, then pick a scope. From a shell: `claude plugin install quality-loop --marketplace lolisaigao1234/cc-agents`.

## Developing

```
npm install
npm run check        # typecheck, unit + integration tests, plugin validation, mod tests
claude --plugin-dir plugins/quality-loop   # run a session with the working copy
```

`npm run typecheck:mod` type-checks the mod against the declarations Claude Code lays in `plugins/quality-loop/.claude-plugin/types/` the first time an interactive `--plugin-dir` session loads it.

`npm test` runs the `ql` core's tests on throwaway git repositories. `test/e2e/fixture.mjs <dir>` builds the end-to-end fixture: a node project whose `feature` branch seeds two bugs its own test misses.

Design: [CONTEXT.md](CONTEXT.md) (glossary) and [docs/adr/](docs/adr/).
