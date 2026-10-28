// Files a round's review leaves behind. Hunters and verifiers only read the
// change, but the tests they run can write files into the repository
// (coverage, test reports). A file that is new between the hunters' briefs
// and the end of verification is such an artifact, not part of the change:
// it is never an unreviewed edit and never counts toward the change's size.
// A new directory is recorded whole, so later test runs that add to it or
// rewrite it stay artifacts too. Pure.

/**
 * The artifact paths for files `added` while the review ran: each file's
 * highest ancestor directory that did not exist when the review began (as
 * `dir/`), or the file itself when its directory did.
 *
 * @param {string[]} added
 * @param {Set<string>} dirsAtStart the directories in the tree when the review began
 */
export function artifactRoots(added, dirsAtStart) {
  /** @type {Set<string>} */
  const roots = new Set()
  for (const path of added) {
    const parts = path.split('/')
    let root = path
    for (let k = 1; k < parts.length; k++) {
      const dir = parts.slice(0, k).join('/')
      if (!dirsAtStart.has(dir)) {
        root = `${dir}/`
        break
      }
    }
    roots.add(root)
  }
  return mergeRoots([], [...roots])
}

/** @param {string} path @param {string[]} roots */
export function isArtifact(path, roots) {
  return roots.some(r => (r.endsWith('/') ? path.startsWith(r) : path === r))
}

/**
 * Both lists as one, sorted, without paths a directory in it already covers.
 *
 * @param {string[]} a
 * @param {string[]} b
 */
export function mergeRoots(a, b) {
  const all = [...new Set([...a, ...b])]
  return all.filter(p => !all.some(r => r !== p && r.endsWith('/') && p.startsWith(r))).sort()
}
