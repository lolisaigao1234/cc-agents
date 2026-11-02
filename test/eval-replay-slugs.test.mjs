import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { renameSlugs } from '../evals/review/lib/replay.mjs'

const source = { owner: 'lolisaigao1234', repo: 'cc-agents' }

test('the source slug becomes the replay slug, and the bare owner the eval org', () => {
  assert.equal(
    renameSlugs('add lolisaigao1234/cc-agents, by lolisaigao1234', source, 'eval-org/r-1'),
    'add eval-org/r-1, by eval-org')
})

test('text without the owner comes back unchanged', () => {
  assert.equal(renameSlugs('nothing here', source, 'eval-org/r-1'), 'nothing here')
})

test('no issue the replays post names the source repository once renamed', () => {
  // The answer-key check voids a run whose tool output shows the source slug,
  // so an issue that names it voids every run of its case (#39, clean-pr28).
  const body = readFileSync(new URL('../evals/review/data/issues/27.md', import.meta.url), 'utf8')
  assert.match(body, /lolisaigao1234\/cc-agents/)
  assert.doesNotMatch(renameSlugs(body, source, 'eval-org/r-1'), /lolisaigao1234\/cc-agents/i)
})
