// The archive block: the hard block on agents touching the archive, the
// human's store of superseded docs at a repository's root (ADR 0008).
// Moving a file into it, and making the directories that needs, is the one
// thing allowed.
//
// It reads command text, so it is a seatbelt, not a sandbox: a path built
// from variables or by a script can get past it.

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { CASE_INSENSITIVE_FS, real, untilde } from './paths.mjs'
import { cdTarget, gitParts, operandIndexes, parseCommands, shortFlags, withCwds } from './shell.mjs'

/** @typedef {import('./shell.mjs').SimpleCommand} SimpleCommand */

const DENY_SUFFIX = ' The archive is managed by the human alone; agents may only move files into it (ADR 0008).'
const EXCLUDE_HINT = "rg -g '!archive', grep --exclude-dir=archive, git … -- ':!archive', find … -name archive -prune"

// --- where the archive is ----------------------------------------------------

const isArchiveName = (/** @type {string} */ n) => (CASE_INSENSITIVE_FS ? n.toLowerCase() : n) === 'archive'
const isRepoRoot = (/** @type {string} */ dir) => existsSync(join(dir, '.git'))
const isBareRepo = (/** @type {string} */ dir) => ['HEAD', 'objects', 'refs'].every(f => existsSync(join(dir, f)))

// Directories an earlier command on the same line makes into a repository
// (a clone, a worktree). Reset for every tool call.
/** @type {Set<string>} */
const fresh = new Set()

/** @param {string} dir @returns {string | null} the repository root at or above `dir` */
function repoRoot(dir) {
  for (let d = dir; ; d = dirname(d)) {
    if (isRepoRoot(d) || fresh.has(d)) return d
    if (dirname(d) === d) return null
  }
}

/** @param {string} p an absolute path @returns {boolean} whether it is an archive or inside one */
function inArchive(p) {
  for (const q of new Set([p, real(p)])) {
    for (let d = q; dirname(d) !== d; d = dirname(d)) {
      if (isArchiveName(basename(d)) && (isRepoRoot(dirname(d)) || fresh.has(dirname(d)))) return true
    }
  }
  return false
}

/** @param {string} p an absolute path @returns {boolean} whether it is an archive itself */
const isArchive = p => [p, real(p)].some(q => isArchiveName(basename(q)) && (isRepoRoot(dirname(q)) || fresh.has(dirname(q))))

/**
 * The repositories whose archive a recursive walk of `dir` reaches, or null
 * when that cannot be told: a walk from outside any repository may reach
 * the repositories below it, and those are looked for only so far.
 *
 * @param {string} dir
 * @returns {string[] | null}
 */
function archivesUnder(dir) {
  const d = real(dir)
  const prefix = d.endsWith(sep) ? d : d + sep
  const root = repoRoot(d)
  if (root) return existsSync(join(root, 'archive')) && join(root, 'archive', sep).startsWith(prefix) ? [root] : []
  const found = []
  let budget = 2000
  for (let level = [d], depth = 0; level.length; depth++) {
    /** @type {string[]} */
    const next = []
    for (const x of level) {
      if (--budget < 0) return null
      if (isRepoRoot(x)) {
        if (existsSync(join(x, 'archive'))) found.push(x)
        continue
      }
      let entries = /** @type {import('node:fs').Dirent[]} */ ([])
      try {
        entries = readdirSync(x, { withFileTypes: true })
      } catch {}
      for (const e of entries) if (e.isDirectory()) next.push(join(x, e.name))
    }
    if (next.length && depth >= 4) return null
    level = next
  }
  return found
}

// --- paths, globs included ----------------------------------------------------

const GLOB = /[*?[(]/
/** @type {Record<string, string>} */
const CLASSES = {
  alpha: 'a-zA-Z', digit: '0-9', alnum: 'a-zA-Z0-9', upper: 'A-Z', lower: 'a-z',
  space: '\\s', xdigit: '0-9A-Fa-f', word: '\\w', punct: '!-\\/:-@\\[-`{-~',
}

/**
 * One path segment of a shell glob, zsh's `(a|b)` included, as a RegExp.
 * A pattern the shell cannot read matches only itself.
 *
 * @param {string} seg
 * @param {boolean} [icase]
 */
function globRegex(seg, icase = CASE_INSENSITIVE_FS) {
  let re = ''
  for (let i = 0; i < seg.length; i++) {
    const c = /** @type {string} */ (seg[i])
    if (c === '*') re += '.*'
    else if (c === '?') re += '.'
    else if (c === '(') re += '(?:'
    else if (c === '|' || c === ')') re += c
    else if (c === '[') {
      let j = i + 1
      let body = seg[j] === '!' || seg[j] === '^' ? '^' : ''
      if (body) j++
      if (seg[j] === ']') {
        body += '\\]'
        j++
      }
      for (; j < seg.length && seg[j] !== ']'; j++) {
        const cls = /^\[:(\w+):\]/.exec(seg.slice(j))
        if (cls) {
          body += CLASSES[/** @type {string} */ (cls[1])] ?? ''
          j += cls[0].length - 1
        } else body += seg[j] === '\\' ? '\\\\' : seg[j]
      }
      if (j >= seg.length) re += '\\['
      else {
        re += `[${body}]`
        i = j
      }
    } else re += c.replace(/[.+^${}\\]/g, '\\$&')
  }
  try {
    return new RegExp(`^${re}$`, icase ? 'i' : '')
  } catch {
    return new RegExp(`^${seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
  }
}

/**
 * How a word with glob characters, expanded against the file system the
 * way the shell will, relates to the archive (see `pathKind`).
 *
 * @param {string} start the directory a relative word starts from
 * @param {string} word
 * @returns {'archive' | 'inside' | null}
 */
function globKind(start, word) {
  let dirs = [isAbsolute(word) ? sep : start]
  for (const seg of word.split('/')) {
    if (seg === '' || seg === '.') continue
    if (dirs.some(d => inArchive(d) && !isArchive(d))) return 'inside'
    if (dirs.some(isArchive)) return 'inside' // a segment follows the archive
    if (seg === '..') dirs = dirs.map(d => dirname(d))
    else if (seg.includes('**')) return dirs.some(d => archivesUnder(d)?.length !== 0) ? 'inside' : null
    else if (!GLOB.test(seg)) dirs = dirs.map(d => join(d, seg))
    else {
      const re = globRegex(seg)
      /** @type {string[]} */
      const next = []
      for (const d of dirs) {
        let names = /** @type {string[]} */ ([])
        try {
          names = readdirSync(d)
        } catch {}
        for (const n of names) if (re.test(n)) next.push(join(d, n))
        if (next.length > 5000) return 'inside'
      }
      dirs = next
    }
  }
  if (dirs.some(d => inArchive(d) && !isArchive(d))) return 'inside'
  return dirs.some(isArchive) ? 'archive' : null
}

/**
 * How a word relates to the archive, read as a path from each directory
 * the command may run in: 'archive' when it names an archive itself,
 * 'inside' when it reaches into one, or null.
 *
 * @param {string} word
 * @param {string[]} cwds
 * @returns {'archive' | 'inside' | null}
 */
function pathKind(word, cwds) {
  if (word === '' || word.includes('\n') || /^[A-Za-z][\w+.-]*:\/\//.test(word)) return null
  /** @type {'archive' | 'inside' | null} */
  let kind = null
  for (const cwd of cwds) {
    const w = untilde(word, cwd)
    const k = GLOB.test(w) ? globKind(cwd, w) : isArchive(resolve(cwd, w)) ? 'archive' : inArchive(resolve(cwd, w)) ? 'inside' : null
    if (k === 'inside') return k
    kind ??= k
  }
  return kind
}

// --- exclusions -------------------------------------------------------------------

/** @param {string} pattern @returns {string[]} the alternatives of its `{a,b}` groups */
const braces = pattern => parseCommands(`: ${pattern.replace(/[\s'"\\$`;&|<>()]/g, '\\$&')}`)[0]?.args ?? [pattern]

/**
 * Whether a gitignore-style glob (rg's `-g`, the Grep tool's `glob`) matches
 * the archive directory itself, which is what lets rg walk into it.
 *
 * @param {string} glob
 * @param {boolean} icase
 */
function globMatchesArchive(glob, icase) {
  return braces(glob).some(alt => {
    let a = alt.replace(/^\//, '').replace(/\/$/, '')
    while (a.startsWith('**/')) a = a.slice(3)
    return !a.includes('/') && globRegex(a.replace(/\*\*/g, '*'), icase).test('archive')
  })
}

/**
 * Whether rg's globs, in order, leave the archive out (true), let it back in
 * (false), or say nothing about it (null). The last glob that matches the
 * archive wins; `!archive/**` leaves out everything inside it.
 *
 * @param {{ glob: string, icase: boolean }[]} globs
 * @returns {boolean | null}
 */
function rgGlobsExclude(globs) {
  /** @type {boolean | null} */
  let out = null
  for (const { glob, icase } of globs) {
    const neg = glob.startsWith('!')
    const g = neg ? glob.slice(1) : glob
    if (globMatchesArchive(g, icase) || (neg && braces(g).some(a => /^\/?archive\/\*{1,2}$/.test(a)))) out = neg
  }
  return out
}

/**
 * Whether a repository's root ignore files, as rg, fd and ag read them,
 * leave its archive out: one lists `/archive/`, and none takes it back.
 *
 * @param {string[]} names
 * @param {string} root
 */
function ignoredByFiles(names, root) {
  const lines = names.flatMap(n => {
    try {
      return readFileSync(join(root, n), 'utf8').split('\n').map(l => l.trim())
    } catch {
      return []
    }
  })
  return lines.some(l => /^\/?archive\/?(?:\*\*)?$/.test(l)) && !lines.some(l => l.startsWith('!') && /archive|^!\*/.test(l))
}

// --- commands other than git ------------------------------------------------------

/**
 * How the archive block reads a command:
 * - `letters`, `longs`: the options that take a value;
 * - `pathValues`: those of them whose value is a path;
 * - `pattern`: its first operand is a pattern, unless an option matching `pattern.unless` is given;
 * - `walks`: when it walks directories; `roots`: which operands it walks (all, by default);
 * - `fromCwd`: whether it walks the working directory when it names none;
 * - `shallow`: options whose value, at 1 or less, keeps it out of subdirectories;
 * - `namesOnly`: when naming the archive itself does not read inside it (`ls -d`);
 * - `excludes`: the options, and the values of them, that leave the archive out;
 * - `ignoreFiles`, `ignoreOff`: the ignore files it honours, and the options that stop that.
 *
 * @typedef {{
 *   letters?: string, longs?: string[], pathValues?: string[], pattern?: { unless: RegExp },
 *   walks?: (args: string[]) => boolean, roots?: (ops: string[]) => string[], fromCwd?: boolean,
 *   shallow?: string[], namesOnly?: (args: string[]) => boolean,
 *   excludes?: Record<string, RegExp>, ignoreFiles?: string[], ignoreOff?: RegExp,
 * }} Tool
 */

/** @param {string[]} args @param {string} letter @param {string} [long] */
const has = (args, letter, long) =>
  shortFlags(args).has(letter) || (long !== undefined && args.some(a => a === long || a.startsWith(`${long}=`)))
const always = () => true
const allButLast = (/** @type {string[]} */ ops) => ops.slice(0, -1)
const NAMED_ARCHIVE = /^archive$/

/** @type {Tool} */
const GREP = {
  letters: 'efmABCdD',
  longs: ['--regexp', '--file', '--max-count', '--context', '--after-context', '--before-context', '--exclude', '--exclude-dir',
    '--include', '--exclude-from', '--label', '--binary-files', '--devices', '--directories', '--color', '--colour'],
  pathValues: ['-f', '--file', '--exclude-from'],
  pattern: { unless: /^(?:-e|-f|--regexp|--file)$/ },
  walks: args => has(args, 'r', '--recursive') || has(args, 'R', '--dereference-recursive') ||
    args.some((a, i) => /^(?:-d|--directories)$/.test(a) ? args[i + 1] === 'recurse' : /^(?:-drecurse|--directories=recurse)$/.test(a)),
  fromCwd: true,
  excludes: { '--exclude-dir': NAMED_ARCHIVE },
}
/** @type {Tool} */
const FD = {
  letters: 'eEtdjScxX',
  longs: ['--exclude', '--extension', '--type', '--max-depth', '--min-depth', '--exact-depth', '--threads', '--size', '--changed-within',
    '--changed-before', '--owner', '--exec', '--exec-batch', '--base-directory', '--search-path', '--color', '--max-results', '--ignore-file'],
  pathValues: ['--base-directory', '--search-path', '--ignore-file'],
  pattern: { unless: /^$/ },
  walks: always,
  fromCwd: true,
  shallow: ['-d', '--max-depth', '--exact-depth'],
  excludes: { '-E': NAMED_ARCHIVE, '--exclude': NAMED_ARCHIVE },
  ignoreFiles: ['.ignore', '.fdignore'],
  ignoreOff: /^(?:-[A-Za-z]*[uIL][A-Za-z]*|--no-ignore|--unrestricted|--follow)$/,
}
/** @type {Tool} */
const TAR = {
  letters: 'fCTXbHKLNV',
  longs: ['--file', '--directory', '--files-from', '--exclude-from', '--exclude', '--format', '--transform'],
  pathValues: ['-f', '-C', '-T', '-X', '--file', '--directory', '--files-from', '--exclude-from'],
  walks: args => has(args, 'c', '--create') || has(args, 'r', '--append') || has(args, 'u', '--update'),
  excludes: { '--exclude': NAMED_ARCHIVE },
}

/** @type {Record<string, Tool>} */
const TOOLS = {
  rg: {
    letters: 'efgtTmABCrjMdE',
    longs: ['--regexp', '--file', '--glob', '--iglob', '--type', '--type-not', '--max-count', '--context', '--after-context',
      '--before-context', '--replace', '--threads', '--max-columns', '--max-depth', '--sort', '--sortr', '--type-add', '--type-clear',
      '--encoding', '--engine', '--colors', '--context-separator', '--field-match-separator', '--field-context-separator',
      '--path-separator', '--pre', '--pre-glob', '--max-filesize', '--dfa-size-limit', '--regex-size-limit', '--ignore-file',
      '--color', '--hyperlink-format'],
    pathValues: ['-f', '--file', '--ignore-file'],
    pattern: { unless: /^(?:-e|-f|--regexp|--file|--files|--type-list)$/ },
    walks: always,
    fromCwd: true,
    shallow: ['-d', '--max-depth'],
    ignoreFiles: ['.ignore', '.rgignore'],
    ignoreOff: /^(?:-[A-Za-z]*[uL][A-Za-z]*|--no-ignore|--no-ignore-dot|--unrestricted|--follow)$/,
  },
  grep: GREP,
  egrep: GREP,
  fgrep: GREP,
  rgrep: { ...GREP, walks: always },
  ag: {
    letters: 'ABCGgm',
    longs: ['--ignore', '--ignore-dir', '--file-search-regex', '--depth', '--context', '--after', '--before', '--max-count', '--path-to-ignore'],
    pattern: { unless: /^-g$/ },
    walks: always,
    fromCwd: true,
    excludes: { '--ignore': NAMED_ARCHIVE, '--ignore-dir': NAMED_ARCHIVE },
    ignoreFiles: ['.ignore'],
    ignoreOff: /^(?:-[A-Za-z]*[uUf][A-Za-z]*|--unrestricted|--skip-vcs-ignores|--follow)$/,
  },
  ack: {
    letters: 'ABCm',
    longs: ['--ignore-dir', '--ignore-file', '--type', '--context', '--max-count'],
    pattern: { unless: /^-f$/ },
    walks: always,
    fromCwd: true,
    excludes: { '--ignore-dir': NAMED_ARCHIVE },
  },
  fd: FD,
  fdfind: FD,
  find: { walks: always, fromCwd: true, shallow: ['-maxdepth'] },
  tree: {
    letters: 'LPIoHT',
    pathValues: ['-o'],
    walks: always,
    fromCwd: true,
    shallow: ['-L'],
    excludes: { '-I': /^(?:[^|]*\|)*archive(?:\|[^|]*)*$/ },
  },
  du: {
    letters: 'dBtI',
    longs: ['--max-depth', '--block-size', '--threshold', '--exclude'],
    walks: args => !has(args, 's', '--summarize'),
    fromCwd: true,
    shallow: ['-d', '--max-depth'],
    namesOnly: always,
    excludes: { '--exclude': NAMED_ARCHIVE, '-I': NAMED_ARCHIVE },
  },
  ls: {
    letters: 'Tw',
    longs: ['--ignore', '--hide', '--format', '--sort', '--time-style', '--width', '--tabsize', '--color', '--block-size',
      '--quoting-style', '--indicator-style', '--time'],
    walks: args => has(args, 'R', '--recursive'),
    fromCwd: true,
    namesOnly: args => has(args, 'd', '--directory'),
    excludes: { '--ignore': NAMED_ARCHIVE, '--hide': NAMED_ARCHIVE },
  },
  stat: { namesOnly: always },
  test: { namesOnly: always },
  '[': { namesOnly: always },
  cp: {
    letters: 'tS',
    longs: ['--target-directory', '--suffix'],
    pathValues: ['-t', '--target-directory'],
    walks: args => has(args, 'r', '--recursive') || has(args, 'R') || has(args, 'a', '--archive'),
    roots: allButLast,
  },
  rsync: {
    letters: 'eTfB',
    longs: ['--exclude', '--include', '--filter', '--exclude-from', '--include-from', '--rsh', '--temp-dir', '--files-from'],
    pathValues: ['--exclude-from', '--include-from', '--files-from'],
    walks: args => has(args, 'r', '--recursive') || has(args, 'a', '--archive'),
    roots: allButLast,
    excludes: { '--exclude': /^archive\/?$/ },
  },
  scp: { letters: 'cFiJlLoPS', walks: args => has(args, 'r'), roots: allButLast },
  ditto: { walks: always, roots: allButLast },
  tar: TAR,
  bsdtar: TAR,
  zip: { letters: 'bnt', walks: args => has(args, 'r', '--recurse-paths') || has(args, 'R'), roots: ops => ops.slice(1) },
  pax: { letters: 'fsx', pathValues: ['-f'], walks: args => has(args, 'w'), fromCwd: true },
  '7z': { walks: args => args[0] === 'a', roots: ops => ops.slice(2) },
  diff: {
    letters: 'xX',
    longs: ['--exclude', '--exclude-from'],
    walks: args => has(args, 'r', '--recursive'),
    excludes: { '-x': NAMED_ARCHIVE, '--exclude': NAMED_ARCHIVE },
  },
  node: {
    longs: ['--test-name-pattern', '--test-skip-pattern', '--eval', '--print', '--require', '--import', '--loader'],
    pathValues: ['--require', '--import', '--loader'],
  },
}

// Commands whose words are text, never paths (gh's file options aside).
const TEXT_ONLY = new Set(['echo', 'printf', 'true', 'false', ':'])
const GH_FILE_OPTIONS = /^(?:--body-file|-F|--input|--file|--template)$/
// Commands whose operands name scripts, targets or images more often than paths: only a path inside the archive counts.
const RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'make', 'just', 'cargo', 'docker', 'go', 'kubectl'])
// Interpreters whose code, given on the command line, may name a file in the archive.
const INTERPRETERS = /^(?:node|deno|bun|python[\d.]*|ruby|perl|php|osascript|lua|Rscript|awk|gawk|jq)$/

/**
 * The options in `args` that take a value, with the value and where it is.
 *
 * @param {string[]} args
 * @param {{ letters?: string, longs?: string[] }} tool
 * @returns {{ opt: string, value: string, index: number }[]}
 */
function optionValues(args, tool) {
  const letters = tool.letters ?? ''
  const longs = tool.longs ?? []
  const out = []
  for (let i = 0; i < args.length; i++) {
    const a = /** @type {string} */ (args[i])
    if (a === '--') break
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq > 0) out.push({ opt: a.slice(0, eq), value: a.slice(eq + 1), index: i })
      else if (longs.includes(a)) out.push({ opt: a, value: args[i + 1] ?? '', index: ++i })
    } else if (/^-[A-Za-z0-9]/.test(a)) {
      for (let j = 1; j < a.length; j++) {
        const ch = /** @type {string} */ (a[j])
        if (!letters.includes(ch)) continue
        if (j < a.length - 1) out.push({ opt: `-${ch}`, value: a.slice(j + 1), index: i })
        else out.push({ opt: `-${ch}`, value: args[i + 1] ?? '', index: ++i })
        break
      }
    }
  }
  return out
}

/**
 * Whether `find`'s expression prunes the archive before it walks in: a
 * `-name archive`, or a `-path` naming it under the one root, followed by
 * `-prune` directly or after a `\( … -o … \)` group. `-delete` and `-depth`
 * turn pruning off.
 *
 * @param {string[]} args
 * @param {string[]} roots
 */
function findPrunes(args, roots) {
  if (args.some(a => /^-(?:delete|d|depth)$/.test(a)) || roots.length > 1) return false
  const root = (roots[0] ?? '.').replace(/\/+$/, '') || '/'
  const names = new Set([`${root}/archive`, '*/archive'])
  const test = (/** @type {number} */ i) =>
    /^-i?name$/.test(args[i] ?? '') ? args[i + 1] === 'archive' : /^-i?(?:path|wholename)$/.test(args[i] ?? '') && names.has(args[i + 1] ?? '')
  for (let i = 0; i < args.length; i++) {
    if (!test(i)) continue
    let j = i + 2
    while (/^-(?:o|or)$/.test(args[j] ?? '') && /^-i?(?:name|path|wholename)$/.test(args[j + 1] ?? '')) j += 3
    if (args[j] === '-prune' || (args[j] === ')' && args[j + 1] === '-prune')) return true
  }
  return false
}

/**
 * Whether a walking command's options leave the archive of the repository
 * at `root` out of its walk.
 *
 * @param {string} name
 * @param {Tool} tool
 * @param {string[]} args
 * @param {string[]} roots the directories it walks, as written
 * @param {string} root
 */
function excludesArchive(name, tool, args, roots, root) {
  const values = optionValues(args, tool)
  if (values.some(v => tool.excludes?.[v.opt]?.test(v.value))) return true
  if (name === 'find') return findPrunes(args, roots)
  if (name === 'zip') {
    const x = args.indexOf('-x')
    return x >= 0 && args.slice(x + 1).includes('archive/*') && roots.every(r => r === '.' || r === './')
  }
  if (name === '7z') return args.some(a => /^-xr?!archive$/.test(a))
  if (name !== 'rg' && !tool.ignoreFiles) return false
  const icase = (/** @type {string} */ opt) => opt === '--iglob' || args.includes('--glob-case-insensitive')
  const globs = name === 'rg' ? values.filter(v => /^(?:-g|--glob|--iglob)$/.test(v.opt)).map(v => ({ glob: v.value, icase: icase(v.opt) })) : []
  const byGlobs = rgGlobsExclude(globs)
  if (byGlobs !== null) return byGlobs
  return !!tool.ignoreFiles && !args.some(a => tool.ignoreOff?.test(a)) && ignoredByFiles(tool.ignoreFiles, root)
}

/** @param {string} what */
const walkMessage = what => `\`${what}\` would walk into the archive. Leave it out (${EXCLUDE_HINT}) or name a subdirectory.`
const OUTSIDE = 'walks a directory outside any repository, which may hold other repositories and their archives. ' +
  'Name a directory inside a repository.'

/**
 * Why a walk of `roots` reaches an archive that `excluded` does not leave
 * out, or null.
 *
 * @param {string} what the command, for the message
 * @param {string[]} roots
 * @param {string[]} cwds
 * @param {(root: string) => boolean} excluded
 * @param {string} [reaches] the message when it reaches one
 */
function walkTouches(what, roots, cwds, excluded, reaches = walkMessage(what)) {
  for (const cwd of cwds) {
    for (const r of roots) {
      const reached = archivesUnder(resolve(cwd, untilde(r, cwd)))
      if (reached === null) return `\`${what}\` ${OUTSIDE}`
      if (reached.some(root => !excluded(root))) return reaches
    }
  }
  return null
}

/**
 * Why one simple command, other than git, touches the archive, or null.
 *
 * @param {SimpleCommand} c
 * @param {string[]} cwds
 */
function commandTouches(c, cwds) {
  const { name } = c
  if (TEXT_ONLY.has(name) || name === 'mkdir') return null
  // tar's old style: a first word of option letters without the dash (`tar czf x.tgz .`).
  const args = TOOLS[name] === TAR && /^[A-Za-z]+$/.test(c.args[0] ?? '') ? [`-${c.args[0]}`, ...c.args.slice(1)] : c.args
  if (name === 'gh') {
    for (let i = 0; i < args.length; i++) {
      if (!GH_FILE_OPTIONS.test(/** @type {string} */ (args[i]))) continue
      const v = (args[i + 1] ?? '').replace(/^@/, '')
      if (pathKind(v, cwds)) return `\`gh\` reads ${v}, in the archive.`
    }
    return null
  }
  if (name === 'mv' && movesIn(args, 'tS', cwds)) return null
  if (INTERPRETERS.test(name)) {
    for (const a of args) {
      for (const [m] of a.matchAll(/[\w.~/-]*archive\/[\w./-]*/g)) {
        if (pathKind(m, cwds) === 'inside') return `\`${name}\` names ${m}, in the archive.`
      }
    }
  }

  const tool = TOOLS[name] ?? {}
  const values = optionValues(args, tool)
  const valueAt = new Map(values.map(v => [v.index, v]))
  let ops = operandIndexes(args, tool.letters, tool.longs)
  const unless = tool.pattern?.unless
  if (unless && ops.length && !args.some(a => unless.test(a)) && !values.some(v => unless.test(v.opt))) ops = ops.slice(1)
  if (name === 'zip') {
    const x = args.indexOf('-x')
    if (x >= 0) ops = ops.filter(i => i < x)
  }
  /** @type {string[]} */
  let findRoots = []
  if (name === 'find') {
    const end = args.findIndex(a => a.startsWith('-') || a === '(' || a === '!')
    findRoots = (end < 0 ? args : args.slice(0, end)).filter(a => a !== '--')
    // In the expression, a word after a test or action is its value; the rest may be paths (`-exec cat archive/x`).
    const isValue = (/** @type {number} */ i) => end >= 0 && i >= end && /^-/.test(args[i - 1] ?? '')
    ops = args.map((_, i) => i).filter(i => !isValue(i) && !/^[-()!;+]/.test(/** @type {string} */ (args[i])) && args[i] !== '{}')
  }

  // Operands: a path inside the archive counts; so does one naming it, unless the
  // command does not read what it names, or the word may be an option's value.
  const namesOnly = tool.namesOnly?.(args) ?? false
  for (const i of ops) {
    const a = /** @type {string} */ (args[i])
    const kind = pathKind(a, cwds)
    if (kind === 'inside') return `\`${name}\` names ${a}, in the archive.`
    const maybeValue = !TOOLS[name] && /^-/.test(args[i - 1] ?? '') && !(args[i - 1] ?? '').includes('=')
    if (kind === 'archive' && !namesOnly && !RUNNERS.has(name) && !maybeValue) return `\`${name}\` names ${a}, the archive.`
  }
  for (const v of values) {
    const kind = pathKind(v.value, cwds)
    // The value of an option the table knows counts if it is a path; of one it does not, if it reaches inside.
    const known = tool.longs?.includes(v.opt) || (v.opt.length === 2 && tool.letters?.includes(v.opt.charAt(1)))
    if (kind && (tool.pathValues?.includes(v.opt) || (kind === 'inside' && !known))) return `\`${name}\` names ${v.value}, in the archive.`
  }
  // Values glued to options we do not know (`-oarchive/x`, `if=archive/x`).
  for (let i = 0; i < args.length; i++) {
    const a = /** @type {string} */ (args[i])
    if (valueAt.has(i)) continue
    const glued = /^-[A-Za-z]./.test(a) && !a.startsWith('--') ? a.slice(2) : /^[A-Za-z_]+=/.test(a) ? a.slice(a.indexOf('=') + 1) : null
    if (glued && pathKind(glued, cwds) === 'inside') return `\`${name}\` names ${glued}, in the archive.`
  }

  if (!tool.walks?.(args)) return null
  if (values.some(v => tool.shallow?.includes(v.opt) && /^\d+$/.test(v.value) && Number(v.value) <= 1)) return null
  if (name === 'find' && args.some((a, i) => a === '-maxdepth' && Number(args[i + 1]) <= 1)) return null
  const named = name === 'find' ? findRoots : (tool.roots ?? (x => x))(ops.map(i => /** @type {string} */ (args[i])))
  const roots = named.length ? named : tool.fromCwd ? ['.'] : []
  return walkTouches(name, roots, cwds, root => excludesArchive(name, tool, args, roots, root))
}

/**
 * Whether `mv`-style arguments move only things outside the archive into
 * it, without overwriting anything there.
 *
 * @param {string[]} args
 * @param {string} letters the options that take a value
 * @param {string[]} cwds
 */
function movesIn(args, letters, cwds) {
  const ops = operandIndexes(args, letters, ['--target-directory', '--suffix']).map(i => /** @type {string} */ (args[i]))
  const t = args.findIndex(a => a === '-t' || a.startsWith('--target-directory'))
  const dest = t < 0 ? ops.pop() : args[t]?.includes('=') ? args[t]?.slice(args[t].indexOf('=') + 1) : args[t + 1]
  const sources = ops.filter(o => o !== dest)
  if (dest === undefined || pathKind(dest, cwds) === null || !sources.length) return false
  return cwds.every(cwd => {
    const d = resolve(cwd, untilde(dest, cwd))
    const intoDir = t >= 0 || sources.length > 1 || dest.endsWith('/') || isDir(d)
    return sources.every(s => {
      const src = resolve(cwd, untilde(s, cwd))
      return !GLOB.test(s) && !inArchive(src) && archivesUnder(src)?.length === 0 && !existsSync(intoDir ? join(d, basename(src)) : d)
    })
  })
}

/** @param {string} p */
function isDir(p) {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

// --- git ----------------------------------------------------------------------------

/**
 * A pathspec as git reads it: whether it excludes, and the path relative to
 * the repository root.
 *
 * @param {string} spec
 * @param {string} cwd
 * @param {string} root
 */
function pathspec(spec, cwd, root) {
  const m = /^:(?:\(([^)]*)\)|([!^/]*))(.*)$/s.exec(spec)
  const magic = m ? (m[1] ?? '').split(',').concat((m[2] ?? '').split('')) : []
  const rest = m ? /** @type {string} */ (m[3]) : spec
  const top = magic.some(x => x === 'top' || x === '/')
  return {
    exclude: magic.some(x => x === 'exclude' || x === '!' || x === '^'),
    rel: relative(root, top ? join(root, rest) : resolve(cwd, rest)).split(sep).join('/'),
    literal: magic.includes('literal'),
    icase: magic.includes('icase'),
  }
}

/** @typedef {ReturnType<typeof pathspec>} Pathspec */

/** @param {Pathspec} p @returns {boolean} whether a pathspec can match a path in the archive */
function specReaches(p) {
  if (p.rel === '' || p.rel === '.') return true
  if (p.rel.startsWith('..')) return false
  const lit = p.literal ? p.rel : /** @type {string} */ (p.rel.split(/[*?[]/)[0])
  const l = p.icase ? lit.toLowerCase() : lit
  return 'archive/'.startsWith(l) || l.startsWith('archive/') || l === 'archive'
}

/** @param {Pathspec} p @returns {boolean} whether a pathspec names the archive or a path in it */
const specNamesArchive = p => (p.icase ? p.rel.toLowerCase() : p.rel).split('/')[0] === 'archive'
/** @param {Pathspec} p @returns {boolean} whether an exclude pathspec leaves the whole archive out */
const specExcludesArchive = p => p.exclude && /^archive(?:\/(?:\*{1,2})?)?$/.test(p.rel)

/**
 * Whether the history a git command prints touches the archive: asks git
 * for every path it would show. (A pathspec would change which commits
 * options like `-1` pick, so the paths are filtered here instead.)
 *
 * @param {string} sub
 * @param {string[]} opts the arguments before `--`
 * @param {string} cwd
 * @returns {boolean}
 */
function historyTouches(sub, opts, cwd) {
  const diff = /^diff/.test(sub)
  const r = spawnSync('git', ['-C', cwd, sub === 'difftool' ? 'diff' : sub, ...opts, '--name-only', '--no-renames', '--no-ext-diff',
    ...(sub === 'diff' || sub === 'difftool' ? ['--no-relative'] : []), ...(diff ? [] : ['--format='])],
  { encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 * 1024 })
  // When git cannot say, assume the worst.
  if (r.status !== 0) return true
  return r.stdout.split('\n').some(l => l === 'archive' || l.startsWith('archive/'))
}

// Options that make log, reflog or show print what changed, not only messages.
const SHOWS_CHANGES = new RegExp(
  '^(?:-[puWmc]|-U\\d*|-L.*|--patch.*|--stat.*|--numstat|--shortstat|--name-only|--name-status|--raw|--summary|--compact-summary|' +
    '--dirstat.*|--word-diff.*|--color-words.*|--cc|--binary|--function-context|--remerge-diff|--diff-merges.*|--full-diff)$',
)

/**
 * Per git subcommand: the options that take a value, those of them whose
 * value is a path, and what its operands are:
 * - 'history': revisions and pathspecs, printing what changed;
 * - 'tree': a tree (by default the working tree) and pathspecs, walked;
 * - 'dump': revisions whose whole content it writes out;
 * - 'paths': pathspecs it reads or writes;
 * - 'index': pathspecs it stages or commits, which never shows content.
 *
 * @type {Record<string, { letters?: string, longs?: string[], pathValues?: string[], kind: 'history' | 'tree' | 'dump' | 'paths' | 'index' }>}
 */
const GIT = {
  log: {
    letters: 'nSGL',
    longs: ['--grep', '--author', '--committer', '--since', '--until', '--after', '--before', '--format', '--pretty', '--date',
      '--max-count', '--skip', '--encoding'],
    kind: 'history',
  },
  reflog: { letters: 'n', longs: ['--format', '--pretty', '--date', '--max-count'], kind: 'history' },
  show: { letters: 'nSG', longs: ['--format', '--pretty', '--date', '--encoding'], kind: 'history' },
  whatchanged: { letters: 'n', longs: ['--format', '--pretty'], kind: 'history' },
  diff: {
    letters: 'SGO',
    longs: ['--diff-filter', '--relative', '--src-prefix', '--dst-prefix', '--output'],
    pathValues: ['--output', '-O'],
    kind: 'history',
  },
  difftool: { letters: 'xt', longs: ['--extcmd', '--tool'], kind: 'history' },
  'diff-tree': { letters: 'SG', kind: 'history' },
  'diff-index': { letters: 'SG', kind: 'history' },
  'diff-files': { letters: 'SG', kind: 'history' },
  grep: { letters: 'efmABCO', longs: ['--max-count', '--context', '--max-depth', '--threads'], pathValues: ['-f'], kind: 'tree' },
  'ls-files': { letters: 'xX', longs: ['--exclude', '--exclude-from', '--format'], kind: 'tree' },
  'ls-tree': { longs: ['--format', '--abbrev'], kind: 'tree' },
  archive: { letters: 'o', longs: ['--output', '--format', '--prefix', '--remote', '--exec'], pathValues: ['-o', '--output'], kind: 'tree' },
  'format-patch': { letters: 'ovn', longs: ['--output-directory', '--subject-prefix', '--in-reply-to', '--to', '--cc', '--from'], kind: 'dump' },
  'fast-export': { kind: 'dump' },
  'range-diff': { kind: 'dump' },
  bundle: { kind: 'dump' },
  add: { kind: 'index' },
  commit: {
    letters: 'mcCFt',
    longs: ['--message', '--reuse-message', '--reedit-message', '--file', '--template', '--author', '--date', '--fixup', '--squash',
      '--trailer', '--cleanup'],
    pathValues: ['-F', '-t', '--file', '--template'],
    kind: 'index',
  },
  reset: { kind: 'index' },
  restore: { letters: 's', longs: ['--source'], kind: 'paths' },
  checkout: { letters: 'bB', longs: ['--orphan'], kind: 'paths' },
  rm: { kind: 'paths' },
  blame: { letters: 'L', kind: 'paths' },
  annotate: { kind: 'paths' },
  'cat-file': { kind: 'paths' },
  'checkout-index': { longs: ['--prefix'], kind: 'paths' },
  apply: { kind: 'paths' },
  am: { kind: 'paths' },
  stash: { letters: 'm', longs: ['--message'], kind: 'paths' },
}

// Subcommands that read objects named as <rev>:<path>.
const READS_OBJECTS = new Set(['show', 'cat-file', 'rev-parse', 'grep', 'ls-tree', 'archive', 'diff', 'difftool', 'log', 'whatchanged',
  'blame', 'annotate', 'diff-tree', 'checkout', 'restore'])

/**
 * Where a git command works: the repositories, by root, whose archive it
 * may reach. A bare repository, or one an earlier command on the line
 * makes, may hold an archive in its history.
 *
 * @param {string[]} here
 */
function gitRoots(here) {
  return here.flatMap(cwd => {
    const root = repoRoot(real(cwd))
    if (root) return existsSync(join(root, 'archive')) || fresh.has(root) ? [{ cwd, root }] : []
    return isBareRepo(cwd) ? [{ cwd, root: cwd }] : []
  })
}

/**
 * Notes the directory a `git clone` or `git worktree add` makes, so later
 * commands on the line see the archive it will hold.
 *
 * @param {string | undefined} sub
 * @param {string[]} rest
 * @param {string[]} here
 */
function noteFresh(sub, rest, here) {
  let dest
  if (sub === 'clone') {
    const ops = operandIndexes(rest, 'obucj', ['--origin', '--branch', '--upload-pack', '--config', '--depth', '--reference', '--template',
      '--separate-git-dir', '--shallow-since', '--shallow-exclude', '--filter', '--jobs', '--bundle-uri']).map(i => /** @type {string} */ (rest[i]))
    dest = ops[1] ?? basename((ops[0] ?? '').replace(/\/+$/, '')).replace(/\.git$/, '')
  } else if (sub === 'worktree' && rest[0] === 'add') {
    dest = operandIndexes(rest.slice(1), 'bB', ['--reason']).map(i => rest[i + 1])[0]
  }
  if (!dest) return
  for (const cwd of here) {
    const d = resolve(cwd, untilde(dest, cwd))
    fresh.add(d).add(real(d))
  }
}

/**
 * Why a git command touches the archive, or null.
 *
 * @param {string[]} gitArgs the arguments after `git`
 * @param {string[]} cwds
 */
function gitTouches(gitArgs, cwds) {
  const { dirs, relocated, sub = '', rest } = gitParts(gitArgs)
  for (const d of dirs) if (pathKind(d, cwds)) return `\`git -C ${d}\` works in the archive.`
  const here = cwds.map(c => dirs.reduce((acc, d) => resolve(acc, untilde(d, acc)), c))
  noteFresh(sub, rest, here)
  const targets = gitRoots(here)
  if (!targets.length) return null
  if (relocated) return '`git --git-dir/--work-tree` points git elsewhere, which can copy the archive out.'
  if (sub === 'cat-file' && rest.some(a => a.startsWith('--batch'))) return '`git cat-file --batch` can read every object, the archive included.'
  if (sub === 'rev-list' && rest.includes('--objects')) return '`git rev-list --objects` lists every object, the archive included.'
  if (sub === 'checkout-index' && has(rest, 'a', '--all')) return '`git checkout-index --all` copies the archive out.'
  if (sub === 'mv') return movesIn(rest, '', here) ? null : pathsTouch('git mv', rest, here)
  const spec = /** @type {{ letters?: string, longs?: string[], pathValues?: string[], kind?: string }} */ (GIT[sub] ?? {})
  if (sub === 'restore' && has(rest, 'S', '--staged') && !has(rest, 'W', '--worktree')) return null

  const dd = rest.indexOf('--')
  const before = dd < 0 ? rest : rest.slice(0, dd)
  const values = optionValues(before, spec)
  for (const v of values) if (spec.pathValues?.includes(v.opt) && pathKind(v.value, here)) return `\`git ${sub}\` names ${v.value}, in the archive.`
  let ops = operandIndexes(before, spec.letters, spec.longs).map(i => /** @type {string} */ (before[i]))
  if (sub === 'grep' && !values.some(v => v.opt === '-e' || v.opt === '-f')) ops = ops.slice(1)
  const after = dd < 0 ? [] : rest.slice(dd + 1)

  for (const { cwd, root } of targets) {
    // <rev>:<path> and :<stage>:<path> name a file in a tree or the index.
    /** @type {string[]} */
    const blobs = []
    for (const o of READS_OBJECTS.has(sub) ? [...ops, ...values.filter(v => v.opt === '-L').map(v => v.value.replace(/^[^:]*/, ''))] : []) {
      const m = /^(?::[0-3]:|[^:]+:|:(?![(!^/]))(.+)$/s.exec(o)
      if (!m || o.startsWith(':(')) continue
      const p = /** @type {string} */ (m[1])
      const rel = p.startsWith('./') || p.startsWith('../') ? relative(root, resolve(cwd, p)).split(sep).join('/') : p
      if (rel === 'archive' || rel.startsWith('archive/')) return `\`git ${sub}\` names ${o}, in the archive.`
      blobs.push(o)
    }
    if (!spec.kind) continue
    // Before `--`, an operand that exists on disk is a path; anything else is a revision.
    const specs = [
      ...ops.filter(o => !o.includes(':') && existsSync(resolve(cwd, o))),
      ...ops.filter(o => o.startsWith(':(') || /^:[!^/]/.test(o)),
      ...after,
    ].map(s => pathspec(s, cwd, root))
    const included = specs.filter(s => !s.exclude)
    const excluded = specs.some(specExcludesArchive)
    if (spec.kind === 'index') continue
    if (included.some(s => specReaches(s) && !(excluded && !specNamesArchive(s)))) {
      if (spec.kind === 'paths' || included.some(specNamesArchive)) return `\`git ${sub}\` names a path in the archive.`
      if (!excluded) return walkMessage(`git ${sub}`)
      continue
    }
    if (included.length || excluded) continue
    // No pathspec: the whole tree (from here), or the history.
    if (spec.kind === 'dump') return `\`git ${sub}\` would write out the archive. Add \`-- ':!archive'\` or name the paths you need.`
    const walksTree = spec.kind === 'tree' && !blobs.length && (sub !== 'ls-tree' || has(before, 'r'))
    if (walksTree && specReaches(pathspec('.', cwd, root))) return walkMessage(`git ${sub}`)
    if (spec.kind !== 'history') continue
    // Files named by <rev>:<path> are checked above; only the revisions left can print history.
    if (blobs.length && blobs.length === ops.length) continue
    const changes = before.filter(a => SHOWS_CHANGES.test(a))
    if (/^(?:log|reflog)$/.test(sub) && !changes.length) continue
    if (sub === 'show' && before.some(a => a === '-s' || a === '--no-patch') && !changes.some(a => a !== '-s')) continue
    // A -L range shows only the file it names.
    if (changes.length && changes.every(a => a.startsWith('-L'))) continue
    if (historyTouches(sub, before.filter(a => !blobs.includes(a)), cwd)) {
      return `\`git ${sub}\` would print changes in the archive. Add \`-- ':!archive'\` or name the paths you need.`
    }
  }
  return null
}

/** @param {string} what @param {string[]} args @param {string[]} cwds */
function pathsTouch(what, args, cwds) {
  for (const a of args) if (!a.startsWith('-') && pathKind(a, cwds)) return `\`${what}\` names ${a}, in the archive.`
  return null
}

// --- Bash ------------------------------------------------------------------------------

/**
 * Why a Bash command touches the archive, or null.
 *
 * Tracks the directories each command may run in. A `cd` that the next
 * command depends on (`cd x && …`) moves there; any other `cd` (after `;`
 * or `||`, which a failure skips past) adds its target to the candidates.
 * Leaving a subshell or nested script restores its parent's directories,
 * and `popd` or `cd -` may return to any directory seen so far.
 *
 * @param {string} command
 * @param {string} cwd
 */
function bashTouches(command, cwd) {
  for (const { c, cwds, at } of withCwds(command, cwd)) {
    for (const f of c.files) if (pathKind(f, cwds)) return `\`${c.name}\` redirects to or from ${f}, in the archive.`
    const t = cdTarget(c)
    if (t !== null) {
      if (typeof t === 'object' && pathKind(t.to, cwds)) return `\`${c.name} ${t.to}\` enters the archive.`
      continue
    }
    if (c.chdir !== undefined && pathKind(c.chdir, cwds)) return `\`${c.name}\` runs in ${c.chdir}, in the archive.`
    const why = c.name === 'git' ? gitTouches(c.args, at) : commandTouches(c, at)
    if (why) return why
  }
  return null
}

// --- the block ---------------------------------------------------------------------------

/**
 * Why the Grep or Glob tool, searching `root`, reaches into the archive.
 *
 * @param {string} toolName
 * @param {Record<string, unknown>} toolInput
 * @param {string} root
 * @param {string} cwd
 */
function searchToolTouches(toolName, toolInput, root, cwd) {
  if (toolName === 'Glob') {
    const pattern = typeof toolInput.pattern === 'string' ? toolInput.pattern : ''
    if (!braces(pattern).some(p => globKind(root, p) === 'inside')) return null
    return `the pattern ${pattern} reaches into the archive. Narrow it to the directories you need.`
    return null
  }
  // The Grep tool runs rg, so rg's globs and ignore files apply.
  const glob = typeof toolInput.glob === 'string' ? toolInput.glob : ''
  const byGlob = glob ? rgGlobsExclude([{ glob, icase: false }]) : null
  const hint = `searching ${toolInput.path ?? 'the repository'} would reach into the archive. ` +
    'Pass glob "!archive", a subdirectory path, or list /archive/ in the root .ignore.'
  return walkTouches('Grep', [root], [cwd], r => byGlob ?? ignoredByFiles(['.ignore', '.rgignore'], r), hint)
}

/**
 * Why a tool call touches the archive, or null if it does not.
 *
 * @param {string} toolName
 * @param {Record<string, unknown>} toolInput
 * @param {string} cwd the agent's working directory
 * @returns {string | null}
 */
export function archiveBlock(toolName, toolInput, cwd) {
  fresh.clear()
  const str = (/** @type {string} */ k) => (typeof toolInput[k] === 'string' ? /** @type {string} */ (toolInput[k]) : undefined)
  /** @type {string | null} */
  let why = null
  if (toolName === 'Bash') why = bashTouches(str('command') ?? '', cwd)
  else {
    for (const k of ['file_path', 'notebook_path']) {
      const p = str(k)
      if (p !== undefined && pathKind(p, [cwd])) why = `${p} is in the archive.`
    }
    const path = str('path')
    if (!why && (toolName === 'Grep' || toolName === 'Glob' || toolName === 'LS')) {
      const root = resolve(cwd, untilde(path ?? '.', cwd))
      if (inArchive(root)) why = `${path} is in the archive.`
      else if (toolName !== 'LS') why = searchToolTouches(toolName, toolInput, root, cwd)
    }
  }
  return why && `archive block: ${why}${DENY_SUFFIX}`
}
