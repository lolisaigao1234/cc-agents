#!/usr/bin/env node
// The trace's check on GitHub (ADR 0006): `node check.mjs <pr number>`, in a
// workflow run, judges that pull request of GITHUB_REPOSITORY as GitHub has
// it now, asking through `gh` (GH_TOKEN). It exits 0 when the PR is traced
// and 1 when it breaks a rule, printing each as an error annotation; when
// GitHub does not answer, it fails rather than guess.

import { pullRequestVerdict, realGitHub } from './lib/pull-request.mjs'

/** @param {string} text @returns {string} `text` as the data of a workflow command, which ends at a line's end */
const data = text => text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')

/** @param {string} why */
const fail = why => console.log(`::error title=trace::${data(why)}`)

const n = Number(process.argv[2])
const slug = process.env.GITHUB_REPOSITORY ?? ''
if (!Number.isInteger(n) || n <= 0 || !/^[^/\s]+\/[^/\s]+$/.test(slug)) {
  fail('usage: GITHUB_REPOSITORY=<owner>/<name> node check.mjs <pr number>')
  process.exit(1)
}
try {
  const why = pullRequestVerdict(n, realGitHub(slug))
  for (const w of why) fail(`PR #${n}: ${w}`)
  if (!why.length) console.log(`trace: PR #${n} is traced.`)
  process.exitCode = why.length ? 1 : 0
} catch (err) {
  fail(`PR #${n} could not be judged: ${err instanceof Error ? err.message : String(err)}. Run the check again once GitHub answers.`)
  process.exitCode = 1
}
