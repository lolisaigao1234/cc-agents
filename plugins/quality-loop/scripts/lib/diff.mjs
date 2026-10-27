// Unified diff parsing. Pure: no Node APIs.

/**
 * @typedef {{ line: number, text: string }} DiffLine
 * @typedef {{
 *   path: string,
 *   oldPath: string,
 *   status: 'added' | 'deleted' | 'modified' | 'renamed',
 *   added: DiffLine[],
 *   removed: DiffLine[],
 *   touchedLines: Set<number>,
 * }} DiffFile
 */

/** @param {string} raw */
function unquote(raw) {
  const s = raw.trim()
  if (!s.startsWith('"')) return s
  return s.slice(1, -1).replace(/\\(["\\])/g, '$1').replace(/\\t/g, '\t')
}

/** @param {string} raw */
function stripPrefix(raw) {
  const s = unquote(raw)
  if (s === '/dev/null') return s
  return s.replace(/^[ab]\//, '')
}

/**
 * Parses `git diff` output (any context size) into per-file added and removed
 * lines. `touchedLines` holds new-side line numbers that were added, plus the
 * new-side position of each pure deletion, so a finding placed where code
 * was removed still counts as touching the change.
 *
 * @param {string} text
 * @returns {DiffFile[]}
 */
export function parseUnifiedDiff(text) {
  /** @type {DiffFile[]} */
  const files = []
  /** @type {DiffFile | null} */
  let cur = null
  let oldLine = 0
  let newLine = 0
  let inHunk = false

  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      cur = {
        path: '',
        oldPath: '',
        status: 'modified',
        added: [],
        removed: [],
        touchedLines: new Set(),
      }
      files.push(cur)
      inHunk = false
      const m = /^diff --git ("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/.exec(line)
      if (m && m[1] && m[2]) {
        cur.oldPath = stripPrefix(m[1])
        cur.path = stripPrefix(m[2])
      }
      continue
    }
    if (!cur) continue
    if (!inHunk) {
      if (line.startsWith('new file mode')) cur.status = 'added'
      else if (line.startsWith('deleted file mode')) cur.status = 'deleted'
      else if (line.startsWith('rename from ')) {
        cur.status = 'renamed'
        cur.oldPath = unquote(line.slice('rename from '.length))
      } else if (line.startsWith('rename to ')) {
        cur.path = unquote(line.slice('rename to '.length))
      } else if (line.startsWith('--- ')) {
        const p = stripPrefix(line.slice(4))
        if (p !== '/dev/null') cur.oldPath = p
      } else if (line.startsWith('+++ ')) {
        const p = stripPrefix(line.slice(4))
        if (p !== '/dev/null') cur.path = p
        else cur.path = cur.oldPath
      }
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (hunk) {
      inHunk = true
      oldLine = Number(hunk[1])
      newLine = Number(hunk[3])
      // A hunk that adds nothing (`+N,0`) sits after line N on the new side.
      if (hunk[4] === '0') cur.touchedLines.add(Math.max(newLine, 1))
      continue
    }
    if (!inHunk) continue
    if (line.startsWith('+')) {
      cur.added.push({ line: newLine, text: line.slice(1) })
      cur.touchedLines.add(newLine)
      newLine++
    } else if (line.startsWith('-')) {
      cur.removed.push({ line: oldLine, text: line.slice(1) })
      cur.touchedLines.add(Math.max(newLine, 1))
      oldLine++
    } else if (line.startsWith(' ')) {
      oldLine++
      newLine++
    }
    // `\ No newline at end of file` and blank trailing lines change nothing.
  }
  return files.filter(f => f.path !== '')
}

/**
 * Whether the new-side range [start, end] lies within `slack` lines of a line
 * the diff touched.
 *
 * @param {DiffFile} file
 * @param {number} start
 * @param {number} end
 * @param {number} [slack]
 */
export function rangeTouches(file, start, end, slack = 0) {
  for (const l of file.touchedLines) {
    if (l >= start - slack && l <= end + slack) return true
  }
  return false
}
