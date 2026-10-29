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
 *
 * @typedef {{ name: string, args: string[], files: string[], chdir?: string, level: number, op?: string }} SimpleCommand
 */

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish'])
const KEYWORDS = new Set(['!', '{', '}', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'time'])

/** @param {string | undefined} w */
const base = w => (w ?? '').replace(/\/+$/, '').split('/').pop() ?? ''

/**
 * Drops leading keywords, `VAR=value` assignments and wrapper commands, so
 * the first word left is the command that runs. Also returns the directory
 * a wrapper changes to, and the command line `env -S` splits.
 *
 * @param {string[]} words
 * @returns {{ words: string[], chdir?: string, split?: string, inputs: string[] }}
 */
function unwrap(words) {
  const w = [...words]
  /** @type {string[]} files a wrapper reads (`xargs -a`) */
  const inputs = []
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
        if (f === '-a' && v !== undefined) inputs.push(v)
      } else if (f.startsWith('--chdir=')) chdir = f.slice('--chdir='.length)
    }
  }
  for (;;) {
    while (w.length && (KEYWORDS.has(/** @type {string} */ (w[0])) || /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(/** @type {string} */ (w[0])))) w.shift()
    const name = base(w[0])
    if (name === 'env') {
      w.shift()
      while (w[0] !== undefined && (w[0].startsWith('-') || w[0].includes('='))) {
        const f = /** @type {string} */ (w.shift())
        if (f === '-u' || f === '--unset') w.shift()
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
    } else if (name === 'stdbuf' || name === 'caffeinate' || name === 'unbuffer') {
      w.shift()
      dropFlags(name === 'stdbuf' ? /^-[ioe]$/ : name === 'caffeinate' ? /^-[tw]$/ : undefined)
    } else return { words: w, chdir, split, inputs }
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
  const nested = (/** @type {string} */ s) => {
    for (const c of parseCommands(s, depth + 1)) out.push({ ...c, level: c.level + 100 * (depth + 1) + parens + 1 })
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
  /** @type {{ delim: string, strip: boolean, words: string[] }[]} */
  let heredocs = []

  const append = (/** @type {string} */ s) => {
    word = (word ?? '') + s
  }
  const endWord = () => {
    if (word === null) return
    const expanded = expandBraces(word)
    if (redirect === 'file' || (redirect === 'dup' && !/^(?:\d+-?|-)$/.test(word))) files.push(...expanded)
    else if (redirect === null) words.push(...expanded)
    redirect = null
    word = null
  }
  const endCommand = (/** @type {string} */ op = '') => {
    endWord()
    redirect = null
    if (words.length || files.length) {
      const { words: w, chdir, split, inputs } = unwrap(words)
      const name = base(w[0])
      const args = w.slice(1)
      /** @type {SimpleCommand} */
      const cmd = { name, args, files: [...files, ...inputs], level: parens }
      if (chdir !== undefined) cmd.chdir = chdir
      if (op) cmd.op = op
      out.push(cmd)
      if (split !== undefined) nested(split)
      if (SHELLS.has(name)) {
        const c = args.findIndex(a => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a))
        if (c >= 0 && args[c + 1] !== undefined) nested(/** @type {string} */ (args[c + 1]))
      } else if (name === 'eval') nested(args.join(' '))
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
    words = []
    files = []
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
        // A heredoc fed to a shell is a script; fed to anything else it is data.
        if (SHELLS.has(base(unwrap(h.words).words[0]))) nested(body.join('\n'))
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
      if (word !== null && /^\d+$/.test(word)) word = null
      endWord()
      if (c === '<' && src[i + 1] === '<' && src[i + 2] === '<') {
        redirect = 'data' // here-string: the next word is input text
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

// --- reading options ------------------------------------------------------

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

const GIT_VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env'])

/**
 * A git invocation split into its global options, its subcommand and the
 * subcommand's arguments: `config` holds the `-c` settings, `dirs` the `-C`
 * directories, and `relocated` says whether `--git-dir` or `--work-tree`
 * points git somewhere else.
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
  return { config, dirs, relocated, sub: args[i], rest, opts, long: (/** @type {string} */ f) => opts.some(x => x === f || x.startsWith(`${f}=`)) }
}
