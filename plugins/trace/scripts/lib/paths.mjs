// Paths as the filesystem sees them, shared by the archive block and the trace.

import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

/** @param {string} p @returns {string} `p` with symlinks resolved as far as it exists */
export function real(p) {
  try {
    return realpathSync.native(p)
  } catch {
    const parent = dirname(p)
    return parent === p ? p : join(real(parent), basename(p))
  }
}

/** @param {string} w @param {string} cwd @returns {string} `w` with a leading `~` form expanded */
export function untilde(w, cwd) {
  const m = /^~([^/]*)(.*)$/s.exec(w)
  if (!m) return w
  const [, who = '', rest = ''] = m
  const home = who === '' ? homedir() : who === '+' || who === '-' ? cwd : join(dirname(homedir()), who)
  return home + rest
}
