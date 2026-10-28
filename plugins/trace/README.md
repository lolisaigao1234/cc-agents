# trace

Hooks that will keep a model's work traced and its context grounded in the project's decisions (ADRs 0005–0008). So far it ships the guard; the rest lands ticket by ticket under #3. It depends on `mattpocock-skills`, which supplies the skills the work goes through.

## The guard

A PreToolUse hook on Bash. In every repository, and in every subagent, it refuses commands that destroy work or history:

- `git reset --hard`, `clean -f`, discarding checkouts, switches and restores
- force pushes, including `+refspec`
- `stash drop` / `clear`, `branch -D`
- `--no-verify`, `commit -n`, and overriding `core.hooksPath`
- `rm -r`

It parses the command the way a shell does. Text that only mentions a command is allowed, such as `rg 'rm -rf'` or a commit message. Commands inside `bash -c`, `$(...)` and heredocs fed to a shell are checked. It reads command text, so it is a seatbelt, not a sandbox.

## Compaction

The trace keeps state in GitHub, not in the context. To compact earlier, at about 300k tokens for example, use Claude Code's own `autoCompactWindow` setting. The plugin does not manage compaction.
