import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathWithoutHome } from '../evals/review/lib/cli.mjs'
import { verdict } from '../evals/review/lib/egress-guard.mjs'

// conv-pr38-halt rep 2 ran `HOME=/home/<human> git ...` inside the sandbox (#39).
// The agent's PATH named the human's home, and the guard let a command aimed at it run.

test("the agent's PATH keeps system directories and drops the human's home", () => {
  const path = ['/home/u/.local/bin', '/usr/local/bin', '/home/u/bin', '/usr/bin', '/home/user2/bin', '/home/u'].join(':')
  assert.equal(pathWithoutHome(path, '/home/u'), ['/usr/local/bin', '/usr/bin', '/home/user2/bin'].join(':'))
})

test('an empty or missing PATH stays empty', () => {
  assert.equal(pathWithoutHome('', '/home/u'), '')
  assert.equal(pathWithoutHome(undefined, '/home/u'), '')
})

const slug = 'eval-org/r-1'
const keys = ['/home/u', '/srv/checkout', '/tmp/review-eval/run-1/plugins/trace']

test("a command that names the human's home or another answer key is denied", () => {
  assert.match(String(verdict('HOME=/home/u XDG_CONFIG_HOME=/home/u/.config git cat-file -e HEAD:nope', slug, keys)), /outside this task/)
  assert.match(String(verdict('cat /srv/checkout/evals/review/data/bugs.json', slug, keys)), /outside this task/)
  assert.match(String(verdict('diff -r /tmp/review-eval/run-1/plugins/trace .', slug, keys)), /outside this task/)
})

test('a path that only shares a prefix with an answer key is allowed', () => {
  assert.equal(verdict('ls /home/user2 /srv/checkout-other', slug, keys), null)
  assert.equal(verdict('git status && npm test', slug, keys), null)
})

test('the guard still works with no answer keys passed', () => {
  assert.equal(verdict('cat /home/u/.gitconfig', slug), null)
  assert.match(String(verdict('gh search code foo', slug)), /GitHub search/)
})
