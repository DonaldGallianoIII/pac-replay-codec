/**
 * Cross-check against the published releases. The .paczd format is frozen, so every build of this repository's
 * codec (the source, web/lib/index.js, web/lib/decode.js) is held against pac-replay-codec 1.0.0 and 1.0.1 exactly
 * as they sit on npm (see support.ts for how they are pinned):
 *
 *   packs       byte for byte what 1.0.1 packs, with and without the mini-game formulas
 *   reads old   what 1.0.0 and 1.0.1 packed comes back as the original
 *   old reads   1.0.0 and 1.0.1 unpack what this build packs
 *   damage      the same damaged files are refused and the same ones accepted, with the same bytes back
 *   model       a file 1.0.1 packed with a starting model: same bytes here, and it unpacks with that model
 *
 * Run: node --test test/compat.test.ts
 *      REPLAY_DIR=~/my-replays node --test test/compat.test.ts          (plus the same checks on real replays)
 *      REPLAY_DIR=~/my-replays REPLAY_LIMIT=100 node --test test/compat.test.ts
 *
 * @interacts support.ts (the builds, the releases, the fixtures); reads REPLAY_DIR when set; writes nothing
 * @deps      support.ts, src/prior.ts (writePrior, to make the hand-made starting model), node:test
 * @complexity fixtures: about 40 inputs of 20 KB, each packed and unpacked by every build and release, plus
 *            FuzzCases unpack calls per build. Real replays: R replays (REPLAY_LIMIT, default 20) of up to 5 MB,
 *            each packed once per packer and release and unpacked once per build and release, about 2.5 s each
 * @alloc     one replay with its packed and unpacked forms at a time
 * @rng       lcg(FuzzSeed) for the damaged files, the same ones on every run
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  BUILDS, PACKERS, RELEASES, LATEST_RELEASE, NEEDS_RELEASES, SYNTHETIC, REPLAYS, NEEDS_REPLAYS, relabel, damagedCases, lcg, sha,
  handMadePrior,
} from './support.ts';
import type { Build, Lib } from './support.ts';
import { writePrior } from '../src/prior.ts';

const CONFIG = Object.freeze({ FuzzSeed: 20261114, FuzzCases: 1000, BodyMax: 2048, FlipsMax: 4, TimeoutMs: 600000 });
/** CLRZ header pieces, spelled out here so the test does not lean on the code under test. */
const CLRZ = Object.freeze({ Magic: [0x43, 0x4c, 0x52, 0x5a], Version: 1, ModeCoded: 0, ModePrior: 2, ExpansionMax: 1024, VarintBase: 128 });
const VERSIONS = ['6.11.2', '6.11', '7.0.0'];
const OPTIONS = [{}, { gameAware: false }];
const NEEDS = NEEDS_RELEASES;

const packer = (b: Build): NonNullable<Lib['packReplay']> => b.lib.packReplay as NonNullable<Lib['packReplay']>;
const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && sha(a) === sha(b);

/** The fixtures, each also under three other game version labels and in six damaged forms. */
function fixtureInputs(): [string, Uint8Array][] {
  const out: [string, Uint8Array][] = [];
  for (const file of SYNTHETIC) {
    const name = path.basename(file);
    const src = new Uint8Array(fs.readFileSync(file));
    out.push([name, src]);
    for (const version of VERSIONS) out.push([`${name} as ${version}`, relabel(src, version)]);
    for (const [damage, bytes] of damagedCases(src)) out.push([`${name} ${damage}`, bytes]);
  }
  return out;
}

/** Hold every build against the releases on one input: packed bytes, and reading in both directions. */
function crossCheck(label: string, src: Uint8Array, opts: { gameAware?: boolean }): void {
  const latest = LATEST_RELEASE as Build;
  const want = packer(latest)(src, opts);
  for (const b of PACKERS) {
    const got = packer(b)(src, opts);
    assert.ok(same(got.bytes, want.bytes), `${label}: ${b.name} packs ${got.bytes.length} bytes, ${latest.name} packs ${want.bytes.length}, and they differ`);
    assert.equal(got.mode, want.mode, `${label}: ${b.name} mode`);
    assert.equal(got.predictors, want.predictors, `${label}: ${b.name} predictor set`);
  }
  // what each release packed (1.0.0 may differ from 1.0.1 on a version it does not name) reads back everywhere
  for (const r of RELEASES) {
    const packed = packer(r)(src, opts).bytes;
    for (const b of BUILDS) assert.ok(same(b.lib.unpackReplay(packed), src), `${label}: ${b.name} unpacks what ${r.name} packed`);
    // and the releases read what the builds pack: the bytes are those of the latest release, checked above
    assert.ok(same(r.lib.unpackReplay(want.bytes), src), `${label}: ${r.name} unpacks what this build packs`);
  }
}

test('fixtures: every build packs the bytes 1.0.1 packs, and old and new read each other', { skip: NEEDS }, () => {
  for (const [label, src] of fixtureInputs()) {
    for (const opts of OPTIONS) crossCheck(`${label}${opts.gameAware === false ? ' (schema only)' : ''}`, src, opts);
  }
});

/** A CLRZ header: magic, version, predictor set, mode, varint size claim, crc32. */
function header(predictors: number, mode: number, rawLen: number, crc: number): number[] {
  const h = [...CLRZ.Magic, CLRZ.Version, predictors, mode];
  let v = rawLen;
  while (v >= CLRZ.VarintBase) {
    h.push((v % CLRZ.VarintBase) | CLRZ.VarintBase);
    v = Math.floor(v / CLRZ.VarintBase);
  }
  h.push(v);
  h.push(crc & 0xff, (crc >>> 8) & 0xff, (crc >>> 16) & 0xff, (crc >>> 24) & 0xff);
  return h;
}

/** What a build does with one file: the bytes it returns, or null when it throws an Error. */
function outcome(b: Build, input: Uint8Array, label: string): Uint8Array | null {
  try {
    return b.lib.unpackReplay(input);
  } catch (e) {
    assert.ok(e instanceof Error, `${label}: ${b.name} throws an Error, not ${typeof e}`);
    return null;
  }
}

test(`damage: ${CONFIG.FuzzCases} random, cut and flipped files get the same answer as from 1.0.1`, { skip: NEEDS, timeout: CONFIG.TimeoutMs }, () => {
  const latest = LATEST_RELEASE as Build;
  const rnd = lcg(CONFIG.FuzzSeed);
  const randomBytes = (n: number): Uint8Array => Uint8Array.from({ length: n }, () => rnd(256));
  const original = new Uint8Array(fs.readFileSync(SYNTHETIC[1]));
  const good = packer(latest)(original).bytes;
  let accepted = 0;
  for (let i = 0; i < CONFIG.FuzzCases; i++) {
    let input: Uint8Array;
    const kind = i % 4;
    if (kind === 0) {
      // random bytes behind a valid header with a size claim inside the limits
      const body = randomBytes(1 + rnd(CONFIG.BodyMax));
      const head = header(rnd(2), CLRZ.ModeCoded, rnd((body.length + 1) * CLRZ.ExpansionMax), rnd(2 ** 31));
      input = new Uint8Array(head.length + body.length);
      input.set(head);
      input.set(body, head.length);
    } else if (kind === 1) {
      input = randomBytes(rnd(CONFIG.BodyMax)); // anything at all
    } else if (kind === 2) {
      input = good.subarray(0, rnd(good.length)); // a real packed file, cut short
    } else {
      input = Uint8Array.from(good); // a real packed file with a few bytes changed
      for (let k = 0; k <= rnd(CONFIG.FlipsMax); k++) input[rnd(input.length)] ^= 1 + rnd(255);
    }
    const want = outcome(latest, input, `case ${i}`);
    if (want !== null) accepted++;
    for (const b of BUILDS) {
      const got = outcome(b, input, `case ${i}`);
      assert.equal(got === null, want === null, `case ${i}: ${b.name} ${got === null ? 'refuses' : 'accepts'} a file ${latest.name} ${want === null ? 'refuses' : 'accepts'}`);
      if (got !== null && want !== null) assert.ok(same(got, want), `case ${i}: ${b.name} returns other bytes than ${latest.name}`);
    }
  }
  // a flip in the coder's final padding leaves a file valid, so a few are accepted; that both sides agree is the test
  assert.ok(accepted < CONFIG.FuzzCases / 40, `${accepted} damaged files unpacked; only padding flips may`);
});

test('starting model: a file 1.0.1 packed with one packs to the same bytes here and unpacks with that model', { skip: NEEDS }, () => {
  const latest = LATEST_RELEASE as Build;
  const src = new Uint8Array(fs.readFileSync(SYNTHETIC[1]));
  const file = writePrior(handMadePrior(src));
  const parse = (b: Build): unknown => (b.lib.parsePrior as NonNullable<Lib['parsePrior']>)(file);
  const want = packer(latest)(src, { prior: parse(latest) });
  assert.equal(want.mode, CLRZ.ModePrior, 'the release packed with the model');
  for (const b of BUILDS) {
    if (b.lib.parsePrior === undefined) {
      // a build without starting models says so; it never returns bytes for such a file
      assert.throws(() => b.lib.unpackReplay(want.bytes), Error, `${b.name} refuses a file that needs a starting model`);
      continue;
    }
    const prior = parse(b);
    assert.ok(same(b.lib.unpackReplay(want.bytes, [prior]), src), `${b.name} unpacks what ${latest.name} packed with the model`);
    assert.throws(() => b.lib.unpackReplay(want.bytes), /starting model/, `${b.name} without the model refuses the file`);
    if (b.lib.packReplay !== undefined) {
      const got = packer(b)(src, { prior });
      assert.ok(same(got.bytes, want.bytes), `${b.name} packs with the model to the bytes ${latest.name} packs`);
    }
  }
  for (const r of RELEASES) assert.ok(same(r.lib.unpackReplay(want.bytes, [parse(r)]), src), `${r.name} unpacks it too`);
});

test('your replays: packs match 1.0.1 byte for byte, and old and new read each other', { skip: NEEDS || NEEDS_REPLAYS, timeout: CONFIG.TimeoutMs * 10 }, () => {
  for (const f of REPLAYS) crossCheck(path.basename(f), new Uint8Array(fs.readFileSync(f)), {});
  // one replay through the other paths: schema only, and the two-pass choice for a version no build names
  const first = new Uint8Array(fs.readFileSync(REPLAYS[0]));
  crossCheck(`${path.basename(REPLAYS[0])} (schema only)`, first, { gameAware: false });
  for (const version of ['6.11', '7.0.0']) crossCheck(`${path.basename(REPLAYS[0])} as ${version}`, relabel(first, version), {});
});
