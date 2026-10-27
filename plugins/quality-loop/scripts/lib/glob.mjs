// Minimal glob matching for skip/protected path lists: `**` spans
// directories, `*` and `?` stay within one path segment. Pure: no Node APIs,
// so the mod can import it too.

/** @param {string} glob */
export function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` matches zero or more whole directories; a trailing `**` matches the rest.
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?'
          i += 2
        } else {
          re += '.*'
          i += 1
        }
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${re}$`)
}

/** @param {string} path */
export function normalizePath(path) {
  return path.replace(/\\/g, '/').replace(/^\.\//, '')
}

/**
 * @param {string} path
 * @param {readonly string[]} globs
 */
export function matchesAny(path, globs) {
  const p = normalizePath(path)
  return globs.some(g => globToRegExp(normalizePath(g)).test(p))
}
