// Generated shell text, read by the plugin and by bash (#62). Every hard
// block that reads a Bash command rests on the plugin reading it as the
// shell that runs it does, so the two readings are compared on inputs no one
// picked by hand: the words of one command's arguments (the splitter), and
// whether `cat ./<word>/archive/f` reaches a directory `<name>` (the glob
// matcher, through the archive block, against bash's pathname expansion).
//
// bash never runs what is generated. It only lists the words of the
// arguments of a function, or the paths a word expands to:
// - by construction: an operator, a newline, `$` or a backtick is only ever
//   written quoted or escaped, so the text holds one command's arguments,
//   with no substitution, redirection or second command;
// - by confinement, should the generator be wrong: bash runs restricted
//   (`-r`: no redirection to a file, no command named by path) with a PATH
//   that holds no command, pathname expansion is off (`set -f`) for the
//   splitter and reads only the directories made for the glob cases, and
//   anything bash writes to stderr fails the test.
//
// Bounded: a fixed number of cases, one bash call per comparison that is
// killed after BASH_TIMEOUT_MS, and a deadline of TEST_DEADLINE_MS checked
// between cases.
//
// `TRACE_FUZZ_SEED=<n>` picks other inputs; a failure prints the seed and
// the inputs, and the line that runs them again.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { accessSync, constants, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'

import { archiveBlock } from '../plugins/trace/scripts/lib/archive.mjs'
import { CASE_INSENSITIVE_FS } from '../plugins/trace/scripts/lib/paths.mjs'
import { parseCommands, unliteral } from '../plugins/trace/scripts/lib/shell.mjs'

const SPLIT_CASES = 2000
const GLOB_CASES = 1000
const BASH_TIMEOUT_MS = 20_000
const TEST_DEADLINE_MS = 60_000

const SEED = (() => {
  const raw = process.env.TRACE_FUZZ_SEED ?? '1'
  if (!/^\d{1,9}$/.test(raw)) throw new Error(`TRACE_FUZZ_SEED must be a whole number of at most 9 digits, not ${JSON.stringify(raw)}`)
  return Number(raw)
})()
const REPLAY = `replay: TRACE_FUZZ_SEED=${SEED} node --test test/bash-differential.test.mjs`

// --- known differences --------------------------------------------------------
//
// What the comparison has found, each filed as its own issue. An entry
// switches its construct off in the generator, and its examples are checked
// to differ still, so the list cannot outlive a fix: fixing one means
// deleting its entry, which puts the construct back into the generated
// inputs. `effect` is the urgency: 'skips' when the plugin can read a
// command differently from the shell that runs it in a way that lets a hard
// block be skipped, 'refuses' when it can only refuse more than it should.

/**
 * @typedef {{ input: string, bash: string[], plugin: string[] }} SplitExample the arguments of `f <input>`
 * @typedef {{ word: string, name: string, bash: boolean }} GlobExample whether bash, running `cat ./<word>/archive/f` beside a directory `<name>`, reads `<name>/archive/f`; the archive block says the opposite
 * @typedef {'skips' | 'refuses'} Effect
 */

/** @type {Record<string, { issue: number, effect: Effect, what: string, examples: SplitExample[] }>} */
const SPLIT_KNOWN = {
  carriageReturn: {
    issue: 66,
    effect: 'skips',
    what: 'a carriage return ends a word, where bash keeps it in the word',
    examples: [
      { input: 'a\rb', bash: ['a\rb'], plugin: ['a', 'b'] },
      // What follows is a comment to the plugin and a word to bash, which goes on to read the rest of the line.
      { input: 'a \r#b c', bash: ['a', '\r#b', 'c'], plugin: ['a'] },
    ],
  },
  emptyAnsiWord: {
    issue: 67,
    effect: 'skips',
    what: "`$''` alone is no word, where bash passes an empty argument",
    examples: [
      { input: "a $'' b", bash: ['a', '', 'b'], plugin: ['a', 'b'] },
      { input: "$''#b c", bash: ['#b', 'c'], plugin: [] },
    ],
  },
  emptyBraceWord: {
    issue: 68,
    effect: 'skips',
    what: 'an empty word that brace expansion leaves is kept, where bash drops it',
    examples: [
      { input: 'a {,} b', bash: ['a', 'b'], plugin: ['a', '', '', 'b'] },
      { input: '{x,}', bash: ['x'], plugin: ['x', ''] },
    ],
  },
  braceClosedEarly: {
    issue: 69,
    effect: 'skips',
    what: 'a `}` before the first comma closes a brace group, where bash reads on to the `}` after it',
    examples: [
      { input: '{a},b}', bash: ['a}', 'b'], plugin: ['{a},b}'] },
      { input: 'x{},y}z', bash: ['x}z', 'xyz'], plugin: ['x{},y}z'] },
    ],
  },
  braceSequence: {
    issue: 70,
    effect: 'skips',
    what: '`{a..c}` and `{1..3}` are not expanded',
    examples: [
      { input: '{1..3}', bash: ['1', '2', '3'], plugin: ['{1..3}'] },
      { input: 'x{c..a}y', bash: ['xcy', 'xby', 'xay'], plugin: ['x{c..a}y'] },
    ],
  },
  braceBudget: {
    issue: 71,
    effect: 'skips',
    what: 'the words of one brace expansion past the 64th are dropped',
    examples: [{ input: `{a,b}${'{,}'.repeat(6)}`, bash: [...Array(64).fill('a'), ...Array(64).fill('b')], plugin: Array(64).fill('a') }],
  },
  trailingBackslash: {
    issue: 72,
    effect: 'skips',
    what: 'a backslash that ends the command is dropped, where bash keeps it',
    examples: [
      { input: 'a\\', bash: ['a\\'], plugin: ['a'] },
      { input: 'a \\', bash: ['a', '\\'], plugin: ['a', ''] },
    ],
  },
  dollarThenBrace: {
    issue: 73,
    effect: 'skips',
    what: "a `$` that ends a double-quoted string, or that `$'\\x24'` writes, makes the `{` after it a parameter, where bash expands the braces",
    examples: [
      { input: '"$"{a,b}', bash: ['$a', '$b'], plugin: ['${a,b}'] },
      { input: "$'\\x24'{a,b}", bash: ['$a', '$b'], plugin: ['${a,b}'] },
      { input: '{x"$"{},y}', bash: ['x${}', 'y'], plugin: ['{x${},y}'] },
    ],
  },
  ansiEscapes: {
    issue: 74,
    effect: 'skips',
    what: "in `$'…'`, `\\E`, `\\cX`, `\\u` and `\\U` are not decoded, and an escape bash does not know loses its backslash",
    examples: [
      { input: "$'\\E\\cA'", bash: ['\x1b\x01'], plugin: ['EcA'] },
      { input: "$'\\u0061\\U00000062'", bash: ['ab'], plugin: ['u0061U00000062'] },
      { input: "$'\\q\\xg'", bash: ['\\q\\xg'], plugin: ['qxg'] },
    ],
  },
  ansiNul: {
    issue: 75,
    effect: 'skips',
    what: "a NUL in `$'…'` ends the whole word, where bash ends only the quoted string",
    examples: [
      { input: "$'a\\0b'c", bash: ['ac'], plugin: ['a'] },
      { input: "$'\\x00'c d", bash: ['c', 'd'], plugin: ['', 'd'] },
    ],
  },
  ansiBytes: {
    issue: 76,
    effect: 'skips',
    what: "in `$'…'`, `\\xHH` and `\\NNN` are code points, where bash writes bytes: UTF-8 sequences are not joined, and an octal over 377 does not wrap",
    examples: [
      { input: "$'\\xc3\\xa9'", bash: ['é'], plugin: ['Ã©'] },
      { input: "$'\\541'", bash: ['a'], plugin: ['š'] },
    ],
  },
}

/** @type {Record<string, { issue: number, effect: Effect, what: string, examples: GlobExample[], before?: number }>} `before`: the first bash that reads it as the plugin does */
const GLOB_KNOWN = {
  quotedPattern: {
    issue: 77,
    effect: 'skips',
    what: 'a quoted `*`, `?`, `[`, `(`, `|` or `)` is read as a pattern, where bash matches the character itself',
    examples: [
      { word: "'[ab]'", name: '[ab]', bash: true },
      { word: '\\(x\\)', name: '(x)', bash: true },
      { word: '"*"', name: 'a', bash: false },
      { word: '[a\\]b]', name: ']', bash: true },
    ],
  },
  posixBracket: {
    issue: 78,
    effect: 'skips',
    what: 'in a bracket, `[:ascii:]`, `[:blank:]`, `[:cntrl:]`, `[:graph:]`, `[:print:]`, `[.x.]` and `[=x=]` match nothing, and the classes it knows hold only ASCII',
    examples: [
      { word: '[[:alpha:]]', name: 'é', bash: true },
      { word: '[[:graph:]]', name: 'a', bash: true },
      { word: '[![:print:]]', name: 'a', bash: false },
      { word: '[[=a=]]', name: 'a', bash: true },
      { word: '[[.a.]]', name: 'a', bash: true },
    ],
  },
  rangeOutOfOrder: {
    issue: 79,
    effect: 'skips',
    what: 'a bracket holding a range out of order is read as the text it is written with, where bash matches its other members',
    examples: [
      { word: '[ab-a]', name: 'a', bash: true },
      { word: '[!c-a]', name: 'b', bash: true },
    ],
  },
  unclosedBracket: {
    issue: 80,
    effect: 'refuses',
    before: 503,
    what: 'in a word with another pattern character, a `[` that no `]` closes matches itself, where bash before 5.3 matches nothing and keeps the word as written',
    examples: [
      { word: '?[a-', name: '1[a-', bash: false },
      { word: '*[!0-', name: '1[!0-', bash: false },
    ],
  },
  astral: {
    issue: 81,
    effect: 'skips',
    what: '`?` does not match a character outside the Basic Multilingual Plane',
    examples: [{ word: '?', name: '😀', bash: true }],
  },
  newline: {
    issue: 82,
    effect: 'skips',
    what: 'a word with a newline in it is not read as a path',
    examples: [{ word: "'a\nb'", name: 'a\nb', bash: true }],
  },
  quotedDollar: {
    issue: 83,
    effect: 'skips',
    what: 'a quoted `$` or backtick in a path is not matched against the name that holds it',
    examples: [
      { word: "'$x'", name: '$x', bash: true },
      { word: '\\`', name: '`', bash: true },
    ],
  },
  doubleStar: {
    issue: 84,
    effect: 'refuses',
    what: '`**` in a word reaches every directory below, where bash without globstar reads it as `*`',
    examples: [{ word: 'a**', name: 'b', bash: false }],
  },
  literalFallback: {
    issue: 91,
    effect: 'skips',
    what: 'a word whose pattern matches no name reaches nothing, where bash keeps the word as written and reads the name it spells',
    examples: [
      { word: '[ab]', name: '[ab]', bash: true },
      { word: 'B[:]', name: 'B[:]', bash: true },
      { word: '?[_Z]', name: '?[_Z]', bash: true },
      { word: "'c'@[a-z-]9", name: 'c@[a-z-]9', bash: true },
    ],
  },
  leadingDot: {
    issue: 92,
    effect: 'refuses',
    what: '`*`, `?` and a bracket match a `.` that starts a name, where bash matches it only with a `.`',
    examples: [
      { word: '*', name: '.a', bash: false },
      { word: '?a', name: '.a', bash: false },
      { word: '[.]a', name: '.a', bash: false },
    ],
  },
  bracketInBracket: {
    issue: 93,
    effect: 'skips',
    what: 'in a bracket, a `[` that a `:`, `.` or `=` follows is itself unless a whole `[:name:]` follows, where bash reads a class that can run on past the `]` that ends the bracket for the plugin (and bash 4.4 to 5.3 differ among themselves here)',
    examples: [
      { word: '[[:lower:][:alpha::][1[:punct:]]?', name: 'z1', bash: true },
      { word: '[[:alpha:Z[:]?', name: 'Zc', bash: false },
      { word: '[[::]+', name: '[+', bash: false },
    ],
  },
}

// --- bash ---------------------------------------------------------------------

/** @returns {string | null} the bash on PATH, as an absolute path: the PATH bash is given holds no command */
function findBash() {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const file = resolve(dir, 'bash')
    try {
      accessSync(file, constants.X_OK)
      if (statSync(file).isFile()) return file
    } catch {}
  }
  return null
}

const BASH = process.platform === 'win32' ? null : findBash()
const NO_BASH = process.platform === 'win32' ? 'the comparison with bash is not run on Windows' : 'bash is not on PATH'

/** @template T @param {() => T} f @returns {() => T} f, called the first time only */
function once(f) {
  /** @type {{ value: T } | null} */
  let done = null
  return () => (done ??= { value: f() }).value
}

/** Its version, 5.2 as 502, or null when it does not say. */
const bashVersion = once(() => {
  const out = BASH && spawnSync(BASH, ['-c', 'printf %d "$((BASH_VERSINFO[0] * 100 + BASH_VERSINFO[1]))"'], { env: { PATH: '/dev/null' }, timeout: BASH_TIMEOUT_MS }).stdout?.toString()
  return out && /^\d+$/.test(out) ? Number(out) : null
})
// The examples of the known differences were recorded on bash 4.4 to 5.3; older ones differ in a few (3.2 decodes no `\u`).
const RECORDED_FROM = 404
/** @param {number} v */
const dotted = v => `${Math.floor(v / 100)}.${v % 100}`
/** @returns {string | null} why the examples of the known differences are not checked against this bash */
function unrecorded() {
  const v = bashVersion()
  if (v === null) return 'bash did not say which version it is'
  return v < RECORDED_FROM ? `recorded on bash ${dotted(RECORDED_FROM)} and later; this is ${dotted(v)}` : null
}

/**
 * What bash prints for `script`, run restricted, with `args` as its
 * positional parameters and nothing on its PATH.
 *
 * @param {string} bash @param {string} script @param {string[]} args @param {string} locale
 */
function askBash(bash, script, args, locale) {
  const r = spawnSync(bash, ['-r', '-c', script, 'bash', ...args], {
    env: { PATH: '/dev/null', LC_ALL: locale },
    cwd: tmpdir(),
    timeout: BASH_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    maxBuffer: 64 << 20,
  })
  if (r.error) throw new Error(`bash gave no answer within ${BASH_TIMEOUT_MS} ms: ${r.error.message}`)
  // A generator that wrote a second command or a redirection would show here, as a command not found or a restriction.
  assert.equal(r.stderr.toString(), '', `bash complained, so the generated text was not only arguments. ${REPLAY}`)
  assert.equal(r.status, 0, `bash exited with ${r.status}. ${REPLAY}`)
  return r.stdout.toString('utf8')
}

// Each text is evaluated as the arguments of `f`, which prints how many it got and then each, NUL-terminated.
const LIST_WORDS = `f() { printf '%s\\0' "$#" "$@"; }; set -f; for t; do eval "f $t" || printf 'E\\0'; done`

/** @param {string} bash @param {string[]} texts @returns {(string[] | null)[]} the arguments bash reads in each text; null where it reads none */
function bashWords(bash, texts) {
  const fields = askBash(bash, LIST_WORDS, texts, 'C').split('\0')
  let at = 0
  const out = texts.map(() => {
    const n = Number(fields[at++])
    if (!Number.isInteger(n)) return null
    at += n
    return fields.slice(at - n, at)
  })
  assert.equal(at, fields.length - 1, `bash's answer does not line up with the ${texts.length} texts. ${REPLAY}`)
  return out
}

/** @param {string} text @returns {string[] | string} the arguments the plugin reads in `f <text>`, or what it read instead of one command */
function pluginWords(text) {
  const commands = parseCommands(`f ${text}`)
  const [c] = commands
  if (commands.length !== 1 || !c || c.name !== 'f' || c.files.length || c.level) return `not one command: ${JSON.stringify(commands)}`
  return c.args.map(unliteral)
}

// The root, then pairs of a name and a word. The word is expanded as the path
// of `cat ./<word>/archive/f` is, from the directory of its case, with
// globbing as it is for a command: no extglob, nullglob, failglob, dotglob or
// nocaseglob. So a pattern that matches nothing is kept as written, and only
// a `.` matches a leading `.`. bash reads the file when a word of the
// expansion is that file.
const READS = `shopt -u extglob nullglob failglob dotglob nocaseglob
if ((BASH_VERSINFO[0] * 100 + BASH_VERSINFO[1] >= 403)); then shopt -s globasciiranges; fi
r=$1; shift; i=0
while (($#)); do
  d=$r/$i s=$1 t=$2; shift 2; ((++i))
  eval "w=(\\"\\$d\\"/./$t/archive/f)" || { printf E; continue; }
  hit=0; for f in "\${w[@]}"; do [[ $f -ef $d/$s/archive/f ]] && hit=1; done
  printf %d $hit
done`

/**
 * Whether bash, running `cat ./<word>/archive/f` in the directory of each
 * case, reads `<name>/archive/f` there (see `makeNames`).
 *
 * @param {string} bash @param {string} locale @param {string} root
 * @param {{ word: string, name: string }[]} cases
 * @returns {(boolean | null)[]} null where bash cannot read the word
 */
function bashReads(bash, locale, root, cases) {
  const out = askBash(bash, READS, [root, ...cases.flatMap(c => [c.name, c.word])], locale)
  assert.equal(out.length, cases.length, `bash's answer does not line up with the ${cases.length} cases. ${REPLAY}`)
  return cases.map((_, i) => (out[i] === '1' ? true : out[i] === '0' ? false : null))
}

/**
 * Under `root`, a directory for each case, `<root>/<i>`, holding a directory
 * `<name>` that holds a repository with an archive with a file `f` in it.
 *
 * @param {string} root @param {{ name: string }[]} cases
 */
function makeNames(root, cases) {
  cases.forEach(({ name }, i) => {
    mkdirSync(join(root, String(i), name, '.git'), { recursive: true })
    mkdirSync(join(root, String(i), name, 'archive'))
    writeFileSync(join(root, String(i), name, 'archive', 'f'), '')
  })
}

/**
 * Whether the archive block refuses `cat ./<word>/archive/f` run in the
 * directory of case `i`: whether the plugin takes the word to reach the
 * name there.
 *
 * @param {string} root @param {number} i @param {string} word
 */
const pluginReads = (root, i, word) => archiveBlock('Bash', { command: `cat ./${word}/archive/f` }, join(root, String(i))) !== null

/** A locale in which bash reads UTF-8 text as characters, or null. */
const utf8Locale = once(() =>
  BASH ? (['C.UTF-8', 'en_US.UTF-8'].find(l => spawnSync(BASH, ['-c', 'case é in ?) printf 1;; esac'], { env: { PATH: '/dev/null', LC_ALL: l }, timeout: BASH_TIMEOUT_MS }).stdout?.toString() === '1') ?? null) : null,
)

// --- the generator ------------------------------------------------------------

/** @param {number} seed @returns {() => number} mulberry32: numbers in [0, 1) that depend only on the seed */
function random(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** @param {() => number} r */
function dice(r) {
  /** @param {number} n */
  const int = n => Math.floor(r() * n)
  /** @template T @param {readonly T[]} from @returns {T} */
  const pick = from => /** @type {T} */ (from[int(from.length)])
  /** @param {number} p */
  const chance = p => r() < p
  return { int, pick, chance }
}

// Characters that mean themselves unquoted, in an argument, with pathname expansion off.
const BARE = [...'abxyz019-_/:=+%@^,é']
// Characters written only quoted or escaped: every one the shell acts on is here and not in BARE.
const QUOTED = [...BARE, ...';&|<>()`$"\'\\ \t\n\r#~{}*?[]!.\v\f']

/**
 * The text of one command's arguments: bare words, every kind of quoting,
 * brace groups, a trailing comment. Nothing in it runs or redirects.
 *
 * @param {() => number} r
 * @param {(construct: string) => boolean} on whether a construct with a known difference may be written
 * @returns {string}
 */
function splitText(r, on) {
  const { int, pick, chance } = dice(r)
  const chars = (/** @type {string[]} */ from, /** @type {number} */ max) => Array.from({ length: int(max + 1) }, () => pick(from)).join('')
  const sq = () => `'${chars(QUOTED.filter(c => c !== "'"), 4)}'`
  /** Whether the last double-quoted string written ends in a bare `$`. */
  let endsDollar = false
  const dq = () => {
    let s = ''
    for (let k = int(5); k > 0; k--) {
      const x = int(10)
      if (x < 6) s += pick(QUOTED.filter(c => !'"\\$`'.includes(c)))
      else if (x < 8) s += `\\${pick(['"', '\\', '$', '`', '\n'])}`
      else if (x < 9) s += `\\${pick(QUOTED.filter(c => !'"\\$`\n'.includes(c)))}`
      // A `$` that no name, brace or parenthesis follows is itself.
      else s += `$${pick([...' \'/.%=:,+^'])}`
    }
    endsDollar = chance(0.1)
    return `"${s}${endsDollar ? '$' : ''}"`
  }
  // A character to write as a number: not `$`, which a brace group may follow, unless that difference is fixed.
  const code = (/** @type {number} */ below) => {
    const n = 1 + int(below - 1)
    return n === 0x24 && !on('dollarThenBrace') ? 0x25 : n
  }
  // `$'…'` with at least one character, in ASCII. A short hex or octal number is followed by a character that cannot extend it.
  const ansi = () => {
    let s = ''
    for (let k = 1 + int(4); k > 0; k--) {
      const x = int(13)
      if (x < 4) s += pick(QUOTED.filter(c => c !== "'" && c !== '\\'))
      else if (x < 6) s += `\\${pick([...'ntrabefv\\\'"?'])}`
      else if (x < 8) s += `\\x${chance(0.7) ? code(128).toString(16).padStart(2, '0') : code(16).toString(16) + pick([...'gG -'])}`
      else if (x < 10) s += `\\${chance(0.7) ? code(128).toString(8).padStart(3, '0') : code(64).toString(8) + pick([...'89a -'])}`
      else if (x < 11 && on('ansiEscapes')) s += pick(['\\E', '\\ca', '\\cA', '\\c?', '\\c[', '\\u0041', '\\u61', '\\U00000062', '\\U7e', '\\q', '\\z', '\\8', '\\ ', '\\$', '\\{', '\\xg'])
      else if (x < 12 && on('ansiNul')) s += pick(['\\0', '\\x00', '\\000', '\\x0']) + pick(['', 'a', '-'])
      else if (x < 13 && on('ansiBytes')) s += pick(['\\xc3\\xa9', '\\303\\251', '\\xC3\\251', '\\541'])
      else s += pick(BARE)
    }
    return `$'${s}'`
  }
  /**
   * One word, or one alternative of a brace group.
   *
   * @param {number} depth how many brace groups it is inside
   * @param {boolean} emptyOk whether an alternative may be empty: the word has other text, so no word comes out empty
   * @returns {{ text: string, count: number }} `count`: how many words it expands to
   */
  const word = (depth, emptyOk) => {
    let s = ''
    let count = 1
    // Whether a word has begun for the plugin and for bash alike, so that a `#` is no comment.
    let started = depth > 0
    // Whether the text so far ends in the bare `$` of a double-quoted string.
    let rawDollar = false
    const bare = depth > 0 ? BARE.filter(c => c !== ',') : BARE
    for (let k = 1 + int(3); k > 0; k--) {
      const x = int(24)
      const brace = on('dollarThenBrace') || !rawDollar
      endsDollar = false
      let add
      if (x < 7) add = chars(bare, 2) + pick(bare)
      else if (x < 9) add = pick([...'*?[]!'])
      // Two dots in a row inside a group would make it a sequence.
      else if (x < 10 && !s.endsWith('.')) add = '.'
      else if (x < 13 && depth < 2 && brace) {
        const empty = on('emptyBraceWord') || emptyOk || (depth === 0 && /^[a-z0-9]/.test(s))
        const alts = Array.from({ length: pick([1, 2, 2, 2, 3]) }, () => (empty && chance(0.2) ? { text: '', count: 1 } : word(depth + 1, empty)))
        const n = alts.reduce((sum, a) => sum + a.count, 0)
        if (count * n > 64 && !on('braceBudget')) add = 'b'
        else {
          add = `{${alts.map(a => a.text).join(',')}}`
          count *= n
        }
      } else if (x < 14 && brace) add = pick(['{}', ...(started ? ['#'] : []), ...(on('braceClosedEarly') ? ['{', '}', '}'] : [])])
      else if (x < 16) add = `\\${pick(QUOTED.filter(c => c !== '\n' || depth === 0 || emptyOk))}`
      else if (x < 18) add = sq()
      else if (x < 20) add = dq()
      else if (x < 21) add = ansi()
      else if (x < 22) add = `$${dq()}`
      else if (x < 23) add = pick(["''", '""', '$""', ...(started || on('emptyAnsiWord') ? ["$''"] : [])])
      else if (on('carriageReturn') && chance(0.5)) add = '\r'
      else if (on('braceSequence') && brace && chance(0.5)) add = pick(['{1..3}', '{a..c}', '{1..9..4}', '{08..10}', '{c..a}', '{-1..1}', '{a..c..2}', '{1..3}{x,y}', '{a..3}', '{1..}'])
      else add = pick(['\v', '\f'])
      s += add
      if (endsDollar) rawDollar = true
      else if (!/^(?:\$?''|\$?""|\\\n)$/.test(add)) rawDollar = false
      started ||= !/^(?:\\\n|\$'')*$/.test(s)
    }
    return { text: s, count }
  }
  /** @type {string[]} */
  const words = []
  for (let k = int(5); k > 0; k--) {
    if (on('braceBudget') && chance(0.03)) words.push(pick(['{a,b}'.repeat(7), `x{${Array.from({ length: 66 }, (_, i) => i).join(',')}}`]))
    // A `$` that ends a word is itself.
    else words.push(word(0, false).text + (chance(0.05) ? '$' : ''))
  }
  let text = chance(0.2) ? pick([' ', '\t']) : ''
  text += words.map((w, i) => w + (i < words.length - 1 ? pick([' ', ' ', '\t', '  ', ' \\\n', ...(on('carriageReturn') ? ['\r'] : [])]) : '')).join('')
  if (chance(0.15)) text += pick([' ', '\t'])
  // A comment runs to the end of the line, quotes and all, so one is written only last and without a newline.
  if (chance(0.1)) text += ` #${chars(QUOTED.filter(c => c !== '\n'), 6)}`
  else if (on('trailingBackslash') && chance(0.05)) text += '\\'
  return text
}

/** A character a class stands for, to build a name that may match. @type {Record<string, string>} */
const CLASS_SAMPLE = { alpha: 'b', digit: '1', alnum: 'c', lower: 'z', space: ' ', xdigit: 'a', punct: '+', word: '_', upper: 'B', ascii: 'a', blank: ' ', cntrl: '\x01', graph: 'a', print: 'a' }

/**
 * A word to use as a pattern, and a file name it may or may not match:
 * the name follows the word (mostly), follows it with one change, is the
 * word's text taken literally, or is unrelated.
 *
 * @param {() => number} r
 * @param {(construct: string) => boolean} on whether a construct with a known difference may be written
 * @param {{ upper: boolean, nonAscii: boolean }} world whether names differing only in case are different files, and whether bash reads characters past ASCII
 * @returns {{ word: string, name: string }}
 */
function globCase(r, on, { upper, nonAscii }) {
  const { int, pick, chance } = dice(r)
  // A case has characters past ASCII or named classes, not both, while the classes hold only ASCII.
  const wide = nonAscii && chance(0.4)
  // Characters that mean themselves in a pattern, unquoted. No braces, and no `/`: one path segment.
  const LIT = [...'abcz019-_.+@%=:,', ...(upper ? [...'ABZ'] : []), ...(wide ? ['é', 'ü', ...(on('astral') ? ['😀'] : [])] : [])]
  // Characters that are no pattern, which the shell text must quote.
  const QLIT = [...' ;&<>\'"#~{}!^\\\t', ...(on('quotedDollar') ? ['$', '`'] : []), ...(on('newline') ? ['\n'] : [])]
  const quote = (/** @type {string} */ c) => (c === "'" ? pick(["\\'", `"'"`]) : c === '\n' ? pick([`'\n'`, `"\n"`]) : pick([`\\${c}`, `'${c}'`, '"\\$`'.includes(c) ? `"\\${c}"` : `"${c}"`]))
  const CLASSES = on('posixBracket') ? Object.keys(CLASS_SAMPLE) : wide ? [] : ['alpha', 'digit', 'alnum', 'lower', 'space', 'xdigit', 'punct', 'word', ...(upper ? ['upper'] : [])]
  /** @typedef {{ text: string, raw: string, sample: () => string }} Piece its shell text, that text taken literally, and a string it matches */
  /** @returns {Piece} */
  const bracket = () => {
    const not = chance(0.25) ? pick(['!', '^']) : ''
    let body = ''
    /** @type {string[]} */
    const members = []
    const add = (/** @type {string} */ text, /** @type {string} */ member) => {
      body += text
      members.push(member)
    }
    if (chance(0.1)) add(']', ']')
    for (let k = 1 + int(3); k > 0; k--) {
      const x = int(12)
      if (x < 5) {
        const c = pick(LIT.filter(c => c !== '-'))
        add(c, c)
      } else if (x < 7) {
        const [a, b] = pick(/** @type {[string, string][]} */ ([['a', 'c'], ['0', '9'], ['a', 'z'], ['b', 'b'], ...(upper ? [['A', 'Z'], ['A', 'z']] : []), ...(wide ? [['à', 'ü']] : [])]))
        add(`${a}-${b}`, pick([a, b]))
      } else if (x < 9 && CLASSES.length) {
        const c = pick(CLASSES)
        add(`[:${c}:]`, CLASS_SAMPLE[c] ?? 'a')
      } else if (x < 10) {
        const c = pick([...'[!^'])
        // `!` and `^` negate when first; `[:`, `[.` and `[=` open a class, so a `[` comes last.
        if ((body === '' && c !== '[') || (c === '[' && k > 1 && !on('bracketInBracket'))) add('a', 'a')
        else add(c, c)
      } else if (x < 11 && on('posixBracket')) add(pick(['[.a.]', '[=a=]', '[.-.]']), 'a')
      else if (on('rangeOutOfOrder') && chance(0.5)) add(pick(['c-a', '9-0', 'z-b']), 'a')
      else if (on('bracketInBracket')) add(pick(['[:alpha:', '[:', '[.', '[=']), '[')
      else add('a-c-z', 'z')
    }
    if (chance(0.1)) add('-', '-')
    const text = `[${not}${body}]`
    return { text, raw: text, sample: () => (not ? pick([...'qy7#']) : pick(members)) }
  }
  /** @type {Piece[]} */
  const pieces = []
  const one = (/** @type {string} */ text, raw = text) => pieces.push({ text, raw, sample: () => raw })
  for (let k = 1 + int(4); k > 0; k--) {
    const x = int(20)
    if (x < 6) one(pick(LIT))
    else if (x < 9 && (on('doubleStar') || pieces.at(-1)?.text !== '*')) pieces.push({ text: '*', raw: '*', sample: () => Array.from({ length: int(3) }, () => pick(LIT)).join('') })
    else if (x < 11) pieces.push({ text: '?', raw: '?', sample: () => pick(LIT) })
    else if (x < 15) pieces.push(bracket())
    else if (x < 17) {
      const c = pick([...QLIT, ...LIT])
      one(quote(c), c)
    } else if (x < 18 && on('quotedPattern')) {
      const c = pick([...'*?[]()|'])
      one(quote(c), c)
    } else if (x < 19 && on('quotedPattern')) {
      const b = bracket()
      const text = pick([`'${b.text}'`, `"${b.text}"`, `\\${b.text}`, b.text.replace(/\]$/, '\\]'), b.text.replace(/^\[(.)/, '[\\$1'), b.text.replace(/^\[(.)/, "['$1'")])
      pieces.push({ text, raw: b.raw, sample: () => (chance(0.5) ? b.raw : b.sample()) })
    } else if (on('unclosedBracket') && (k === 1 || on('bracketInBracket'))) {
      // Last, unless a bracket may hold a `[`: a `]` after it would close it.
      one(pick(['[', '[]', '[!]', '[a', '[]a', '[^', '[[', '[a-', '[!0-', ...(on('bracketInBracket') ? ['[x[:'] : [])]))
    } else one(']')
  }
  const follows = () => [...pieces.map(p => p.sample()).join('')]
  const how = int(10)
  let name = follows()
  if (how >= 6 && how < 8) name.splice(int(name.length + 1), int(2), ...(chance(0.6) ? [pick(LIT)] : []))
  else if (how === 8) name = [...pieces.map(p => p.raw).join('')]
  else if (how === 9) name = Array.from({ length: 1 + int(3) }, () => pick(LIT))
  // Only a `.` written first matches a `.` that starts a name.
  if (name[0] === '.' && pieces[0]?.raw !== '.' && !on('leadingDot')) name[0] = '_'
  // A word that bash keeps as written, when its pattern matches nothing, spells the name.
  if (!on('literalFallback') && name.join('') === pieces.map(p => p.raw).join('') && /[*?[]/.test(name.join(''))) name.push(pick(LIT))
  const joined = name.join('')
  return { word: pieces.map(p => p.text).join(''), name: ['', '.', '..'].includes(joined) ? 'a' : joined }
}

// --- the comparisons ----------------------------------------------------------

/** @param {Record<string, unknown>} known @returns {(construct: string) => boolean} whether no known difference switches a construct off */
const unlessKnown = known => construct => !Object.hasOwn(known, construct)

/** @param {string[]} failures @param {number} cases @param {string} what */
function report(failures, cases, what) {
  if (!failures.length) return
  const shown = failures.slice(0, 5).join('\n')
  assert.fail(`${failures.length} of ${cases} generated ${what} are read differently by bash and by the plugin (seed ${SEED}):\n${shown}${failures.length > 5 ? `\n… and ${failures.length - 5} more` : ''}\n${REPLAY}`)
}

/** @returns {() => void} fails once the test has run past its deadline */
function deadline() {
  const end = Date.now() + TEST_DEADLINE_MS
  return () => assert.ok(Date.now() < end, `the comparison ran past ${TEST_DEADLINE_MS} ms. ${REPLAY}`)
}

/** @param {(dir: string) => void} run with an empty directory, removed afterwards */
function inTemp(run) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bash-differential-')))
  try {
    run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test(`the splitter reads ${SPLIT_CASES} generated commands' arguments as bash does`, t => {
  if (!BASH) return t.skip(NO_BASH)
  const inTime = deadline()
  const r = random(SEED)
  const texts = Array.from({ length: SPLIT_CASES }, () => splitText(r, unlessKnown(SPLIT_KNOWN)))
  const bash = bashWords(BASH, texts)
  /** @type {string[]} */
  const failures = []
  texts.forEach((text, i) => {
    inTime()
    const plugin = pluginWords(text)
    if (JSON.stringify(plugin) !== JSON.stringify(bash[i])) failures.push(`  case ${i}: ${JSON.stringify(text)}\n    bash:   ${JSON.stringify(bash[i])}\n    plugin: ${JSON.stringify(plugin)}`)
  })
  report(failures, SPLIT_CASES, 'texts')
})

for (const [construct, { issue, effect, what, examples }] of Object.entries(SPLIT_KNOWN)) {
  test(`known difference #${issue} (${effect}), splitter: ${what}`, t => {
    if (!BASH) return t.skip(NO_BASH)
    const why = unrecorded()
    if (why) return t.skip(why)
    const bash = bashWords(BASH, examples.map(e => e.input))
    examples.forEach((e, i) => {
      const plugin = pluginWords(e.input)
      const input = JSON.stringify(e.input)
      assert.notDeepEqual(plugin, bash[i], `the plugin now reads ${input} as bash does. If #${issue} is fixed, delete SPLIT_KNOWN.${construct}, so that the generator writes this again.`)
      assert.deepEqual(bash[i], e.bash, `bash reads ${input} differently from what #${issue} records`)
      assert.deepEqual(plugin, e.plugin, `the plugin reads ${input} differently from what #${issue} records, and still not as bash does`)
    })
  })
}

test(`the glob matcher reaches what bash reads through ${GLOB_CASES} generated words`, t => {
  if (!BASH) return t.skip(NO_BASH)
  const inTime = deadline()
  const locale = utf8Locale()
  if (!locale) t.diagnostic('bash has no UTF-8 locale here: the names are ASCII only')
  const r = random(SEED + 1)
  const cases = Array.from({ length: GLOB_CASES }, () => globCase(r, unlessKnown(GLOB_KNOWN), { upper: !CASE_INSENSITIVE_FS, nonAscii: locale !== null }))
  /** @type {string[]} */
  const failures = []
  inTemp(root => {
    makeNames(root, cases)
    const bash = bashReads(BASH, locale ?? 'C', root, cases)
    cases.forEach(({ word, name }, i) => {
      inTime()
      const plugin = pluginReads(root, i, word)
      if (plugin !== bash[i]) failures.push(`  case ${i}: word ${JSON.stringify(word)}, name ${JSON.stringify(name)}\n    bash reads it:      ${bash[i] ?? 'cannot read the word'}\n    the plugin refuses: ${plugin}`)
    })
  })
  report(failures, GLOB_CASES, 'words')
})

for (const [construct, { issue, effect, what, examples, before }] of Object.entries(GLOB_KNOWN)) {
  test(`known difference #${issue} (${effect}), glob matcher: ${what}`, t => {
    if (!BASH) return t.skip(NO_BASH)
    // The plugin answers the opposite of bash in each example, so the effect follows from them.
    assert.equal(effect, examples.some(e => e.bash) ? 'skips' : 'refuses', `the examples of #${issue} say whether bash reads what the plugin allows`)
    const why = unrecorded()
    if (why) return t.skip(why)
    const version = /** @type {number} */ (bashVersion())
    if (before && version >= before) return t.skip(`bash ${dotted(version)} reads these as the plugin does`)
    const locale = utf8Locale()
    if (!locale && examples.some(e => /[^\0-\x7f]/.test(e.word + e.name))) return t.skip('bash has no UTF-8 locale here')
    inTemp(root => {
      makeNames(root, examples)
      const bash = bashReads(BASH, locale ?? 'C', root, examples)
      examples.forEach((e, i) => {
        const plugin = pluginReads(root, i, e.word)
        const pair = `${JSON.stringify(e.word)} with a directory ${JSON.stringify(e.name)}`
        assert.notEqual(plugin, bash[i], `the plugin now reads ${pair} as bash does. If #${issue} is fixed, delete GLOB_KNOWN.${construct}, so that the generator writes this again.`)
        assert.equal(bash[i], e.bash, `bash reads ${pair} differently from what #${issue} records`)
      })
    })
  })
}
