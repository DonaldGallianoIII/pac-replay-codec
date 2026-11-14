/**
 * Tests of the replay codec: round trip, damaged input, the version gate, damaged packed data, and the two building
 * blocks other builds must match bit for bit (crc32 and the deterministic sine and cosine).
 *
 * The repository holds no recorded games. Every test here runs on the two synthetic replays in test/fixtures/,
 * written by make-synthetic.cjs from Colyseus's own encoder with a schema that is not a game. The tests that need a
 * real game replay run only when REPLAY_DIR points at a folder of .colreplay files:
 *
 *   node --test test/codec.test.ts
 *   REPLAY_DIR=~/my-replays node --test test/codec.test.ts
 *
 * @interacts reads test/fixtures/ and, when set, the .colreplay files in REPLAY_DIR; writes nothing
 * @deps      src/index.ts, src/trig.ts, node:test
 * @complexity about 30 pack and unpack calls on the 20 KB fixtures; with REPLAY_DIR, 4 per replay (R replays, up
 *            to REPLAY_LIMIT) of up to 5 MB each
 * @alloc     one replay and its packed and unpacked forms at a time
 * @rng       seeded LCG for the damaged cases (DamageSeed), so every run tests the same bytes
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { packReplay, unpackReplay, crc32, MODE_CODED, MODE_STORED, PREDICTORS_SCHEMA, PREDICTORS_PAC_MINIGAME } from '../src/index.ts';
import { detSin, detCos } from '../src/trig.ts';

const FIXTURES = path.join(import.meta.dirname, 'fixtures');
const SYNTHETIC = ['synthetic-schema4.colreplay', 'synthetic-schema5.colreplay'].map((n) => path.join(FIXTURES, n));
const CONFIG = Object.freeze({ DamageSeed: 20261113, LcgA: 1664525, LcgC: 1013904223, GarbageBytes: 4096,
  RandomBytes: 100000, FlippedBytes: 12, HeaderCut: 40, ReplayLimit: 20 });
const REPLAY_DIR = process.env.REPLAY_DIR ?? '';
const REPLAYS = REPLAY_DIR
  ? fs.readdirSync(REPLAY_DIR).filter((n) => n.endsWith('.colreplay')).sort().slice(0, CONFIG.ReplayLimit)
    .map((n) => path.join(REPLAY_DIR, n))
  : [];
const NEEDS_REPLAYS = REPLAYS.length === 0 ? 'set REPLAY_DIR to a folder of .colreplay files to run this' : false;

const sha = (u8: Uint8Array): string => crypto.createHash('sha256').update(u8).digest('hex');
const roundTrip = (src: Uint8Array, gameAware = true) => {
  const packed = packReplay(src, { gameAware });
  const back = unpackReplay(packed.bytes);
  assert.equal(back.length, src.length);
  assert.equal(sha(back), sha(src));
  return packed;
};

/**
 * The format lock. These are the sha256 of the packed bytes of the two synthetic fixtures under format version 1.
 * They change only when the model changes: any edit that moves one of them is a format change, and files packed
 * before it stop being readable unless the old model is kept under its own version number.
 */
const LOCK = Object.freeze({
  Schema4: '5961d453d627e6e13fc7c684b3ed4ce3efdd45eb1ad4c41337001b7a263e9574',
  Schema5: 'ea67b7dc0ee8b1f21bbc7f3c97c126366b8cb46ae3b4614ed38b2b8128cb3d81',
});

test('format lock: the packed bytes of the fixtures are the ones format version 1 promises', () => {
  assert.equal(sha(packReplay(fs.readFileSync(SYNTHETIC[0])).bytes), LOCK.Schema4);
  assert.equal(sha(packReplay(fs.readFileSync(SYNTHETIC[1])).bytes), LOCK.Schema5);
});

test('self-describing: replays from a schema that is not PAC, Colyseus schema 4 and 5', () => {
  for (const file of SYNTHETIC) {
    const src = fs.readFileSync(file);
    const packed = roundTrip(src);
    assert.equal(packed.mode, MODE_CODED);
    assert.equal(packed.predictors, PREDICTORS_SCHEMA, 'an unknown game version never gets the PAC formulas');
    assert.equal(packed.stats?.rawFrames, 0, 'every frame is walked with the type table from the file');
    assert.ok(packed.bytes.length * 3 < src.length);
  }
});

/** Damaged versions of one replay: cut, padded, flipped, and inputs that are not replays at all. */
function damagedCases(src: Uint8Array): [string, Uint8Array][] {
  let seed = CONFIG.DamageSeed;
  // the top bits of the generator: its low bits repeat every 256 draws and would make the "garbage" compressible
  const rnd = (): number => {
    seed = (Math.imul(seed, CONFIG.LcgA) + CONFIG.LcgC) >>> 0;
    return seed >>> 16;
  };
  const bytes = (n: number): Uint8Array => Uint8Array.from({ length: n }, () => rnd() & 0xff);
  const flipped = Uint8Array.from(src);
  for (let i = 0; i < CONFIG.FlippedBytes; i++) {
    const at = (src.length >> 2) + (rnd() % (src.length >> 1));
    flipped[at] ^= 1 + (rnd() % 255);
  }
  const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };
  return [
    ['cut-in-half', src.subarray(0, src.length >> 1)],
    ['cut-in-header', src.subarray(0, CONFIG.HeaderCut)],
    ['plus-4kb-garbage', concat(src, bytes(CONFIG.GarbageBytes))],
    [`${CONFIG.FlippedBytes}-bytes-flipped`, flipped],
    ['random-100kb', bytes(CONFIG.RandomBytes)],
    ['empty', new Uint8Array(0)],
  ];
}

test('damaged input: every case comes back bit for bit, and never grows by more than the header', () => {
  for (const [name, src] of damagedCases(fs.readFileSync(SYNTHETIC[1]))) {
    const packed = roundTrip(src);
    assert.ok(packed.bytes.length <= src.length + 16, `${name}: packing never grows a file by more than the header`);
    if (name === 'random-100kb' || name === 'empty' || name === 'cut-in-header') assert.equal(packed.mode, MODE_STORED, `${name} is stored as it is`);
  }
});

test('damaged packed data is refused, never returned wrong', () => {
  const src = fs.readFileSync(SYNTHETIC[1]);
  const packed = packReplay(src, {}).bytes;
  for (const at of [0, 5, 6, 9, 40, Math.floor(packed.length / 2)]) {
    const bad = Uint8Array.from(packed);
    bad[at] ^= 0x10;
    assert.throws(() => unpackReplay(bad), `a flipped bit at byte ${at} must be noticed`);
  }
  // the very last bytes only pad the coder's final state: a flip there may change nothing, and then the original
  // must still come back exactly
  const tail = Uint8Array.from(packed);
  tail[tail.length - 1] ^= 0x10;
  let back: Uint8Array | null = null;
  try {
    back = unpackReplay(tail);
  } catch {
    back = null;
  }
  if (back !== null) assert.equal(sha(back), sha(src));
  assert.throws(() => unpackReplay(packed.subarray(0, packed.length - 100)), 'a cut file must be noticed');
  assert.throws(() => unpackReplay(new Uint8Array(0)));
});

test('crc32 matches zlib', () => {
  const src = fs.readFileSync(SYNTHETIC[1]);
  for (const n of [0, 1, 2, 3, 4, 5, 1001, src.length]) assert.equal(crc32(src.subarray(0, n)), zlib.crc32(src.subarray(0, n)));
});

test('deterministic sine and cosine: fixed bit patterns (a port must match the same list)', () => {
  const hex = (x: number): string => {
    const b = Buffer.alloc(8);
    b.writeDoubleBE(x);
    return b.toString('hex');
  };
  const inputs = [0, 0.5, 1, 2.5, 12.345, 31.99, 1000.25, -7.75];
  const got = inputs.map((x) => `${hex(detSin(x))} ${hex(detCos(x))}`);
  assert.deepEqual(got, TRIG_GOLDEN);
  for (const x of inputs) {
    assert.ok(Math.abs(detSin(x) - Math.sin(x)) < 1e-15);
    assert.ok(Math.abs(detCos(x) - Math.cos(x)) < 1e-15);
  }
});

test('your replays: each one round trips, game-aware and schema-only', { skip: NEEDS_REPLAYS }, () => {
  for (const f of REPLAYS) {
    const src = fs.readFileSync(f);
    const aware = roundTrip(src);
    assert.equal(aware.mode, MODE_CODED, `${path.basename(f)} is coded`);
    const plain = roundTrip(src, false);
    assert.equal(plain.predictors, PREDICTORS_SCHEMA);
    if (aware.predictors === PREDICTORS_PAC_MINIGAME) {
      assert.ok(plain.bytes.length > aware.bytes.length, 'the mini-game formulas save bytes');
    }
  }
});

test('your replays: a 6.11 replay relabelled 7.00 packs with the schema alone and still round trips', { skip: NEEDS_REPLAYS }, (t) => {
  const src = Buffer.from(fs.readFileSync(REPLAYS[0]));
  const at = src.indexOf('"version":"6.11.');
  if (at < 0) { t.skip('the first replay in REPLAY_DIR is not from game version 6.11'); return; }
  src.write('7.00', at + '"version":"'.length);
  const packed = roundTrip(src);
  assert.equal(packed.predictors, PREDICTORS_SCHEMA);
  assert.equal(packed.stats?.rawFrames, 0);
});

test('your replays: damaged copies of one come back bit for bit', { skip: NEEDS_REPLAYS }, () => {
  for (const [name, src] of damagedCases(fs.readFileSync(REPLAYS[0]))) {
    const packed = roundTrip(src);
    assert.ok(packed.bytes.length <= src.length + 16, `${name}: packing never grows a file by more than the header`);
  }
});

/** detSin and detCos of 0, 0.5, 1, 2.5, 12.345, 31.99, 1000.25, -7.75 as big-endian IEEE doubles. */
const TRIG_GOLDEN = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'trig-golden.json'), 'utf8')) as string[];
