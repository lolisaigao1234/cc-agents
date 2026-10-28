# trace

Hooks that will keep a model's work traced and its context grounded in the project's decisions (ADRs 0005–0008). So far it ships the edit gate of the trace, the guard and the archive block; the rest lands ticket by ticket under #3. It depends on `mattpocock-skills`, which supplies the skills the work goes through.

## The trace

Every change follows one pipeline, tied to a GitHub issue: Read → Track → Branch → Implement → Review → Update → Close (ADR 0006). The `trace` skill maps each step onto Matt's skills and Claude Code's commands; the model reaches it on its own.

A repository opts in through `/trace:setup`, which only the human can run. It checks `gh`, the triage labels and the docs, then commits the marker `.claude/trace.json` and the archive deny rule through an issue of its own. The marker counts while the working tree, `HEAD` or the default branch has it.

In an opted-in repository, a PreToolUse hook on Edit, Write, MultiEdit and NotebookEdit refuses, in every agent, an edit to a file inside the repository:

- on the default branch;
- on a branch whose `<n>-` prefix names no open issue: a closed or missing issue, or a pull request;
- to `.git/`, on any branch: git and `gh issue develop` change branches and remotes.

On Bash, the same hook refuses, in a traced repository:

- `git commit` whose message does not reference the linked issue (`#<n>`), read as git records it: `-m`, `--trailer`, `-F <file>`, a heredoc or here-string to `-F -`, `-C`, `--fixup`, the commit an `--amend --no-edit` rewrites, with comment lines dropped under `strip` or `scissors` cleanup;
- `gh pr create` (or `gh pr new`) whose body does not say `Closes #<n>` (or `Fixes`, `Resolves`, with `owner/name#<n>` or the issue's URL), read from the last `--body` or `--body-file`, outside code and HTML comments;
- either one when it cannot tell the message, the body or the repository: an editor, `--fill`, `--web`, an option it does not know, a piped, shell-computed or same-line-written file, a `cd` it cannot follow, a shell alias, or `-R` naming another repository. Git and gh aliases are followed.

Every refusal names the pipeline step, the issue and the exact text to add. The edit gate's branch rules apply to commits and PRs too.

It resolves symlinks and `~` first, and a nested repository that is not traced itself is gated by the traced one around it. It asks GitHub about `origin`'s repository on every edit, commit and PR; when GitHub cannot answer in time, it refuses. Edits outside any traced repository are never gated.

The human switches the trace off by launching Claude Code with `TRACE_BYPASS=1`. The edit tools cannot: everywhere, they are refused a change to `env`, `disableAllHooks`, `enabledPlugins` or `hooks` in any Claude Code settings file (user, `CLAUDE_CONFIG_DIR`, project, local or managed), any settings change the hook cannot read or predict, and any change to installed plugins. A plugin loaded with `--plugin-dir` is ordinary code in its own repository. A Bash command that writes those settings is still an open route (#13).

## The guard

A PreToolUse hook on Bash. In every repository, and in every subagent, it refuses commands that destroy work or history:

- `git reset --hard`, `clean -f`, discarding checkouts, switches and restores
- force pushes, including `+refspec`
- `stash drop` / `clear`, `branch -D`
- `--no-verify`, `commit -n`, and overriding `core.hooksPath`
- `rm -r`

It parses the command the way a shell does. Text that only mentions a command is allowed, such as `rg 'rm -rf'` or a commit message. Commands inside `bash -c`, `$(...)` and heredocs fed to a shell are checked. It reads command text, so it is a seatbelt, not a sandbox.

## The archive block

A PreToolUse hook on Read, Edit, Write, MultiEdit, NotebookEdit, NotebookRead, Grep, Glob, LS and Bash. In every repository, and in every agent, it refuses anything that reaches into `archive/` at a repository's root (ADR 0008):

- reading, searching or listing inside it, including history (`git show HEAD:archive/…`, or a `git log -p` that would print it);
- writing, editing or deleting there, and copying or moving out;
- recursive commands that would walk into it (`rg`, `grep -r`, `find`, `git grep`, `tar`, `cp -r`, …), unless they exclude it (`rg -g '!archive'`, `grep --exclude-dir=archive`, `git grep … -- ':!archive'`, `find … -path ./archive -prune`).

Moving files into the archive (`mv`, `git mv`), creating directories there, and staging and committing the move are allowed. A root `.ignore` listing `/archive/` lets plain `rg`, `fd`, `ag` and the Grep tool search the rest of the repository; the Glob tool ignores `.ignore`, so scope its pattern instead.

## Compaction

The trace keeps state in GitHub, not in the context. To compact earlier, at about 300k tokens for example, use Claude Code's own `autoCompactWindow` setting. The plugin does not manage compaction.
