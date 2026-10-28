// The archive block: the hard block on agents touching the archive, the
// human's store of superseded docs at a repository's root (ADR 0008). Moving
// a file into it is the one thing allowed.
//
// It reads command text, so it is a seatbelt, not a sandbox: a path built
// from variables can get past it.

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'

import { parseCommands } from './shell.mjs'

const TAIL = ' The archive is managed by the human alone; agents may only move files into it (ADR 0008).'
const HINT = "rg -g '!archive', grep --exclude-dir=archive, git grep … -- ':!archive', find … -path ./archive -prune"

// --- where the archive is ----------------------------------------------------

const FOLD = process.platform === 'darwin' || process.platform === 'win32'
const isArchiveName = (/** @type {string} */ n) => (FOLD ? n.toLowerCase() : n) === 'archive'
const isRepoRoot = (/** @type {string} */ dir) => existsSync(join(dir, '.git'))

/** @param {string} dir @returns {string | null} the repository root at or above `dir` */
function repoRoot(dir) {
  for (let d = dir; ; d = dirname(d)) {
    if (isRepoRoot(d)) return d
    if (dirname(d) === d) return null
  }
}

/** @param {string} p @returns {string} `p` with symlinks resolved as far as it exists */
function real(p) {
  try {
    return realpathSync.native(p)
  } catch {
    const parent = dirname(p)
    return parent === p ? p : join(real(parent), basename(p))
  }
}

/** @param {string} p an absolute path @returns {boolean} whether it is the archive or inside it */
function inArchive(p) {
  for (const q of new Set([p, real(p)])) {
    for (let d = q; dirname(d) !== d; d = dirname(d)) {
      if (isArchiveName(basename(d)) && isRepoRoot(dirname(d))) return true
    }
  }
  return false
}

/**
 * Whether walking `dir` recursively would reach an archive: the one of the
 * repository it is in, or of the repository the agent works in.
 *
 * @param {string} dir
 * @param {string} cwd
 */
function containsArchive(dir, cwd) {
  const d = real(dir)
  const prefix = d.endsWith(sep) ? d : d + sep
  for (const root of [repoRoot(d), repoRoot(real(cwd))]) {
    if (root && existsSync(join(root, 'archive')) && join(root, 'archive', sep).startsWith(prefix)) return true
  }
  return false
}

// --- paths named by a tool call or a command ----------------------------------

const GLOB = /[*?[]/

/** @param {string} seg one path segment of a shell glob */
function globRegex(seg) {
  let re = ''
  for (let i = 0; i < seg.length; i++) {
    const c = /** @type {string} */ (seg[i])
    if (c === '*') re += '.*'
    else if (c === '?') re += '.'
    else if (c === '[') {
      const k = seg.indexOf(']', i + 2)
      if (k < 0) re += '\\['
      else {
        re += `[${seg.slice(i + 1, k).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`
        i = k
      }
    } else re += c.replace(/[.+^${}()|\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`, FOLD ? 'i' : '')
}

/**
 * Whether the absolute path `abs`, which may hold glob segments, names or
 * could expand into the archive.
 *
 * @param {string} abs
 * @param {string} cwd
 */
function reaches(abs, cwd) {
  const parts = abs.split(sep)
  const first = parts.findIndex(s => GLOB.test(s))
  if (first < 0) return inArchive(abs)
  const prefix = parts.slice(0, first).join(sep) || sep
  if (inArchive(prefix)) return true
  for (let i = first; i < parts.length; i++) {
    const seg = /** @type {string} */ (parts[i])
    if (seg === '**') return i === first ? containsArchive(prefix, cwd) : true
    // Past the first glob segment the directory is unknown, so a literal `archive` may be it.
    if (i > first ? isArchiveName(seg) || globRegex(seg).test('archive') : globRegex(seg).test('archive') && isRepoRoot(prefix) && existsSync(join(prefix, 'archive'))) {
      return true
    }
  }
  return false
}

/** @param {string} w @param {string} cwd */
const absolute = (w, cwd) => (w === '~' || w.startsWith('~/') ? join(homedir(), w.slice(1)) : resolve(cwd, w))

// --- Bash ----------------------------------------------------------------------

/**
 * Indexes of `args` that are operands, skipping options and the values of
 * the short options in `valueLetters` and the long options in `valueLongs`.
 *
 * @param {string[]} args
 * @param {string} valueLetters
 * @param {string[]} [valueLongs]
 */
function operandIndexes(args, valueLetters, valueLongs = []) {
  const out = []
  for (let i = 0; i < args.length; i++) {
    const a = /** @type {string} */ (args[i])
    if (a === '--') {
      for (let j = i + 1; j < args.length; j++) out.push(j)
      break
    }
    if (a.startsWith('--')) {
      if (!a.includes('=') && valueLongs.includes(a)) i++
    } else if (/^-[A-Za-z0-9]/.test(a)) {
      for (let j = 1; j < a.length; j++) {
        if (valueLetters.includes(/** @type {string} */ (a[j]))) {
          if (j === a.length - 1) i++
          break
        }
      }
    } else out.push(i)
  }
  return out
}

/** @param {string[]} args @param {string} letter @param {string} [long] */
const hasFlag = (args, letter, long) => args.some(a => (/^-[A-Za-z]+$/.test(a) && a.includes(letter)) || a === long)

// Per searcher: short options taking a value, long ones taking one, and the options that mean there is no pattern operand.
/** @type {Record<string, { letters: string, longs: string[], noPattern: RegExp }>} */
const SEARCHERS = {
  rg: { letters: 'efgtTmABCrjMdE', longs: ['--regexp', '--file', '--glob', '--iglob', '--type', '--type-not', '--max-count', '--context', '--replace', '--max-depth'], noPattern: /^(?:-[A-Za-z]*[ef]|--regexp|--file|--files)\b/ },
  grep: { letters: 'efmABCdD', longs: ['--regexp', '--file', '--exclude', '--exclude-dir', '--include', '--max-count', '--context'], noPattern: /^(?:-[A-Za-z]*[ef]|--regexp|--file)\b/ },
  ag: { letters: 'ABCGgm', longs: ['--ignore', '--ignore-dir'], noPattern: /^-[A-Za-z]*g$/ },
  fd: { letters: 'eEtdjSc', longs: ['--exclude', '--extension', '--type', '--max-depth'], noPattern: /^$/ },
  'git grep': { letters: 'efmABCO', longs: [], noPattern: /^-[A-Za-z]*[ef]$/ },
}
SEARCHERS.egrep = SEARCHERS.fgrep = SEARCHERS.rgrep = SEARCHERS.grep
SEARCHERS.ack = SEARCHERS.ag
SEARCHERS.fdfind = SEARCHERS.fd

// A value of these options names something to leave out.
const EXCLUDE_LONG = /^--(?:exclude|exclude-dir|ignore|ignore-dir)$/
const EXCLUDE_SHORT = /** @type {Record<string, string>} */ ({ fd: 'E', fdfind: 'E', tree: 'I', zip: 'x' })
const MENTIONS_ARCHIVE = /(?:^|[/!|{,(^*]|\.\/)archive(?:$|[/*|},)])/i
// Options that make rg or fd search what ignore files leave out.
const IGNORE_OFF = /** @type {Record<string, RegExp>} */ ({
  rg: /^(?:-[A-Za-z]*u[A-Za-z]*|--no-ignore\S*|--unrestricted)$/,
  fd: /^(?:-[A-Za-z]*[uI][A-Za-z]*|--no-ignore\S*|--unrestricted)$/,
})

/**
 * Whether a recursive command leaves the archive out: by an exclusion on its
 * command line, or (for rg and fd) by a root `.ignore` that lists it.
 *
 * @param {string} tool
 * @param {string[]} args
 * @param {string} cwd
 */
function excludesArchive(tool, args, cwd) {
  for (let i = 0; i < args.length; i++) {
    const a = /** @type {string} */ (args[i])
    const next = args[i + 1] ?? ''
    const [flag, value = next] = a.startsWith('--') ? a.split(/=(.*)/s) : [a]
    if (EXCLUDE_LONG.test(/** @type {string} */ (flag)) && MENTIONS_ARCHIVE.test(value)) return true
    if (a === `-${EXCLUDE_SHORT[tool] ?? '\0'}` && MENTIONS_ARCHIVE.test(next)) return true
    if (/^(?:-g|--glob|--iglob)$/.test(a) && next.startsWith('!') && MENTIONS_ARCHIVE.test(next)) return true
    if (/^-g!/.test(a) && MENTIONS_ARCHIVE.test(a)) return true
    if (/^:(?:!|\^|\(exclude\))/.test(a) && MENTIONS_ARCHIVE.test(a.replace(/^:(?:!|\^|\(exclude\))/, '/'))) return true
  }
  if (tool === 'find') {
    const pruned = args.includes('-prune')
    for (let i = 0; i < args.length; i++) {
      if (!/^-i?(?:path|name|wholename)$/.test(/** @type {string} */ (args[i])) || !MENTIONS_ARCHIVE.test(args[i + 1] ?? '')) continue
      if (pruned || args[i - 1] === '!' || args[i - 1] === '-not') return true
    }
  }
  const off = IGNORE_OFF[tool === 'fdfind' ? 'fd' : tool]
  if (off && !args.some(a => off.test(a))) {
    const root = repoRoot(real(cwd))
    for (const name of tool === 'rg' ? ['.ignore', '.rgignore'] : ['.ignore', '.fdignore']) {
      try {
        if (root && readFileSync(join(root, name), 'utf8').split('\n').some(l => /^\/?archive\/?(?:\*\*)?\s*$/.test(l))) return true
      } catch {}
    }
  }
  return false
}

/**
 * How a command walks directories: whether it does, which operands are where
 * it starts, and whether it starts in the working directory when it has none.
 *
 * @param {string} tool
 * @param {string[]} args
 * @param {number[]} ops operand indexes, the pattern left out
 * @returns {{ roots: number[], defaultsToCwd: boolean } | null}
 */
function walk(tool, args, ops) {
  const all = { roots: ops, defaultsToCwd: true }
  switch (tool) {
    case 'rg':
    case 'ag':
    case 'ack':
    case 'fd':
    case 'fdfind':
    case 'tree':
    case 'du':
    case 'rgrep':
    case 'git grep':
    case 'git ls-files':
    case 'git archive':
      return all
    case 'find': {
      const end = args.findIndex(a => a.startsWith('-') || a === '(' || a === '!')
      return { roots: ops.filter(i => end < 0 || i < end), defaultsToCwd: true }
    }
    case 'grep':
    case 'egrep':
    case 'fgrep':
      return hasFlag(args, 'r', '--recursive') || hasFlag(args, 'R', '--dereference-recursive') || args.includes('--directories=recurse') ? all : null
    case 'ls':
      return hasFlag(args, 'R', '--recursive') ? all : null
    case 'git ls-tree':
      return hasFlag(args, 'r') ? all : null
    case 'cp':
    case 'rsync':
      return hasFlag(args, 'r', '--recursive') || hasFlag(args, 'R') || hasFlag(args, 'a', '--archive') ? { roots: ops.slice(0, -1), defaultsToCwd: false } : null
    case 'zip':
      return hasFlag(args, 'r') ? { roots: ops.slice(1), defaultsToCwd: false } : null
    case 'tar':
      return args.some(a => /^-?[A-Za-z]*c[A-Za-z]*$/.test(a) && !a.startsWith('--')) || args.includes('--create') ? { roots: ops, defaultsToCwd: false } : null
  }
  return null
}

/**
 * Why one simple command touches the archive, or null.
 *
 * @param {import('./shell.mjs').SimpleCommand} c
 * @param {string} cwd
 */
function commandTouches(c, cwd) {
  let { name, args } = c
  let tool = name
  if (name === 'git') {
    // Global options first: `-C <dir>` moves git, and is itself a path.
    let i = 0
    while (i < args.length && /** @type {string} */ (args[i]).startsWith('-')) {
      const a = /** @type {string} */ (args[i])
      if (a === '-C') {
        if (reaches(absolute(args[i + 1] ?? '.', cwd), cwd)) return `\`git -C ${args[i + 1]}\` works in the archive.`
        cwd = absolute(args[i + 1] ?? '.', cwd)
      }
      i += ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'].includes(a) ? 2 : 1
    }
    tool = `git ${args[i] ?? ''}`
    args = args.slice(i + 1)
  }

  for (const f of c.files) if (reaches(absolute(f, cwd), cwd)) return `\`${name}\` redirects to or from ${f}, in the archive.`
  if (name === 'echo' || name === 'printf' || name === 'mkdir') return null

  // Moving in: every source outside the archive, the destination in it.
  if (name === 'mv' || tool === 'git mv') {
    const ops = operandIndexes(args, 'tS', ['--target-directory', '--suffix']).map(i => /** @type {string} */ (args[i]))
    const t = args.findIndex(a => a === '-t' || a.startsWith('--target-directory'))
    const dest = t < 0 ? ops.pop() : (args[t]?.includes('=') ? args[t]?.split('=')[1] : args[t + 1])
    const sources = t < 0 ? ops : ops.filter(o => o !== dest)
    if (dest !== undefined && reaches(absolute(dest, cwd), cwd) && sources.every(s => !reaches(absolute(s, cwd), cwd) && !containsArchive(absolute(s, cwd), cwd))) return null
  }

  const searcher = SEARCHERS[tool]
  /** @type {Set<number>} indexes that are not paths */
  const skip = new Set()
  let ops = operandIndexes(args, searcher?.letters ?? '', searcher?.longs ?? [])
  if (searcher) {
    for (let i = 0; i < args.length; i++) if (/^(?:-[A-Za-z]*[egtTIE]|--(?:regexp|glob|iglob|exclude|exclude-dir|include|ignore|ignore-dir|type))$/.test(/** @type {string} */ (args[i]))) skip.add(i + 1)
    if (!args.some(a => searcher.noPattern.test(a)) && ops.length) {
      skip.add(/** @type {number} */ (ops[0]))
      ops = ops.slice(1)
    }
  }
  if (tool === 'find') for (let i = 0; i < args.length; i++) if (/^-i?(?:path|name|wholename|regex)$/.test(/** @type {string} */ (args[i]))) skip.add(i + 1)
  if (tool.startsWith('git ')) for (let i = 0; i < args.length; i++) if (/^(?:-m|--message)$/.test(/** @type {string} */ (args[i]))) skip.add(i + 1)
  for (let i = 0; i < args.length; i++) {
    const a = /** @type {string} */ (args[i])
    if (EXCLUDE_LONG.test(a) || a === `-${EXCLUDE_SHORT[tool] ?? '\0'}`) skip.add(i + 1)
  }

  for (let i = 0; i < args.length; i++) {
    if (skip.has(i)) continue
    const a = /** @type {string} */ (args[i])
    /** @type {string[]} */
    const paths = []
    if (a.startsWith('--')) {
      const [flag, value] = a.split(/=(.*)/s)
      if (value && !EXCLUDE_LONG.test(/** @type {string} */ (flag))) paths.push(absolute(value, cwd))
    } else if (a.startsWith('-') && a !== '-') continue
    else if (tool.startsWith('git ') && /^[^:]*:(?![!^(])/.test(a)) {
      // <rev>:<path> names a path from the repository root, or from here with ./
      const p = a.slice(a.indexOf(':') + 1)
      paths.push(p.startsWith('./') || p.startsWith('../') ? absolute(p, cwd) : join(repoRoot(real(cwd)) ?? cwd, p))
    } else if (!a.startsWith(':')) paths.push(absolute(a, cwd))
    for (const p of paths) if (reaches(p, cwd)) return `\`${name}\` names ${a}, in the archive.`
  }

  const w = walk(tool, args, ops)
  if (w) {
    // A magic pathspec (`:!docs`) narrows a walk; it is not where one starts.
    const named = w.roots.map(i => /** @type {string} */ (args[i])).filter(a => !a.startsWith(':'))
    const roots = named.length ? named.map(a => absolute(a, cwd)) : w.defaultsToCwd ? [cwd] : []
    if (roots.some(r => containsArchive(r, cwd)) && !excludesArchive(tool, args, cwd)) {
      return `\`${tool}\` would walk into the archive. Exclude it (${HINT}) or name a subdirectory.`
    }
  }
  return null
}

/**
 * Why a Bash command touches the archive, or null.
 *
 * @param {string} command
 * @param {string} cwd
 */
function bashTouches(command, cwd) {
  let here = cwd
  for (const c of parseCommands(command)) {
    if (c.name === 'cd' || c.name === 'pushd') {
      const to = c.args.find(a => !a.startsWith('-'))
      if (to === undefined || /[$`]/.test(to)) continue
      const abs = absolute(to, here)
      if (reaches(abs, here)) return `\`cd ${to}\` enters the archive.`
      here = abs
      continue
    }
    const why = commandTouches(c, here)
    if (why) return why
  }
  return null
}

// --- the block -----------------------------------------------------------------

/**
 * Why a tool call touches the archive, or null if it does not.
 *
 * @param {string} toolName
 * @param {Record<string, unknown>} toolInput
 * @param {string} cwd the agent's working directory
 * @returns {string | null}
 */
export function archiveBlock(toolName, toolInput, cwd) {
  const str = (/** @type {string} */ k) => (typeof toolInput[k] === 'string' ? /** @type {string} */ (toolInput[k]) : undefined)
  /** @type {string | null} */
  let why = null
  if (toolName === 'Bash') why = bashTouches(str('command') ?? '', cwd)
  else {
    for (const k of ['file_path', 'notebook_path']) {
      const p = str(k)
      if (p !== undefined && reaches(absolute(p, cwd), cwd)) why = `${p} is in the archive.`
    }
    if (!why && (toolName === 'Grep' || toolName === 'Glob' || toolName === 'LS')) {
      const root = absolute(str('path') ?? '.', cwd)
      if (inArchive(root)) why = `${str('path')} is in the archive.`
      else if (toolName === 'Glob') {
        if (reaches(resolve(root, str('pattern') ?? ''), cwd)) why = `the pattern ${str('pattern')} reaches into the archive. Narrow it to the directories you need.`
      } else if (toolName === 'Grep' && containsArchive(root, cwd)) {
        const glob = str('glob') ?? ''
        if (!(glob.startsWith('!') && MENTIONS_ARCHIVE.test(glob))) why = `searching ${str('path') ?? 'the repository'} would reach into the archive. Pass glob "!archive/**" or a subdirectory path.`
      }
    }
  }
  return why && `archive block: ${why}${TAIL}`
}
