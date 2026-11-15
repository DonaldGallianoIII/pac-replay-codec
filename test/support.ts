/**
 * Shared pieces of the tests: the builds of the codec under test, the published releases they are held against,
 * the fixtures, and the helpers more than one test file needs (relabel a replay, damage one, seeded numbers).
 *
 * Builds under test (BUILDS):
 *   source           src/index.ts, every capability on
 *   web/lib/index    the packaged library entry: packs, unpacks, loads starting models
 *   web/lib/encode   the packaged entry that packs and unpacks, without starting models
 *   web/lib/decode   the packaged unpack-only entry
 * Published releases (RELEASES): pac-replay-codec 1.0.0 and 1.0.1 exactly as they sit on npm. They are dev
 * dependencies under alias names, pinned by integrity hash in package-lock.json, so `npm install` brings exactly the
 * bytes that were published. Without them the tests that need them skip and say so (NEEDS_RELEASES).
 *
 * @interacts reads test/fixtures/ and, when REPLAY_DIR is set, the .colreplay files in it; loads src/index.ts,
 *            web/lib/index.js, web/lib/encode.js, web/lib/decode.js and the two published packages
 * @deps      src/index.ts, src/codec.ts, src/clrp.ts, src/prior.ts, web/lib/ (built by tools/build-web.mjs),
 *            node_modules/pac-replay-codec-1.0.0 and -1.0.1 (npm install)
 * @complexity O(1) to load; each helper is O(input)
 * @alloc     one copy of the input per helper call
 * @rng       lcg(seed): a seeded generator, the same numbers on every run
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as source from '../src/index.ts';
import { Codec } from '../src/codec.ts';
import { HEADER_FIXED_BYTES, MAGIC_BYTES, u32At, firstHandshakeBody } from '../src/clrp.ts';
import { writePrior, stateCode, OWNER, SITE, CONTEXTS_UNCHECKED } from '../src/prior.ts';
import type { PriorParts } from '../src/prior.ts';

/** The calls a build of the codec offers. Only an unpacker is required; packing and starting models are optional. */
export interface Lib {
  unpackReplay: (packed: Uint8Array, priors?: readonly unknown[]) => Uint8Array;
  packReplay?: (src: Uint8Array, opts?: { gameAware?: boolean; prior?: unknown }) => { bytes: Uint8Array; mode: number; predictors: number; error: string | null };
  parsePrior?: (file: Uint8Array) => unknown;
}
export interface Build { name: string; lib: Lib }

const ROOT = path.join(import.meta.dirname, '..');
export const FIXTURES = path.join(import.meta.dirname, 'fixtures');
export const SYNTHETIC = ['synthetic-schema4.colreplay', 'synthetic-schema5.colreplay'].map((n) => path.join(FIXTURES, n));

export const CONFIG = Object.freeze({
  /** Seed and constants of the generator behind every damaged or random test input. */
  DamageSeed: 20261113, LcgA: 1664525, LcgC: 1013904223,
  GarbageBytes: 4096, RandomBytes: 100000, FlippedBytes: 12, HeaderCut: 40,
  /** Real replays read from REPLAY_DIR unless REPLAY_LIMIT says otherwise. */
  ReplayLimit: 20,
  /** The CLRZ format version a hand-made starting model is written for. */
  PriorModel: 1,
});

export const REPLAY_DIR = process.env.REPLAY_DIR ?? '';
const REPLAY_LIMIT = Number(process.env.REPLAY_LIMIT ?? CONFIG.ReplayLimit);
/** The real replays the caller pointed at: the first REPLAY_LIMIT .colreplay files of REPLAY_DIR, by name. */
export const REPLAYS = REPLAY_DIR
  ? fs.readdirSync(REPLAY_DIR).filter((n) => n.endsWith('.colreplay')).sort().slice(0, REPLAY_LIMIT).map((n) => path.join(REPLAY_DIR, n))
  : [];
export const NEEDS_REPLAYS = REPLAYS.length === 0 ? 'set REPLAY_DIR to a folder of .colreplay files to run this' : false;

/** Load a module by path or package name without asking the type checker to resolve it. */
async function load(specifier: string): Promise<Lib> {
  return (await import(specifier)) as Lib;
}
const libFile = (name: string): string => path.join(ROOT, 'web', 'lib', name);

/** Every build of this repository's codec. A missing packaged build fails here, loudly, before any test runs. */
export const BUILDS: Build[] = [
  { name: 'source', lib: source as unknown as Lib },
  { name: 'web/lib/index', lib: await load(libFile('index.js')) },
  { name: 'web/lib/encode', lib: await load(libFile('encode.js')) },
  { name: 'web/lib/decode', lib: await load(libFile('decode.js')) },
];
/** The builds that can pack. */
export const PACKERS = BUILDS.filter((b) => typeof b.lib.packReplay === 'function');

const RELEASE_NAMES = ['1.0.0', '1.0.1'];
const loaded: Build[] = [];
let missing = '';
for (const version of RELEASE_NAMES) {
  try {
    loaded.push({ name: `published ${version}`, lib: await load(`pac-replay-codec-${version}`) });
  } catch {
    missing = `pac-replay-codec ${version} is not installed: run npm install (it is a dev dependency)`;
  }
}
/** pac-replay-codec 1.0.0 and 1.0.1 as published, oldest first; empty when they are not installed. */
export const RELEASES: Build[] = missing === '' ? loaded : [];
export const NEEDS_RELEASES = missing === '' ? false : missing;
/** The release every new pack must match byte for byte: the newest one. */
export const LATEST_RELEASE: Build | null = RELEASES.length > 0 ? RELEASES[RELEASES.length - 1] : null;

/** sha256 of bytes, as hex. @complexity O(n) @alloc the digest */
export function sha(u8: Uint8Array): string {
  return crypto.createHash('sha256').update(u8).digest('hex');
}

/**
 * A seeded generator: rnd(n) is the next number below n. The top bits of the state are used because the low bits
 * of this generator repeat every 256 draws.
 * @complexity O(1) per draw @alloc one closure @rng the generator itself; one seed per test
 */
export function lcg(seed: number): (n: number) => number {
  let s = seed;
  return (n: number): number => {
    s = (Math.imul(s, CONFIG.LcgA) + CONFIG.LcgC) >>> 0;
    return (s >>> 8) % n;
  };
}

const GAME_VERSION_KEY = '"game":{"version":"';

/**
 * A copy of a replay whose meta block names another game version: the text after "game":{"version":" up to the
 * next quote is replaced and the u32 meta length in the CLRP header is rewritten to match.
 * @complexity O(file) @alloc the copy
 */
export function relabel(src: Uint8Array, version: string): Uint8Array {
  const metaEnd = HEADER_FIXED_BYTES + u32At(src, MAGIC_BYTES + 1);
  const meta = Buffer.from(src.subarray(HEADER_FIXED_BYTES, metaEnd)).toString('latin1');
  const at = meta.indexOf(GAME_VERSION_KEY);
  assert.ok(at >= 0, 'the replay names a game version');
  const from = at + GAME_VERSION_KEY.length;
  const next = Buffer.from(meta.slice(0, from) + version + meta.slice(meta.indexOf('"', from)), 'latin1');
  const out = Buffer.alloc(HEADER_FIXED_BYTES + next.length + src.length - metaEnd);
  out.set(src.subarray(0, HEADER_FIXED_BYTES));
  out.writeUInt32LE(next.length, MAGIC_BYTES + 1);
  out.set(next, HEADER_FIXED_BYTES);
  out.set(src.subarray(metaEnd), HEADER_FIXED_BYTES + next.length);
  return new Uint8Array(out);
}

/**
 * Damaged versions of one replay: cut, padded, flipped, and inputs that are not replays at all.
 * @complexity O(file) @alloc six arrays @rng lcg(CONFIG.DamageSeed), so every run damages the same bytes
 */
export function damagedCases(src: Uint8Array): [string, Uint8Array][] {
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

/**
 * Parts of a small hand-made starting model for the type table of `src` (the schema 5 fixture): three words, three
 * fields, one block per key count, two states. Its context count is taken from a coder that loads a draft of it.
 * @interacts src/codec.ts (one empty coder, to count contexts), src/prior.ts
 * @complexity O(type table) @alloc the parts and one coder
 */
export function handMadePrior(src: Uint8Array): PriorParts {
  const at = firstHandshakeBody(src);
  assert.ok(at !== null, 'the replay opens with a handshake frame');
  const enc = new TextEncoder();
  const parts: PriorParts = {
    model: CONFIG.PriorModel, contexts: 0, handshake: src.slice(at[0], at[1]),
    strings: [enc.encode('GAME_END'), enc.encode('PIKACHU'), enc.encode('WATER')],
    fields: [
      { owner: OWNER.MSGTYPE, key: 0, dict: [0] },
      { owner: OWNER.FIELD, key: 385, dict: [1] },
      { owner: OWNER.KEY, key: 328, dict: [2] },
    ],
    blocks: [
      { site: SITE.HEAD_FLAG, a: 1300, b: 0, c: 0 },
      { site: SITE.BYTE, a: 400, b: 0, c: 0 },
      { site: SITE.BYTE_HI, a: 400, b: 0, c: 5 },
      { site: SITE.BYTE_HI, a: 401, b: 2, c: 7 },
      { site: SITE.FLOAT_HI, a: 786, b: 3, c: 0 },
      { site: SITE.STR_HINT, a: 1, b: 0, c: 0 },
    ],
    states: [],
  };
  // the context count a file must record: load the draft into a coder that does not check it
  const draft = { ...source.parsePrior(writePrior({ ...parts, contexts: 1 })), contexts: CONTEXTS_UNCHECKED };
  parts.contexts = new Codec(new Uint8Array(0), true, { formulas: false, counted: false, rawLen: 0, startModel: draft }).rc.used;
  parts.states = [{ index: 70000, code: stateCode(5, 3) }, { index: parts.contexts - 1, code: stateCode(60, 0) }];
  return parts;
}
