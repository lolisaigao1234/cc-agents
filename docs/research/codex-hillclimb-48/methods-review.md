# Independent methods/spec audit: sanitized public record and v2 disposition

Independent agent review, 2026-11-04, of immutable v1 commit
`36c1081983b93114073a9e334ae443f98633fbfe`. The supplied private
`methods-review.md` is hash-bound in `review-provenance.json`. Sources were issues
#48/#49 and public protocol/caller interfaces; no raw answers, model calls,
authentication, remote replay or experiment outcomes were used. The old 9 tests
passed; independent synthetic arithmetic and an invalid-row example exposed gaps.
This record grants no execution permission or statistical waiver.

The existing exact PR sign-flip inversion is algebraically correct under independent
symmetric errors about a common shift. Independent signed-sum enumeration for
D=[-.2,.1,.3,.4,.5,.8] yields p(0)=3/64; the first non-rejected endpoint is .05.
Four groups have minimum p=1/16>.05, making v1 unpromotable. Five have minimum
p=1/32 and lower95=min(D_g). Every primary PR gain must therefore exceed the same
T=max(.05,N). This removes an arithmetic barrier and still gives low power; it does
not prove independence, symmetry, a common effect, or adequate power.

V2 follows the pre-outcome metadata-only repair: retain v1's 21 selected cases and
five pilot cases in screen; select the numerically smallest optional screen primary
bug PR and move its whole cluster. PR14 moves, yielding screen 11 (5/3/3 kinds),
holdout 10 (5/2/3), five primary PRs each and 33/30 keys per arm. The helper is
checked against immutable v1 membership and the permitted metadata projection.
Original pool selection was postexposure; this deterministic partition repair does
not create new data or undo exposure. No original defect truth/difficulty/grades
informed this revision and no experiment outcomes exist.

The audit reproduced a real baseline-reporting bug: status-ok bug rows with recall
.25 and rep0 rounds=999 produced overall INCONCLUSIVE but baseline.complete=true,
noise=0 and recall=.25. Caller provenance/evidence issues appended afterward caused
the same misleading readiness. V2 uses a single per-arm validation contract for
exact keys, normalized metrics, retained failed attempts and native caller issues
before calculating aggregates. Invalid/duplicate/unexpected baseline rows or
baseline identity/evidence failures withhold validated completeness/aggregates/noise.
Candidate gaps/failures do not hide an otherwise valid baseline. Raw native rows
and sources remain retained; normalized numeric rows and artifact locators are
reported, never manufactured replacement scores.

Baseline-only uncertainty was missing. V2 publishes raw primary case recall triples,
case min/max/ranges, PR per-repetition case means, and equal-PR macro recalls at
rep0/1/2 with min/max/range, before candidate results. These are empirical descriptive
three-repeat variability, not confidence coverage or a population noise bound.
The gate's existing N remains the equal-PR mean of case repeat ranges, distinct
from the range of macro recalls. Incomplete/invalid baseline summaries are null
with scheduled/valid denominators. An independently worked unequal-PR example
checks both formulas. The later paired 95% method and gates are unchanged.

The native compact report previously omitted precision, first-clean-round,
hook-denial and before/after-test coverage. V2 reports those fields with known and
scheduled denominators, test counts and per-key evidence locators. Unknown remains
unknown; full independent human-stop, rejected-disposition, test-log and attempt
review remains necessary. A compact numeric report cannot replace that review.

The audit also distinguishes issue requirements from discretionary policy. The
five-point practical margin, per-key clean-harm/round/fix/regression/test dominance,
and any-failed-attempt INCONCLUSIVE rule are stricter preparation policy choices,
not claims that the issues prescribe them. The parent explicitly retains them in
v2. Arbitrary rep pairing can reject equal-mean stochastic arms; unchanged bounded
native retries can recover yet leave adoption inconclusive. Those costs are disclosed
rather than changing gates. No broad inferential framework or new human clearance
mechanism was introduced. No model-quality outcome or promotion is claimed.
