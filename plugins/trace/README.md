# trace

Hooks that will keep a model's work traced and its context grounded in the project's decisions (ADRs 0005–0008). So far it ships the guard and the archive block; the rest lands ticket by ticket under #3. It depends on `mattpocock-skills`, which supplies the skills the work goes through.

## The guard

A PreToolUse hook on Bash. In every repository, and in every subagent, it refuses commands that destroy work or history:

- `git reset --hard`, `clean -f`, discarding checkouts, switches and restores
- force pushes, including `+refspec`
- `stash drop` / `clear`, `branch -D`
- `--no-verify`, `commit -n`, and overriding `core.hooksPath`
- `rm -r`

It parses the command the way a shell does. Text that only mentions a command is allowed, such as `rg 'rm -rf'` or a commit message. Commands inside `bash -c`, `$(...)` and heredocs fed to a shell are checked. It reads command text, so it is a seatbelt, not a sandbox.

## The archive block

A PreToolUse hook on Read, Edit, Write, MultiEdit, NotebookEdit, Grep, Glob, LS and Bash. In every repository, and in every agent, it refuses anything that reaches into `archive/` at a repository's root (ADR 0008):

- reading, searching or listing inside it, including history (`git show HEAD:archive/…`);
- writing, editing or deleting there, and copying or moving out;
- recursive commands that would walk into it (`rg`, `grep -r`, `find`, `git grep`, `tar`, `cp -r`, …), unless they exclude it (`rg -g '!archive'`, `grep --exclude-dir=archive`, `git grep … -- ':!archive'`, `find … -path ./archive -prune`).

Moving files into the archive (`mv`, `git mv`) and creating directories there are allowed. A root `.ignore` listing `/archive/` lets plain `rg` and `fd` search the rest of the repository.

## Compaction

The trace keeps state in GitHub, not in the context. To compact earlier, at about 300k tokens for example, use Claude Code's own `autoCompactWindow` setting. The plugin does not manage compaction.
