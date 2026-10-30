# trace

Hooks that keep a model's work traced and its context grounded in the project's decisions (ADRs 0005–0008): the edit, commit and PR gates of the trace, its forced reads, the issue kept in context, the progress-comment nudge, the band and `/trace`, the guard and the archive block. It depends on `mattpocock-skills`, which supplies the skills the work goes through.

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
- every text file under `docs/` that the linked issue's body names, other than notebooks and files too large for Read;
- the linked issue's title, body and each comment.

The glossary and the ADRs come from `HEAD` as well as the working tree, so moving, emptying or re-marking one does not drop it; a doc that is gone from the working tree is read with `git show HEAD:<path>`. Besides `git commit`, the git commands that make or move commits (`merge`, `cherry-pick`, `revert`, `am`, `rebase`, `pull`, `commit-tree`, `update-ref`) wait for the reads on an issue's branch; stopping one (`--abort`, `--quit`, `--skip`) does not. During a rebase, the branch being rebased is the issue's branch.

A PostToolUse hook records what each agent read, separately for the main session and each subagent, so a parent's reads never count for its subagent. A file counts when Read has returned all its lines, in one read or in chunks, exactly as they are on disk; the same text read under another name counts too, so a renamed doc stays read. A doc the agent wrote, or edited after reading all of it, stays read. The issue counts when a `gh` command and its output contain each part's text, plain or as JSON; a comment the agent posted with `--body` counts as read. Output too long for Claude Code to show counts only for the preview the agent saw; a long issue part or doc in `HEAD` counts once saved to a file outside the repository and Read there. Any other change to a file or an issue part makes its read stale. The refusal lists what is unread or stale, and the commands to read them. Without a session id in the hook input, or when GitHub's answer about the issue cannot be read, it refuses; when GitHub does not answer, the session halts (below).

The records live in the temp directory under `trace-reads/`, signed for the agent they belong to, so one copied from another agent or written by hand does not count. The hook refuses edits there and Bash commands that name it. A model that set out to read the signing key could still forge a record: the forced reads are a seatbelt against drift, not a sandbox.

It resolves symlinks and `~` first, and a nested repository that is not traced itself is gated by the traced one around it. It asks GitHub about `origin`'s repository on every edit, commit and PR. Edits outside any traced repository are never gated; but telling whether a repository without the marker in its working tree has it in `HEAD` or on the default branch takes git, so when git cannot answer there, the session halts (below).

The human switches the trace off by launching Claude Code with `TRACE_BYPASS=1`. The edit tools cannot: everywhere, they are refused a change to `env`, `disableAllHooks`, `enabledPlugins` or `hooks` in any Claude Code settings file (user, `CLAUDE_CONFIG_DIR`, project, local or managed), any settings change the hook cannot read or predict, and any change to installed plugins. A plugin loaded with `--plugin-dir` is ordinary code in its own repository. Bash commands that write them are the guard's.

### The issue in context

The issue is the record that survives compaction (ADR 0006). When a session starts, resumes or is compacted, and when a subagent starts, a hook tells the agent the linked issue's title, its acceptance criteria (the section under that heading, or the body when it has none), its latest progress comment (one headed "Progress", else the latest comment), and the related docs it must read, with the paths a scoped ADR covers; off an issue's branch, it names the step to go back to. The issue's own text is quoted line by line, so nothing a GitHub user wrote reads as the hook's words. Long parts are cut, with the command that prints them whole. This is orientation: the forced reads still decide what may be changed. After a compaction, the agent's reads are forgotten, since its context no longer holds them, and it reads the docs again.

When the agent stops after commits reached the issue's branch on its remote since the issue's last comment, the Stop hook blocks once and asks for a progress comment: progress, decisions, verification results. The branch is where git pushes it (its push destination, else its upstream, else origin's branch of its name), and it counts only when it holds commits the remote's other branches do not; the time is when that ref last moved here, else its commit date. It asks once per pushed head, in any session, and lets the next stop through. When GitHub's answer cannot be read, it lets the stop through.

Nothing is injected, and nothing nudged, in a repository that has not opted in, or under `TRACE_BYPASS=1`.

### The halt

The trace rests on git and GitHub, so when a hook needs an answer from them and gets none, it does not guess: it halts the session (ADR 0006). It returns `continue: false` with a `stopReason` that names what failed and what to restore (`git status`, `gh auth status`, the network); on PreToolUse it also denies the call and exits 2. It never offers `TRACE_BYPASS=1` as the remedy.

- git gets no answer when it is not on PATH or fails to start, times out, is killed, runs past the hook call's deadline, or fails in any way that is not an answer about what was asked: an untrusted (`safe.directory`), locked, corrupt or unreadable repository, a HEAD that names no object, and, for the trace's own questions, any failure the hook has no words for. Of a command the agent wrote, which the archive block asks git about, only the words for a broken repository count: any other failure, such as an unknown option, may be the command's own mistake, so the command is denied in git's words. What git repeats of a command, such as a branch or revision name it quotes (`16-fix-corrupt-index`) or an option's file it cannot read (`-O`), is never taken for those words. git runs with `LC_ALL=C`, so its words are the same in every locale. git saying no, such as "path does not exist in HEAD", "bad revision", a reflog entry that does not exist or "no upstream configured", is an answer.
- GitHub gets none when `gh` is not on PATH, times out, is not logged in (exit 4, HTTP 401 or 403), cannot reach GitHub (a connection or TLS error, HTTP 5xx, a rate limit), or fails in any other way than "Not Found (HTTP 404)", 410, "no pull requests found" or "no aliases", which are answers.

The gates, the archive block, SessionStart, SubagentStart and Stop halt this way when they ask. The halt is recorded for the session next to the read records, so while it stands every hook call in the session halts at once, in the main session and every subagent, PostToolUse included: a subagent's halt reaches its parent's next tool call. PreToolUse runs for every tool, so a halt stops the Agent tool, web fetches and MCP tools too; it judges only the tools listed under each block below.

What lifts the halt is set by ADR 0006: any prompt except a background agent's report, which arrives as a prompt too; starting, resuming or clearing the session lifts it as well, and a compaction does not. A UserPromptSubmit hook and the SessionStart hook clear it. The hook cannot tell the human's prompt from one a scheduled task (`/loop`, cron) or another session sends, so those lift it too. If git still cannot answer, the next call that asks halts again.

Hooks ask git and GitHub only what judging a call, or telling an agent its issue, needs:
- git commands neither the gates nor the archive block judge (`git status`, `git log` without changes, …) ask git nothing, so they do not halt. A git command outside git's own (a possible alias) asks git for the alias, where it runs or, when an earlier command on the line makes that directory, in the nearest one that exists.
- Every `gh` command asks `gh alias list`, since an alias may open a PR. When gh gives no answer there, the command halts where it may run in a traced repository, or where the trace cannot tell where it runs (`cd "$X" && gh issue view 6`); elsewhere it runs.
- The archive block judges history commands that print changes (`git log -p`, `git show`, `git diff <rev>`) in a repository with an archive, and asks git what they print, so these can halt (see the archive block).
- Recording what an agent read never halts. A Read inside the repository asks git nothing; a saved output read, a `gh issue` or `gh api` command, or a `git show` asks which issue the branch is linked to. When git or GitHub gives no answer there, nothing is recorded, and the gate that needs the read asks for it again.

Under `TRACE_BYPASS=1` the trace asks git nothing either; the archive block still does. Any other failure of a hook, such as a bug or bad input, is not a halt: the gates and the archive block deny the call, and the other hooks let it through. A hook process that itself crashes, or is killed at its 30s timeout, cannot halt, so the git and GitHub calls of one hook call share a 20s deadline.

### The band and `/trace`

A band above the prompt shows the trace at a glance (ADR 0005): the linked issue, the pipeline with the steps done (`✓`) and the step reached (`▸`), whether the related docs are read, and the PR with its CI state (passing, failing, pending, or none without checks). Off an issue's branch it is one line, the step the gates name. On a narrow terminal the pipeline shortens to the step reached and a count, so the docs and the PR stay in view.

It reads the same state the hooks enforce, through the hook script's `status` event for the main session, and keeps none of its own. A step is done when its gate is satisfied: Read when every related doc is read, Implement when a commit on the branch and not on the default branch references `#<n>` as the commit gate reads it, Review when the branch has an open PR (a closed one, or one merged into another branch while the issue stays open, closes nothing), Update when the issue's last comment is newer than the branch's last push.

It reads the state again when a session starts, clears, compacts or changes directory, when a prompt is sent, after each turn, and after each Read, Bash, Edit, Write or MultiEdit, at most once every 5 seconds. While the PR's CI is pending it asks again every minute, idle or not. While the session is halted, or when git or GitHub cannot answer the status itself, the band shows that and its reason in place of the trace, and `/trace` prints it. When the state cannot be read for any other reason, it keeps what it showed.

`/trace`, typed bare by the person, at the terminal or through Remote Control, prints the same in full: the issue and its URL, the step and why, in the hooks' own words, the last comment and the latest progress comment, and each of the PR's checks. `/trace` is also the `trace` skill's command; with arguments, or run by the model, the SDK or a plugin, it is the skill.

In a repository that has not opted in, or under `TRACE_BYPASS=1`, the band draws nothing and `/trace` says so.

## The guard

A PreToolUse hook on Bash. In every repository, and in every subagent, it refuses commands that destroy work or history:

- `git reset --hard`, `clean -f`, discarding checkouts, switches and restores
- force pushes, including `+refspec`
- deleting remote branches (`push --delete`, `push origin :<branch>`), `push --mirror` and `push --prune`
- `stash drop` / `clear`, `branch -D`
- `reflog expire` and `reflog delete`, `gc --prune=now` (or `gc` under a `gc.*Expire=now` setting), `prune`
- `--no-verify`, `commit -n`, and overriding `core.hooksPath`
- `rm -r`, `find -delete`, `rsync --delete` (and its variants, and `--remove-source-files`)

A dry run (`-n`, `--dry-run`) of a push that deletes, mirrors or prunes, of `reflog`, `prune` or `rsync`, is allowed; a forced one is not. git's abbreviations of long options (`--del`, `--mirr`) count as the option.

It also refuses commands that write Claude Code's settings files or installed plugins, the files the edit gate guards from the edit tools:

- a redirection, `tee`, `cp`, `mv`, `rm`, `git rm`, `git mv`, `sed -i`, `curl -o`, `wget -O` and their kin naming one, from where the command runs, with `~`, `$HOME` and `$CLAUDE_CONFIG_DIR` expanded; copies to another host are not;
- moving a directory that holds them: a `.claude` directory, Claude Code's config directory, or one above it;
- an interpreter's code naming one, on its command line, in a heredoc or piped in;
- `claude plugin install|uninstall|enable|disable|update`, `claude plugin marketplace add|remove|update`, and `claude config set|add|remove`.

Reading them is allowed; a settings change other than the switches can be made with the Edit tool.

It parses the command the way a shell does. Text that only mentions a command is allowed, such as `rg 'rm -rf'` or a commit message. Commands inside `bash -c`, `$(...)`, and the heredocs and `echo` or `printf` text a shell reads as its script are checked. It reads command text, so it is a seatbelt, not a sandbox.

## The archive block

A PreToolUse hook on Read, Edit, Write, MultiEdit, NotebookEdit, NotebookRead, Grep, Glob, LS and Bash. In every repository, and in every agent, it refuses anything that reaches into `archive/` at a repository's root (ADR 0008):

- reading, searching or listing inside it, including history (`git show HEAD:archive/…`, or a `git log -p` that would print it);
- writing, editing or deleting there, and copying or moving out;
- recursive commands that would walk into it (`rg`, `grep -r`, `find`, `git grep`, `tar`, `cp -r`, …), unless they exclude it (`rg -g '!archive'`, `grep --exclude-dir=archive`, `git grep … -- ':!archive'`, `find … -path ./archive -prune`).

Moving files into the archive (`mv`, `git mv`), creating directories there, and staging and committing the move are allowed. A root `.ignore` listing `/archive/` lets plain `rg`, `fd`, `ag` and the Grep tool search the rest of the repository; the Glob tool ignores `.ignore`, so scope its pattern instead.

Asking git what history commands print draws on the hook call's deadline, which the trace's gates share. When git cannot answer, or the hook call runs out of time, the session halts as above, and the history command is not called one that touches the archive; the halt names `-- ':!archive'`, with which a history command asks git nothing. A history command git takes more than 5s to list, or whose list overflows the hook's buffer, is denied as one that could not be checked, naming the same fix: that is the command's size, not git failing. One git refuses for a reason other than a broken repository (a bad revision or option) is denied in git's words, as the command's own mistake. The hook asks git for the paths with `--name-only`, leaving out the options git refuses beside it or that change only what git exits with or how it ends each path (`--name-status`, `--check`, `-s`, `--exit-code`, `-z`), so such a command is judged by the paths it covers; one with `--quiet` prints no changes and is allowed. One with `--output`, which writes a file, is denied without being run, since the hook runs before any permission prompt. One in a repository an earlier command on the line makes (`git clone … && cd … && git log -p`) is denied until it runs as its own command. A tool call the hook fails to check for any other reason is denied.

## Compaction

The trace keeps state in GitHub, not in the context, and tells the agent the issue again after each compaction. To compact earlier, at about 300k tokens for example, use Claude Code's own `autoCompactWindow` setting. The plugin does not decide when to compact.
