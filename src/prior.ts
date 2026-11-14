/**
 * The starting model ("prior") file: what the coder knows before the first byte of a replay. A cold coder starts
 * every context at one half and every dictionary empty, and pays to learn both in each file. A prior carries what
 * many other games taught: the type table, the game's vocabulary, and a starting probability for the contexts that
 * are worth one. It holds no model state of any single game.
 *
 * A prior is data, not code: it is built offline from many replays (no trainer ships with this codec), and named in the
 * header of every file packed with it. The unpacker must have the same prior, bit for bit, forever.
 *
 * File layout (little endian, varint = unsigned LEB128):
 *   "CLRQ" | u8 prior format = 1 | u8 model = the CLRZ format version whose model it fits
 *   varint contexts      how many coder contexts exist once the prior is loaded (a build whose tables differ
 *                        from the trainer's gets another number and refuses the prior)
 *   varint n, n bytes    the body of the handshake frame (the type table) the prior was trained on; n may be 0
 *   varint S, S varints, bytes     the vocabulary: S byte strings (their lengths, then their bytes)
 *   varint F, then per string field: u8 owner | varint key | varint n | n varints (vocabulary ids, in
 *                        dictionary order). Field 0 is always the message type field.
 *   varint G, then per group of blocks: u8 site | varint count | per block: varint (a minus the previous a of
 *                        the group) | varint b | varint c   (b and c only for sites that have them)
 *   varint C, C varints (context index minus the previous one), C bytes (state codes)
 *   u32 crc32 of every byte before it. This number is the prior's id.
 *
 * A state code is 6 bits of probability level (PROB_LEVELS, mirrored for the upper half) and 2 bits of starting
 * count (COUNT_LEVELS). The table is a list of integers on purpose: every build must turn a code into the same 16
 * bit probability, and exp() does not round the same way everywhere.
 *
 * Blocks and fields are listed in the order they are created when the prior is loaded. That order fixes where
 * every context lives, which is why the states can name contexts by plain index.
 *
 * @interacts none (pure over the bytes it is given)
 * @deps      crc32.ts
 * @complexity O(file) to parse or to write
 * @alloc     the parsed tables: a few integers per string, block and state
 */

import { crc32 } from './crc32.ts';

export const PRIOR_MAGIC = [0x43, 0x4c, 0x52, 0x51];
export const PRIOR_FORMAT = 1;
const MAGIC_BYTES = 4;
/** magic, prior format, model version */
const FIXED_BYTES = MAGIC_BYTES + 2;
const U32_BYTES = 4;
const BITS_PER_BYTE = 8;
const BYTE_MASK = 0xff;
const VARINT_CONTINUE = 0x80;
const VARINT_DATA = 0x7f;
const VARINT_BASE = 128;
/** Longest varint accepted: 5 bytes hold 35 bits, more than any index or length in a prior. */
const VARINT_MAX_BYTES = 5;
const VARINT_LIMIT = 4294967296;
const DAMAGED = 'starting model file is damaged';

/** Who owns a string field (how the codec finds it again when the prior is loaded). */
export const OWNER = Object.freeze({
  /** The message type names (field 0). */
  MSGTYPE: 0,
  /** A string field of a structure, or the string items of a collection: key is the field id. */
  FIELD: 1,
  /** The keys of a map: key is the collection id. */
  KEY: 2,
  COUNT: 3,
});

/**
 * The context blocks a prior may create, by where the codec keeps them. The numbers are part of the prior file.
 * `keys` is how many of (a, b, c) the site uses.
 */
export const SITE = Object.freeze({
  HEAD_FLAG_START: 1, HEAD_FLAG: 2, HEAD_TREE: 3, HEAD_MISS: 4, COLL: 5, INDEX: 6, SWITCH: 7, TREE_STOP: 8,
  TREE_STEP: 9, NEW_REF: 10, TYPE: 11, TYPE_LO: 12, BYTE: 13, BYTE_HI: 14, INT16: 15, INT16_HI: 16, NUM_CLASS: 17,
  NUM_HI: 18, NUM_LO: 19, FLOAT_LO: 20, FLOAT_HI: 21, OTHER: 22, STR_HINT: 23, COUNT: 24,
});
/** Keys per site, indexed by site code (0 is unused). */
export const SITE_KEYS = Object.freeze([0, 1, 1, 1, 2, 1, 1, 1, 1, 2, 1, 1, 2, 2, 3, 2, 3, 1, 2, 1, 2, 2, 1, 2]);

/** Probability that the bit is 1, out of 65536, for state levels 0 to 31; level 63 - k is 65536 minus level k. */
export const PROB_LEVELS = Object.freeze([
  33, 42, 53, 68, 86, 109, 139, 177, 225, 286, 364, 462, 588, 746, 947, 1200, 1520, 1923, 2429, 3060, 3847, 4819,
  6013, 7468, 9219, 11301, 13738, 16541, 19699, 23174, 26902, 30794,
]);
const PROB_CODES = 64;
const PROB_CODE_MASK = 63;
const PROB_CODE_BITS = 6;
const PROB_ONE = 65536;
/** Starting observation counts a state may carry (the coder's own limit is 30). */
export const COUNT_LEVELS = Object.freeze([2, 6, 14, 30]);
const PROB_SHIFT = 16;
/** The coder stores a state XOR this (range-coder.ts). */
const STATE_FLIP = 0x80000000;

/**
 * `contexts` value of a prior that is still being built in memory: the coder then skips the check of its context
 * count. A parsed file never carries it.
 */
export const CONTEXTS_UNCHECKED = -1;

/** A parsed prior, ready to be loaded into a coder. Treat every array as read only. */
export interface Prior {
  /** crc32 of the file: the number written in the header of a file packed with this prior. */
  id: number;
  /** The CLRZ format version whose model this prior fits. */
  model: number;
  /** Coder contexts in existence right after loading. */
  contexts: number;
  /** Body of the handshake frame the prior was trained on (empty when it carries none). */
  handshake: Uint8Array;
  /** Vocabulary bytes, and where each string starts (stringStart[S] is the end of the last). */
  stringBytes: Uint8Array;
  stringStart: Int32Array;
  /** String fields in creation order: owner (OWNER), key, and the slice of fieldDict that is its dictionary. */
  fieldOwner: Uint8Array;
  fieldKey: Int32Array;
  fieldDictStart: Int32Array;
  fieldDict: Int32Array;
  /** Context blocks in creation order: site (SITE) and up to three keys. */
  blockSite: Uint8Array;
  blockA: Int32Array;
  blockB: Int32Array;
  blockC: Int32Array;
  /** Context indices, ascending, and the state word to store at each (already in the coder's stored form). */
  ctxIndex: Int32Array;
  ctxState: Uint32Array;
}

/** What the trainer hands to writePrior: the same content as Prior, with states still as codes. */
export interface PriorParts {
  model: number;
  contexts: number;
  handshake: Uint8Array;
  strings: Uint8Array[];
  fields: { owner: number; key: number; dict: number[] }[];
  /** Sorted by site, then a, b, c. */
  blocks: { site: number; a: number; b: number; c: number }[];
  /** Sorted by index. `code` is a state code (stateCode). */
  states: { index: number; code: number }[];
}

/**
 * The state code for probability level `level` (0 to 63) and count level `count` (0 to 3).
 * @complexity O(1) @alloc none
 */
export function stateCode(level: number, count: number): number {
  return (count << PROB_CODE_BITS) | level;
}

/**
 * The probability (out of 65536) that state level `level` stands for.
 * @complexity O(1) @alloc none
 */
export function levelProbability(level: number): number {
  return level < PROB_CODES / 2 ? PROB_LEVELS[level] : PROB_ONE - PROB_LEVELS[PROB_CODE_MASK - level];
}

/** The coder's stored state word for a state code. */
function stateWord(code: number): number {
  const p = levelProbability(code & PROB_CODE_MASK);
  return (((p << PROB_SHIFT) | COUNT_LEVELS[code >>> PROB_CODE_BITS]) ^ STATE_FLIP) >>> 0;
}

/**
 * Parse a prior file. Throws when the bytes are not a prior this build reads, or fail their checksum.
 * @interacts none @deps none
 * @complexity O(file) @alloc the tables of the result
 */
export function parsePrior(file: Uint8Array): Prior {
  if (file.length < FIXED_BYTES + U32_BYTES) throw new Error('not a starting model file');
  for (let i = 0; i < MAGIC_BYTES; i++) if (file[i] !== PRIOR_MAGIC[i]) throw new Error('not a starting model file');
  if (file[MAGIC_BYTES] !== PRIOR_FORMAT) throw new Error(`starting model format ${file[MAGIC_BYTES]} is not supported`);
  const end = file.length - U32_BYTES;
  const id = (file[end] | (file[end + 1] << 8) | (file[end + 2] << 16) | (file[end + 3] << 24)) >>> 0;
  if (crc32(file.subarray(0, end)) !== id) throw new Error(DAMAGED);
  let p = FIXED_BYTES;
  const varint = (): number => {
    let v = 0;
    let scale = 1;
    let n = 0;
    let x: number;
    do {
      if (p >= end || n === VARINT_MAX_BYTES) throw new Error(DAMAGED);
      x = file[p++];
      v += (x & VARINT_DATA) * scale;
      scale *= VARINT_BASE;
      n++;
    } while ((x & VARINT_CONTINUE) !== 0);
    if (v >= VARINT_LIMIT) throw new Error(DAMAGED);
    return v;
  };
  /** A count of things that each take at least `each` bytes of what is left: bounds every allocation below. */
  const count = (each: number): number => {
    const n = varint();
    if (n * each > end - p) throw new Error(DAMAGED);
    return n;
  };
  const contexts = varint();
  const hsLen = count(1);
  const handshake = file.slice(p, p + hsLen);
  p += hsLen;

  const strings = count(1);
  const stringStart = new Int32Array(strings + 1);
  for (let i = 0; i < strings; i++) stringStart[i + 1] = stringStart[i] + varint();
  const stringLen = stringStart[strings];
  if (stringLen > end - p) throw new Error(DAMAGED);
  const stringBytes = file.slice(p, p + stringLen);
  p += stringLen;

  const fields = count(3);
  const fieldOwner = new Uint8Array(fields);
  const fieldKey = new Int32Array(fields);
  const fieldDictStart = new Int32Array(fields + 1);
  const dict: number[] = [];
  for (let f = 0; f < fields; f++) {
    if (p >= end) throw new Error(DAMAGED);
    fieldOwner[f] = file[p++];
    fieldKey[f] = varint();
    const n = count(1);
    for (let i = 0; i < n; i++) {
      const sid = varint();
      if (sid >= strings) throw new Error(DAMAGED);
      dict.push(sid);
    }
    fieldDictStart[f + 1] = dict.length;
    if (fieldOwner[f] >= OWNER.COUNT || (f === 0) !== (fieldOwner[f] === OWNER.MSGTYPE)) throw new Error(DAMAGED);
  }
  if (fields < 1) throw new Error(DAMAGED);

  const groups = count(2);
  const site: number[] = [];
  const ka: number[] = [];
  const kb: number[] = [];
  const kc: number[] = [];
  for (let g = 0; g < groups; g++) {
    if (p >= end) throw new Error(DAMAGED);
    const s = file[p++];
    if (s < 1 || s >= SITE.COUNT) throw new Error(DAMAGED);
    const keys = SITE_KEYS[s];
    const n = count(keys);
    let a = 0;
    for (let i = 0; i < n; i++) {
      a += varint();
      site.push(s);
      ka.push(a);
      kb.push(keys >= 2 ? varint() : 0);
      kc.push(keys >= 3 ? varint() : 0);
    }
  }

  const states = count(2);
  const ctxIndex = new Int32Array(states);
  const ctxState = new Uint32Array(states);
  let index = 0;
  for (let i = 0; i < states; i++) {
    const d = varint();
    if (i > 0 && d === 0) throw new Error(DAMAGED);
    index += d;
    if (index < 1 || index >= contexts) throw new Error(DAMAGED);
    ctxIndex[i] = index;
  }
  if (states > end - p) throw new Error(DAMAGED);
  for (let i = 0; i < states; i++) ctxState[i] = stateWord(file[p++]);
  if (p !== end) throw new Error(DAMAGED);
  return {
    id, model: file[MAGIC_BYTES + 1], contexts, handshake, stringBytes, stringStart, fieldOwner, fieldKey, fieldDictStart,
    fieldDict: Int32Array.from(dict), blockSite: Uint8Array.from(site), blockA: Int32Array.from(ka), blockB: Int32Array.from(kb),
    blockC: Int32Array.from(kc), ctxIndex, ctxState,
  };
}

/**
 * Write a prior file. Used by the trainer; the result parses back with parsePrior.
 * @interacts none @deps none
 * @complexity O(content) @alloc the file
 */
export function writePrior(parts: PriorParts): Uint8Array {
  const out: number[] = [...PRIOR_MAGIC, PRIOR_FORMAT, parts.model];
  const varint = (v: number): void => {
    if (!(v >= 0 && v < VARINT_LIMIT && v === Math.floor(v))) throw new Error(`prior: ${v} does not fit a varint`);
    while (v >= VARINT_BASE) {
      out.push((v % VARINT_BASE) | VARINT_CONTINUE);
      v = Math.floor(v / VARINT_BASE);
    }
    out.push(v);
  };
  const bytes = (b: Uint8Array): void => {
    for (let i = 0; i < b.length; i++) out.push(b[i]);
  };
  varint(parts.contexts);
  varint(parts.handshake.length);
  bytes(parts.handshake);
  varint(parts.strings.length);
  for (const s of parts.strings) varint(s.length);
  for (const s of parts.strings) bytes(s);
  varint(parts.fields.length);
  for (const f of parts.fields) {
    out.push(f.owner);
    varint(f.key);
    varint(f.dict.length);
    for (const sid of f.dict) varint(sid);
  }
  // blocks arrive sorted by site: one group per run of the same site
  const groups: { site: number; from: number; to: number }[] = [];
  for (let i = 0; i < parts.blocks.length; i++) {
    const s = parts.blocks[i].site;
    if (groups.length > 0 && groups[groups.length - 1].site === s) groups[groups.length - 1].to = i + 1;
    else groups.push({ site: s, from: i, to: i + 1 });
  }
  varint(groups.length);
  for (const g of groups) {
    const keys = SITE_KEYS[g.site];
    out.push(g.site);
    varint(g.to - g.from);
    let a = 0;
    for (let i = g.from; i < g.to; i++) {
      const b = parts.blocks[i];
      if (b.a < a) throw new Error('prior: blocks are not sorted');
      varint(b.a - a);
      a = b.a;
      if (keys >= 2) varint(b.b);
      if (keys >= 3) varint(b.c);
    }
  }
  varint(parts.states.length);
  let index = 0;
  for (const s of parts.states) {
    if (s.index <= index && index !== 0) throw new Error('prior: states are not sorted');
    varint(s.index - index);
    index = s.index;
  }
  for (const s of parts.states) out.push(s.code);
  const file = new Uint8Array(out.length + U32_BYTES);
  file.set(out);
  const crc = crc32(file.subarray(0, out.length));
  for (let i = 0; i < U32_BYTES; i++) file[out.length + i] = (crc >>> (i * BITS_PER_BYTE)) & BYTE_MASK;
  return file;
}
