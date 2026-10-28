// Splits shell command text the way a shell does, so a rule can tell a
// command that runs from text that only mentions one. Quoted text, heredoc
// bodies and arguments are data: only a word in command position counts as a
// command (`rg 'rm -rf'` and `git commit -m "... reset --hard"` are fine),
// while `bash -c "..."`, `$(...)` and backticks are looked into.

/**
 * One simple command: its name (basename of the command word, after
 * assignments and wrappers such as `sudo`, `env`, `xargs`), its arguments
 * with quotes removed, and the files its redirections name, for input or
 * output (a path rule needs them, since they are not arguments).
 *
 * @typedef {{ name: string, args: string[], files: string[] }} SimpleCommand
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
const LB = '\uE000'
const CM = '\uE001'
const RB = '\uE002'
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
    for (const c of parseCommands(s, depth + 1)) out.push(c)
  }

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
  const endCommand = () => {
    endWord()
    redirect = null
    if (words.length || files.length) {
      const w = unwrap(words)
      const name = base(w[0])
      const args = w.slice(1)
      out.push({ name, args, files })
      if (SHELLS.has(name)) {
        const c = args.findIndex(a => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a))
        if (c >= 0 && args[c + 1] !== undefined) nested(/** @type {string} */ (args[c + 1]))
      } else if (name === 'eval') nested(args.join(' '))
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
        redirect = 'file'
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
