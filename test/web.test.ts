/**
 * Tests of the page's pure helpers that run without a browser: the zip writer and the zip entry names.
 *
 * Run: node --test test/web.test.ts
 *
 * @interacts web/zip.js; writes a zip into a temporary folder and reads it back with python3's zipfile when present
 * @deps      node:test, node:child_process (python3, optional)
 * @complexity a few small arrays and one zip of three tiny files
 * @alloc     the zip, a few hundred bytes
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
// @ts-ignore: plain JavaScript module of the page, no types
import { makeZip, uniqueNames } from '../web/zip.js';

test('zip entry names: duplicates get a suffix that no other entry already has', () => {
  const cases: string[][] = [
    ['g.clrz', 'g.clrz', 'g (2).clrz'],
    ['g (2).clrz', 'g.clrz', 'g.clrz'],
    ['a.clrz', 'a.clrz', 'a.clrz', 'a (2).clrz', 'a (3).clrz'],
    ['noext', 'noext', 'noext'],
    ['x.clrz', 'y.clrz'],
  ];
  for (const names of cases) {
    const out: string[] = uniqueNames(names);
    assert.equal(out.length, names.length);
    assert.equal(new Set(out).size, out.length, `${names.join(', ')} -> ${out.join(', ')} has a duplicate`);
    // a name that was unique to begin with keeps its name
    names.forEach((n, i) => { if (names.indexOf(n) === i) assert.equal(out[i], n); });
  }
  assert.deepEqual(uniqueNames(['g.clrz', 'g.clrz', 'g (2).clrz']), ['g.clrz', 'g (3).clrz', 'g (2).clrz']);
});

const HAS_PYTHON = spawnSync('python3', ['-c', 'import zipfile'], { encoding: 'utf8' }).status === 0;

test('zip: a standard reader gets every entry back, names (UTF-8) and bytes', { skip: HAS_PYTHON ? false : 'no python3 on this machine' }, async () => {
  const items = [['a.clrz', 'first'], ['a (2).clrz', 'second'], ['\u00e9.colreplay', 'third']];
  const files = items.map(([name, text]) => {
    const bytes = new TextEncoder().encode(text);
    return { name, blob: new Blob([bytes]), crc: zlib.crc32(bytes) };
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clrz-zip-test-'));
  try {
    const zipFile = path.join(dir, 'all.zip');
    fs.writeFileSync(zipFile, new Uint8Array(await makeZip(files).arrayBuffer()));
    // Python's zipfile honours the UTF-8 name flag and checks every crc (testzip); Info-ZIP unzip 6.0 does not
    const script = 'import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; ' +
      'print(json.dumps([[i.filename, z.read(i).decode()] for i in z.infolist()]))';
    const r = spawnSync('python3', ['-I', '-c', script, zipFile], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), items);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
