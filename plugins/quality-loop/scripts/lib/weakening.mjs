// Detects changes that make checks pass by weakening them instead of fixing
// the code: skipped or focused tests, deleted test files, dropped assertions,
// and new lint/type suppressions. Pure.

/** @param {string} path */
export function isTestFile(path) {
  return (
    /(^|\/)(tests?|__tests__|spec)\//.test(path) ||
    /\.(test|spec)\.[a-z0-9]+$/i.test(path) ||
    /_test\.(go|py|rb|exs?)$/.test(path) ||
    /(^|\/)test_[^/]+\.py$/.test(path) ||
    /(Test|Tests|Spec)\.(java|kt|cs|swift|scala)$/.test(path)
  )
}

const SKIP = [
  /\b(?:it|test|describe|context|suite)\.skip\b/,
  /\b(?:xit|xdescribe|xtest|xcontext)\s*\(/,
  /@pytest\.mark\.(?:skip|xfail)\b/,
  /@unittest\.(?:skip|expectedFailure)\b/,
  /\bt\.Skip(?:Now|f)?\(/,
  /#\[ignore\]/,
  /@(?:Disabled|Ignore)\b/,
  /\bpending\(\s*\)/,
]

const FOCUS = [/\b(?:it|test|describe|context|suite)\.only\b/, /\b(?:fit|fdescribe)\s*\(/]

const SUPPRESS = [
  /eslint-disable/,
  /@ts-(?:ignore|nocheck|expect-error)/,
  /#\s*type:\s*ignore/,
  /#\s*noqa\b/,
  /\/\/\s*nolint\b/,
  /#\[allow\(/,
  /@SuppressWarnings\b/,
  /#\s*pylint:\s*disable/,
  /\brubocop:disable\b/,
]

const ASSERTION = /\b(?:expect|assert\w*|should|require\.\w+|t\.(?:Error|Fatal)\w*|XCTAssert\w*)\s*[.(]/

/**
 * @typedef {{
 *   kind: 'skip-added' | 'focus-added' | 'suppression-added' | 'test-file-deleted' | 'assertions-removed',
 *   file: string, line: number, text: string, blocking: boolean,
 * }} Weakening
 */

/**
 * @param {import('./diff.mjs').DiffFile[]} files
 * @returns {Weakening[]}
 */
export function scanWeakening(files) {
  /** @type {Weakening[]} */
  const out = []
  for (const f of files) {
    const isTest = isTestFile(f.path)
    if (f.status === 'deleted') {
      if (isTest) out.push({ kind: 'test-file-deleted', file: f.path, line: 0, text: '', blocking: true })
      continue
    }
    for (const l of f.added) {
      if (isTest && SKIP.some(r => r.test(l.text))) {
        out.push({ kind: 'skip-added', file: f.path, line: l.line, text: l.text.trim(), blocking: true })
      } else if (isTest && FOCUS.some(r => r.test(l.text))) {
        out.push({ kind: 'focus-added', file: f.path, line: l.line, text: l.text.trim(), blocking: true })
      } else if (SUPPRESS.some(r => r.test(l.text))) {
        out.push({ kind: 'suppression-added', file: f.path, line: l.line, text: l.text.trim(), blocking: false })
      }
    }
    if (isTest) {
      const added = f.added.filter(l => ASSERTION.test(l.text)).length
      const removed = f.removed.filter(l => ASSERTION.test(l.text)).length
      if (removed > added) {
        out.push({
          kind: 'assertions-removed',
          file: f.path,
          line: 0,
          text: `${removed - added} fewer assertion line(s)`,
          blocking: true,
        })
      }
    }
  }
  return out
}
