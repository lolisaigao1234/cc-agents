// Policy for the PreToolUse guard. Pure, apart from resolving symlinks in
// the paths it is asked about.
//
// It reads command text, so it is a seatbelt, not a sandbox: aliases,
// functions and scripts can get past it. Permission rules are the hard block.
// Commands are parsed the way a shell splits them: quoted text, heredoc
// bodies and arguments are data, so only a word in command position counts
// as a command (`rg 'rm -rf'` and `git commit -m "... reset --hard"` are
// fine), while `bash -c "..."`, `$(...)` and backticks are looked into.

import { realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { matchesAny, normalizePath } from './glob.mjs'

/**
 * One simple command: its name (basename of the command word, after
 * assignments and wrappers such as `sudo`, `env`, `xargs`), its arguments
 * with quotes removed, and the files it redirects output into.
 *
 * @typedef {{ name: string, args: string[], writes: string[] }} SimpleCommand
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
    if (redirect === 'write') writes.push(word)
    else if (redirect !== 'read') words.push(word)
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
      out.push({ name, args, writes })
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
      append(c)
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

/** @param {string[]} args */
function gitDestructive(args) {
  /** @type {string[]} */
  const config = []
  let i = 0
  while (i < args.length && /** @type {string} */ (args[i]).startsWith('-')) {
    const a = /** @type {string} */ (args[i])
    if (GIT_VALUE_OPTS.has(a)) {
      if (a === '-c' || a === '--config-env') config.push(args[i + 1] ?? '')
      i += 2
    } else {
      if (a.startsWith('--config-env=')) config.push(a.slice('--config-env='.length))
      i++
    }
  }
  const sub = args[i]
  const rest = args.slice(i + 1)
  const opts = beforeDashDash(rest)
  const long = (/** @type {string} */ f) => opts.some(x => x === f || x.startsWith(`${f}=`))

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

// A script that writes, moves or deletes files (node, python, ruby, perl).
const SCRIPT_WRITE =
  /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|rmSync|unlinkSync|renameSync|copyFileSync|write_text|write_bytes|os\.remove|os\.unlink|shutil\.\w+|File\.write)\b|\bopen\([^)]*,\s*["'][wax]/
const INTERPRETER = /^(?:node|nodejs|python[\d.]*|ruby|perl|deno|bun|php)$/

/**
 * The paths a command writes to: its redirects, and the file arguments of
 * commands that change files. `deletes` marks a path removed or moved away
 * (so a directory holding a protected file counts).
 *
 * @param {SimpleCommand} c
 * @returns {{ path: string, deletes: boolean }[]}
 */
function writeTargets(c) {
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
      if (dest !== undefined) {
        add([dest])
        // Copying into a directory writes <dir>/<name>.
        add(sources.map(s => `${dest.replace(/\/+$/, '')}/${base(s)}`))
      }
      if (c.name === 'mv') add(sources, true)
      break
    }
    case 'dd':
      add(c.args.filter(a => a.startsWith('of=')).map(a => a.slice(3)))
      break
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

/**
 * Answers whether a path is protected, comparing paths the way the file
 * system does: `..`, `//` and symlinks resolved, and case folded on
 * case-insensitive systems.
 *
 * @param {{ root: string, cwd?: string, caseInsensitive?: boolean }} g
 * @param {string[]} globs
 */
function protectedMatcher(g, globs) {
  const ci = g.caseInsensitive ?? (process.platform === 'darwin' || process.platform === 'win32')
  const fold = (/** @type {string} */ s) => (ci ? s.toLowerCase() : s)
  const root = fold(realish(resolve(g.root)))
  const folded = globs.map(x => fold(normalizePath(x)))
  // Directories that hold a protected path: deleting or moving one deletes it.
  const literals = folded.map(x => x.replace(/\/?\*\*.*$/, '').replace(/\*.*$/, '').replace(/\/+$/, '')).filter(Boolean)

  /** @param {string} rel root-relative, folded */
  const hit = (rel, deletes = false) =>
    matchesAny(rel, folded) || (deletes && literals.some(l => rel === '' || rel === '.' || l === rel || l.startsWith(`${rel}/`)))

  /** @param {string} abs */
  const relOf = abs => {
    const p = fold(realish(abs))
    if (p === root) return ''
    return p.startsWith(`${root}/`) ? p.slice(root.length + 1) : null
  }

  return {
    literals,
    fold,
    /**
     * @param {string} target as written (absolute, or relative to `cwd`)
     * @param {{ deletes?: boolean, cwd?: string | null }} [o] cwd null: unknown (after `cd $X`)
     */
    isProtected(target, o = {}) {
      const t = normalizePath(target)
      if (!t || /^\d+$|^-$|^&/.test(t)) return false
      const dynamic = /[$`~]/.test(t)
      if (dynamic || (o.cwd === null && !t.startsWith('/'))) {
        // Unknown prefix ("$ROOT/...", "~/..."): judge what follows it as root-relative.
        const parts = t.split('/')
        let k = 0
        parts.forEach((p, j) => {
          if (/[$`~]/.test(p)) k = j + 1
        })
        const rest = resolve('/', ...parts.slice(k)).slice(1)
        return hit(fold(rest), o.deletes)
      }
      const rel = relOf(resolve(o.cwd ?? g.cwd ?? g.root, t))
      return rel !== null && hit(rel, o.deletes)
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
 * }} GuardInput
 */

const EXTEND =
  'quality-loop: only the user may extend a capped or stalled loop. Report to the user and let them run `! ql extend` themselves.'
const RESTART =
  'quality-loop: only the user may start over a loop that has not finished: it would reset the round cap and archive the ledger. Report to the user; they can run `! ql start --force ...` (or `! ql extend`) themselves.'

/**
 * @param {GuardInput} g
 * @returns {string | null} the reason to deny, or null to allow
 */
export function evaluateGuard(g) {
  const isLoopActive = g.loopStatus === 'active'
  // A loop that has not finished (active, paused, capped, stalled, aborted)
  // keeps its limits and state out of the agent's hands.
  const loopUnfinished = !!g.loopStatus && g.loopStatus !== 'done'
  const protectFiles = loopUnfinished || g.hillclimbActive
  const protectedPaths = [...g.protectedPaths]
  if (g.hillclimbActive) protectedPaths.push('.quality-loop/evals/**')

  if (g.tool === 'Bash') {
    const raw = String(g.input.command ?? '')
    const commands = parseCommands(raw)
    for (const q of qlInvocations(raw)) {
      if (q.sub === 'extend') return EXTEND
      if (q.sub === 'start' && q.flags.has('force') && loopUnfinished) return RESTART
    }
    if ((isLoopActive || g.hillclimbActive) && g.blockDestructive) {
      for (const c of commands) {
        const why = destructive(c)
        if (why) {
          return `quality-loop: blocked during an active loop (${why}). The loop reverts its own rounds with checkpoints; if you really need this, pause the loop and ask the user.`
        }
      }
    }
    if (protectFiles) {
      const m = protectedMatcher(g, protectedPaths)
      /** @type {string | null} */
      let cwd = g.cwd ?? g.root
      for (const c of commands) {
        if (c.name === 'cd') {
          const to = operands(c.args)[0]
          cwd = to === undefined || to === '-' || /[$`~]/.test(to) || cwd === null ? null : resolve(cwd, to)
          continue
        }
        for (const t of writeTargets(c)) {
          if (m.isProtected(t.path, { deletes: t.deletes, cwd })) {
            return `quality-loop: ${t.path} is protected while the loop runs; change it only through \`ql\` commands or ask the user.`
          }
        }
        if (INTERPRETER.test(c.name) && SCRIPT_WRITE.test(raw)) {
          const lit = m.literals.find(l => m.fold(raw).includes(l))
          if (lit) return `quality-loop: ${lit} is protected while the loop runs; change it only through \`ql\` commands or ask the user.`
        }
      }
    }
    return null
  }

  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(g.tool) && protectFiles) {
    const file = String(g.input.file_path ?? g.input.notebook_path ?? '')
    if (file && protectedMatcher(g, protectedPaths).isProtected(file)) {
      return `quality-loop: ${file} is protected while the loop runs (loop limits, state and eval answer keys are not the agent's to change). Use \`ql\` commands or ask the user.`
    }
  }
  return null
}
