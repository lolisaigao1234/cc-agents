# v10: family J-latent-sweep, all on

The `J-latent-sweep` family has one idea, `nightly-sweep-existing-code`, and it is switched on for the first screen. `variant.json` sets `"sweep": true`. That makes the runner add the whole-tree sweep case to the diff cases, which run as usual.

Files:

| File | What it is |
|---|---|
| `plugin/skills/trace/SKILL.md` | A copy of `plugins/trace/skills/trace/SKILL.md`. One paragraph is added after the pipeline table, before "Review and fix run in rounds". Every other line is byte-identical. |
| `repo/.claude/workflows/latent-sweep.js` | A Workflow script laid into both trees of the replay repo. It maps the repository's hand-written code into areas, runs one `/code-review high <path>` sweep per area in parallel, and returns every finding tagged with its area. |
| `variant.json` | The family, the idea and `"sweep": true`. It adds no prompt text. |

There is no `repo-append/` and no hook.

## nightly-sweep-existing-code: implemented

- **Quote:** "run nightly over existing code". The full sentence is "Review agents also run nightly over existing code, helping us catch old bugs before they show up somewhere else." The post does not say how wide the sweep is, how deep it goes, or where its findings go. It describes a separate job over existing code, not a step of every PR's review.
- **Switch:** "Workflow: whole-repo /code-review at a snapshot before each latent bug's fix. Off: diff review only. The nightly schedule itself is not replayed."

### What "on" means here

The sweep runs when the issue asks for a sweep of the existing code, which is what the nightly job's own issue would ask. It does not run on every change.

- **The sweep case** (`sweep-405c33d`) is the stand-in for one night's sweep. Its replayed issue is titled "Whole-tree sweep of …", so the skill sends the agent to the workflow before its first review round. The workflow reviews the code as it stands at the snapshot.
- **Diff and clean cases** run as the baseline does. No case issue in `data/issues/` asks for a sweep, so the paragraph does not fire. The only differences from the baseline are the extra paragraph in the skill and the unused workflow file in the repo.

Each replay is a fresh snapshot, so the sweep case covers the code as it was before any later fix. That is what "at a snapshot before each latent bug's fix" asks for.

### Why not sweep on every change

An earlier draft swept the whole repository once per change, diff and clean cases included. That is not the post's idea. The post runs the sweep nightly, apart from PR review. A per-PR sweep would also make J's numbers on the diff and clean cases measure where the sweep was placed, not the sweep:
- every run would pay for a map agent plus one `high` review per area;
- every sweep finding that is not one of the case's `pre_existing_bugs` would be graded noise, or harmful if it is wrong.

The idea's own metric is "latent-bug recall at snapshot; noise per KLOC". Both come from the sweep case.

### For the screen

- J's signal is the sweep case. Its recall is the latent-bug recall; its noise and harmful counts per KLOC swept are the noise metric.
- On the diff and clean cases J should match the baseline within the noise floor. Running J on the 14 clean cases checks only that the trigger does not fire there and that the paragraph changes nothing else. One rep is enough for that, or they can be skipped.
- `pr14-r0`, the other case in the idea's coverage, is a diff case. Its issue asks for no sweep, so it runs as the baseline does. Its latent bugs count only through the diff review, not the sweep.

### The workflow (`latent-sweep.js`)

The script takes no args. It runs in two phases.

1. **Map.** One low-effort agent runs `git ls-files` and splits the tracked files into areas of hand-written code.
   - Each area is one directory or file of at most about 3,000 lines.
   - Areas must not overlap.
   - Tests count as code. Config that changes how the code runs (hook manifests, package scripts, plugin manifests) belongs to the area of the code it configures.
   - `.claude/` (the agent's own tooling, which holds this script) is left out, and so are docs, lockfiles, data, fixtures, and vendored or generated files. The agent lists what it left out.
   - The script then keeps one spelling of each path (`./a`, `a/` and `a` are one area). It drops an area that lies inside another listed area, since the outer area already covers it, and returns those under `nested`.
2. **Sweep.** One agent per area calls the Skill tool with `code-review` and `high <path>`.
   - If the skill refuses, is unavailable, or reviews only a diff, the agent reads the area itself and sets `via: "self"`.
   - The prompt asks for correctness bugs, each with a concrete input, state or environment that makes the code fail.
   - It says to follow a bug into callers outside the area.
   - It excludes style and cleanup, which matches `/code-review`'s own scope.

The script returns every finding with `area`, `location`, `summary`, `failure` and `bug_class`. Nothing is voted on or filtered, because filters belong to family D. Findings are not deduplicated either. Areas do not overlap, so one bug is reported twice only when two areas' reviewers each follow it across the boundary.

Nothing is dropped silently:
- Areas beyond the twelfth are logged and returned under `not_swept`.
- Areas inside another area are logged and returned under `nested`.
- Areas whose agent failed are returned under `failed`.

### Level: `high`

The post names no depth for the sweep. A sweep reads many times more code than a PR diff, and each area is a review of its own. At `xhigh` (v3's Deep setting) the cost per case would multiply. `high` is one step above the default and one below Deep. Which depth the sweep should use is a question for a single-arm follow-up.

### Skill text

The added paragraph:

> Old bugs hide outside any diff, so a nightly sweep reviews the existing code. When the issue asks for such a sweep, run it before the first review round: call the Workflow tool with `scriptPath: ".claude/workflows/latent-sweep.js"`. It reviews each area of the repository as it stands and only reports; it is not a review round. Answer each sweep finding like any other finding, and list every one in the progress comment with its location and failure.

What each part does:
- "When the issue asks for such a sweep" ties the sweep to the nightly job's issue, not to every change.
- "Answer each sweep finding like any other finding" keeps today's rule: every finding gets a fix, or a reason in the progress comment. The sweep's issue asks for the sweep, so its findings are in scope for that PR.
- "List every one in the progress comment" is what grading needs. The judge sees sweep findings only through the progress comment or the agent's own text (see Caveats).
- "It is not a review round" keeps two rules meaning what they mean today: "After the first round, review only the new diff", and the cap of three rounds.

What the paragraph does not do: it does not route sweep findings into new issues, and it does not tag them pre-existing. That routing is family D's `tag-important-nit-preexisting` ("Pre-existing is filed … not fixed in-branch"). Borrowing it would mix D into J's result. Issues the agent filed would also be invisible to the grader, which reads only the case's own issue and PR.

### Fairness

The workflow and the paragraph name no module, bug, case or commit. The map agent picks the areas from whatever the snapshot holds. The config rule names kinds of file (hook manifests, package scripts, plugin manifests), not any file's contents.

## Not implemented

Nothing. The nightly schedule itself is outside the switch: the switch says it is "not replayed". The sweep case's issue stands in for the nightly job.

## Caveats for the runner (not changed here: they are outside this variant)

The progress comment of 2026-10-30 says family J needs harness support before the screen. These are the gaps this variant runs into:

- **The judge sees sweep findings only through the progress comment or the agent's own text.**
  - `transcript.mjs` adds tool results to the judge's material for `Agent`, `Task` and `Skill`, but not for `Workflow`.
  - `gitHubMaterial` reads only the case's own issue and PR.
  - This is why the skill text asks for every sweep finding, with its location, in the progress comment. If the agent cuts that list short, sweep recall will be understated.
  - Adding `Workflow` results to the material would close this gap.
- **Noise on the sweep case is graded against a diff.**
  - The judge files a claim it cannot confirm from the diff or the issue as `noise`. On the sweep case, a real latent bug outside the 8 known ones will count as noise.
  - The noise is a real cost, since every sweep finding is more for the human to read, but a grader built for diffs overstates it.
- **Rounds may be overcounted.**
  - If the sweep agents' `/code-review` Skill calls appear in the main stream, each area will count as one round in `rounds` and in the `=== REVIEW ROUND k ===` markers.
  - A smoke run should check this. If it happens, the digest should count only `/code-review` calls made by the main session.
- **The sweep case has no baseline row.**
  - `loadCases` runs the sweep case only for a variant with `sweep` set, so the baseline never runs it.
  - Sweep-case recall therefore has no baseline row to compare with. A comparison would need a baseline run that includes the case.
  - Its replayed issue is titled "Whole-tree sweep", so a baseline run would also be told to sweep. The comparison would then be this workflow against the agent's own way of sweeping, which is the comparison the arm should make.
- **Coverage is thin.**
  - There is one sweep snapshot, `sweep-405c33d`, with 8 latent bugs, and the idea's coverage is marked "not enough".
  - A second snapshot needs a new case in `cases.json`. That is harness work, not part of this variant.
- **`/code-review` with a path target is unverified.**
  - It was not checked whether `/code-review high <path>` reviews the files at that path or only the diff within it.
  - The sweep prompt falls back to reading the area directly and then reports `via: "self"`.
  - A smoke run should count how many areas came back with `via: "code-review"`.
- **Cost.**
  - Only the sweep case pays for the sweep: one map agent and one `high` review per area, on top of the baseline's median of $4.28.
  - The sweep snapshot holds about 6.5k lines of JS/TS in 19 files under `plugins/` and `test/`. At the 3,000-line target that is about 3 to 5 areas, depending on how the map splits directories. Earlier snapshots would have fewer.
  - Expect the sweep case to cost about two to three times a baseline case. The per-case `--budget-usd` (default $40) should not be reached. A run that reaches it shows as `budget_hit`.
