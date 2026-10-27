import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

/**
 * A throwaway git repository on `main` with one commit holding `files`.
 *
 * @param {Record<string, string>} files
 */
export function makeRepo(files) {
  const root = mkdtempSync(join(tmpdir(), 'ql-test-'))
  const run = (/** @type {string[]} */ args) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  }
  run(['init', '-q', '-b', 'main'])
  run(['config', 'user.email', 'test@example.com'])
  run(['config', 'user.name', 'Test'])
  run(['config', 'commit.gpgsign', 'false'])
  writeFiles(root, files)
  run(['add', '-A'])
  run(['commit', '-qm', 'initial'])
  return root
}

/**
 * @param {string} root
 * @param {Record<string, string>} files
 */
export function writeFiles(root, files) {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true })
    writeFileSync(join(root, p), text)
  }
}
