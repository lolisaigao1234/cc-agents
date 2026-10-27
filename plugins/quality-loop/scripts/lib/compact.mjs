// The context cap. Past a few hundred thousand tokens attention spreads thin
// and a long loop drifts from its goal, so quality-loop sessions compact by
// `loop.maxContextTokens` (300k by default). Claude Code's own auto-compaction
// does the work: it is the one mechanism that fires mid-turn. A plugin cannot
// set it for the main session, so this lowers `autoCompactWindow` in the
// repository's local settings; the agents carry it in their frontmatter, and
// headless runs get CLAUDE_CODE_AUTO_COMPACT_WINDOW.

import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

import { writeJson } from './store.mjs'

export const MIN_WINDOW = 100000
export const MAX_WINDOW = 1000000

const SETTINGS = '.claude/settings.local.json'

/** @param {unknown} w */
const above = (w, /** @type {number} */ cap) => w === undefined || w === 'auto' || !(typeof w === 'number' && w <= cap)

/**
 * The settings with every auto-compact window lowered to `cap`, or null when
 * none is above it. Claude Code takes the lowest window across settings
 * files, and a per-model window replaces the top-level one within a file.
 *
 * @param {Record<string, any>} settings
 * @param {number} cap
 * @returns {Record<string, any> | null}
 */
export function capWindow(settings, cap) {
  let changed = false
  const out = { ...settings }
  if (above(out.autoCompactWindow, cap)) {
    out.autoCompactWindow = cap
    changed = true
  }
  if (out.modelSettings && typeof out.modelSettings === 'object') {
    out.modelSettings = Object.fromEntries(
      Object.entries(out.modelSettings).map(([model, s]) => {
        if (!s || typeof s !== 'object' || !('autoCompactWindow' in s) || !above(s.autoCompactWindow, cap)) return [model, s]
        changed = true
        return [model, { ...s, autoCompactWindow: cap }]
      }),
    )
  }
  return changed ? out : null
}

/**
 * Lowers the auto-compact window in `<root>/.claude/settings.local.json` to
 * `cap`, and keeps that personal file out of git.
 *
 * @param {string} root
 * @param {number} cap
 * @returns {{ file: string, changed: boolean, previous?: unknown, error?: string }}
 */
export function ensureCompactWindow(root, cap) {
  const file = join(root, SETTINGS)
  /** @type {Record<string, any>} */
  let settings = {}
  if (existsSync(file)) {
    try {
      settings = JSON.parse(readFileSync(file, 'utf8'))
    } catch (err) {
      return { file, changed: false, error: `${SETTINGS} is not valid JSON, so the context cap was not set: ${/** @type {Error} */ (err).message}` }
    }
  }
  const next = capWindow(settings, cap)
  if (next) writeJson(file, next)
  ignoreLocally(root, SETTINGS)
  return { file, changed: !!next, previous: settings.autoCompactWindow }
}

/** Adds `path` to .git/info/exclude unless git already ignores it. */
function ignoreLocally(/** @type {string} */ root, /** @type {string} */ path) {
  const git = (/** @type {string[]} */ args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (git(['check-ignore', '-q', path]).status === 0) return
  const rel = git(['rev-parse', '--git-path', 'info/exclude'])
  if (rel.status !== 0) return
  const exclude = isAbsolute(rel.stdout.trim()) ? rel.stdout.trim() : join(root, rel.stdout.trim())
  mkdirSync(dirname(exclude), { recursive: true })
  const text = existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
  appendFileSync(exclude, `${text && !text.endsWith('\n') ? '\n' : ''}${path}\n`)
}
