// Splits shell command text the way a shell does, so a rule can tell a
// command that runs from text that only mentions one. Quoted text, heredoc
// bodies and arguments are data: only a word in command position counts as a
// command (`rg 'rm -rf'` and `git commit -m "... reset --hard"` are fine),
// while `bash -c "..."`, `$(...)` and backticks are looked into.

/**
 * One simple command: its name (basename of the command word, after
 * assignments and wrappers such as `sudo`, `env`, `xargs`), its arguments
 * with quotes removed, and the files its redirections name, for input or
 * output (a path rule needs them, since they are not arguments). `chdir`
 * is a directory a wrapper runs it in (`env -C`, `sudo -D`). `level` is
 * how deep in subshells and nested scripts it runs, and `op` the operator
 * after it (`&&`, `||`, `;`, `|`, `&`), so a rule can follow a `cd`.
 * `stdin` is the text a heredoc or here-string feeds it, when that is its
 * last input redirection, and `piped` says another command's output does.
 * `stdinLiteral` says that text is a quoted heredoc's, which the shell does
 * not expand. `env` names the variables its assignments and `env` wrapper set.
 *
 * @typedef {{ name: string, args: string[], files: string[], chdir?: string, level: number, op?: string, stdin?: string, stdinLiteral?: boolean, piped?: boolean, env?: string[] }} SimpleCommand
 */

import { homedir } from 'node:os'
import { resolve } from 'node:path'

import { CASE_INSENSITIVE_FS, untilde } from './paths.mjs'

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish'])
const KEYWORDS = new Set(['!', '{', '}', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'time'])

/** @param {string | undefined} w the command a word names, case-folded where the file system folds case */
const base = w => {
  const b = (w ?? '').replace(/\/+$/, '').split('/').pop() ?? ''
  return CASE_INSENSITIVE_FS ? b.toLowerCase() : b
}

/** @param {string} w @returns {boolean} whether the shell computes part of `w` */
export const computed = w => /[$`]/.test(w)

/**
 * Drops leading keywords, `VAR=value` assignments and wrapper commands, so
 * the first word left is the command that runs. Also returns the directory
 * a wrapper changes to, the command line `env -S` or `script -c` runs, and
 * the variables set on the way.
 *
 * @param {string[]} words
 * @returns {{ words: string[], chdir?: string, split?: string, inputs: string[], env: string[] }}
 */
function unwrap(words) {
  const w = [...words]
  /** @type {string[]} files a wrapper reads (`xargs -a`) */
  const inputs = []
  /** @type {string[]} */
  const env = []
  const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/
  /** @type {string | undefined} */
  let chdir
  /** @type {string | undefined} */
  let split
  /** @param {RegExp} [takesValue] */
  const dropFlags = takesValue => {
    while (w[0]?.startsWith('-')) {
      const f = /** @type {string} */ (w.shift())
      if (takesValue?.test(f)) {
        const v = w.shift()
        if (/^(?:-D|--chdir)$/.test(f)) chdir = v
        if (f === '-a' && v !== undefined && name === 'xargs') inputs.push(v)
      } else if (f.startsWith('--chdir=')) chdir = f.slice('--chdir='.length)
    }
  }
  let name = ''
  for (;;) {
    while (w.length && (KEYWORDS.has(/** @type {string} */ (w[0])) || ASSIGN.test(/** @type {string} */ (w[0])))) {
      const m = ASSIGN.exec(/** @type {string} */ (w.shift()))
      if (m) env.push(/** @type {string} */ (m[1]))
    }
    name = base(w[0])
    if (name === 'env') {
      w.shift()
      while (w[0] !== undefined && (w[0].startsWith('-') || w[0].includes('='))) {
        const f = /** @type {string} */ (w.shift())
        const m = ASSIGN.exec(f)
        if (m) env.push(/** @type {string} */ (m[1]))
        else if (f === '-u' || f === '--unset' || f === '-P') w.shift()
        else if (f === '-C' || f === '--chdir') chdir = w.shift()
        else if (f.startsWith('--chdir=')) chdir = f.slice('--chdir='.length)
        else if (f === '-S' || f === '--split-string') split = w.shift()
        else if (f.startsWith('--split-string=')) split = f.slice('--split-string='.length)
      }
    } else if (name === 'sudo' || name === 'doas') {
      w.shift()
      dropFlags(/^(?:-[ugCDhpRrTt]|--chdir)$/)
    } else if (['command', 'exec', 'nohup', 'builtin', 'noglob', 'time'].includes(name)) {
      w.shift()
      dropFlags(name === 'exec' ? /^-a$/ : undefined)
    } else if (name === 'arch') {
      w.shift()
      dropFlags(/^-(?:arch|d|e)$/)
    } else if (name === 'script') {
      // script [options] [file [command ...]]; util-linux runs `-c command`.
      w.shift()
      while (w[0]?.startsWith('-')) {
        const f = /** @type {string} */ (w.shift())
        if (/^-[tFTIBOE]$/.test(f)) w.shift()
        else if (f === '-c' || f === '--command') split = w.shift()
      }
      w.shift() // the typescript file
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
    } else if (name === 'stdbuf' || name === 'caffeinate' || name === 'unbuffer') {
      w.shift()
      dropFlags(name === 'stdbuf' ? /^-[ioe]$/ : name === 'caffeinate' ? /^-[tw]$/ : undefined)
    } else return { words: w, chdir, split, inputs, env }
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
const LB = '\uE000'
const CM = '\uE001'
const RB = '\uE002'
const BRACE_CHARS = { [LB]: '{', [CM]: ',', [RB]: '}' }

/**
 * The words a word brace-expands to, as bash and zsh expand it
 * (`a{b,c}d` is `abd acd`; `{}` and `{x}` stay as they are).
 *
 * @param {string} w a word with its unquoted braces and commas marked
 * @param {{ left: number }} [budget] how many more words it may make
 * @returns {string[]}
 */
function expandBraces(w, budget = { left: 64 }) {
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
      if (budget.left <= 0) break
      out.push(...expandBraces(w.slice(0, i) + w.slice(from, k) + w.slice(close + 1), budget))
      from = k + 1
    }
    return out
  }
  budget.left--
  return [w.replace(/[\uE000-\uE002]/g, ch => BRACE_CHARS[/** @type {keyof typeof BRACE_CHARS} */ (ch)])]
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
  /** `here`: it runs in this shell (`eval`), so its `cd` lasts. */
  const nested = (/** @type {string} */ s, here = false) => {
    for (const c of parseCommands(s, depth + 1)) out.push({ ...c, level: here ? c.level + parens : c.level + 100 * (depth + 1) + parens + 1 })
  }
  let parens = 0

  /** @type {string[]} */
  let words = []
  /** @type {string[]} */
  let files = []
  /** @type {string | null} */
  let word = null
  /** `dup`: after `>&`, where a descriptor number or `-` names no file. @type {'file' | 'dup' | 'data' | null} */
  let redirect = null
  /**
   * Heredocs waiting for their bodies: `owner` is the command each belongs
   * to, `feeds` whether it is that command's stdin.
   *
   * @typedef {{ delim: string, quoted: boolean, strip: boolean, words: string[], owner?: SimpleCommand | null, feeds?: boolean }} Heredoc
   * @type {Heredoc[]}
   */
  let heredocs = []
  /** @type {string | undefined} a here-string's text */
  let herestring
  /** The command's last stdin redirection. @type {Heredoc | 'here' | 'file' | null} */
  let lastInput = null
  let prevOp = ''

  const append = (/** @type {string} */ s) => {
    word = (word ?? '') + s
  }
  const endWord = () => {
    if (word === null) return
    // An argument ends at a NUL, which $'\0' can write.
    if (word.includes('\0')) word = word.slice(0, word.indexOf('\0'))
    const expanded = expandBraces(word)
    if (redirect === 'file' || (redirect === 'dup' && !/^(?:\d+-?|-)$/.test(word))) files.push(...expanded)
    else if (redirect === 'data') herestring = word
    else if (redirect === null) words.push(...expanded)
    redirect = null
    word = null
  }
  const endCommand = (/** @type {string} */ op = '') => {
    endWord()
    redirect = null
    if (words.length || files.length) {
      const { words: w, chdir, split, inputs, env } = unwrap(words)
      const name = base(w[0])
      const args = w.slice(1)
      /** @type {SimpleCommand} */
      const cmd = { name, args, files: [...files, ...inputs], level: parens }
      if (chdir !== undefined) cmd.chdir = chdir
      if (env.length) cmd.env = env
      if (op) cmd.op = op
      if (lastInput === 'here' && herestring !== undefined) cmd.stdin = herestring
      if (prevOp === '|') cmd.piped = true
      for (const h of heredocs) {
        if (h.owner !== undefined) continue
        h.owner = cmd
        h.feeds = lastInput === h
      }
      out.push(cmd)
      if (split !== undefined) nested(split)
      if (SHELLS.has(name)) {
        const c = args.findIndex(a => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a))
        const script = args[c + 1] === '--' ? args[c + 2] : args[c + 1]
        if (c >= 0 && script !== undefined) nested(script)
        else if (cmd.stdin !== undefined) nested(cmd.stdin)
      } else if (name === 'eval') nested(args.join(' '), true)
      else if (name === 'watch') nested(args.filter(a => !a.startsWith('-')).join(' '))
      else if (name === 'find') {
        // -exec and -ok run a command, with `{}` standing for each path.
        const quote = (/** @type {string} */ a) => (/[\s'"$`\\;&|<>(){}*?[\]]/.test(a) ? `'${a.replace(/'/g, `'\\''`)}'` : a)
        args.forEach((a, i) => {
          if (!/^-(?:exec|execdir|ok|okdir)$/.test(a)) return
          const end = args.findIndex((x, j) => j > i && (x === ';' || x === '+'))
          nested(args.slice(i + 1, end < 0 ? undefined : end).map(quote).join(' '))
        })
      }
    }
    for (const h of heredocs) h.owner ??= null
    words = []
    files = []
    herestring = undefined
    lastInput = null
    prevOp = op
  }

  const n = src.length
  let i = 0
  while (i < n) {
    const c = /** @type {string} */ (src[i])
    if (c === '\n') {
      const pending = heredocs
      endCommand(';')
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
        // An unquoted heredoc joins lines ending in a backslash, as the shell does.
        const text = h.quoted ? body.join('\n') : body.join('\n').replace(/\\\n/g, '')
        // A heredoc fed to a shell is a script; fed to anything else it is data.
        if (SHELLS.has(base(unwrap(h.words).words[0]))) nested(text)
        else if (h.owner && h.feeds) Object.assign(h.owner, { stdin: text, stdinLiteral: h.quoted })
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
    } else if (c === '$' && src[i + 1] === "'") {
      // $'...' quoting, with its backslash escapes.
      let j = i + 2
      for (; j < n && src[j] !== "'"; j++) {
        if (src[j] !== '\\') {
          append(/** @type {string} */ (src[j]))
          continue
        }
        const e = src[++j] ?? ''
        const hex = e === 'x' ? /^[0-9a-fA-F]{1,2}/.exec(src.slice(j + 1)) : null
        const oct = /^[0-7]{1,3}/.exec(src.slice(j))
        if (hex) {
          append(String.fromCharCode(parseInt(hex[0], 16)))
          j += hex[0].length
        } else if (oct) {
          append(String.fromCharCode(parseInt(oct[0], 8)))
          j += oct[0].length - 1
        } else append({ n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', f: '\f', v: '\v' }[e] ?? e)
      }
      i = j + 1
    } else if (c === '$' && src[i + 1] === '"') {
      i++ // $"..." is double-quoted text
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
    } else if (c === '(' && (word !== null || words.length > 0) && !KEYWORDS.has(/** @type {string} */ (words[words.length - 1]))) {
      // In argument position, `(a|b)` is a zsh glob group; it is also read as commands, in case it is a subshell.
      const k = closingParen(src, i)
      nested(src.slice(i + 1, k))
      append(src.slice(i, k + 1))
      i = k + 1
    } else if (c === '(' || c === ')') {
      endCommand()
      parens += c === '(' ? 1 : -1
      i++
    } else if (c === ';' || c === '|') {
      const op = src[i + 1] === c ? c + c : c
      endCommand(op === ';;' ? ';' : op)
      i += op.length
    } else if (c === '&') {
      if (src[i + 1] === '>') {
        endWord()
        redirect = 'file'
        i += src[i + 2] === '>' ? 3 : 2
      } else {
        endCommand(src[i + 1] === '&' ? '&&' : '&')
        i += src[i + 1] === '&' ? 2 : 1
      }
    } else if (c === '>' || c === '<') {
      // A file descriptor number written right before the operator is part of it.
      /** @type {string | null} */
      let fd = null
      if (word !== null && /^\d+$/.test(word)) [fd, word] = [word, null]
      endWord()
      const stdin = fd === null || fd === '0'
      if (c === '<' && src[i + 1] === '<' && src[i + 2] === '<') {
        redirect = 'data' // here-string: the next word is input text
        if (stdin) lastInput = 'here'
        i += 3
      } else if (c === '<' && src[i + 1] === '<') {
        let j = i + 2
        const strip = src[j] === '-'
        if (strip) j++
        while (src[j] === ' ' || src[j] === '\t') j++
        let delim = ''
        while (j < n && !/[\s;&|<>()]/.test(/** @type {string} */ (src[j]))) delim += src[j++]
        const h = { delim: delim.replace(/["'\\]/g, ''), quoted: /["'\\]/.test(delim), strip, words: [...words] }
        heredocs.push(h)
        if (stdin) lastInput = h
        i = j
      } else if (c === '<') {
        if (stdin) lastInput = 'file'
        redirect = src[i + 1] === '&' ? 'dup' : 'file'
        i += src[i + 1] === '>' || src[i + 1] === '&' ? 2 : 1
      } else {
        let k = i + 1
        if (src[k] === '>' || src[k] === '|') k++
        redirect = src[k] === '&' ? 'dup' : 'file'
        if (src[k] === '&') k++
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

// --- following cd -------------------------------------------------------------

/**
 * Each simple command of `command`, with the directories it may run in:
 * `cwds` before its own wrapper's directory, `at` after it. Only a `cd`
 * chained with `&&` (and not after `||`) is certain; any other adds its
 * target as one more candidate, and a subshell's `cd` ends with it.
 * `unknown` says a `cd` the shell computes came before.
 *
 * @param {string} command
 * @param {string} cwd
 * @returns {Generator<{ c: SimpleCommand, cwds: string[], at: string[], unknown: boolean }>}
 */
export function* withCwds(command, cwd) {
  /** @type {{ level: number, cwds: string[], unknown: boolean, prevOp?: string }[]} */
  const stack = [{ level: 0, cwds: [cwd], unknown: false }]
  const seen = new Set([cwd])
  // With CDPATH set, `cd name` may enter a directory elsewhere.
  let cdpath = Boolean(process.env.CDPATH)
  for (const c of parseCommands(command)) {
    while (stack.length > 1 && c.level < /** @type {{ level: number }} */ (stack[stack.length - 1]).level) stack.pop()
    let top = /** @type {(typeof stack)[number]} */ (stack[stack.length - 1])
    if (c.level > top.level) stack.push((top = { level: c.level, cwds: [...top.cwds], unknown: top.unknown }))
    const { cwds, unknown } = top
    const prevOp = top.prevOp
    top.prevOp = c.op
    const at = c.chdir === undefined ? cwds : cwds.map(d => resolve(d, untilde(/** @type {string} */ (c.chdir), d)))
    yield { c, cwds, at, unknown: unknown || computed(c.chdir ?? '') }
    if (c.env?.includes('CDPATH') || (DECLARES.has(c.name) && c.args.some(a => /^CDPATH(?:=|$)/.test(a)))) cdpath = true
    const t = cdTarget(c)
    if (t === null) continue
    if (t === 'back') {
      top.cwds = [...new Set([...cwds, ...seen])]
    } else if (t === 'unknown' || (cdpath && !/^[./~]/.test(t.to))) {
      top.unknown = true
    } else {
      const targets = cwds.map(d => resolve(d, untilde(t.to, d)))
      for (const d of targets) seen.add(d)
      top.cwds = c.op === '&&' && prevOp !== '||' ? targets : [...new Set([...cwds, ...targets])]
    }
  }
}

const DECLARES = new Set(['export', 'declare', 'typeset', 'readonly', 'local'])

/**
 * Where a `cd`, `pushd` or `popd` goes: a literal directory, `back` to one
 * entered before, or `unknown` when the shell computes it. Null for any
 * other command.
 *
 * @param {SimpleCommand} c
 * @returns {{ to: string } | 'back' | 'unknown' | null}
 */
export function cdTarget(c) {
  if (c.name !== 'cd' && c.name !== 'pushd' && c.name !== 'popd') return null
  if (c.name === 'popd') return 'back'
  const ops = c.args.filter(a => !/^-[LPen@]+$/.test(a) && a !== '--')
  const to = ops[0]
  // A bare pushd swaps the top two directories; zsh's `cd old new` substitutes.
  if (to === undefined) return c.name === 'pushd' ? 'back' : { to: '~' }
  if (ops.length > 1) return 'unknown'
  if (to === '-' || /^[+-]\d+$/.test(to)) return 'back'
  return computed(to) ? 'unknown' : { to }
}

// --- reading options ------------------------------------------------------

/**
 * A command's options: each long name, with its short letter and whether it
 * takes a value ('required', or 'optional' when only a glued `=` or cluster
 * value counts).
 *
 * @typedef {Record<string, { short?: string, value?: 'required' | 'optional' }>} OptionTable
 */

/**
 * Reads `args` against `table`, in order: clusters (`-am x`), glued values
 * (`-mx`, `--message=x`), `--no-<name>` negations and `--`. With `abbrev`, a
 * unique prefix of a long name counts, as git's option parser allows. With
 * `pflag`, a short option's glued value may start with `=` (`-F=x`), as
 * gh's parser allows. `unknown` is the first option the table does not know.
 *
 * @param {string[]} args
 * @param {OptionTable} table
 * @param {{ abbrev?: boolean, pflag?: boolean }} [o]
 * @returns {{ opts: [string, string | undefined][], operands: string[], unknown: string | null }}
 */
export function readOptions(args, table, { abbrev = false, pflag = false } = {}) {
  /** @type {[string, string | undefined][]} */
  const opts = []
  /** @type {string[]} */
  const operands = []
  /** @type {string | null} */
  let unknown = null
  const shorts = new Map(Object.entries(table).flatMap(([name, o]) => (o.short ? [[o.short, name]] : [])))
  const longs = [...Object.keys(table), ...Object.keys(table).map(n => `no-${n}`)]
  /** @param {string} name @returns {string | undefined} */
  const longName = name => {
    if (longs.includes(name)) return name
    const prefixed = abbrev ? longs.filter(l => l.startsWith(name)) : []
    return prefixed.length === 1 ? prefixed[0] : undefined
  }
  for (let i = 0; i < args.length; i++) {
    const a = /** @type {string} */ (args[i])
    if (a === '--') {
      operands.push(...args.slice(i + 1))
      break
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      const name = longName(eq < 0 ? a.slice(2) : a.slice(2, eq))
      if (name === undefined) {
        unknown ??= a
        continue
      }
      const takes = name.startsWith('no-') && !table[name] ? undefined : table[name]?.value
      opts.push([name, eq >= 0 ? a.slice(eq + 1) : takes === 'required' ? args[++i] : undefined])
      continue
    }
    if (!/^-./.test(a)) {
      operands.push(a)
      continue
    }
    for (let j = 1; j < a.length; j++) {
      const name = shorts.get(/** @type {string} */ (a[j]))
      if (name === undefined) {
        unknown ??= a
        break
      }
      const takes = table[name]?.value
      if (!takes) {
        opts.push([name, undefined])
        continue
      }
      const glued = pflag && a[j + 1] === '=' ? a.slice(j + 2) : a.slice(j + 1)
      opts.push([name, j + 1 < a.length ? glued : takes === 'required' ? args[++i] : undefined])
      break
    }
  }
  return { opts, operands, unknown }
}

// git commit's options, from `git commit -h`.
/** @type {OptionTable} */
export const GIT_COMMIT_OPTIONS = {
  message: { short: 'm', value: 'required' },
  file: { short: 'F', value: 'required' },
  'reuse-message': { short: 'C', value: 'required' },
  'reedit-message': { short: 'c', value: 'required' },
  template: { short: 't', value: 'required' },
  fixup: { value: 'required' },
  squash: { value: 'required' },
  cleanup: { value: 'required' },
  author: { value: 'required' },
  date: { value: 'required' },
  trailer: { value: 'required' },
  'pathspec-from-file': { value: 'required' },
  unified: { short: 'U', value: 'required' },
  'inter-hunk-context': { value: 'required' },
  'gpg-sign': { short: 'S', value: 'optional' },
  'untracked-files': { short: 'u', value: 'optional' },
  ...Object.fromEntries(
    [['quiet', 'q'], ['verbose', 'v'], ['signoff', 's'], ['edit', 'e'], ['all', 'a'], ['include', 'i'], ['patch', 'p'], ['only', 'o'], ['no-verify', 'n'], ['null', 'z']].map(([l, s]) => [l, { short: s }]),
  ),
  ...Object.fromEntries(
    ['reset-author', 'interactive', 'verify', 'dry-run', 'short', 'branch', 'ahead-behind', 'porcelain', 'long', 'amend', 'post-rewrite', 'status', 'pathspec-file-nul', 'allow-empty', 'allow-empty-message'].map(l => [l, {}]),
  ),
}

/** @param {string[]} args the arguments before a `--` */
export const beforeDashDash = args => {
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
export function shortFlags(args, valueLetters = '') {
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
 * Indexes of the operands (non-option arguments) in `args`. A short option
 * whose letter is in `valueLetters`, or a long option in `valueLongs`,
 * takes a value: the rest of its cluster or the next argument.
 *
 * @param {string[]} args
 * @param {string} [valueLetters]
 * @param {string[]} [valueLongs]
 */
export function operandIndexes(args, valueLetters = '', valueLongs = []) {
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

/** @param {string[]} args @param {string} [valueLetters] @param {string[]} [valueLongs] */
export const operands = (args, valueLetters, valueLongs) => operandIndexes(args, valueLetters, valueLongs).map(i => /** @type {string} */ (args[i]))

/** @param {string} kv `key=NAME` @returns {string} `key=$NAME` */
const fromEnv = kv => kv.replace(/=/, '=$')

const GIT_VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env'])

/**
 * A git invocation split into its global options, its subcommand and the
 * subcommand's arguments: `config` holds the `-c` settings, `dirs` the `-C`
 * directories, and `relocated` says whether `--git-dir` or `--work-tree`
 * points git somewhere else. A `--config-env` setting's value reads
 * `$NAME`, since the environment holds it.
 *
 * @param {string[]} args
 */
export function gitParts(args) {
  /** @type {string[]} */
  const config = []
  /** @type {string[]} */
  const dirs = []
  let relocated = false
  let i = 0
  while (i < args.length && /** @type {string} */ (args[i]).startsWith('-')) {
    const a = /** @type {string} */ (args[i])
    if (/^--(?:git-dir|work-tree)\b/.test(a)) relocated = true
    if (GIT_VALUE_OPTS.has(a)) {
      if (a === '-c') config.push(args[i + 1] ?? '')
      if (a === '--config-env') config.push(fromEnv(args[i + 1] ?? ''))
      if (a === '-C') dirs.push(args[i + 1] ?? '.')
      i += 2
    } else {
      if (a.startsWith('--config-env=')) config.push(fromEnv(a.slice('--config-env='.length)))
      i++
    }
  }
  const rest = args.slice(i + 1)
  const opts = beforeDashDash(rest)
  return { config, dirs, relocated, sub: args[i], rest, opts, long: (/** @type {string} */ f) => opts.some(x => x === f || x.startsWith(`${f}=`)) }
}
