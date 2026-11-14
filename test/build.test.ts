/**
 * The command line tool, the npm package and the web page all run web/lib/, the type-stripped copy of src/. This
 * test fails when someone changed src/ and forgot `node tools/build-web.mjs`.
 *
 * Run: node --test test/build.test.ts
 *
 * @interacts reads src/*.ts and web/lib/*.js; writes nothing
 * @deps      node:module stripTypeScriptTypes, node:test
 * @complexity O(S) over the size of src/ (about 200 KB)
 * @alloc     one stripped copy of each source file at a time
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';

const ROOT = path.join(import.meta.dirname, '..');
const TS_IMPORT = /(from\s+['"]\.{1,2}\/[^'"]+)\.ts(['"])/g;

test('web/lib is src with the types stripped, file for file', () => {
  const src = fs.readdirSync(path.join(ROOT, 'src')).filter((n) => n.endsWith('.ts')).sort();
  const lib = fs.readdirSync(path.join(ROOT, 'web', 'lib')).filter((n) => n.endsWith('.js')).sort();
  assert.deepEqual(lib, src.map((n) => n.replace(/\.ts$/, '.js')), 'the same modules on both sides');
  for (const name of src) {
    const want = stripTypeScriptTypes(fs.readFileSync(path.join(ROOT, 'src', name), 'utf8'), { mode: 'strip' })
      .replace(TS_IMPORT, '$1.js$2');
    const have = fs.readFileSync(path.join(ROOT, 'web', 'lib', name.replace(/\.ts$/, '.js')), 'utf8');
    assert.ok(have === want, `web/lib/${name.replace(/\.ts$/, '.js')} is stale: run node tools/build-web.mjs`);
  }
});
