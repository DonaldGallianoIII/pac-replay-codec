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
 * The tests that only use the public calls run on every build of the codec (support.ts: the source and the
 * packaged web/lib entries); the ones that reach into the coder run on the source.
 *
 * @interacts reads test/fixtures/ and, when set, the .colreplay files in REPLAY_DIR; writes nothing. One test
 *            swaps Codec.prototype.encode for the length of the test and puts it back.
 * @deps      support.ts, src/index.ts, src/codec.ts, src/trig.ts, node:test
 * @complexity about 30 pack and unpack calls per build on the 20 KB fixtures; with REPLAY_DIR, 4 per replay (R
 *            replays, up to REPLAY_LIMIT) of up to 5 MB each; the relabelled cases code each file with both
 *            predictor sets
 * @alloc     one replay and its packed and unpacked forms at a time
 * @rng       seeded generator for the damaged cases (support.ts, DamageSeed), so every run tests the same bytes
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { packReplay, unpackReplay, crc32, knowsGameVersion, MODE_CODED, MODE_STORED, PREDICTORS_SCHEMA, PREDICTORS_PAC_MINIGAME } from '../src/index.ts';
import { Codec } from '../src/codec.ts';
import { detSin, detCos } from '../src/trig.ts';
import { BUILDS, PACKERS, SYNTHETIC, REPLAYS, NEEDS_REPLAYS, sha, relabel, damagedCases } from './support.ts';
import type { Build, Lib } from './support.ts';

const packWith = (b: Build): NonNullable<Lib['packReplay']> => b.lib.packReplay as NonNullable<Lib['packReplay']>;
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

test('format lock: every build packs the fixtures to the bytes format version 1 promises', () => {
  for (const b of PACKERS) {
    assert.equal(sha(packWith(b)(fs.readFileSync(SYNTHETIC[0])).bytes), LOCK.Schema4, `${b.name}, schema 4 fixture`);
    assert.equal(sha(packWith(b)(fs.readFileSync(SYNTHETIC[1])).bytes), LOCK.Schema5, `${b.name}, schema 5 fixture`);
  }
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

/** The coded body of `src` with one predictor set, straight from the coder. */
const bodyWith = (src: Uint8Array, gameAware: boolean): Uint8Array =>
  new Codec(src, true, { gameAware, account: false, rawLen: src.length, prior: null }).encode() as Uint8Array;

/** Pack `src`, check it round trips, and check the packer kept the smaller of the two predictor sets (tie: schema). */
function packsTheSmaller(src: Uint8Array, label: string) {
  assert.equal(knowsGameVersion(src), false, `${label}: not a version this build names`);
  const packed = roundTrip(src);
  const schema = bodyWith(src, false);
  const game = bodyWith(src, true);
  const want = game.length < schema.length ? PREDICTORS_PAC_MINIGAME : PREDICTORS_SCHEMA;
  const body = want === PREDICTORS_PAC_MINIGAME ? game : schema;
  assert.equal(packed.mode, MODE_CODED, `${label} is coded`);
  assert.equal(packed.predictors, want, `${label}: schema ${schema.length} B, formulas ${game.length} B`);
  assert.deepEqual(packed.bytes.subarray(packed.bytes.length - body.length), body, `${label}: the body is that set's`);
  return { packed, schema, game };
}

test('unknown game versions ("6.11" as v7 writes it, "7.0.0"): both sets tried, the smaller kept, exact round trip', () => {
  for (const file of SYNTHETIC) {
    const src = new Uint8Array(fs.readFileSync(file));
    for (const version of ['6.11', '7.0.0']) packsTheSmaller(relabel(src, version), `${path.basename(file)} as ${version}`);
  }
});

test('a 6.11.x replay takes the formulas in one pass, and gameAware: false takes the schema', () => {
  const src = relabel(new Uint8Array(fs.readFileSync(SYNTHETIC[1])), '6.11.2');
  assert.equal(knowsGameVersion(src), true);
  assert.equal(roundTrip(src).predictors, PREDICTORS_PAC_MINIGAME);
  assert.equal(roundTrip(relabel(src, '7.0.0'), false).predictors, PREDICTORS_SCHEMA);
});

test('the formulas throwing on an unknown version falls back to the schema set; on 6.11.x the file is stored as before', () => {
  const real = Codec.prototype.encode;
  Codec.prototype.encode = function (this: Codec) {
    if (Reflect.get(this, 'formulas') === true) throw new Error('formula pass failed (test)');
    return real.call(this);
  };
  try {
    const src = new Uint8Array(fs.readFileSync(SYNTHETIC[1]));
    for (const version of ['6.11', '7.0.0']) {
      const packed = roundTrip(relabel(src, version));
      assert.equal(packed.mode, MODE_CODED, `${version}: still coded`);
      assert.equal(packed.predictors, PREDICTORS_SCHEMA, `${version}: schema set`);
      assert.equal(packed.error, null, `${version}: a clean fallback`);
    }
    const known = roundTrip(relabel(src, '6.11.2'));
    assert.equal(known.mode, MODE_STORED, '6.11.x keeps one pass: a coder error stores the file');
    assert.match(known.error ?? '', /formula pass failed/);
  } finally {
    Codec.prototype.encode = real;
  }
});

test('damaged input: every case comes back bit for bit from every build, and never grows by more than the header', () => {
  for (const [name, src] of damagedCases(fs.readFileSync(SYNTHETIC[1]))) {
    for (const p of PACKERS) {
      const packed = packWith(p)(src);
      for (const b of BUILDS) {
        const back = b.lib.unpackReplay(packed.bytes);
        assert.equal(back.length, src.length, `${name}: packed by ${p.name}, unpacked by ${b.name}`);
        assert.equal(sha(back), sha(src), `${name}: packed by ${p.name}, unpacked by ${b.name}`);
      }
      assert.ok(packed.bytes.length <= src.length + 16, `${name}: packing never grows a file by more than the header`);
      if (name === 'random-100kb' || name === 'empty' || name === 'cut-in-header') assert.equal(packed.mode, MODE_STORED, `${name} is stored as it is`);
    }
  }
});

test('damaged packed data is refused by every build, never returned wrong', () => {
  const src = fs.readFileSync(SYNTHETIC[1]);
  const packed = packReplay(src, {}).bytes;
  for (const b of BUILDS) {
    const unpack = b.lib.unpackReplay;
    for (const at of [0, 5, 6, 9, 40, Math.floor(packed.length / 2)]) {
      const bad = Uint8Array.from(packed);
      bad[at] ^= 0x10;
      assert.throws(() => unpack(bad), `${b.name}: a flipped bit at byte ${at} must be noticed`);
    }
    // the very last bytes only pad the coder's final state: a flip there may change nothing, and then the original
    // must still come back exactly
    const tail = Uint8Array.from(packed);
    tail[tail.length - 1] ^= 0x10;
    let back: Uint8Array | null = null;
    try {
      back = unpack(tail);
    } catch {
      back = null;
    }
    if (back !== null) assert.equal(sha(back), sha(src), b.name);
    assert.throws(() => unpack(packed.subarray(0, packed.length - 100)), `${b.name}: a cut file must be noticed`);
    assert.throws(() => unpack(new Uint8Array(0)), b.name);
  }
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

test('your replays: a 6.11.2 replay relabelled "6.11" and "7.0.0" keeps the smaller set and round trips', { skip: NEEDS_REPLAYS }, (t) => {
  const src = new Uint8Array(fs.readFileSync(REPLAYS[0]));
  if (!knowsGameVersion(src)) { t.skip('the first replay in REPLAY_DIR is not from game version 6.11.x'); return; }
  const known = packReplay(src).bytes.length;
  for (const version of ['6.11', '7.0.0']) {
    const { packed } = packsTheSmaller(relabel(src, version), version);
    assert.equal(packed.stats?.rawFrames, 0);
    // a 6.11 game under another label still fits the formulas: the two-pass path must find them
    assert.equal(packed.predictors, PREDICTORS_PAC_MINIGAME, `${version}: the formulas win on a 6.11 game`);
    assert.ok(Math.abs(packed.bytes.length - known) < known / 100, `${version}: within 1% of the 6.11.2 size`);
  }
});

test('your replays: damaged copies of one come back bit for bit', { skip: NEEDS_REPLAYS }, () => {
  for (const [name, src] of damagedCases(fs.readFileSync(REPLAYS[0]))) {
    const packed = roundTrip(src);
    assert.ok(packed.bytes.length <= src.length + 16, `${name}: packing never grows a file by more than the header`);
  }
});

/** detSin and detCos of 0, 0.5, 1, 2.5, 12.345, 31.99, 1000.25, -7.75 as big-endian IEEE doubles. */
const TRIG_GOLDEN = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'trig-golden.json'), 'utf8')) as string[];
