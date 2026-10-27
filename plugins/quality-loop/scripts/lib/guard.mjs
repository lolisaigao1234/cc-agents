// Policy for the PreToolUse guard. Pure, apart from resolving symlinks in
// the paths it is asked about.
//
// It reads command text, so it is a seatbelt, not a sandbox: aliases,
// functions and scripts can get past it. Permission rules are the hard block.
// Commands are parsed the way a shell splits them: quoted text, heredoc
// bodies and arguments are data, so only a word in command position counts
// as a command (`rg 'rm -rf'` and `git commit -m "... reset --hard"` are
// fine), while `bash -c "..."`, `$(...)` and backticks are looked into.

import { readdirSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { matchesAny, normalizePath } from './glob.mjs'

/**
 * One simple command: its name (basename of the command word, after
 * assignments and wrappers such as `sudo`, `env`, `xargs`), its arguments
 * with quotes removed, and the files it redirects output into. `xargs` marks
 * a command run by xargs, whose operands come from its input.
 *
 * @typedef {{ name: string, args: string[], writes: string[], xargs?: boolean }} SimpleCommand
 */

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])
const KEYWORDS = new Set(['!', '{', '}', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'time'])

/** @param {string | undefined} w */
const base = w => (w ?? '').replace(/\/+$/, '').split('/').pop() ?? ''

/**
 * Drops leading keywords, `VAR=value` assignments and wrapper commands, so
 * the first word left is the command that runs.
 *
 * @param {string[]} words
 */
function unwrap(words) {
  const w = [...words]
  /** @param {RegExp} [takesValue] */
  const dropFlags = takesValue => {
    while (w[0]?.startsWith('-')) {
      const f = /** @type {string} */ (w.shift())
      if (takesValue?.test(f)) w.shift()
    }
  }
  for (;;) {
    while (w.length && (KEYWORDS.has(/** @type {string} */ (w[0])) || /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(/** @type {string} */ (w[0])))) w.shift()
    const name = base(w[0])
    if (name === 'env') {
      w.shift()
      while (w[0] !== undefined && (w[0].startsWith('-') || w[0].includes('='))) {
        const f = w.shift()
        if (f === '-u' || f === '-C') w.shift()
      }
    } else if (name === 'sudo' || name === 'doas') {
      w.shift()
      dropFlags(/^-[ugCDhpRrTt]$/)
    } else if (['command', 'exec', 'nohup', 'builtin', 'noglob', 'time'].includes(name)) {
      w.shift()
      dropFlags()
    } else if (name === 'nice') {
      w.shift()
      dropFlags(/^-n$/)
    } else if (name === 'timeout') {
      w.shift()
      dropFlags(/^(?:-s|-k|--signal|--kill-after)$/)
      w.shift() // the duration
    } else if (name === 'xargs') {
      w.shift()
      dropFlags(/^-[IdEnLPsa]$/)
    } else return w
  }
}

/**
 * Index of the `)` closing the `(` at `open`, skipping quoted text.
 *
 * @param {string} src
 * @param {number} open
 */
function closingParen(src, open) {
  let depth = 0
  for (let j = open; j < src.length; j++) {
    const c = src[j]
    if (c === '\\') j++
    else if (c === "'") {
      const k = src.indexOf("'", j + 1)
      j = k < 0 ? src.length : k
    } else if (c === '"') {
      for (j++; j < src.length && src[j] !== '"'; j++) if (src[j] === '\\') j++
    } else if (c === '(') depth++
    else if (c === ')' && --depth === 0) return j
  }
  return src.length
}

/** @param {string} src @param {number} from index after the opening backtick */
function closingBacktick(src, from) {
  for (let j = from; j < src.length; j++) {
    if (src[j] === '\\') j++
    else if (src[j] === '`') return j
  }
  return src.length
}

// Unquoted `{`, `,` and `}` while a word is read, so brace expansion can
// tell them from quoted ones.
const LB = ''
const CM = ''
const RB = ''
const BRACE_CHARS = { [LB]: '{', [CM]: ',', [RB]: '}' }

/**
 * The words a word brace-expands to, as bash and zsh expand it
 * (`a{b,c}d` is `abd acd`; `{}` and `{x}` stay as they are).
 *
 * @param {string} w a word with its unquoted braces and commas marked
 * @returns {string[]}
 */
function expandBraces(w) {
  for (let i = w.indexOf(LB); i >= 0; i = w.indexOf(LB, i + 1)) {
    let depth = 0
    let close = -1
    const commas = []
    for (let j = i + 1; j < w.length && close < 0; j++) {
      if (w[j] === LB) depth++
      else if (w[j] === RB) {
        if (depth === 0) close = j
        else depth--
      } else if (w[j] === CM && depth === 0) commas.push(j)
    }
    if (close < 0 || !commas.length) continue
    const out = []
    let from = i + 1
    for (const k of [...commas, close]) {
      for (const x of expandBraces(w.slice(0, i) + w.slice(from, k) + w.slice(close + 1))) if (out.length < 64) out.push(x)
      from = k + 1
    }
    return out
  }
  return [w.replace(/[-]/g, ch => BRACE_CHARS[/** @type {keyof typeof BRACE_CHARS} */ (ch)])]
}

/**
 * Splits a shell command line into simple commands, including the ones
 * inside `$(...)`, backticks, `<(...)`, `sh -c "..."`, `eval` and heredocs
 * fed to a shell. Heredoc bodies fed to anything else are data.
 *
 * @param {string} src
 * @param {number} [depth]
 * @returns {SimpleCommand[]}
 */
export function parseCommands(src, depth = 0) {
  /** @type {SimpleCommand[]} */
  const out = []
  if (depth > 6) return out
  const nested = (/** @type {string} */ s) => {
    for (const c of parseCommands(s, depth + 1)) out.push(c)
  }

  /** @type {string[]} */
  let words = []
  /** @type {string[]} */
  let writes = []
  /** @type {string | null} */
  let word = null
  /** @type {'write' | 'read' | null} */
  let redirect = null
  /** @type {{ delim: string, strip: boolean, words: string[] }[]} */
  let heredocs = []

  const append = (/** @type {string} */ s) => {
    word = (word ?? '') + s
  }
  const endWord = () => {
    if (word === null) return
    const expanded = expandBraces(word)
    if (redirect === 'write') writes.push(...expanded)
    else if (redirect !== 'read') words.push(...expanded)
    redirect = null
    word = null
  }
  const endCommand = () => {
    endWord()
    redirect = null
    if (words.length || writes.length) {
      const w = unwrap(words)
      const name = base(w[0])
      const args = w.slice(1)
      const xargs = words.slice(0, words.length - w.length).some(x => base(x) === 'xargs')
      out.push(xargs ? { name, args, writes, xargs } : { name, args, writes })
      if (SHELLS.has(name)) {
        const c = args.findIndex(a => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a))
        if (c >= 0 && args[c + 1] !== undefined) nested(/** @type {string} */ (args[c + 1]))
      } else if (name === 'eval') nested(args.join(' '))
    }
    words = []
    writes = []
  }

  const n = src.length
  let i = 0
  while (i < n) {
    const c = /** @type {string} */ (src[i])
    if (c === '\n') {
      const pending = heredocs
      endCommand()
      i++
      for (const h of pending) {
        /** @type {string[]} */
        const body = []
        while (i < n) {
          const e = src.indexOf('\n', i)
          const line = src.slice(i, e < 0 ? n : e)
          i = e < 0 ? n : e + 1
          if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break
          body.push(line)
        }
        // A heredoc fed to a shell is a script; fed to anything else it is data.
        if (SHELLS.has(base(unwrap(h.words)[0]))) nested(body.join('\n'))
      }
      heredocs = []
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord()
      i++
    } else if (c === '#' && word === null) {
      while (i < n && src[i] !== '\n') i++
    } else if (c === '\\') {
      if (src[i + 1] !== '\n') append(src[i + 1] ?? '')
      i += 2
    } else if (c === "'") {
      const j = src.indexOf("'", i + 1)
      const end = j < 0 ? n : j
      append(src.slice(i + 1, end))
      i = end + 1
    } else if (c === '"') {
      append('')
      let j = i + 1
      for (; j < n && src[j] !== '"'; j++) {
        const d = src[j]
        if (d === '\\') {
          const e = src[j + 1] ?? ''
          if ('$`"\\'.includes(e)) append(e)
          else if (e !== '\n') append(`\\${e}`)
          j++
        } else if (d === '$' && src[j + 1] === '(') {
          const k = closingParen(src, j + 1)
          nested(src.slice(j + 2, k))
          append(src.slice(j, k + 1))
          j = k
        } else if (d === '`') {
          const k = closingBacktick(src, j + 1)
          nested(src.slice(j + 1, k))
          append(src.slice(j, k + 1))
          j = k
        } else append(/** @type {string} */ (d))
      }
      i = j + 1
    } else if (c === '`') {
      const k = closingBacktick(src, i + 1)
      nested(src.slice(i + 1, k))
      append(src.slice(i, k + 1))
      i = k + 1
    } else if ((c === '$' || c === '<' || c === '>') && src[i + 1] === '(') {
      // $(...) runs a command; <(...) and >(...) too, and stand for a path.
      const k = closingParen(src, i + 1)
      nested(src.slice(i + 2, k))
      append(src.slice(i, k + 1))
      i = k + 1
    } else if (c === ';' || c === '|' || c === '(' || c === ')') {
      endCommand()
      i++
    } else if (c === '&') {
      if (src[i + 1] === '>') {
        endWord()
        redirect = 'write'
        i += src[i + 2] === '>' ? 3 : 2
      } else {
        endCommand()
        i++
      }
    } else if (c === '>' || c === '<') {
      // A file descriptor number written right before the operator is part of it.
      if (word !== null && /^\d+$/.test(word)) word = null
      endWord()
      if (c === '<' && src[i + 1] === '<' && src[i + 2] === '<') {
        redirect = 'read' // here-string: the next word is input
        i += 3
      } else if (c === '<' && src[i + 1] === '<') {
        let j = i + 2
        const strip = src[j] === '-'
        if (strip) j++
        while (src[j] === ' ' || src[j] === '\t') j++
        let delim = ''
        while (j < n && !/[\s;&|<>()]/.test(/** @type {string} */ (src[j]))) delim += src[j++]
        heredocs.push({ delim: delim.replace(/["'\\]/g, ''), strip, words: [...words] })
        i = j
      } else if (c === '<') {
        redirect = src[i + 1] === '>' ? 'write' : 'read'
        i += src[i + 1] === '>' || src[i + 1] === '&' ? 2 : 1
      } else {
        let k = i + 1
        if (src[k] === '>' || src[k] === '|') k++
        if (src[k] === '&') k++
        redirect = 'write'
        i = k
      }
    } else {
      // `${...}` is a parameter, not a brace expansion.
      append(c === '{' && !(word ?? '').endsWith('$') ? LB : c === ',' ? CM : c === '}' ? RB : c)
      i++
    }
  }
  endCommand()
  return out
}

// --- ql ----------------------------------------------------------------------

// ql.mjs parseArgs: these flags take no value; every other `--flag` takes the next word.
const QL_BOOL = new Set(['json', 'force', 'none', 'all', 'keep', 'reset', 'allow-weakening', 'review-only', 'help'])
const NODE_VALUE_FLAGS = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions', '--env-file'])

/**
 * The arguments of a `ql` invocation (`ql`, `.../bin/ql`, `node .../ql.mjs`), or null.
 *
 * @param {SimpleCommand} c
 */
function qlArgs(c) {
  if (c.name === 'ql' || c.name === 'ql.mjs') return c.args
  if (/^(?:node|nodejs|bun|sh|bash|zsh|dash)$/.test(c.name)) {
    let i = 0
    while (i < c.args.length && /** @type {string} */ (c.args[i]).startsWith('-')) i += NODE_VALUE_FLAGS.has(/** @type {string} */ (c.args[i])) ? 2 : 1
    const script = c.args[i]
    if (script !== undefined && /(?:^|\/)ql(?:\.mjs)?$/.test(script)) return c.args.slice(i + 1)
  }
  return null
}

/**
 * Every `ql` invocation in a shell command, with its subcommand and flags
 * read the way ql itself reads them.
 *
 * @param {string} command
 * @returns {{ sub: string | undefined, flags: Set<string> }[]}
 */
export function qlInvocations(command) {
  const found = []
  for (const c of parseCommands(command)) {
    const args = qlArgs(c)
    if (!args) continue
    /** @type {string[]} */
    const positional = []
    const flags = new Set()
    for (let i = 0; i < args.length; i++) {
      const a = /** @type {string} */ (args[i])
      if (a.startsWith('--')) {
        const [k = '', v] = a.slice(2).split(/=(.*)/s)
        flags.add(k)
        if (v === undefined && !QL_BOOL.has(k)) i++
      } else positional.push(a)
    }
    found.push({ sub: positional[0], flags })
  }
  return found
}

// --- destructive commands ----------------------------------------------------

/** @param {string[]} args the arguments before a `--` */
const beforeDashDash = args => {
  const k = args.indexOf('--')
  return k < 0 ? args : args.slice(0, k)
}

/**
 * The single-letter options set in `args` (clusters like `-fdx` included).
 * A letter in `valueLetters` takes the rest of its cluster, or the next
 * argument, as its value.
 *
 * @param {string[]} args
 * @param {string} [valueLetters]
 */
function shortFlags(args, valueLetters = '') {
  const set = new Set()
  for (let i = 0; i < args.length; i++) {
    const a = /** @type {string} */ (args[i])
    if (!/^-[A-Za-z]+$/.test(a)) continue
    for (let j = 1; j < a.length; j++) {
      const ch = /** @type {string} */ (a[j])
      set.add(ch)
      if (valueLetters.includes(ch)) {
        if (j === a.length - 1) i++
        break
      }
    }
  }
  return set
}

/**
 * Operands (non-option arguments), skipping the values of `valueOpts`.
 *
 * @param {string[]} args
 * @param {string[]} [valueOpts]
 */
function operands(args, valueOpts = []) {
  const out = []
  for (let i = 0; i < args.length; i++) {
    const a = /** @type {string} */ (args[i])
    if (a === '--') return [...out, ...args.slice(i + 1)]
    if (valueOpts.includes(a)) i++
    else if (!a.startsWith('-') || a === '-') out.push(a)
  }
  return out
}

const GIT_VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env'])

/**
 * A git invocation split into its global options (the `-c` settings and the
 * `-C` directories), its subcommand and the subcommand's arguments.
 *
 * @param {string[]} args
 */
function gitParts(args) {
  /** @type {string[]} */
  const config = []
  /** @type {string[]} */
  const dirs = []
  let i = 0
  while (i < args.length && /** @type {string} */ (args[i]).startsWith('-')) {
    const a = /** @type {string} */ (args[i])
    if (GIT_VALUE_OPTS.has(a)) {
      if (a === '-c' || a === '--config-env') config.push(args[i + 1] ?? '')
      if (a === '-C') dirs.push(args[i + 1] ?? '.')
      i += 2
    } else {
      if (a.startsWith('--config-env=')) config.push(a.slice('--config-env='.length))
      i++
    }
  }
  const rest = args.slice(i + 1)
  const opts = beforeDashDash(rest)
  return { config, dirs, sub: args[i], rest, opts, long: (/** @type {string} */ f) => opts.some(x => x === f || x.startsWith(`${f}=`)) }
}

/** @param {string[]} args */
function gitDestructive(args) {
  const { config, sub, rest, opts, long } = gitParts(args)

  if (['commit', 'push', 'merge', 'rebase', 'am', 'cherry-pick', 'revert'].includes(sub ?? '')) {
    if (long('--no-verify')) return '--no-verify skips the checks the loop relies on'
    if (config.some(c => /^core\.hookspath\b/i.test(c))) return 'overriding core.hooksPath skips the checks the loop relies on'
  }
  switch (sub) {
    case 'reset':
      if (long('--hard')) return 'git reset --hard discards uncommitted work'
      break
    case 'clean': {
      const s = shortFlags(opts, 'e')
      if ((s.has('f') || long('--force')) && !(s.has('n') || long('--dry-run'))) return 'git clean -f deletes untracked files'
      break
    }
    case 'checkout': {
      const s = shortFlags(opts, 'bB')
      if (s.has('f') || long('--force')) return 'git checkout -f discards working-tree changes'
      const dd = rest.indexOf('--')
      if (dd >= 0 && dd < rest.length - 1) return 'git checkout [<ref>] -- <path> discards working-tree changes'
      const ops = operands(opts, ['-b', '-B', '--orphan'])
      if (ops.includes('.')) return 'git checkout . discards working-tree changes'
      const creates = s.has('b') || s.has('B') || long('--orphan')
      if (!creates && ops.length >= 2) return 'git checkout <ref> <path> overwrites working-tree files'
      break
    }
    case 'switch': {
      const s = shortFlags(opts, 'cC')
      if (s.has('f') || long('--force') || long('--discard-changes')) return 'git switch --discard-changes discards working-tree changes'
      break
    }
    case 'restore': {
      // It only unstages with --staged and without --worktree.
      const s = shortFlags(opts, 's')
      const staged = s.has('S') || long('--staged')
      const worktree = s.has('W') || long('--worktree')
      if (!staged || worktree) return 'git restore discards working-tree changes'
      break
    }
    case 'push': {
      const s = shortFlags(opts, 'o')
      if (s.has('f') || long('--force') || long('--force-with-lease') || long('--force-if-includes')) return 'force push rewrites shared history'
      if (operands(opts, ['-o', '--push-option', '--repo', '--receive-pack', '--exec']).some(x => x.startsWith('+'))) return 'a +refspec force-pushes'
      break
    }
    case 'stash':
      if (rest[0] === 'drop' || rest[0] === 'clear') return 'dropping a stash loses work'
      break
    case 'branch': {
      const s = shortFlags(opts)
      if (s.has('D') || ((s.has('d') || long('--delete')) && (s.has('f') || long('--force')))) return 'git branch -D deletes unmerged work'
      break
    }
    case 'commit': {
      if (shortFlags(opts, 'mFcCt').has('n')) return 'git commit -n skips the checks the loop relies on'
      break
    }
  }
  return null
}

/**
 * @param {SimpleCommand} c
 * @returns {string | null} why the command is destructive
 */
function destructive(c) {
  if (c.name === 'git') return gitDestructive(c.args)
  if (c.name === 'rm') {
    const opts = beforeDashDash(c.args)
    if (shortFlags(opts).has('r') || shortFlags(opts).has('R') || opts.includes('--recursive')) return 'rm -r deletes whole directory trees'
  }
  return null
}

// --- protected files ---------------------------------------------------------

// Calls in a script that delete files or move them away.
const SCRIPT_DELETE =
  /\b(?:rmSync|rmdirSync|unlinkSync|renameSync|rmdir|unlink|rename|rmtree|removedirs|os\.remove|shutil\.move|FileUtils\.(?:rm\w*|mv)|File\.delete)\b|\.rm\(/
// A script that writes, moves or deletes files (node, python, ruby, perl).
const SCRIPT_WRITE = new RegExp(
  `\\b(?:writeFileSync|writeFile|appendFileSync|appendFile|copyFileSync|cpSync|write_text|write_bytes|shutil\\.\\w+|File\\.write)\\b|\\bopen\\([^)]*,\\s*["'][wax]|${SCRIPT_DELETE.source}`,
)
const INTERPRETER = /^(?:node|nodejs|python[\d.]*|ruby|perl|deno|bun|php)$/
// Commands that delete or move away the files they are given.
const DELETERS = new Set(['rm', 'unlink', 'shred', 'truncate', 'rmdir', 'mv'])

/**
 * A path a filtered delete could reach: a protected file, a directory that
 * holds one, or a file of the tombstone. `rel` is root-relative (null for
 * the tombstone, which lives in the git directory); `unknown` stands for a
 * tree too large to list.
 *
 * @typedef {{ abs: string, rel: string | null, dir: boolean, unknown?: boolean, tomb?: boolean }} Candidate
 */

/**
 * Whether a delete that starts at `from` (absolute, as resolved) and was
 * written as `written` removes `c`, which lies below `from`.
 *
 * @typedef {(c: Candidate, from: string, written: string) => boolean} DeleteFilter
 */

/**
 * Whether the command `find -exec` runs deletes or moves files (or may: a
 * shell or interpreter script that does).
 *
 * @param {string[]} words
 * @returns {boolean}
 */
function execDeletes(words) {
  const w = unwrap(words)
  const name = base(w[0])
  if (DELETERS.has(name)) return true
  if (SHELLS.has(name)) {
    const c = w.findIndex(a => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a))
    return c < 0 || parseCommands(w[c + 1] ?? '').some(x => DELETERS.has(x.name) || execDeletes([x.name, ...x.args]))
  }
  return INTERPRETER.test(name) && SCRIPT_WRITE.test(w.join(' '))
}

/**
 * Whether `find`'s pattern `p` matches `s`: fnmatch, where `*` and `?` also
 * match `/` and a leading dot.
 *
 * @param {string} p
 * @param {string} s
 * @param {boolean} ci
 */
function fnmatch(p, s, ci) {
  const esc = (/** @type {string} */ x) => x.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  let re = ''
  for (let i = 0; i < p.length; i++) {
    const c = /** @type {string} */ (p[i])
    const close = c === '[' ? p.indexOf(']', i + 2) : -1
    if (c === '\\' && i + 1 < p.length) re += esc(/** @type {string} */ (p[++i]))
    else if (c === '*') re += '[\\s\\S]*'
    else if (c === '?') re += '[\\s\\S]'
    else if (close > 0) {
      re += `[${p.slice(i + 1, close).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`
      i = close
    } else re += esc(c)
  }
  try {
    return new RegExp(`^${re}$`, ci ? 'i' : '').test(s)
  } catch {
    return true
  }
}

const FIND_OPTS = /^-(?:[HLPEXdsx]|O\d*)$/
// Tests and actions without an argument that select everything (or only narrow).
const FIND_NO_ARG = new Set([
  '-a', '-and', '-print', '-print0', '-ls', '-depth', '-xdev', '-mount', '-follow', '-noleaf', '-true', '-prune', '-quit',
  '-nowarn', '-warn', '-ignore_readdir_race', '-noignore_readdir_race', '-daystart', '-empty', '-readable', '-writable',
  '-executable', '-nouser', '-nogroup',
])
const FIND_GROUPING = new Set(['-o', '-or', '!', '-not', '(', ')', ','])

/** @param {string[]} args `find`'s arguments @returns {{ starts: string[], expr: string[] }} */
function findParts(args) {
  let i = 0
  while (FIND_OPTS.test(args[i] ?? '') || args[i] === '-D') i += args[i] === '-D' ? 2 : 1
  const starts = []
  while (i < args.length && !/^[-(!]/.test(/** @type {string} */ (args[i]))) starts.push(/** @type {string} */ (args[i++]))
  return { starts: starts.length ? starts : ['.'], expr: args.slice(i) }
}

/**
 * What a `find` deletes: its starting points, and which paths below them its
 * expression selects. The filter is exact for a chain of name, path, type
 * and depth tests joined by AND (any other test only narrows it); with `-o`,
 * `!` or parentheses there is no filter and everything below counts.
 * `-delete` removes files (a directory only once it is empty); `-exec rm -r`
 * removes directories too.
 *
 * @param {string[]} args
 * @returns {{ starts: string[], filter: DeleteFilter | null } | null} null when it deletes nothing
 */
function findPlan(args) {
  const { starts, expr } = findParts(args)
  let deletes = false
  let dirs = false
  let exact = true
  let minDepth = 0
  let maxDepth = Infinity
  /** @type {((c: { path: string, name: string, dir: boolean }) => boolean)[]} */
  const tests = []
  for (let k = 0; k < expr.length; k++) {
    const a = /** @type {string} */ (expr[k])
    if (a === '-delete') deletes = true
    else if (['-exec', '-execdir', '-ok', '-okdir'].includes(a)) {
      const end = expr.findIndex((x, j) => j > k && (x === ';' || x === '+'))
      if (execDeletes(expr.slice(k + 1, end < 0 ? undefined : end))) deletes = dirs = true
      k = end < 0 ? expr.length : end
    } else if (FIND_GROUPING.has(a)) exact = false
    else if (FIND_NO_ARG.has(a)) continue
    else if (a === '-false') tests.push(() => false)
    else if (/^-i?(?:name|path|wholename)$/.test(a)) {
      const p = expr[++k] ?? ''
      const ci = a.startsWith('-i')
      const whole = /path|wholename/.test(a)
      tests.push(c => fnmatch(p, whole ? c.path : c.name, ci))
    } else if (a === '-type') {
      const types = (expr[++k] ?? '').split(',')
      tests.push(c => types.includes(c.dir ? 'd' : 'f'))
    } else if (a === '-maxdepth' || a === '-mindepth') {
      const n = Number(expr[++k])
      if (Number.isFinite(n)) {
        if (a === '-maxdepth') maxDepth = n
        else minDepth = n
      }
    } else if (a.startsWith('-') && expr[k + 1] !== undefined && !/^[-(!);]/.test(/** @type {string} */ (expr[k + 1]))) k++ // another test and its argument
  }
  if (!deletes) return null
  if (!exact) return { starts, filter: null }
  /** @type {DeleteFilter} */
  const filter = (c, from, written) => {
    if (c.dir && !dirs) return false
    const rel = c.abs.length <= from.length ? '' : c.abs.slice(from === '/' ? 1 : from.length + 1)
    const depth = rel ? rel.split('/').length : 0
    if (depth < minDepth || depth > maxDepth) return false
    const top = written.length > 1 ? written.replace(/\/+$/, '') : written
    const path = rel ? `${top === '/' ? '' : top}/${rel}` : written
    const name = (rel ? base(rel) : base(written)) || written
    return tests.every(t => t({ path, name, dir: c.dir }))
  }
  return { starts, filter }
}

/**
 * What a git command deletes from the working tree that no checkpoint
 * holds: `git clean -f` and `git stash -u` remove untracked files that are
 * not ignored; `-X` removes only ignored ones, `-x` and `stash -a` both.
 * Tracked files are never removed.
 *
 * @param {string[]} args
 * @returns {{ paths: string[], removes: 'untracked' | 'ignored' | 'all' } | null}
 */
function gitPlan(args) {
  const { dirs, sub, rest, opts, long } = gitParts(args)
  // Pathspecs are relative to the last `-C` directories.
  const at = (/** @type {string[]} */ ps) =>
    (ps.length ? ps : ['.']).map(x => [...dirs, x].reduce((acc, d) => (d.startsWith('/') || !acc ? d : `${acc}/${d}`), ''))
  if (sub === 'clean') {
    const s = shortFlags(opts, 'e')
    if ((s.has('f') || long('--force')) && !(s.has('n') || long('--dry-run'))) {
      return { paths: at(operands(rest, ['-e', '--exclude'])), removes: s.has('x') ? 'all' : s.has('X') ? 'ignored' : 'untracked' }
    }
  }
  if (sub === 'stash') {
    const verb = rest[0] !== undefined && !rest[0].startsWith('-') ? rest[0] : 'push'
    if (verb !== 'push' && verb !== 'save') return null
    const a = verb === rest[0] ? rest.slice(1) : rest
    const o = beforeDashDash(a)
    const s = shortFlags(o, 'm')
    const has = (/** @type {string} */ f) => o.some(x => x === f || x.startsWith(`${f}=`))
    const all = s.has('a') || has('--all')
    if (all || s.has('u') || has('--include-untracked')) {
      return { paths: at(verb === 'push' ? operands(a, ['-m', '--message', '--pathspec-from-file']) : []), removes: all ? 'all' : 'untracked' }
    }
  }
  return null
}

/**
 * How git sees a root-relative path.
 *
 * @typedef {(rel: string) => 'tracked' | 'ignored' | 'untracked'} GitStatus
 */

// What the loop's own .gitignore (store.mjs) ignores: the guess when git is not asked.
const LOOP_IGNORED = [
  '.quality-loop/state.json',
  '.quality-loop/LOOP.md',
  '.quality-loop/runs/**',
  '.quality-loop/work/**',
  '.quality-loop/history/**',
  '.quality-loop/trash/**',
  '.quality-loop/evals/results/**',
  '.quality-loop/evals/work/**',
  '.quality-loop/evals/hillclimb.json',
]
/** @type {GitStatus} */
const guessGitStatus = rel => (matchesAny(rel, LOOP_IGNORED) ? 'ignored' : 'untracked')

/**
 * The paths a command writes to: its redirects, and the file arguments of
 * commands that change files. `deletes` marks a path removed or moved away
 * (so a directory holding a protected file counts); `filter`, when given,
 * says which paths below it the command actually removes.
 *
 * @param {SimpleCommand} c
 * @param {GitStatus} gitStatus
 * @returns {{ path: string, deletes: boolean, filter?: DeleteFilter }[]}
 */
function writeTargets(c, gitStatus) {
  /** @type {{ path: string, deletes: boolean, filter?: DeleteFilter }[]} */
  const targets = c.writes.map(path => ({ path, deletes: false }))
  const add = (/** @type {string[]} */ ps, deletes = false) => {
    for (const path of ps) targets.push({ path, deletes })
  }
  const ops = operands(c.args)
  switch (c.name) {
    case 'tee':
      add(ops)
      break
    case 'sed':
    case 'gsed':
    case 'perl':
      if (c.args.some(a => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'))) add(ops)
      break
    case 'rm':
    case 'unlink':
    case 'truncate':
    case 'shred':
    case 'rmdir':
      add(ops, true)
      break
    case 'mv':
    case 'cp':
    case 'install':
    case 'ln':
    case 'rsync': {
      const t = c.args.findIndex(a => a === '-t' || a === '--target-directory')
      const dir = t >= 0 ? c.args[t + 1] : c.args.find(a => a.startsWith('--target-directory='))?.split('=')[1]
      const dest = dir ?? ops.at(-1)
      const sources = dir ? ops.filter(o => o !== dir) : ops.slice(0, -1)
      // rsync --delete removes what the destination has and the source lacks.
      const syncDeletes = c.name === 'rsync' && c.args.some(a => /^--del(?:ete(?:-[a-z]+)?)?$/.test(a))
      if (dest !== undefined) {
        add([dest], syncDeletes)
        // Copying into a directory writes <dir>/<name>.
        add(sources.map(s => `${dest.replace(/\/+$/, '')}/${base(s)}`))
      }
      if (c.name === 'mv' || (c.name === 'rsync' && c.args.includes('--remove-source-files'))) add(sources, true)
      break
    }
    case 'dd':
      add(c.args.filter(a => a.startsWith('of=')).map(a => a.slice(3)))
      break
    case 'find': {
      const plan = findPlan(c.args)
      for (const path of plan?.starts ?? []) targets.push(plan?.filter ? { path, deletes: true, filter: plan.filter } : { path, deletes: true })
      break
    }
    case 'git': {
      const plan = gitPlan(c.args)
      if (!plan) break
      /** @type {DeleteFilter} */
      const filter = cand => {
        // A directory goes only with its files, and git never touches its own directory.
        if (cand.dir || cand.rel === null) return false
        const status = gitStatus(cand.rel)
        return status !== 'tracked' && (plan.removes === 'all' || status === plan.removes)
      }
      for (const path of plan.paths) targets.push({ path, deletes: true, filter })
      break
    }
  }
  return targets
}

/**
 * A path with every symlink in it resolved, as far as it exists; the rest
 * is resolved lexically.
 *
 * @param {string} abs
 */
function realish(abs) {
  if (process.platform === 'win32') return resolve(abs)
  let cur = '/'
  let exists = true
  for (const part of abs.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      cur = dirname(cur)
      continue
    }
    const next = join(cur, part)
    if (exists) {
      try {
        cur = realpathSync(next)
        continue
      } catch {
        exists = false
      }
    }
    cur = next
  }
  return cur
}

const GLOB = /[*?[]/

/** @param {string} seg one path segment of a shell glob */
function segmentRegExp(seg) {
  let re = ''
  for (let i = 0; i < seg.length; i++) {
    const c = /** @type {string} */ (seg[i])
    const close = c === '[' ? seg.indexOf(']', i + 2) : -1
    if (c === '*') re += '.*'
    else if (c === '?') re += '.'
    else if (close > 0) {
      const cls = seg.slice(i + 1, close).replace(/^!/, '^').replace(/\\/g, '\\\\')
      re += `[${cls}]`
      i = close
    } else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

/**
 * Whether the shell would expand `pattern` to `path` (both relative to the
 * same place): wildcards stay within a segment and match a leading dot only
 * when the pattern spells it.
 *
 * @param {string} pattern
 * @param {string} path
 */
function globNames(pattern, path) {
  const ps = pattern.split('/')
  const xs = path.split('/')
  return (
    ps.length === xs.length &&
    ps.every((p, i) => {
      const x = /** @type {string} */ (xs[i])
      if (!GLOB.test(p)) return p === x
      return !(x.startsWith('.') && !p.startsWith('.')) && segmentRegExp(p).test(x)
    })
  )
}

/** @param {string} p a root-relative path, and every directory above it */
const withAncestors = p => p.split('/').map((_, i, a) => a.slice(0, i + 1).join('/'))

/** @param {string} abs every directory above an absolute path */
const ancestorsOf = abs => {
  const out = []
  for (let d = dirname(abs); ; d = dirname(d)) {
    out.push(d)
    if (dirname(d) === d) return out
  }
}

/** Whether absolute `a` is `b` or lies inside it. @param {string} a @param {string} b */
const under = (a, b) => a === b || b === '/' || a.startsWith(`${b}/`)

const MAX_LISTED = 2000

/**
 * Files and directories below `dir`, or null when there are too many to list.
 *
 * @param {string} dir
 */
function listTree(dir) {
  /** @type {{ p: string, dir: boolean }[]} */
  const out = []
  /** @param {string} d @returns {boolean} */
  const walk = d => {
    let entries
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return true
    }
    for (const e of entries) {
      const p = join(d, e.name)
      out.push({ p, dir: e.isDirectory() })
      if (out.length > MAX_LISTED || (e.isDirectory() && !walk(p))) return false
    }
    return true
  }
  return walk(dir) ? out : null
}

/**
 * Answers whether a path is protected, comparing paths the way the file
 * system does: `..`, `//` and symlinks resolved, and case folded on
 * case-insensitive systems. A target with wildcards is protected when the
 * shell could expand it to a protected path. `wholeDirs` are protected from
 * being deleted or moved as a whole; the tombstone (`g.tombstone`, in the
 * git directory) from any change.
 *
 * @param {GuardInput} g
 * @param {string[]} globs
 * @param {string[]} wholeDirs
 */
function protectedMatcher(g, globs, wholeDirs) {
  const ci = g.caseInsensitive ?? (process.platform === 'darwin' || process.platform === 'win32')
  const fold = (/** @type {string} */ s) => (ci ? s.toLowerCase() : s)
  const rootReal = realish(resolve(g.root))
  const root = fold(rootReal)
  const tomb = g.tombstone ? realish(resolve(g.tombstone)) : null
  const T = tomb ? fold(tomb) : null
  const folded = globs.map(x => fold(normalizePath(x)))
  // The protected paths without their wildcards: files, and directories whose trees are protected.
  const fileLiterals = folded.map(x => x.replace(/\/?\*\*.*$/, '').replace(/\*.*$/, '').replace(/\/+$/, '')).filter(Boolean)
  // Directories that hold a protected path: deleting or moving one deletes it.
  const literals = [...fileLiterals, ...wholeDirs.map(d => fold(normalizePath(d)).replace(/\/+$/, ''))]
  const wholeNames = [...new Set(literals.flatMap(withAncestors))]

  // The protected paths a wildcard could name: the literal files, and the
  // directories that hold any protected path (whose deletion deletes it).
  const files = folded.filter(x => !GLOB.test(x))

  /** @param {string} rel root-relative, folded */
  const hit = (rel, deletes = false) => {
    if (GLOB.test(rel)) {
      const names = deletes ? [...files, ...literals].flatMap(withAncestors) : files
      // A wildcard inside a protected tree (`evals/cases/*/expected.json`).
      return names.some(x => globNames(rel, x)) || matchesAny(rel.replace(/\[[^\]]*\]|[*?]/g, 'x'), folded.filter(x => GLOB.test(x)))
    }
    return matchesAny(rel, folded) || (deletes && literals.some(l => rel === '' || rel === '.' || l === rel || l.startsWith(`${rel}/`)))
  }

  /** @type {string[] | null} */
  let tombList = null
  const tombFiles = () => (tombList ??= tomb ? (listTree(tomb) ?? []).map(e => fold(e.p)) : [])
  /** @param {boolean} [deletes] */
  const tombNames = deletes => (T ? [T, ...tombFiles(), ...(deletes ? ancestorsOf(T) : [])] : [])

  /** @type {Candidate[] | null} */
  let cands = null
  /** Every path a filtered delete must not reach. */
  const candidates = () => {
    if (cands) return cands
    /** @type {Candidate[]} */
    const out = []
    const seen = new Set()
    const push = (/** @type {Candidate} */ c) => {
      const k = `${c.abs}\0${c.dir}`
      if (!seen.has(k)) seen.add(k), out.push(c)
    }
    const dirChain = (/** @type {string} */ rel) => {
      push({ abs: rootReal, rel: '', dir: true })
      for (const r of rel ? withAncestors(rel) : []) push({ abs: join(rootReal, r), rel: r, dir: true })
    }
    for (const x of globs.map(normalizePath)) {
      const parts = x.split('/')
      const g0 = parts.findIndex(p => GLOB.test(p))
      if (g0 < 0) {
        push({ abs: join(rootReal, x), rel: x, dir: false })
        dirChain(parts.slice(0, -1).join('/'))
        continue
      }
      const prefix = parts.slice(0, g0).join('/')
      dirChain(prefix)
      const listed = listTree(join(rootReal, prefix))
      if (!listed) push({ abs: join(rootReal, prefix), rel: prefix, dir: true, unknown: true })
      for (const e of listed ?? []) {
        const rel = e.p.slice(rootReal.length + 1)
        if (e.dir || matchesAny(rel, [x])) push({ abs: e.p, rel, dir: e.dir })
      }
    }
    for (const d of wholeDirs) dirChain(normalizePath(d).replace(/\/+$/, ''))
    if (tomb) {
      for (const a of ancestorsOf(tomb)) push({ abs: a, rel: null, dir: true, tomb: true })
      push({ abs: tomb, rel: null, dir: true, tomb: true })
      const listed = listTree(tomb)
      if (!listed) push({ abs: tomb, rel: null, dir: true, unknown: true, tomb: true })
      for (const e of listed ?? []) push({ abs: e.p, rel: null, dir: e.dir, tomb: true })
    }
    return (cands = out)
  }

  return {
    fold,
    /**
     * @param {string} target as written (absolute, or relative to `cwd`)
     * @param {{ deletes?: boolean, cwd?: string | null, filter?: DeleteFilter }} [o] cwd null: unknown (after `cd $X`)
     * @returns {'tomb' | 'loop' | null} what it would change: the tombstone, a protected loop file, or neither
     */
    isProtected(target, o = {}) {
      const t = normalizePath(target)
      if (!t || /^\d+$|^-$|^&/.test(t)) return null
      const dynamic = /[$`~]/.test(t)
      if (dynamic || (o.cwd === null && !t.startsWith('/'))) {
        // Unknown prefix ("$ROOT/...", "~/..."): judge what follows it as root-relative.
        const parts = t.split('/')
        let k = 0
        parts.forEach((p, j) => {
          if (/[$`~]/.test(p)) k = j + 1
        })
        const tail = parts.slice(k)
        // "$(git rev-parse --git-common-dir)/quality-loop/..." may be the tombstone.
        if (T) {
          if (tail.some(p => fold(p) === 'quality-loop' || fold(p) === '.git')) return 'tomb'
          if (o.deletes && !tail.some(p => p && p !== '.') && /\.git\b|git-(?:common-)?dir/.test(parts.slice(0, k).join('/'))) return 'tomb'
        }
        const rest = resolve('/', ...tail).slice(1)
        return hit(fold(rest), o.deletes) ? 'loop' : null
      }
      const abs = realish(resolve(o.cwd ?? g.cwd ?? g.root, t))
      const A = fold(abs)
      if (o.filter && o.deletes && !GLOB.test(t)) {
        const filter = o.filter
        const c = candidates().find(c => under(fold(c.abs), A) && (c.unknown || filter(c, abs, target)))
        return c ? (c.tomb ? 'tomb' : 'loop') : null
      }
      if (T && (GLOB.test(t) ? tombNames(o.deletes).some(x => globNames(A, x)) : under(A, T) || (o.deletes && under(T, A)))) return 'tomb'
      if (A !== root && !A.startsWith(`${root}/`)) return null
      return hit(A === root ? '' : A.slice(root.length + 1), o.deletes) ? 'loop' : null
    },
    /**
     * A protected path that a command line names, for commands whose paths
     * come from text the guard cannot follow (a script, xargs' input).
     *
     * @param {string} raw the whole command line
     * @param {{ deletes: boolean, xargs: boolean, outside: boolean }} o outside: xargs is fed only paths outside the repository
     * @returns {{ kind: 'tomb' | 'loop', name: string } | null}
     */
    named(raw, o) {
      const text = fold(raw)
      if (tomb && T && (text.includes(T) || /\.git\/+quality-loop\b/.test(text) || (/git-(?:common-)?dir/.test(text) && /(?<![\w.-])quality-loop\b/.test(text)))) {
        return { kind: 'tomb', name: tomb }
      }
      const file = fileLiterals.find(l => text.includes(l) || (o.xargs && !o.outside && text.includes(base(l))))
      if (file) return { kind: 'loop', name: file }
      // A directory named as a whole by a script that deletes or moves things.
      const esc = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const whole = o.deletes ? wholeNames.find(d => new RegExp(`(?<![\\w.-])${esc(d)}/?(?![\\w./-])`).test(text)) : undefined
      return whole ? { kind: 'loop', name: whole } : null
    },
    /**
     * Whether `p` (as written, relative to `cwd`) lies outside the repository
     * and the tombstone, and holds neither.
     *
     * @param {string} p
     * @param {string | null} cwd
     */
    outside(p, cwd) {
      if (/[$`~*?[]/.test(p) || (cwd === null && !p.startsWith('/'))) return false
      const A = fold(realish(resolve(cwd ?? g.cwd ?? g.root, p)))
      return !under(A, root) && !under(root, A) && !(T && (under(A, T) || under(T, A)))
    },
  }
}

// --- the guard ---------------------------------------------------------------

/**
 * @typedef {{
 *   tool: string,
 *   input: Record<string, any>,
 *   root: string,
 *   cwd?: string,
 *   loopStatus: string | null,
 *   protectedPaths: string[],
 *   blockDestructive: boolean,
 *   hillclimbActive: boolean,
 *   caseInsensitive?: boolean,
 *   tombstone?: string | null,
 *   restartLocked?: boolean,
 *   gitStatus?: GitStatus,
 * }} GuardInput
 *
 * `tombstone`: the directory in the git common dir that records each loop's
 * end, so deleting `.quality-loop/` cannot reset the round cap. Always
 * protected. `restartLocked`: `ql start` would refuse to start over the last
 * loop (its state, or its tombstone when the state is gone), so only the
 * user may force it. `gitStatus`: how git sees a root-relative path, for
 * judging `git clean` and `git stash -u`; guessed from the loop's own
 * .gitignore when not given.
 */

const LOOP_DIR = '.quality-loop'
const STATE_FILE = `${LOOP_DIR}/state.json`
// While hill climbing: the eval answer keys, and the config that holds the
// keep/revert thresholds (eval.minDelta, tolerance, seed, testFraction).
const HILLCLIMB_PATHS = [`${LOOP_DIR}/evals/**`, `${LOOP_DIR}/config.json`]
const EXTEND =
  'quality-loop: only the user may extend a capped or stalled loop. Report to the user and let them run `! ql extend` themselves.'
const RESTART =
  'quality-loop: only the user may start over a loop that has not finished: it would reset the round cap and archive the ledger. Report to the user; they can run `! ql start --force ...` (or `! ql extend`) themselves.'

/** @param {string} path */
const tombstoneDenial = path =>
  `quality-loop: ${path} is the loop tombstone in the git directory: it keeps a loop's round cap when .quality-loop/ is deleted, and only the user may change it.`

/**
 * @param {GuardInput} g
 * @returns {string | null} the reason to deny, or null to allow
 */
export function evaluateGuard(g) {
  const isLoopActive = g.loopStatus === 'active'
  const loopUnfinished = !!g.loopStatus && g.loopStatus !== 'done'
  // Only the user may start over: the loop has not finished, or its tombstone says so.
  const locked = loopUnfinished || !!g.restartLocked
  // While a loop runs, every protected path. Once it stops without finishing
  // (paused, capped, stalled, aborted), only the state, while the config is
  // free to edit again (its limits apply to the next loop). The round cap
  // itself rests on the tombstone, which `ql start` reads.
  const protectedPaths = isLoopActive
    ? [...g.protectedPaths]
    : loopUnfinished
      ? g.protectedPaths.filter(x => matchesAny(STATE_FILE, [x]))
      : []
  if (g.hillclimbActive) for (const x of HILLCLIMB_PATHS) if (!protectedPaths.includes(x)) protectedPaths.push(x)
  const wholeDirs = locked ? [LOOP_DIR] : []
  const guarded = protectedPaths.length > 0 || wholeDirs.length > 0 || !!g.tombstone
  const when = isLoopActive
    ? 'while the loop runs'
    : loopUnfinished
      ? `while the loop is ${g.loopStatus} (only the user may start it over)`
      : g.restartLocked
        ? 'while the last loop is unfinished (only the user may start it over)'
        : 'while hill climbing'
  const say = (/** @type {'tomb' | 'loop'} */ kind, /** @type {string} */ path) =>
    kind === 'tomb' ? tombstoneDenial(path) : `quality-loop: ${path} is protected ${when}; change it only through \`ql\` commands or ask the user.`

  if (g.tool === 'Bash') {
    const raw = String(g.input.command ?? '')
    const commands = parseCommands(raw)
    for (const q of qlInvocations(raw)) {
      if (q.sub === 'extend') return EXTEND
      if (q.sub === 'start' && q.flags.has('force') && locked) return RESTART
    }
    if ((isLoopActive || g.hillclimbActive) && g.blockDestructive) {
      for (const c of commands) {
        const why = destructive(c)
        if (why) {
          return `quality-loop: blocked during an active loop (${why}). The loop reverts its own rounds with checkpoints; if you really need this, pause the loop and ask the user.`
        }
      }
    }
    if (guarded) {
      const m = protectedMatcher(g, protectedPaths, wholeDirs)
      const gitStatus = g.gitStatus ?? guessGitStatus
      /** @type {string | null} */
      let cwd = g.cwd ?? g.root
      for (const c of commands) {
        if (c.name === 'cd') {
          const to = operands(c.args)[0]
          cwd = to === undefined || to === '-' || /[$`~]/.test(to) || cwd === null ? null : resolve(cwd, to)
          continue
        }
        for (const t of writeTargets(c, gitStatus)) {
          const kind = m.isProtected(t.path, { deletes: t.deletes, cwd, filter: t.filter })
          if (kind) return say(kind, t.path)
        }
        // A script, or xargs, gets its paths from text the guard cannot follow: judge it by what the command line names.
        const script = INTERPRETER.test(c.name) && SCRIPT_WRITE.test(raw)
        const xargs = !!c.xargs && DELETERS.has(c.name)
        if (script || xargs) {
          const finds = commands.filter(x => x.name === 'find')
          const here = cwd
          const outside = xargs && finds.length > 0 && finds.every(f => findParts(f.args).starts.every(s => m.outside(s, here)))
          const named = m.named(raw, { deletes: xargs || SCRIPT_DELETE.test(raw), xargs, outside })
          if (named) return say(named.kind, named.name)
        }
      }
    }
    return null
  }

  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(g.tool) && guarded) {
    const file = String(g.input.file_path ?? g.input.notebook_path ?? '')
    const kind = file ? protectedMatcher(g, protectedPaths, wholeDirs).isProtected(file) : null
    if (kind === 'tomb') return tombstoneDenial(file)
    if (kind) {
      return `quality-loop: ${file} is protected ${when} (loop limits, state and eval answer keys are not the agent's to change). Use \`ql\` commands or ask the user.`
    }
  }
  return null
}
