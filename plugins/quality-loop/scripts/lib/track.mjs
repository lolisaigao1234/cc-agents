// Line tracking between snapshot trees (ADR 0002): where a line range of a
// file in one tree sits in another, decided by git's own diff of that file.
// The hunk arithmetic is pure; `lineTranslator` runs the diffs.

import { git } from './git.mjs'

/**
 * @typedef {{ oldStart: number, oldCount: number, newStart: number, newCount: number }} Hunk
 * @typedef {{ line: number, endLine: number }} Span
 * @typedef {(file: string, line: number, endLine: number, fromTree: string) => Span | null} Translate
 *   where lines [line, endLine] of `file` in `fromTree` are in the current
 *   tree, or null when any of them was changed or deleted (or the diff could
 *   not be read)
 */

/**
 * The hunk headers of a one-file diff.
 *
 * @param {string} text
 * @returns {Hunk[]}
 */
export function parseHunks(text) {
  /** @type {Hunk[]} */
  const hunks = []
  for (const l of text.split('\n')) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l)
    if (!m) continue
    hunks.push({
      oldStart: Number(m[1]),
      oldCount: m[2] === undefined ? 1 : Number(m[2]),
      newStart: Number(m[3]),
      newCount: m[4] === undefined ? 1 : Number(m[4]),
    })
  }
  return hunks
}

/**
 * Lines before a hunk keep their number; lines after it shift by its delta;
 * a range with a line inside a changed hunk, or with lines inserted between
 * its own, is gone (null).
 *
 * @param {Hunk[]} hunks old-side order, as git writes them
 * @param {number} line
 * @param {number} endLine
 * @returns {Span | null}
 */
export function translateRange(hunks, line, endLine) {
  let delta = 0
  for (const h of hunks) {
    if (h.oldCount > 0) {
      const last = h.oldStart + h.oldCount - 1
      if (h.oldStart <= endLine && last >= line) return null
      if (last < line) delta += h.newCount - h.oldCount
    } else {
      // A pure insertion sits after old line `oldStart`.
      if (h.oldStart >= line && h.oldStart < endLine) return null
      if (h.oldStart < line) delta += h.newCount
    }
  }
  return { line: line + delta, endLine: endLine + delta }
}

/**
 * @param {string} diff a one-file diff (empty when the file is unchanged)
 * @param {number} line
 * @param {number} endLine
 */
function throughDiff(diff, line, endLine) {
  const hunks = parseHunks(diff)
  // A binary change has no hunks: nothing in it can be followed.
  if (!hunks.length) return /^(Binary files|GIT binary patch)/m.test(diff) ? null : { line, endLine }
  return translateRange(hunks, line, endLine)
}

/**
 * A translator into `toTree`, the tree of the current ingest. Each file's
 * diff from a given tree is read once.
 *
 * @param {string} root
 * @param {string} toTree
 * @returns {Translate}
 */
export function lineTranslator(root, toTree) {
  /** @type {Map<string, string | null>} */
  const diffs = new Map()
  return (file, line, endLine, fromTree) => {
    if (fromTree === toTree) return { line, endLine }
    const key = `${fromTree}\0${file}`
    let diff = diffs.get(key)
    if (diff === undefined) {
      const r = git(
        ['--literal-pathspecs', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '-U0', fromTree, toTree, '--', file],
        { cwd: root, allowFail: true },
      )
      diff = r.ok ? r.stdout : null
      diffs.set(key, diff)
    }
    return diff === null ? null : throughDiff(diff, line, endLine)
  }
}
