// The change's size against the base, in lines changed (added plus
// removed). Review loops grow a change one cheap-looking fix at a time, so
// the loop measures it at start and after every round, and flags fixes that
// grew it past `loop.maxGrowth`. Code is counted apart from tests, so a
// fix's regression test is not growth; paths review skips (lockfiles,
// generated code) and binary files are not counted. Pure.

import { isArtifact } from './artifacts.mjs'
import { matchesAny } from './glob.mjs'
import { isTestFile } from './weakening.mjs'

/** @typedef {{ files: number, code: number, tests: number }} ChangeSize */

/** Growth below this many code lines is never flagged: a small change may take a ten-line fix. */
export const MIN_GROWTH_LINES = 10

/**
 * @param {string} numstat output of `git diff --numstat -z --no-renames`: `<added>\t<removed>\t<path>\0` per file
 * @param {string[]} skipPaths
 * @param {string[]} [artifacts] files the review left behind (artifacts.mjs), not counted
 * @returns {ChangeSize}
 */
export function sizeOf(numstat, skipPaths, artifacts = []) {
  const size = { files: 0, code: 0, tests: 0 }
  for (const entry of numstat.split('\0')) {
    const m = /^(-|\d+)\t(-|\d+)\t([\s\S]+)$/.exec(entry.replace(/^\n/, ''))
    if (!m || m[1] === '-' || matchesAny(m[3] ?? '', skipPaths) || isArtifact(m[3] ?? '', artifacts)) continue
    const lines = Number(m[1]) + Number(m[2])
    size.files += 1
    if (isTestFile(m[3] ?? '')) size.tests += lines
    else size.code += lines
  }
  return size
}

/**
 * Whether the change's code grew from `start` to `now` by more than
 * `maxGrowth` of its start size (at least MIN_GROWTH_LINES). null turns the
 * meter off; a loop started before the meter has no start size.
 *
 * @param {ChangeSize | null | undefined} start
 * @param {ChangeSize | null | undefined} now
 * @param {number | null} maxGrowth
 */
export function grewPast(start, now, maxGrowth) {
  if (maxGrowth === null || !start || !now) return false
  return now.code - start.code > Math.max(maxGrowth * start.code, MIN_GROWTH_LINES)
}

/** @param {ChangeSize} s */
export function formatSize(s) {
  const n = (/** @type {number} */ k, /** @type {string} */ what) => `${k} ${what}${k === 1 ? '' : 's'}`
  return `${n(s.files, 'file')}, ${n(s.code, 'code line')}, ${n(s.tests, 'test line')}`
}

/**
 * The line that puts growth past the limit to the user, or null.
 *
 * @param {{ start?: ChangeSize | null, now?: ChangeSize | null } | undefined} size
 * @param {number | null} maxGrowth
 */
export function growthWarning(size, maxGrowth) {
  if (!size?.start || !size.now || maxGrowth === null || !grewPast(size.start, size.now, maxGrowth)) return null
  return `the loop's fixes grew the change from ${size.start.code} to ${size.now.code} code lines, past loop.maxGrowth (${Math.round(maxGrowth * 100)}%): cut what the fixes added that their findings did not need (guards for cases no finding names, new helpers, options, caches or locks)`
}
