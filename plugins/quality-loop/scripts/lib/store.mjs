// Where the loop keeps its files, and atomic reads and writes of them.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { LOOP_DIR } from './git.mjs'

/** @param {string} root */
export function paths(root) {
  const dir = join(root, LOOP_DIR)
  return {
    dir,
    config: join(dir, 'config.json'),
    reviewMd: join(dir, 'REVIEW.md'),
    state: join(dir, 'state.json'),
    loopMd: join(dir, 'LOOP.md'),
    runs: join(dir, 'runs'),
    work: join(dir, 'work'),
    history: join(dir, 'history'),
    evals: join(dir, 'evals'),
    gitignore: join(dir, '.gitignore'),
  }
}

// Committed: config.json, REVIEW.md, evals/cases. Everything else is runtime.
export const GITIGNORE = ['state.json', 'LOOP.md', 'runs/', 'work/', 'history/', 'evals/results/', 'evals/work/', 'evals/hillclimb.json', ''].join(
  '\n',
)

/** @param {string} p */
export function readJson(p) {
  if (!existsSync(p)) return null
  const text = readFileSync(p, 'utf8')
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new Error(`${p} is not valid JSON: ${/** @type {Error} */ (err).message}`)
  }
}

/**
 * Writes via a temporary file and rename, so a crash never leaves half a file.
 *
 * @param {string} p
 * @param {unknown} value
 */
export function writeJson(p, value) {
  writeText(p, JSON.stringify(value, null, 2) + '\n')
}

/** @param {string} p @param {string} text */
export function writeText(p, text) {
  mkdirSync(dirname(p), { recursive: true })
  const tmp = `${p}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, p)
}

/**
 * Reads JSON from a file path, or from stdin when the path is `-`.
 *
 * @param {string} source
 */
export function readJsonInput(source) {
  const text = source === '-' ? readFileSync(0, 'utf8') : readFileSync(source, 'utf8')
  const trimmed = text.trim()
  // Agents sometimes wrap JSON in a fenced block; accept that.
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed)
  return JSON.parse(fenced?.[1] ?? trimmed)
}
