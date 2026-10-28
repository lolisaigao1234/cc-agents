# trace

Hooks that will keep a model's work traced and its context grounded in the project's decisions (ADRs 0005–0008). So far it ships the edit, commit and PR gates of the trace, its forced reads, the guard and the archive block; the rest lands ticket by ticket under #3. It depends on `mattpocock-skills`, which supplies the skills the work goes through.

## The trace

Every change follows one pipeline, tied to a GitHub issue: Read → Track → Branch → Implement → Review → Update → Close (ADR 0006). The `trace` skill maps each step onto Matt's skills and Claude Code's commands; the model reaches it on its own.

A repository opts in through `/trace:setup`, which only the human can run. It checks `gh`, the triage labels and the docs, then commits the marker `.claude/trace.json` and the archive deny rule through an issue of its own. The marker counts while the working tree, `HEAD` or the default branch has it.

In an opted-in repository, a PreToolUse hook on Edit, Write, MultiEdit and NotebookEdit refuses, in every agent, an edit to a file inside the repository:

- on the default branch;
- on a branch whose `<n>-` prefix names no open issue: a closed or missing issue, or a pull request;
- to `.git/`, on any branch: git and `gh issue develop` change branches and remotes.

On Bash, the same hook refuses, in a traced repository:

- `git commit` whose message does not reference the linked issue (`#<n>`), read as git records it: `-m`, `--trailer`, `-F <file>`, a heredoc or here-string to `-F -`, `-C`, `--fixup`, the commit an `--amend --no-edit` rewrites, with comment lines dropped under `strip` cleanup;
- `gh pr create` (or `gh pr new`), and `gh pr edit` changing the body, whose body does not say `Closes #<n>` (or `Fixes`, `Resolves`, with `owner/name#<n>` or the issue's URL), read from `--body-file`, else the last `--body`, outside code and HTML comments;
- either one when it cannot tell the message, the body or the repository: an editor, `--fill`, `--web`, an option it does not know, a piped, shell-computed or same-line-written file, a `cd` it cannot follow, a variable such as `GIT_DIR` or `GH_REPO`, a git or gh alias that runs a shell (`!…`), or a PR that gh would open outside origin's repository (`-R`, a fork's upstream). Other git and gh aliases are followed.

Every refusal names the pipeline step; one for a missing reference also names the linked issue and the exact text to add. The edit gate's branch rules apply to commits and PRs too.

### Forced reads

Before an agent may make such an edit or commit, it must have read every related doc in full, itself (ADR 0007). Which docs are related is decided mechanically, never by the agent:

- `GLOSSARY.md`;
- every active ADR: a numbered file under `docs/adr/` that is not superseded, deprecated or rejected, in the working tree or in `HEAD`. An ADR whose frontmatter has `applies-to:` (a path glob or a list of them) counts only for an edit of a matching path; a glob it cannot read counts everywhere, and so does every active ADR at a commit, since what a commit takes cannot be told from its text;
- every text file under `docs/` that the linked issue's body names;
- the linked issue's title, body and each comment.

The glossary and the ADRs come from `HEAD` as well as the working tree, so moving, emptying or re-marking one does not drop it; a doc that is gone from the working tree is read with `git show HEAD:<path>`. Besides `git commit`, the git commands that make or move commits (`merge`, `cherry-pick`, `revert`, `am`, `rebase`, `pull`, `commit-tree`, `update-ref`) wait for the reads on an issue's branch.

A PostToolUse hook records what each agent read, separately for the main session and each subagent, so a parent's reads never count for its subagent. A file counts when Read has returned all its lines, in one read or in chunks, exactly as they are on disk. The issue counts when a `gh` command and its output contain each part's text, plain or as JSON; a comment the agent posted counts as read. Output too long for Claude Code to show counts only for the preview the agent saw. Changing a file or an issue part makes its read stale. The refusal lists what is unread or stale, and the commands to read them. Without a session id in the hook input, or when GitHub cannot say what the issue says, it refuses.

The records live in the temp directory under `trace-reads/`, signed for the agent they belong to, so one copied from another agent or written by hand does not count. The hook refuses edits there and Bash commands that name it. A model that set out to read the signing key could still forge a record: the forced reads are a seatbelt against drift, not a sandbox.

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
