/**
 * Hostile input for the unpacker: crafted headers that claim huge originals, and a seeded fuzz loop over random,
 * truncated and bit-flipped files. Every case must throw a plain Error, quickly, without exhausting memory, and
 * must never hand back bytes.
 *
 * Run: node --test test/hostile.test.ts
 *
 * Every test runs on every build of the codec (support.ts): the source and the packaged web/lib entries.
 *
 * @interacts support.ts (the builds); src/index.ts (packReplay and the limits); reads
 *            test/fixtures/synthetic-schema5.colreplay
 * @deps      support.ts, src/index.ts, node:test
 * @complexity about FuzzCases unpack calls per build on inputs of at most a few KB, plus a handful of crafted
 *            headers
 * @alloc     one small input per case; the memory check asserts nothing near MAX_ORIGINAL_BYTES is allocated
 * @rng       seeded LCG (Seed), so every run tries the same inputs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { packReplay, MAX_ORIGINAL_BYTES, EXPANSION_MAX, MODE_CODED, MODE_STORED, CONTAINER_MAGIC, FORMAT_VERSION, PREDICTORS_SCHEMA, PREDICTORS_PAC_MINIGAME } from '../src/index.ts';
import { BUILDS } from './support.ts';

const CONFIG = Object.freeze({ Seed: 20261114, LcgA: 1664525, LcgC: 1013904223, FuzzCases: 2000, BodyMax: 2048,
  TimeoutMs: 60000, AllocSlackBytes: 64 * 1024 * 1024 });
const MODE_PRIOR_BYTE = 2;
const VARINT_BASE = 128;

let seed = CONFIG.Seed;
const rnd = (n: number): number => {
  seed = (Math.imul(seed, CONFIG.LcgA) + CONFIG.LcgC) >>> 0;
  return (seed >>> 8) % n;
};
const randomBytes = (n: number): Uint8Array => Uint8Array.from({ length: n }, () => rnd(256));

/** A CLRZ header: magic, version, predictor set, mode, [prior id], varint size claim, crc32. */
function header(predictors: number, mode: number, rawLen: number, crc = 0): number[] {
  const h = [...CONTAINER_MAGIC, FORMAT_VERSION, predictors, mode];
  if (mode === MODE_PRIOR_BYTE) h.push(1, 2, 3, 4);
  let v = rawLen;
  while (v >= VARINT_BASE) {
    h.push((v % VARINT_BASE) | VARINT_BASE);
    v = Math.floor(v / VARINT_BASE);
  }
  h.push(v);
  h.push(crc & 0xff, (crc >>> 8) & 0xff, (crc >>> 16) & 0xff, (crc >>> 24) & 0xff);
  return h;
}
const file = (head: number[], body: Uint8Array): Uint8Array => {
  const out = new Uint8Array(head.length + body.length);
  out.set(head);
  out.set(body, head.length);
  return out;
};

/** Run `fn`, which must throw an Error, and check it did not allocate anything near the claimed size. */
function refusedWithoutAllocating(fn: () => unknown, label: string) {
  const before = process.memoryUsage().arrayBuffers;
  assert.throws(fn, Error, label);
  const grew = process.memoryUsage().arrayBuffers - before;
  assert.ok(grew < CONFIG.AllocSlackBytes, `${label}: ${grew} bytes of buffers appeared`);
}

test('a coded file claiming more than MAX_ORIGINAL_BYTES is refused before allocating', () => {
  const body = randomBytes(MAX_ORIGINAL_BYTES / EXPANSION_MAX + 1024); // big enough that only the absolute cap applies
  for (const b of BUILDS) {
    const unpack = b.lib.unpackReplay;
    for (const predictors of [PREDICTORS_SCHEMA, PREDICTORS_PAC_MINIGAME]) {
      refusedWithoutAllocating(() => unpack(file(header(predictors, MODE_CODED, MAX_ORIGINAL_BYTES + 1), body)),
        `${b.name}: claim of MAX_ORIGINAL_BYTES + 1, predictors ${predictors}`);
    }
    assert.throws(() => unpack(file(header(0, MODE_CODED, MAX_ORIGINAL_BYTES + 1), body)), /CLRZ header is damaged/, b.name);
  }
});

test('a coded file claiming more than EXPANSION_MAX bytes per packed byte is refused before allocating', () => {
  const body = randomBytes(100);
  const claim = (body.length + 1) * EXPANSION_MAX + 1;
  for (const b of BUILDS) {
    const unpack = b.lib.unpackReplay;
    refusedWithoutAllocating(() => unpack(file(header(0, MODE_CODED, claim), body)), `${b.name}: ratio claim just past the limit`);
    assert.throws(() => unpack(file(header(0, MODE_CODED, claim), body)), /CLRZ header is damaged/, b.name);
    // the largest varint the header can hold (7 bytes)
    refusedWithoutAllocating(() => unpack(file(header(0, MODE_CODED, 2 ** 49 - 1), body)), `${b.name}: seven-byte size claim`);
  }
});

test('a stored file whose size claim does not match its body is refused', () => {
  const body = randomBytes(10);
  for (const b of BUILDS) {
    refusedWithoutAllocating(() => b.lib.unpackReplay(file(header(0, MODE_STORED, MAX_ORIGINAL_BYTES * 4), body)),
      `${b.name}: stored claim of 1 GB on a 10 byte body`);
  }
});

test('mode 2 names a starting model that was not given: refused', () => {
  const body = randomBytes(200);
  for (const b of BUILDS) {
    assert.throws(() => b.lib.unpackReplay(file(header(0, MODE_PRIOR_BYTE, 1000), body)), /starting model/, b.name);
  }
});

test('a normal replay still packs coded and unpacks under the limits', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'synthetic-schema5.colreplay'));
  const packed = packReplay(src);
  assert.equal(packed.mode, MODE_CODED);
  assert.equal(packed.error, null);
  for (const b of BUILDS) assert.deepEqual(b.lib.unpackReplay(packed.bytes), new Uint8Array(src), b.name);
});

test(`fuzz: ${CONFIG.FuzzCases} random, truncated and flipped files all throw in every build, none hangs`, { timeout: CONFIG.TimeoutMs }, () => {
  const original = new Uint8Array(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'synthetic-schema5.colreplay')));
  const good = packReplay(original).bytes;
  let returned = 0;
  for (let i = 0; i < CONFIG.FuzzCases; i++) {
    let input: Uint8Array;
    const kind = i % 4;
    if (kind === 0) {
      // random bytes behind a valid header with a size claim inside the limits
      const body = randomBytes(1 + rnd(CONFIG.BodyMax));
      input = file(header(rnd(2), MODE_CODED, rnd((body.length + 1) * EXPANSION_MAX), rnd(2 ** 31)), body);
    } else if (kind === 1) {
      input = randomBytes(rnd(CONFIG.BodyMax)); // anything at all
    } else if (kind === 2) {
      input = good.subarray(0, rnd(good.length)); // a real packed file, cut short
    } else {
      input = Uint8Array.from(good); // a real packed file with a few bytes changed
      for (let k = 0; k <= rnd(4); k++) input[rnd(input.length)] ^= 1 + rnd(255);
    }
    for (const b of BUILDS) {
      let back: Uint8Array | null = null;
      try {
        back = b.lib.unpackReplay(input);
      } catch (e) {
        assert.ok(e instanceof Error, `case ${i}, ${b.name}: throws an Error, not ${typeof e}`);
        continue;
      }
      // a flip in the coder's final padding can leave the file valid; then it must be the real original
      returned++;
      assert.equal(kind, 3, `case ${i}, ${b.name}: only a flipped real file may unpack`);
      assert.deepEqual(back, original, `case ${i}, ${b.name}: a file that unpacks gives exactly the original`);
    }
  }
  assert.ok(returned < (CONFIG.FuzzCases * BUILDS.length) / 40, `${returned} damaged files unpacked; only padding flips may`);
});
