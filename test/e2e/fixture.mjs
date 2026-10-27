// Builds the end-to-end fixture: a small node project on `main`, plus a
// `feature` branch that adds a bulk discount with two seeded bugs its own
// test does not catch:
//   1. `qty > 10` where the intent says "10 or more"   (pricing.js, boundary)
//   2. `price * 0.1` where the intent says "10% off"   (pricing.js, wrong formula)
// Usage: node test/e2e/fixture.mjs <dir>

import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const INTENT = 'Add bulk discount: lines with a quantity of 10 or more get 10% off their unit price.'

/** @param {string} dir */
export function makeFixture(dir) {
  const root = resolve(dir)
  mkdirSync(root, { recursive: true })
  const git = (/** @type {string[]} */ args) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  }
  const write = (/** @type {Record<string, string>} */ files) => {
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, p)), { recursive: true })
      writeFileSync(join(root, p), text)
    }
  }
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.email', 'fixture@example.com'])
  git(['config', 'user.name', 'Fixture'])
  git(['config', 'commit.gpgsign', 'false'])
  write({
    'package.json': JSON.stringify({ name: 'shop', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n',
    'src/pricing.js': `// Prices are in cents.

/** Sum of unit price times quantity over all lines. */
export function total(lines) {
  let sum = 0
  for (const line of lines) {
    sum += line.price * line.qty
  }
  return sum
}
`,
    'test/pricing.test.js': `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { total } from '../src/pricing.js'

test('total multiplies price by quantity', () => {
  assert.equal(total([{ price: 250, qty: 2 }, { price: 100, qty: 1 }]), 600)
})
`,
    'CLAUDE.md': '# shop\n\nPrices are integers in cents. Run `npm test` before finishing.\n',
  })
  git(['add', '-A'])
  git(['commit', '-qm', 'Initial pricing module'])
  git(['checkout', '-q', '-b', 'feature'])
  write({
    'src/pricing.js': `// Prices are in cents.

/** Sum of unit price times quantity over all lines. */
export function total(lines) {
  let sum = 0
  for (const line of lines) {
    sum += line.price * line.qty
  }
  return sum
}

/** Lines with a quantity of 10 or more get 10% off their unit price. */
export function bulkDiscount(lines) {
  return lines.map(line => {
    if (line.qty > 10) {
      return { ...line, price: Math.round(line.price * 0.1) }
    }
    return line
  })
}
`,
    'test/pricing.test.js': `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bulkDiscount, total } from '../src/pricing.js'

test('total multiplies price by quantity', () => {
  assert.equal(total([{ price: 250, qty: 2 }, { price: 100, qty: 1 }]), 600)
})

test('small orders are not discounted', () => {
  assert.deepEqual(bulkDiscount([{ price: 100, qty: 5 }]), [{ price: 100, qty: 5 }])
})
`,
  })
  git(['add', '-A'])
  git(['commit', '-qm', INTENT])
  return root
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2]) console.log(makeFixture(process.argv[2]))
