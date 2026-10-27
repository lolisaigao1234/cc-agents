import { test } from 'node:test'
import assert from 'node:assert/strict'

import { globToRegExp, matchesAny } from '../plugins/quality-loop/scripts/lib/glob.mjs'
import { parseUnifiedDiff, rangeTouches } from '../plugins/quality-loop/scripts/lib/diff.mjs'

test('glob: ** spans directories, * stays within one', () => {
  assert.ok(globToRegExp('dist/**').test('dist/a/b.js'))
  assert.ok(globToRegExp('**/*.lock').test('a/b/yarn.lock'))
  assert.ok(globToRegExp('**/*.lock').test('Cargo.lock'))
  assert.ok(globToRegExp('src/*.js').test('src/a.js'))
  assert.ok(!globToRegExp('src/*.js').test('src/x/a.js'))
  assert.ok(globToRegExp('a?.md').test('ab.md'))
  assert.ok(!globToRegExp('a.md').test('aXmd'), 'dots are literal')
})

test('glob: matchesAny normalises leading ./', () => {
  assert.ok(matchesAny('./vendor/x.js', ['vendor/**']))
  assert.ok(!matchesAny('src/x.js', ['vendor/**']))
  assert.ok(!matchesAny('src/x.js', []))
})

const DIFF = `diff --git a/src/a.js b/src/a.js
index 111..222 100644
--- a/src/a.js
+++ b/src/a.js
@@ -10,2 +10,3 @@ function f() {
-  old()
-  old2()
+  new1()
+  new2()
+  new3()
@@ -40 +41,0 @@
-  gone()
diff --git a/test/a.test.js b/test/a.test.js
deleted file mode 100644
--- a/test/a.test.js
+++ /dev/null
@@ -1,2 +0,0 @@
-test('x', () => {})
-expect(1).toBe(1)
diff --git a/new.txt b/new.txt
new file mode 100644
--- /dev/null
+++ b/new.txt
@@ -0,0 +1 @@
+hello
`

test('diff: parses files, added line numbers, removed lines and statuses', () => {
  const files = parseUnifiedDiff(DIFF)
  assert.equal(files.length, 3)
  const [a, t, n] = files
  assert.equal(a.path, 'src/a.js')
  assert.equal(a.status, 'modified')
  assert.deepEqual(a.added.map(l => l.line), [10, 11, 12])
  assert.deepEqual(a.added.map(l => l.text), ['  new1()', '  new2()', '  new3()'])
  assert.deepEqual(a.removed.map(l => l.text), ['  old()', '  old2()', '  gone()'])
  // a pure deletion leaves a touch point where the code used to be
  assert.ok(a.touchedLines.has(41))
  assert.equal(t.path, 'test/a.test.js')
  assert.equal(t.status, 'deleted')
  assert.equal(t.removed.length, 2)
  assert.equal(n.path, 'new.txt')
  assert.equal(n.status, 'added')
})

test('diff: rangeTouches tolerates nearby lines', () => {
  const [a] = parseUnifiedDiff(DIFF)
  assert.ok(rangeTouches(a, 12, 12))
  assert.ok(rangeTouches(a, 14, 15, 2))
  assert.ok(!rangeTouches(a, 30, 31, 2))
})

test('diff: handles quoted paths with spaces and renames', () => {
  const d = `diff --git "a/my file.js" "b/my file.js"
--- "a/my file.js"
+++ "b/my file.js"
@@ -1 +1 @@
-a
+b
diff --git a/old.js b/new.js
similarity index 90%
rename from old.js
rename to new.js
--- a/old.js
+++ b/new.js
@@ -3 +3 @@
-x
+y
`
  const files = parseUnifiedDiff(d)
  assert.equal(files[0].path, 'my file.js')
  assert.equal(files[1].path, 'new.js')
  assert.equal(files[1].oldPath, 'old.js')
  assert.equal(files[1].status, 'renamed')
})
