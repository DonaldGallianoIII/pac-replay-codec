/**
 * The command line tool, the npm package and the web page all run web/lib/, which tools/build-web.mjs builds from
 * src/. This test builds again in memory and fails when the committed files are not what comes out: someone
 * changed src/ (or the build) and forgot `node tools/build-web.mjs`.
 *
 * The build needs its dev dependencies (esbuild, terser, acorn). Without them the test skips and says so; the
 * workflow in .github/ installs them first, so there it always runs.
 *
 * Run: node --test test/build.test.ts
 *
 * @interacts tools/build-web.mjs (buildAll, in memory); reads web/lib/*.js; writes nothing
 * @deps      tools/build-web.mjs and its dev dependencies, node:test
 * @complexity one full build, O(S) over the size of src/ (about 280 KB), a few seconds
 * @alloc     the built files, in memory, for the length of the test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const LIB = path.join(ROOT, 'web', 'lib');
const BUILD_TOOL = path.join(ROOT, 'tools', 'build-web.mjs');

interface Output { out: string; code: string }
interface BuildTool { buildAll: () => Promise<Output[]> }

let tool: BuildTool | null = null;
let needsTools: string | false = false;
try {
  tool = (await import(BUILD_TOOL)) as BuildTool;
} catch (e) {
  if (!(e instanceof Error) || !('code' in e) || e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
  needsTools = 'run npm install: the build needs its dev dependencies (esbuild, terser, acorn)';
}

test('web/lib is what tools/build-web.mjs builds from src, file for file', { skip: needsTools }, async () => {
  const outputs = await (tool as BuildTool).buildAll();
  const have = fs.readdirSync(LIB).filter((n) => n.endsWith('.js')).sort();
  assert.deepEqual(have, outputs.map((o) => o.out).sort(), 'the same files on both sides');
  for (const o of outputs) {
    const committed = fs.readFileSync(path.join(LIB, o.out), 'utf8');
    assert.ok(committed === o.code, `web/lib/${o.out} is stale: run node tools/build-web.mjs`);
  }
});

test('the packaged files stand alone: no imports, and the license notice at the top', () => {
  for (const name of fs.readdirSync(LIB).filter((n) => n.endsWith('.js'))) {
    const code = fs.readFileSync(path.join(LIB, name), 'utf8');
    assert.ok(!/\bimport\s*[({"']|\bfrom\s*["']/.test(code), `web/lib/${name} imports nothing`);
    assert.ok(code.startsWith('/*! pac-replay-codec '), `web/lib/${name} opens with the banner`);
    assert.ok(code.slice(0, 600).includes('Sun Microsystems'), `web/lib/${name} keeps the fdlibm notice`);
    assert.ok(code.slice(0, 600).includes('GPL-3.0-only'), `web/lib/${name} names its license`);
  }
});
