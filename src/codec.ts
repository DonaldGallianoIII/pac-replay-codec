/**
 * The replay coder: turns the body of a .colreplay into range-coded bits and back, byte for byte.
 *
 * One walker runs in both directions. Encoding reads the replay and codes every token through the range coder.
 * Decoding runs the same code path: each token comes back out of the coder and is written to the output. A token is
 * only ever a re-spelling of bytes, never an interpretation that could lose information, and a frame the walker
 * would not reproduce exactly is kept as plain bytes (the escape, counted in stats.rawFrames).
 *
 * What it models:
 *   container   frame kind, time delta, offsets; lengths are never stored, they follow from the parsed content
 *   state body  the Colyseus grammar (wire.ts), driven by the type table each replay carries in its handshake.
 *               Nothing about one game version is built in: field numbers, types and names come from the file.
 *               Which structure comes next: switchRef and treeWalk. Which field: what followed last time. The
 *               value: the change from the slot's last value; a new structure's first values from a look-alike.
 *   messages    msgpack walked syntactically, each element in the context of its place in its message type
 *   game-aware  (opts.gameAware) PAC's mini-game: carousel items, portals and their symbols are a closed formula
 *               of a whole-ms clock; avatars walk at a known speed. PAC_MINIGAME holds the constants. Off, the
 *               coder knows only the schema. The caller decides (index.ts gates it on the game version).
 *   prior       (opts.prior) an optional starting model (prior.ts): the type table as one known block, the
 *               game's vocabulary in the string dictionaries, and a starting probability for the contexts worth
 *               one. Without it every context starts at one half and every dictionary empty. applyPrior loads
 *               it before the first bit; from then on the coder runs exactly as it does cold.
 *
 * Speed comes from three things: every table is a flat typed array indexed by small integers (no hash map, no
 * object, no string in the token loop); a likely symbol is coded as one "as guessed" bit and the full symbol only
 * on a miss; and nothing is allocated per token.
 *
 * Determinism: everything that decides a coded bit uses integers or exact IEEE operations (+ - * / sqrt and
 * float32 rounding), and trig.ts for sine and cosine, so a build in another language can pack to the same bytes.
 * Floats that enter the model are made finite first, because the bits of a NaN are not the same everywhere.
 *
 * Build flags (build.ts): what only packing needs sits behind ENCODE, the bit accounting and the trainer hooks
 * behind MEASURE, loading a starting model behind PRIOR. Methods that one of them alone needs carry `@build` in
 * their doc block and are left out of a packaged file without it. Whatever a build keeps, it codes bit for bit
 * like every other build.
 *
 * @interacts range-coder.ts, symbols.ts, strings.ts, intmap.ts, wire.ts, clrp.ts, trig.ts, prior.ts; no I/O
 * @deps      those modules and build.ts (the flags)
 * @complexity O(tokens): about 0.67 million tokens for a 3.4 MB replay (struct and collection operations, message
 *             elements), each a few dozen array reads and about 8 coder decisions. Switch targets scan at most
 *             SW_FORWARD list entries; a collection's recency list is scanned up to its length (about 20 structs).
 * @alloc     per replay: structure tables (about 12k structures with their slot memory), dictionaries, context
 *            tables. Per token: nothing in the steady state (tables double when they fill).
 */
import {
  HEADER_FIXED_BYTES, TRAILER_FOOTER_BYTES, MAGIC, TRAILER_MAGIC, VERSION, MAGIC_BYTES, KIND_HANDSHAKE, KIND_MESSAGE,
  TYPE_TAG_NUMBER, TYPE_TAG_STRING, ENC_MSGPACK, ENC_BYTES, ENC_NONE, VARINT_CONTINUE, VARINT_DATA, VARINT_BASE,
  VARINT_MAX_BYTES, u32At, hasHeader, trailerStart,
} from './clrp.ts';
import {
  SWITCH_TO_STRUCTURE, TYPE_ID, OP_ADD, OP_DELETE, OP_CLEAR, OP_REVERSE, OP_DELETE_BY_REFID, OP_MASK, KIND_STRUCT,
  KIND_MAP, KIND_ARRAY, VAL_PRIM, VAL_REF, PRIM_STRING, PRIM_NUMBER, PRIM_BOOLEAN, PRIM_INT8, PRIM_UINT8, PRIM_INT16,
  PRIM_UINT16, PRIM_FLOAT32, PRIM_WIDTH, Schema, bootSchema, parseReflection,
} from './wire.ts';
import { RangeCoder, LAZY_BACKOFF } from './range-coder.ts';
import {
  tree, tree2, gamma1, gamma2, gammaSlots, sizeClass, zigzag, unzigzag, GAMMA_BITS_WIDE, GAMMA_BITS_NARROW,
  BACKOFF_MIN_COUNT,
} from './symbols.ts';
import { PairMap, Rows, ABSENT } from './intmap.ts';
import { StringModel, HINT_MAX } from './strings.ts';
import { detSin, detCos } from './trig.ts';
import { SITE, OWNER, CONTEXTS_UNCHECKED } from './prior.ts';
import type { Prior } from './prior.ts';
import { ENCODE, MEASURE, PRIOR } from './build.ts';

/** Token roles, for the bit accounting: every coded bit is charged to the role current when it was coded. */
export const ROLE = {
  META: 0, KIND: 1, DT: 2, FRAME: 3, HS_PREFIX: 4, HEAD: 5, CHEAD: 6, SWITCH: 7, NEWREF: 8, TYPEID: 9, INDEX: 10,
  KEY_SYM: 11, KEY_GLOBAL: 12, KEY_LIT: 13, STR_SYM: 14, STR_GLOBAL: 15, STR_LIT: 16, BYTE: 17, INT16: 18, NUMCLS: 19,
  NUMINT: 20, FLOAT: 21, OTHER: 22, MSGTYPE: 23, MSGMARK: 24, MSGNUM: 25, MSTR_SYM: 26, MSTR_GLOBAL: 27,
  MSTR_LIT: 28, RAW: 29, TAIL: 30, STEP: 31, COUNT: 32,
} as const;
/** Role names in index order (without the COUNT entry). Empty in a build without MEASURE. */
export const ROLE_NAMES: string[] = MEASURE ? Object.keys(ROLE).slice(0, ROLE.COUNT) : [];

/**
 * Speed tricks that can be switched off one at a time to measure what each costs in size.
 * 1 = on. Both directions must use the same settings, and they are part of the packed format: a file packed with
 * other settings does not unpack with these. A port to another language implements the shipped settings only.
 */
export const TUNING = {
  /** Next structure: one bit "the one that followed this pair last time" before the full class symbol. Off also means SwitchChain off. */
  SwitchPairFlag: 1,
  /**
   * Byte fields: one bit "the change that followed this change last time" before the full byte. Off: it is the one
   * trick that costs real size (0.9%) for its speed (4% pack, 3% unpack). Size is only spent on a big speed win.
   */
  ByteFlag: 0,
  /** Byte fields: also condition on the field written just before in the same visit (one hash lookup). */
  ByteVisit: 1,
  /** 16 bit fields: also condition on the field written just before in the same visit (one hash lookup). */
  Int16Visit: 1,
  /** Collection operations: one bit "what followed this operation last time" before the full symbol. Off: it costs 0.3% in size and buys no measurable speed. */
  CollFlag: 0,
  /** Indexes and new refIds: one bit "exactly as predicted" before the size-class code. */
  IntZeroFlag: 1,
  /** Floats: one bit "exactly as predicted" before the size-class code. */
  FloatZeroFlag: 1,
  /** Message elements: one bit "same marker as last time here" before the full marker. */
  MarkFlag: 1,
  /** `number` fields: one bit "same kind (integer, float32, float64) as last time" before the kind symbol. */
  NumClsFlag: 1,
  /** Frame prefix bytes: one bit "same as the last frame of this kind" before the bytes. */
  PrefixFlag: 1,
  /** Next structure, not the pair: a short chain of yes/no questions instead of one 6 bit symbol. */
  SwitchChain: 1,
  /** Tree walk: one bit "same step as last time from here" before the full step. Off: it costs 1.4% in size. */
  TreeFlag: 0,
  /** A field marker that was not the guess: "switch?" and "end?" first, then operation and field. */
  HeadChain: 1,
  /** Message number bytes: one bit "same byte as last time here" before the full byte. */
  MsgNumFlag: 1,
  /** Field markers: after a wrong first guess, one bit for a second guess (what followed in any structure of the type). */
  HeadSecond: 1,
  /** Floats: score each curve order when the value is coded, not later with the final frame times (one curve fit less per float). */
  ScoreNow: 1,
  /**
   * Tree walk into a collection: name the child by its distance (in order of arrival) from the child used last,
   * not by how recently it was visited. No list to keep in order on every switch. Off: 4% faster to unpack but
   * 0.7% larger.
   */
  TreeOrdinal: 0,
  /**
   * Two-context bits: once the specific context is in use, the general one stops learning from it and stays the
   * model of "a context seen for the first time". Saves one update per such bit. The setting itself lives with
   * the coder (range-coder.ts, LAZY_BACKOFF); a build with MEASURE hands this value to each coder it makes.
   */
  LazyBackoff: LAZY_BACKOFF ? 1 : 0,
};

/** PAC's mini-game constants (app/core/mini-game.ts in PAC 6.11), used only by the game-aware predictors. */
const PAC_MINIGAME = {
  CenterX: 335,
  CenterY: 235,
  RadiusX: 150,
  RadiusY: 125,
  /** Root collections whose structures ride the carousel, and their angular speed in rad per ms. */
  CarouselFields: ['floatingItems', 'portals'],
  CarouselSpeeds: [0.0004, 0.0003],
  SymbolField: 'symbols',
  SymbolSpeed: 0.0006,
  SymbolRadius: 25,
  AvatarField: 'avatars',
  /** px per ms */
  AvatarSpeed: 0.12,
  /** An avatar stops within this many px of its target. */
  AvatarStop: 2,
  /** Three physics steps per patch, each losing 0.06% per ms: distance(d ms) = 0.12 d (1 - 0.0002 d). */
  AvatarDrag: 0.0002,
} as const;

export const CONFIG = {
  /** ms: how far past the last clock value the encoder searches for this frame's. */
  CarouselStepMax: 400,
  /** ms: search range when the clock is not known yet (a carousel lasts well under this). */
  CarouselTMax: 80000,
  /** Structures tried per frame before giving up on an exact clock. */
  CarouselSolveTries: 16,
  /** Structures tried when the whole clock range must be searched. */
  CarouselFullTries: 2,
  /** Whole-range searches allowed per carousel. */
  CarouselFullSearches: 4,
  /** px: a clock candidate is checked exactly only when the quick estimate lands this close on both axes. */
  CarouselNear: 0.01,
  /** First capacity of the structure tables, in structures (a game makes 12 to 20 thousand). */
  HandlesStart: 1 << 15,
  /** First capacity of the slot arenas, in slots (a game uses about half a million; untouched pages cost nothing). */
  SlotsStart: 1 << 20,
  /** Copies shorter than this are done byte by byte; longer ones with one bulk call. */
  BulkCopyMin: 48,
  /** First capacity of the refId tables. */
  RefsStart: 1 << 14,
  /** First capacity of the "what followed this pair of structures" table, in pairs (a game makes about 60k). */
  PairsStart: 1 << 16,
  /** First size of the frame buffer (decode), in bytes. */
  FrameBuf: 1 << 16,
} as const;

// ---- limits (a frame that exceeds one is kept raw; a decoded value that does means a damaged file)
/** Context groups for struct types (one per topmost ancestor). Types beyond this share the last group. */
const GROUP_MAX = 256;
/** Groups 0..3 belong to the reflection's own four types. */
const BOOT_GROUPS = 4;
/** A struct head byte addresses at most 64 fields. */
const FIELD_SLOTS = 64;
const FIELD_MASK = 63;
/** Struct field ids: group * 64 + field index. */
const CID_SPACE = GROUP_MAX * FIELD_SLOTS;
/** Field ids: struct fields, then "items of the collection announced by struct field cid". */
const FID_SPACE = CID_SPACE * 2;
/** Context groups: struct groups, then one per collection field, then the start of a frame. */
const SW_START_GROUP = GROUP_MAX + CID_SPACE;
const CG_SPACE = SW_START_GROUP + 1;
const REF_MAX = 1 << 24;
const INDEX_MAX = 1 << 24;
/** Integers of a `number` field beyond this are not modeled (their differences would not be exact doubles). */
const NUM_INT_MAX = 1125899906842624;
/** Longest string the walker models, in bytes. */
const STR_MAX = 65535;
/** Slots a collection of primitives remembers values for; items beyond share the last slot. */
const ITEM_SLOTS_MAX = 65536;
const ITEM_SLOTS_START = 8;
/** Bytes of spare room the decoder keeps in the frame buffer, enough for any fixed-size token. */
const TOKEN_MARGIN = 48;
const MSG_DEPTH_MAX = 64;
/** A look-alike's first value is used for byte, 16 bit and string fields when it is an integer up to this. */
const TPL_INT_MAX = 65535;
/** Bit of a slot's aux word that says "this slot has been written" (its first value is on record). */
const AUX_WRITTEN = 1 << 30;
const AUX_MASK = AUX_WRITTEN - 1;

// ---- handles
const START = 0;
const ROOT = 1;
const ROOT_REF = 0;
const KIND_NONE = 255;
const TPL_NONE = 0x7fffffff;

// ---- frame level
const KIND_END = 4;
const KIND_BITS = 3;
const KIND_SLOTS = 1 << KIND_BITS;
const KIND_PREVS = 5;
/** Frame kinds: handshake, state, patch, message. */
const STATE_KINDS_ALL = 4;
const DT_BUCKETS = 13;
const GAMMA_W = gammaSlots(GAMMA_BITS_WIDE);
const GAMMA_N = gammaSlots(GAMMA_BITS_NARROW);
const CLASS_W = 1 << GAMMA_BITS_WIDE;
const CLASS_N = 1 << GAMMA_BITS_NARROW;
// frame integers
const FI_META = 0;
const FI_JUNK = 1;
const FI_TRAILER = 2;
const FI_MSGLEN = 3;
const FI_OFFSET = 4;
const FI_BODYLEN = 5;
const FI_RAWLEN = 6;
const FI_COUNT = 7;
// flags
const FLAG_TRAILER = 0;
const FLAG_TYPETAG = 1;
const FLAG_FITS = 2;
const FLAG_WALKED = 3;
const FLAG_OFFSET = 4; // + kind (3)
const FLAG_PREFIX = 7; // + kind (3)
const FLAG_MSGWALK = 10; // + enc (2)
/** A handshake frame whose body is the type table the starting model carries (only coded when it carries one). */
const FLAG_HS_KNOWN = 12;
const FLAG_COUNT = 13;
// order-1 byte spaces
const RAW_META = 0;
const RAW_FRAME = 1;
const RAW_BIN = 2;
const RAW_TAIL = 3;
const RAW_TRAILER = 4;
const RAW_PREFIX = 5; // + kind (3)
const RAW_SPACES = 8;
const BYTE_VALUES = 256;
const BYTE_BITS = 8;
const RAW_SPACE_SIZE = BYTE_VALUES * BYTE_VALUES;
const PREFIX_KEEP = 8;
const STATE_KINDS = 3;
// clock hints
const STEP_MODES = 8;
const STEP_BITS = 3;

// ---- struct field markers
const HEAD_END = 256;
const HEAD_START = 256;
const HEAD_BITS = 9;
const HEAD_SYMBOLS = 257;
const HEAD_TREE = 1 << HEAD_BITS;
const HEAD_FLAG_BLOCK = (HEAD_SYMBOLS + 1) * 2;
/** Flag contexts of one situation: the first guess by (guess, source), then the second guess by guess. */
const HEAD_FLAGS = HEAD_FLAG_BLOCK + HEAD_SYMBOLS + 1;
// a missed guess: "switch?", "end?", the operation (2 bit tree), the field (6 bit tree)
const HM_SWITCH = 0;
const HM_END = 1;
const HM_OP = 4;
const HM_OP_BITS = 2;
const HM_FIELD = 64;
const HM_FIELD_BITS = 6;
const HM_BLOCK = 128;
const OPS_PER_FIELD = 4;

// ---- collection operations
const OP_CODES = 12;
const COLL_TREE_OFF = 16;
const COLL_BLOCK = COLL_TREE_OFF + HEAD_TREE;
const OP_CLASSES = 4;
const INT_BLOCK = 1 + GAMMA_N;
const IDX_BLOCK = OP_CLASSES * INT_BLOCK;

// ---- switches
const SW_BITS = 6;
const SW_PAIR = 0;
const SW_RECENT = 1;
const SW_RECENT_MAX = 6;
const SW_FWD = 7;
const SW_FORWARD = 40;
const SW_BACK = 47;
const SW_BACKWARD = 15;
const SW_PENDING = 62;
const SW_TREE = 63;
/** Skipped this many times in a row, a structure leaves the visiting-order list. */
const SW_AGE_LIMIT = 12;
const SW_CLASSES = 8;
// the class questions inside one class block: four yes/no contexts, then the small trees
const SWC_TREE = 0;
const SWC_RECENT = 1;
const SWC_FWD = 2;
const SWC_FWD0 = 3;
const SWC_BACK = 4;
const SWC_RANK = 8;
const SWC_RANK_BITS = 3;
const SWC_BACKK = 16;
const SWC_BACKK_BITS = 4;
const SWC_FWDK = 64;
const SW_CLASS_BLOCK = 128;
const SW_FLAG_OFF = 0;
const SW_UPFLAG_OFF = SW_CLASSES;
const SW_HI_OFF = SW_CLASSES * 2;
const SW_LO_OFF = SW_HI_OFF + SW_CLASSES * 2 * SW_CLASS_BLOCK;
const SW_UP_OFF = SW_LO_OFF + SW_CLASS_BLOCK;
const SW_ID_OFF = SW_UP_OFF + SW_CLASSES * 8;
const SW_BLOCK = SW_ID_OFF + GAMMA_N;
/** "Levels up" value that means: no tree walk, the id follows. */
const TREE_FALLBACK = 7;
const TREE_UP_BITS = 3;
const TREE_MAX_DEPTH = 12;
const TREE_STOPS = 4;
const TREE_STEPS = 3;
const TREE_KID_BITS = 6;
const TREE_KEYS = TREE_STEPS * 8;

// ---- values
/** "Previous change" context of a first write predicted from a look-alike. */
const BYTE_TEMPLATE = 257;
const BYTE_LASTS = 258;
/** A byte block: the guess's bit at 0 (ByteFlag), the tree at 1..255. */
const BYTE_BLOCK = BYTE_VALUES;
const I16_TEMPLATE = 19;
const I16_LASTS = 20;
const I16_MAX_Z = 65535;
const NUM_INT = 0;
const NUM_F32 = 1;
const NUM_F64 = 2;
const NUMCLS_BLOCK = 16;
const NUM_LAST_COUPLED = 61;
const NUM_LAST_TEMPLATE = 62;
const NUM_LASTS = 64;
const OTHER_BLOCK = 8 * BYTE_VALUES;
const TYPE_BLOCK = BYTE_VALUES;
/** Contexts of one string hint block (strings.ts: a 6 bit index tree). */
const STR_HINT_BLOCK = 64;

// ---- floats
/** hold, line, parabola, cubic, and the game's own formula */
const FLOAT_ORDERS = 5;
const FORMULA_ORDER = 4;
const FLOAT_STATES = 4;
const FLOAT_KEYS = FLOAT_STATES * FLOAT_ORDERS;
const FLOAT_LASTS = 64;
const FLOAT_LO_BLOCK = 1 + GAMMA_W;
const FLOAT_HI_BLOCK = 1 + CLASS_W;
/** Scores are fixed point with this many fraction bits; a score is the smoothed size class of the miss. */
const SCORE_FP = 8;
/** A new slot is assumed to miss by 2^8 float steps until it shows better. */
const SCORE_START = 8 << SCORE_FP;
/** The formula is trusted until a slot shows it does not follow it (a carried item). */
const FORMULA_SCORE_START = 0;
/** A formula score under this (missing by under one float step on average) counts as following it. */
const FORMULA_TRUST = 1 << SCORE_FP;
/** Scores move a quarter of the way to new evidence; the formula's half the way. */
const SCORE_SHIFT = 2;
const FORMULA_SCORE_SHIFT = 1;
const HISTORY_MAX = 5;
/** ms: PAC's patch interval, the starting guess for the shared time step. */
const DL_DEFAULT = 50;
const DL_MAX = 5000;
/** The stored time step is in 1/16384 ms. */
const DL_QUANT = 16384;
/** 1 / variance of a value rounded to 1/16384 ms. */
const DL_HINT_WEIGHT = 3221225472;
/** Readings within four stored steps of the hint may sharpen it. */
const DL_REFINE_TOLERANCE = 0.000244140625;
/** ms: readings this close count as agreeing when the encoder measures a frame's step. */
const DL_CONSENSUS_TOL = 0.05;
/** Frames of recent past restretched when the clock is re-pinned. */
const RESCALE_WINDOW = 16;
const RESCALE_MIN = 0.001;
const RESCALE_MAX = 1000;
/** A track older than this many of its own steps is treated as standing still. */
const STALE_FACTOR = 3;
/** Spacing of float32 values relative to their size. */
const FLOAT32_EPSILON = 1.1920929e-7;
const FLOAT_MIN_ULP = 1e-12;
const TWO_PI = 6.283185307179586;
const SIGN_BIT = 0x80000000;
const TWO_POW_32 = 4294967296;
const LAST_EXACT_NEVER = -1000000;

// ---- messages
const MARK_NONE = 256;
const MSG_MAP_POS_MAX = 23;
const MSG_ARRAY_POS_MAX = 7;
const MSG_MAP_CODE = 2;
const MSG_ARRAY_CODE = 60;
const MSG_NUM_POS = 8;
const NUM_TYPE_BASE = 1 << 20;
const NUM_TYPE_SLOTS = 256;
const ENC_BITS = 2;

const CORRUPT = 'packed data is damaged';
const INTERNAL = 'walker and validator disagree';
const PRIOR_MISFIT = 'starting model does not fit this build';
/** The visit context of a byte or 16 bit field: the marker written just before plus one, 0 to this. */
const VISIT_PREV_MAX = HEAD_START + 1;

const EMPTY = new Uint8Array(0);

/** Exact powers of two as doubles, built by doubling, for score-based weights. */
const POW2 = new Float64Array(64);
POW2[0] = 1;
for (let i = 1; i < POW2.length; i++) POW2[i] = POW2[i - 1] * 2;

/** Coarse class of a frame time delta in ms, for the context of the next one: bursts, the 50 ms beat, long gaps. */
function dtBucket(d: number): number {
  if (d < 2) return d;
  if (d < 4) return 2;
  if (d < 8) return 3;
  if (d < 16) return 4;
  if (d < 32) return 5;
  if (d < 44) return 6;
  if (d < 48) return 7;
  if (d < 53) return 8;
  if (d < 60) return 9;
  if (d < 100) return 10;
  if (d < 200) return 11;
  return 12;
}

/** A collection operation byte (or 255 switch, 256 end) as a small code 1..11; 0 is "start of the visit". */
function opCode(sym: number): number {
  switch (sym) {
    case 0: return 1;
    case 64: return 2;
    case 128: return 3;
    case 192: return 4;
    case 10: return 5;
    case 15: return 6;
    case 33: return 7;
    case 129: return 8;
    case 255: return 9;
    case 256: return 10;
    default: return 11;
  }
}

/** float32 bit pattern -> an integer that grows with the float's value (so nearby floats are nearby integers). */
function monotone(bits: number): number {
  return bits < SIGN_BIT ? bits : -(bits - SIGN_BIT) - 1;
}
function unmonotone(m: number): number {
  return m >= 0 ? m : -(m + 1) + SIGN_BIT;
}

function growI32(a: Int32Array, cap: number) {
  const n = new Int32Array(cap);
  n.set(a);
  return n;
}
function growU8(a: Uint8Array, cap: number) {
  const n = new Uint8Array(cap);
  n.set(a);
  return n;
}
function growF64(a: Float64Array, cap: number) {
  const n = new Float64Array(cap);
  n.set(a);
  return n;
}

export interface CodecOptions {
  /** Use PAC's mini-game formulas as predictors. Both directions must agree. */
  gameAware: boolean;
  /** Collect bit costs and decision counts by role (slower). */
  account: boolean;
  /** Decode only: size of the original file, the upper bound of what may be written. */
  rawLen: number;
  /** The starting model to load before the first bit is coded, or none. Both directions must use the same one. */
  prior?: Prior | null;
}

/** Counters of one run, for the report and the tests. */
export interface CodecStats {
  frames: number;
  /** Frames or message payloads kept as plain bytes (the escape path). */
  rawFrames: number;
  rawBytes: number;
  tokens: number;
  /** Switches by how the target was found: pair, recent, forward, backward, pending, tree, id. */
  switches: Int32Array;
  /** State frames by clock hint: none, ratio, exact, both. */
  steps: Int32Array;
}

/**
 * One replay being encoded or decoded. Holds every piece of model state; make one per file and call encode() or
 * decode() once.
 */
export class Codec {
  readonly rc: RangeCoder;
  readonly strings: StringModel;
  /** The counters of a packing run. Kept in a build with ENCODE. */
  declare readonly stats: CodecStats;
  private readonly enc: boolean;
  private readonly formulas: boolean;
  /** Body of the handshake frame the starting model knows (empty: none). Kept in a build with PRIOR. */
  private declare readonly knownHandshake: Uint8Array;
  // bytes: the source file (encode) or the frame being built (decode)
  private b: Uint8Array;
  private p = 0;
  private out: Uint8Array;
  private op = 0;
  private readonly limit: number;
  // The fields from here to the validator cursor belong to packing: they are set up in the constructor, in a
  // build with ENCODE. `end` is where the body being walked ends in the source file.
  private declare end: number;
  // frame being read
  private declare fKind: number;
  private declare fDt: number;
  private declare fOffset: number;
  private declare fLen: number;
  private declare fPayload: number;
  private declare fEnd: number;
  private declare fTypeTag: number;
  private declare fTypeNum: number;
  private declare fTypeStart: number;
  private declare fTypeLen: number;
  private declare fEnc: number;
  private declare vEnd: number;
  // validator cursor
  private declare vp: number;
  private declare vend: number;
  // static contexts
  private readonly cKind: number;
  private readonly cDtHi: number;
  private readonly cDtLo: number;
  private readonly cFrameInt: number;
  private readonly cFlags: number;
  private readonly cStep: number;
  private readonly cStepRatio: number;
  private readonly cStepExact: number;
  private readonly cMsgNum: number;
  private readonly rawBase = new Int32Array(RAW_SPACES);
  private prevDt = 0;
  private readonly lastOffset = new Float64Array([0, 1, 1]);
  private readonly prefixBytes = new Uint8Array(STATE_KINDS * PREFIX_KEEP);
  private readonly prefixLen = new Int32Array(STATE_KINDS).fill(-1);
  // schema
  private schema: Schema | null = null;
  private tGroup = new Int32Array(0);
  private gameGroup = new Int32Array(BYTE_VALUES);
  private groupsUsed = BOOT_GROUPS;
  // game-aware types of the current schema
  private tCar = new Float64Array(0);
  private tCarIx = new Int32Array(0);
  private tCarIy = new Int32Array(0);
  private tCarId = new Int32Array(0);
  private avType = -1;
  private avIx = 0;
  private avIy = 0;
  private avTx = 0;
  private avTy = 0;
  private syType = -1;
  private syIx = 0;
  private syIy = 0;
  private syPortal = 0;
  // refId tables
  private refCap: number = CONFIG.RefsStart;
  private handleOf = new Int32Array(CONFIG.RefsStart).fill(-1);
  private pendFlag = new Uint8Array(CONFIG.RefsStart);
  // the validator's notes on structures announced in the frame it is checking (a build with ENCODE)
  private declare ovStamp: Int32Array;
  private declare ovKind: Uint8Array;
  private declare ovType: Int32Array;
  private declare stamp: number;
  private pending = new Int32Array(CONFIG.HandlesStart);
  private pendingLen = 0;
  private pendingHead = 0;
  private maxRef = 0;
  // structures, by handle
  private hN = 0;
  private hCap: number = CONFIG.HandlesStart;
  private hKind = new Uint8Array(this.hCap);
  private hRef = new Int32Array(this.hCap);
  private hType = new Int32Array(this.hCap);
  private hCg = new Int32Array(this.hCap);
  private hFid = new Int32Array(this.hCap);
  private hSlot = new Int32Array(this.hCap);
  private hSlotCap = new Int32Array(this.hCap);
  private hSucc = new Int32Array(this.hCap);
  private hNextIdx = new Int32Array(this.hCap);
  private hLastItem = new Int32Array(this.hCap);
  private hSwLast = new Uint8Array(this.hCap);
  private hSkips = new Uint8Array(this.hCap);
  private hInList = new Uint8Array(this.hCap);
  private hLn = new Int32Array(this.hCap);
  private hLp = new Int32Array(this.hCap);
  private hRecent = new Int32Array(this.hCap * SW_RECENT_MAX);
  private hRecentN = new Uint8Array(this.hCap);
  private hParent = new Int32Array(this.hCap);
  private hPidx = new Int32Array(this.hCap);
  private hList = new Int32Array(this.hCap);
  private hOrderLen = new Int32Array(this.hCap);
  private hOrderCap = new Int32Array(this.hCap);
  private hInOrder = new Uint8Array(this.hCap);
  private hOrd = new Int32Array(this.hCap);
  private hLastKid = new Int32Array(this.hCap);
  private hTpl = new Int32Array(this.hCap);
  private hTplCount = new Int32Array(this.hCap);
  private hFh = new Int32Array(this.hCap);
  private hCar = new Int32Array(this.hCap);
  private hCarIndex = new Int32Array(this.hCap);
  private hPortal = new Int32Array(this.hCap);
  private hSymIndex = new Int32Array(this.hCap);
  private hSymCount = new Int32Array(this.hCap);
  // slot memory
  private slotUsed = 0;
  private sv = new Float64Array(CONFIG.SlotsStart);
  private saux = new Int32Array(CONFIG.SlotsStart);
  private sinit = new Float64Array(CONFIG.SlotsStart);
  // integer arena: child tables of structs, recency lists of collections
  private ia = new Int32Array(CONFIG.SlotsStart);
  private iaUsed = 0;
  // per structure: the marker that followed each marker last time
  private succ = new Uint16Array(CONFIG.SlotsStart);
  private succUsed = 0;
  // float histories, by float slot
  private fhUsed = 0;
  private fx1 = new Float64Array(BYTE_VALUES);
  private fx2 = new Float64Array(BYTE_VALUES);
  private fx3 = new Float64Array(BYTE_VALUES);
  private fx4 = new Float64Array(BYTE_VALUES);
  private ff0 = new Int32Array(BYTE_VALUES);
  private ff1 = new Int32Array(BYTE_VALUES);
  private ff2 = new Int32Array(BYTE_VALUES);
  private ff3 = new Int32Array(BYTE_VALUES);
  private ff4 = new Int32Array(BYTE_VALUES);
  private fcnt = new Uint8Array(BYTE_VALUES);
  private fscored = new Int32Array(BYTE_VALUES);
  private fscore = new Int32Array(BYTE_VALUES * FLOAT_ORDERS);
  // field markers
  private readonly headFlag = new Int32Array(GROUP_MAX * HEAD_SYMBOLS);
  private readonly headFlagStart = new Int32Array(GROUP_MAX * (HEAD_SYMBOLS + 1));
  private readonly headTree = new Int32Array(GROUP_MAX * HEAD_SYMBOLS);
  private readonly groupSucc = new Uint16Array(GROUP_MAX * HEAD_SYMBOLS);
  private readonly groupStartSucc = new Uint16Array(GROUP_MAX * (HEAD_SYMBOLS + 1));
  private readonly headMiss = new PairMap();
  private prevStructHead = 0;
  private visitPrev = 0;
  // collections
  private readonly collCtx = new Int32Array(CID_SPACE * OP_CODES);
  private readonly collSucc = new Uint16Array(CID_SPACE * OP_CODES);
  private readonly idxCtx = new Int32Array(CID_SPACE);
  private readonly keyField = new Int32Array(CID_SPACE);
  // switches
  private readonly swBlock = new Int32Array(CG_SPACE);
  private readonly treeBlock = new Int32Array(CG_SPACE);
  private readonly swPairs = new PairMap(CONFIG.PairsStart);
  private readonly swUpLast = new Uint8Array(CG_SPACE * SW_CLASSES);
  private readonly twRows = new Rows(CG_SPACE, TREE_KEYS);
  private swPrev = START;
  private readonly chain = new Int32Array(TREE_MAX_DEPTH + 2);
  // values
  private readonly newRefCtx = new Int32Array(FID_SPACE);
  private readonly refOff = new Int32Array(FID_SPACE * 2);
  private readonly typeCtx = new Int32Array(FID_SPACE);
  private readonly typeLo = new PairMap();
  private readonly strFieldOf = new Int32Array(FID_SPACE);
  private readonly byteRows = new Rows(FID_SPACE, BYTE_LASTS);
  private readonly byteHi = new PairMap();
  private readonly i16Rows = new Rows(FID_SPACE, I16_LASTS);
  private readonly i16Hi = new PairMap();
  private readonly numClsCtx = new Int32Array(FID_SPACE);
  private readonly numHi = new Rows(FID_SPACE, NUM_LASTS);
  private readonly numLo = new Int32Array(FID_SPACE);
  private readonly floatLo = new Rows(FID_SPACE, FLOAT_KEYS);
  private readonly floatHi = new Rows(FID_SPACE, FLOAT_LASTS * FLOAT_KEYS);
  private readonly otherCtx = new Int32Array(FID_SPACE);
  private readonly fieldLast = new Float64Array(FID_SPACE);
  private lastStr = 0;
  // look-alikes: (string field id, string) -> the last structure that carried it, and how many have
  private readonly lookalikes = new PairMap();
  private laRef = new Int32Array(BYTE_VALUES);
  private laCount = new Int32Array(BYTE_VALUES);
  private laN = 0;
  // clock
  private frameNo = 0;
  private ft = new Float64Array(CONFIG.HandlesStart);
  private dl = DL_DEFAULT;
  private dl0 = DL_DEFAULT;
  private sw = 0;
  private swd = 0;
  private readonly fPred = new Float64Array(FLOAT_ORDERS);
  private readonly fSlope = new Float64Array(FLOAT_ORDERS);
  private fOrders = 0;
  private lastStepMode = 0;
  private hasRatio = 0;
  private hasExact = 0;
  private floatFrame = 0;
  private exactStep = 0;
  // what measureStep found for the frame about to be coded (a build with ENCODE)
  private declare stepRatioQ: number;
  private declare stepExactQ: number;
  private lastExactFrame = LAST_EXACT_NEVER;
  // mini-game
  private mgT = -1;
  private carGroup = -1;
  private carSeq = 0;
  private carType = -1;
  private carBorn = -1;
  private carCount = 0;
  /** Whole-range clock searches made for the current carousel (a build with ENCODE). */
  private declare carFull: number;
  private portalOf = new Int32Array(BYTE_VALUES);
  // encoder look-ahead: the floats of the frame being validated (a build with ENCODE)
  private declare ftH: Int32Array;
  private declare ftI: Int32Array;
  private declare ftV: Float64Array;
  private declare ftN: number;
  private declare readings: Float64Array;
  // messages
  private readonly msgTypes: number;
  private readonly pathMap = new PairMap();
  private pathN = 1;
  private pLast = new Int32Array(BYTE_VALUES);
  private pCtx = new Int32Array(BYTE_VALUES);
  private pStr = new Int32Array(BYTE_VALUES);
  private pNum = new Int32Array(BYTE_VALUES);
  private pNumLast = new Uint16Array(BYTE_VALUES * MSG_NUM_POS);
  private pEnc = new Int32Array(BYTE_VALUES);
  private readonly markHi = new PairMap();
  private readonly msgNumHi = new PairMap();
  // float <-> bits
  private readonly f32 = new Float32Array(1);
  private readonly u32 = new Uint32Array(this.f32.buffer);

  /**
   * @param input the .colreplay (encode) or the coded body (decode)
   * @param encode direction
   * @complexity O(table sizes): a few hundred KB of zeroed tables @alloc those tables
   */
  constructor(input: Uint8Array, encode: boolean, opts: CodecOptions) {
    const enc = ENCODE && encode;
    this.enc = enc;
    this.formulas = opts.gameAware;
    const rc = new RangeCoder(enc ? null : input);
    this.rc = rc;
    if (MEASURE) {
      rc.lazy = TUNING.LazyBackoff !== 0;
      if (opts.account) {
        rc.account = new Float64Array(ROLE.COUNT);
        rc.decisions = new Float64Array(ROLE.COUNT);
      }
    }
    this.b = enc ? input : new Uint8Array(CONFIG.FrameBuf);
    this.out = enc ? EMPTY : new Uint8Array(opts.rawLen);
    this.limit = opts.rawLen;
    this.strings = new StringModel(rc);
    if (ENCODE) {
      this.stats = { frames: 0, rawFrames: 0, rawBytes: 0, tokens: 0, switches: new Int32Array(7), steps: new Int32Array(4) };
      this.end = 0;
      this.fKind = 0;
      this.fDt = 0;
      this.fOffset = 0;
      this.fLen = 0;
      this.fPayload = 0;
      this.fEnd = 0;
      this.fTypeTag = 0;
      this.fTypeNum = 0;
      this.fTypeStart = 0;
      this.fTypeLen = 0;
      this.fEnc = 0;
      this.vEnd = 0;
      this.vp = 0;
      this.vend = 0;
      this.ovStamp = new Int32Array(CONFIG.RefsStart);
      this.ovKind = new Uint8Array(CONFIG.RefsStart);
      this.ovType = new Int32Array(CONFIG.RefsStart);
      this.stamp = 0;
      this.stepRatioQ = 0;
      this.stepExactQ = 0;
      this.carFull = 0;
      this.ftH = new Int32Array(BYTE_VALUES);
      this.ftI = new Int32Array(BYTE_VALUES);
      this.ftV = new Float64Array(BYTE_VALUES);
      this.ftN = 0;
      this.readings = new Float64Array(BYTE_VALUES * 2);
    }
    this.cKind = rc.alloc(KIND_PREVS * KIND_SLOTS);
    this.cDtHi = rc.alloc(STATE_KINDS_ALL * KIND_PREVS * DT_BUCKETS * CLASS_W);
    this.cDtLo = rc.alloc(STATE_KINDS_ALL * KIND_PREVS * GAMMA_W);
    this.cFrameInt = rc.alloc(FI_COUNT * GAMMA_W);
    this.cFlags = rc.alloc(FLAG_COUNT);
    this.cStep = rc.alloc(STEP_MODES * STEP_MODES);
    this.cStepRatio = rc.alloc(GAMMA_W);
    this.cStepExact = rc.alloc(2 * GAMMA_W);
    this.cMsgNum = rc.alloc(GAMMA_W);
    this.msgTypes = this.strings.newField();
    if (PRIOR) {
      const prior = opts.prior === undefined ? null : opts.prior;
      this.knownHandshake = prior !== null ? prior.handshake : EMPTY;
      if (prior !== null) this.applyPrior(prior);
    }
  }

  // ---------------------------------------------------------------- starting model

  /**
   * Base of the context block rows[id][k], reserved on first use.
   * @build prior
   */
  private rowsBlock(rows: Rows, id: number, k: number, size: number): number {
    const e = rows.entry(id, k);
    let c = rows.ctx[e];
    if (c === 0) {
      c = this.rc.alloc(size);
      rows.ctx[e] = c;
    }
    return c;
  }

  /**
   * Base of the context block that `site` keeps under the keys (a, b, c), created when absent, exactly as the
   * walker would create it on first use. This is the one place that maps a prior's block list to the tables.
   * Throws when a key is outside its table.
   * @build prior
   */
  private siteBlock(site: number, a: number, b: number, c: number): number {
    const fits = (v: number, limit: number): void => {
      if (!(v >= 0 && v < limit)) throw new Error(PRIOR_MISFIT);
    };
    switch (site) {
      case SITE.HEAD_FLAG_START: fits(a, this.headFlagStart.length); return this.ctx(this.headFlagStart, a, HEAD_FLAGS);
      case SITE.HEAD_FLAG: fits(a, this.headFlag.length); return this.ctx(this.headFlag, a, HEAD_FLAGS);
      case SITE.HEAD_TREE: fits(a, this.headTree.length); return this.ctx(this.headTree, a, TUNING.HeadChain !== 0 ? HM_BLOCK : HEAD_TREE);
      case SITE.HEAD_MISS: fits(a, this.headTree.length); fits(b, HEAD_SYMBOLS + 1); return this.sparse(this.headMiss, a, b, TUNING.HeadChain !== 0 ? HM_BLOCK : HEAD_TREE);
      case SITE.COLL: fits(a, this.collCtx.length); return this.ctx(this.collCtx, a, COLL_BLOCK);
      case SITE.INDEX: fits(a, this.idxCtx.length); return this.ctx(this.idxCtx, a, IDX_BLOCK);
      case SITE.SWITCH: fits(a, CG_SPACE); return this.ctx(this.swBlock, a, SW_BLOCK);
      case SITE.TREE_STOP: fits(a, CG_SPACE); return this.ctx(this.treeBlock, a, TREE_STOPS);
      case SITE.TREE_STEP: fits(a, CG_SPACE); fits(b, TREE_KEYS); return this.rowsBlock(this.twRows, a, b, a < GROUP_MAX ? 1 << TREE_KID_BITS : INT_BLOCK);
      case SITE.NEW_REF: fits(a, FID_SPACE); return this.ctx(this.newRefCtx, a, INT_BLOCK);
      case SITE.TYPE: fits(a, FID_SPACE); return this.ctx(this.typeCtx, a, TYPE_BLOCK);
      case SITE.TYPE_LO: fits(a, FID_SPACE); fits(b, BYTE_VALUES); return this.sparse(this.typeLo, a, b, BYTE_VALUES);
      case SITE.BYTE: fits(a, FID_SPACE); fits(b, BYTE_LASTS); return this.rowsBlock(this.byteRows, a, b, BYTE_BLOCK);
      case SITE.BYTE_HI: fits(a, FID_SPACE); fits(b, BYTE_LASTS); fits(c, VISIT_PREV_MAX + 1); return this.sparse(this.byteHi, this.byteRows.entry(a, b), c, BYTE_BLOCK);
      case SITE.INT16: fits(a, FID_SPACE); fits(b, I16_LASTS); return this.rowsBlock(this.i16Rows, a, b, GAMMA_N);
      case SITE.INT16_HI: fits(a, FID_SPACE); fits(b, I16_LASTS); fits(c, VISIT_PREV_MAX + 1); return this.sparse(this.i16Hi, this.i16Rows.entry(a, b), c, CLASS_N);
      case SITE.NUM_CLASS: fits(a, FID_SPACE); return this.ctx(this.numClsCtx, a, NUMCLS_BLOCK);
      case SITE.NUM_HI: fits(a, FID_SPACE); fits(b, NUM_LASTS); return this.rowsBlock(this.numHi, a, b, CLASS_W);
      case SITE.NUM_LO: fits(a, FID_SPACE); return this.ctx(this.numLo, a, GAMMA_W);
      case SITE.FLOAT_LO: fits(a, FID_SPACE); fits(b, FLOAT_KEYS); return this.rowsBlock(this.floatLo, a, b, FLOAT_LO_BLOCK);
      case SITE.FLOAT_HI: fits(a, FID_SPACE); fits(b, FLOAT_LASTS * FLOAT_KEYS); return this.rowsBlock(this.floatHi, a, b, FLOAT_HI_BLOCK);
      case SITE.OTHER: fits(a, FID_SPACE); return this.ctx(this.otherCtx, a, OTHER_BLOCK);
      case SITE.STR_HINT: fits(a, this.strings.fieldsMade); fits(b, HINT_MAX + 1); return this.strings.hintBlock(a, b);
      default: throw new Error(PRIOR_MISFIT);
    }
  }

  /**
   * Load a starting model into this still untouched coder: the vocabulary, each string field with its
   * dictionary, each context block, then the starting state of every context the model names. Fields and blocks
   * are created in the model's order, through the same code the walker uses, so both directions (and the trainer)
   * end up with every context at the same index. The final context count is checked against the model's: a build
   * whose tables are laid out differently refuses the model instead of misreading it.
   * @complexity O(strings + blocks + states) of the model: about 3 ms @alloc the blocks and dictionaries
   * @build prior
   */
  private applyPrior(prior: Prior): void {
    const st = this.strings;
    st.preloadPool(prior.stringBytes, prior.stringStart, prior.stringStart.length - 1);
    for (let f = 0; f < prior.fieldOwner.length; f++) {
      const key = prior.fieldKey[f];
      let field: number;
      if (prior.fieldOwner[f] === OWNER.MSGTYPE) field = this.msgTypes;
      else {
        const table = prior.fieldOwner[f] === OWNER.FIELD ? this.strFieldOf : this.keyField;
        if (!(key >= 0 && key < table.length) || table[key] !== 0) throw new Error(PRIOR_MISFIT);
        field = this.strField(table, key);
      }
      if (field !== f) throw new Error(PRIOR_MISFIT);
      st.preloadField(f, prior.fieldDict, prior.fieldDictStart[f], prior.fieldDictStart[f + 1]);
    }
    for (let i = 0; i < prior.blockSite.length; i++) this.siteBlock(prior.blockSite[i], prior.blockA[i], prior.blockB[i], prior.blockC[i]);
    const rc = this.rc;
    if (prior.contexts !== CONTEXTS_UNCHECKED && rc.used !== prior.contexts) throw new Error(PRIOR_MISFIT);
    const states = rc.st;
    const index = prior.ctxIndex;
    const word = prior.ctxState;
    for (let i = 0; i < index.length; i++) states[index[i]] = word[i];
  }

  /**
   * Call fn(owner, key, field) for every string field in existence that a starting model can name (see OWNER).
   * For the prior trainer.
   * @complexity O(field id space) @alloc none
   * @build measure
   */
  forEachStringField(fn: (owner: number, key: number, field: number) => void): void {
    fn(OWNER.MSGTYPE, 0, this.msgTypes);
    for (let k = 0; k < this.strFieldOf.length; k++) if (this.strFieldOf[k] !== 0) fn(OWNER.FIELD, k, this.strFieldOf[k] - 1);
    for (let k = 0; k < this.keyField.length; k++) if (this.keyField[k] !== 0) fn(OWNER.KEY, k, this.keyField[k] - 1);
  }

  /**
   * Call fn(site, a, b, c, base, size) for every context block in existence that a starting model can name (see
   * SITE): the inverse of siteBlock. For the prior trainer, which reads a finished model.
   * @complexity O(table sizes) @alloc two reverse lookup tables
   * @build measure
   */
  forEachBlock(fn: (site: number, a: number, b: number, c: number, base: number, size: number) => void): void {
    const table = (site: number, t: Int32Array, size: number): void => {
      for (let k = 0; k < t.length; k++) if (t[k] !== 0) fn(site, k, 0, 0, t[k], size);
    };
    const rows = (site: number, r: Rows, size: number): void => r.forEachEntry((id, k, e) => fn(site, id, k, 0, r.ctx[e], size));
    /**
     * A pair map keyed by (entry of `r`, c): name the entry by its (id, k). Every entry of every row gets a name,
     * set or not: a prior may keep such a block without the row's own block.
     */
    const rowPairs = (site: number, map: PairMap, r: Rows, width: number, size: number): void => {
      const name = new Int32Array(r.ctx.length).fill(ABSENT);
      r.forEachRow((id, first) => {
        for (let k = 0; k < width; k++) name[first + k] = id * width + k;
      });
      map.forEachPair((e, c, base) => {
        if (name[e] !== ABSENT) fn(site, Math.floor(name[e] / width), name[e] % width, c, base, size);
      });
    };
    const missSize = TUNING.HeadChain !== 0 ? HM_BLOCK : HEAD_TREE;
    table(SITE.HEAD_FLAG_START, this.headFlagStart, HEAD_FLAGS);
    table(SITE.HEAD_FLAG, this.headFlag, HEAD_FLAGS);
    table(SITE.HEAD_TREE, this.headTree, missSize);
    this.headMiss.forEachPair((a, b, base) => fn(SITE.HEAD_MISS, a, b, 0, base, missSize));
    table(SITE.COLL, this.collCtx, COLL_BLOCK);
    table(SITE.INDEX, this.idxCtx, IDX_BLOCK);
    table(SITE.SWITCH, this.swBlock, SW_BLOCK);
    table(SITE.TREE_STOP, this.treeBlock, TREE_STOPS);
    this.twRows.forEachEntry((id, k, e) => fn(SITE.TREE_STEP, id, k, 0, this.twRows.ctx[e], id < GROUP_MAX ? 1 << TREE_KID_BITS : INT_BLOCK));
    table(SITE.NEW_REF, this.newRefCtx, INT_BLOCK);
    table(SITE.TYPE, this.typeCtx, TYPE_BLOCK);
    this.typeLo.forEachPair((a, b, base) => fn(SITE.TYPE_LO, a, b, 0, base, BYTE_VALUES));
    rows(SITE.BYTE, this.byteRows, BYTE_BLOCK);
    rowPairs(SITE.BYTE_HI, this.byteHi, this.byteRows, BYTE_LASTS, BYTE_BLOCK);
    rows(SITE.INT16, this.i16Rows, GAMMA_N);
    rowPairs(SITE.INT16_HI, this.i16Hi, this.i16Rows, I16_LASTS, CLASS_N);
    table(SITE.NUM_CLASS, this.numClsCtx, NUMCLS_BLOCK);
    rows(SITE.NUM_HI, this.numHi, CLASS_W);
    table(SITE.NUM_LO, this.numLo, GAMMA_W);
    rows(SITE.FLOAT_LO, this.floatLo, FLOAT_LO_BLOCK);
    rows(SITE.FLOAT_HI, this.floatHi, FLOAT_HI_BLOCK);
    table(SITE.OTHER, this.otherCtx, OTHER_BLOCK);
    this.strings.forEachHintBlock((f, h, base) => fn(SITE.STR_HINT, f, h, 0, base, STR_HINT_BLOCK));
  }

  // ---------------------------------------------------------------- small helpers

  /** Base of the context block stored at table[key], reserved on first use. */
  private ctx(table: Int32Array, key: number, size: number): number {
    let c = table[key];
    if (c === 0) {
      c = this.rc.alloc(size);
      table[key] = c;
    }
    return c;
  }

  /** Base of the context block for the pair (a, b), reserved on first use. */
  private sparse(map: PairMap, a: number, b: number, size: number): number {
    let c = map.get(a, b);
    if (c === ABSENT) {
      c = this.rc.alloc(size);
      map.setLast(a, b, c);
    }
    return c;
  }

  /** The string field stored at table[key] (as field + 1), created on first use. */
  private strField(table: Int32Array, key: number): number {
    let f = table[key];
    if (f === 0) {
      f = this.strings.newField() + 1;
      table[key] = f;
    }
    return f - 1;
  }

  private bitsOf(x: number): number {
    this.f32[0] = x;
    return this.u32[0];
  }

  private floatOf(bits: number): number {
    this.u32[0] = bits;
    return this.f32[0];
  }

  // ---------------------------------------------------------------- byte plumbing

  /**
   * Decode only: make sure n more bytes plus a token's worth fit in the frame buffer. `n` is exactly what is about
   * to be written (0 before a fixed-size token): a count that would overrun the original file means damage.
   */
  private room(n: number): void {
    if (this.op + this.p + n > this.limit) throw new Error(CORRUPT);
    if (this.p + n + TOKEN_MARGIN > this.b.length) {
      let cap = this.b.length * 2;
      while (cap < this.p + n + TOKEN_MARGIN) cap *= 2;
      this.b = growU8(this.b, cap);
    }
  }

  private emit(bytes: Uint8Array, start: number, end: number): void {
    const n = end - start;
    if (this.op + n > this.out.length) throw new Error(CORRUPT);
    if (n < CONFIG.BulkCopyMin) {
      const out = this.out;
      let o = this.op;
      for (let i = start; i < end; i++) out[o++] = bytes[i];
    } else this.out.set(bytes.subarray(start, end), this.op);
    this.op += n;
  }

  private emitByte(v: number): void {
    if (this.op >= this.out.length) throw new Error(CORRUPT);
    this.out[this.op++] = v;
  }

  private emitVarint(v: number): void {
    while (v >= VARINT_BASE) {
      this.emitByte((v % VARINT_BASE) | VARINT_CONTINUE);
      v = Math.floor(v / VARINT_BASE);
    }
    this.emitByte(v);
  }

  private emitU32(v: number): void {
    this.emitByte(v & 0xff);
    this.emitByte((v >>> 8) & 0xff);
    this.emitByte((v >>> 16) & 0xff);
    this.emitByte(Math.floor(v / 0x1000000) & 0xff);
  }

  /**
   * Encode only: a shortest-form varint at p, bounded by end. Returns it, or -1; sets vEnd.
   * @build encode
   */
  private varint(p: number, end: number): number {
    const b = this.b;
    let scale = 1;
    let out = 0;
    let n = 0;
    let x: number;
    do {
      if (p >= end || n === VARINT_MAX_BYTES) return -1;
      x = b[p++];
      out += (x & VARINT_DATA) * scale;
      scale *= VARINT_BASE;
      n++;
    } while ((x & VARINT_CONTINUE) !== 0);
    if (n > 1 && x === 0) return -1;
    this.vEnd = p;
    return out;
  }

  /** `n` bytes as literal data, each in the context of the byte before it. */
  private byteRun(n: number, role: number, space: number): void {
    const rc = this.rc;
    if (MEASURE) rc.role = role;
    const base = this.ctx(this.rawBase, space, RAW_SPACE_SIZE);
    let prev = 0;
    if (ENCODE && this.enc) {
      const b = this.b;
      let p = this.p;
      for (let i = 0; i < n; i++) prev = tree(rc, base + prev * BYTE_VALUES, BYTE_BITS, b[p++]);
      this.p = p;
      return;
    }
    this.room(n);
    const b = this.b;
    let p = this.p;
    for (let i = 0; i < n; i++) {
      prev = tree(rc, base + prev * BYTE_VALUES, BYTE_BITS, 0);
      b[p++] = prev;
    }
    this.p = p;
  }

  // ---------------------------------------------------------------- Colyseus numbers

  /**
   * Encode only: the validated integer `number` at the cursor.
   * @build encode
   */
  private num(): number {
    const b = this.b;
    const p = this.p;
    const pre = b[p];
    if (pre < 0x80) {
      this.p = p + 1;
      return pre;
    }
    if (pre >= 0xe0) {
      this.p = p + 1;
      return pre - 0x100;
    }
    switch (pre) {
      case 0xcc: this.p = p + 2; return b[p + 1];
      case 0xcd: this.p = p + 3; return b[p + 1] | (b[p + 2] << 8);
      case 0xce: this.p = p + 5; return u32At(b, p + 1);
      case 0xcf: this.p = p + 9; return u32At(b, p + 1) + u32At(b, p + 5) * TWO_POW_32;
      case 0xd0: this.p = p + 2; return (b[p + 1] << 24) >> 24;
      case 0xd1: this.p = p + 3; return ((b[p + 1] | (b[p + 2] << 8)) << 16) >> 16;
      case 0xd2: this.p = p + 5; return u32At(b, p + 1) | 0;
      case 0xd3: this.p = p + 9; return u32At(b, p + 1) + (u32At(b, p + 5) | 0) * TWO_POW_32;
      default: throw new Error(INTERNAL);
    }
  }

  /** Decode only: the canonical Colyseus encoding of an integer, written at the frame cursor. */
  private writeInt(v: number): void {
    const b = this.b;
    let p = this.p;
    if (v >= 0) {
      if (v < 0x80) b[p++] = v;
      else if (v < 0x100) { b[p++] = 0xcc; b[p++] = v; }
      else if (v < 0x10000) { b[p++] = 0xcd; b[p++] = v & 0xff; b[p++] = v >>> 8; }
      else if (v < TWO_POW_32) { b[p++] = 0xce; b[p++] = v & 0xff; b[p++] = (v >>> 8) & 0xff; b[p++] = (v >>> 16) & 0xff; b[p++] = v >>> 24; }
      else {
        b[p++] = 0xcf;
        const lo = v % TWO_POW_32;
        const hi = Math.floor(v / TWO_POW_32);
        b[p++] = lo & 0xff; b[p++] = (lo >>> 8) & 0xff; b[p++] = (lo >>> 16) & 0xff; b[p++] = lo >>> 24;
        b[p++] = hi & 0xff; b[p++] = (hi >>> 8) & 0xff; b[p++] = (hi >>> 16) & 0xff; b[p++] = hi >>> 24;
      }
    } else if (v >= -0x20) b[p++] = 0xe0 | (v + 0x20);
    else if (v >= -0x80) { b[p++] = 0xd0; b[p++] = v & 0xff; }
    else if (v >= -0x8000) { b[p++] = 0xd1; b[p++] = v & 0xff; b[p++] = (v >> 8) & 0xff; }
    else if (v >= -2147483648) { b[p++] = 0xd2; b[p++] = v & 0xff; b[p++] = (v >> 8) & 0xff; b[p++] = (v >> 16) & 0xff; b[p++] = (v >> 24) & 0xff; }
    else {
      b[p++] = 0xd3;
      const hi = Math.floor(v / TWO_POW_32);
      const lo = v - hi * TWO_POW_32;
      b[p++] = lo & 0xff; b[p++] = (lo >>> 8) & 0xff; b[p++] = (lo >>> 16) & 0xff; b[p++] = lo >>> 24;
      b[p++] = hi & 0xff; b[p++] = (hi >> 8) & 0xff; b[p++] = (hi >> 16) & 0xff; b[p++] = (hi >> 24) & 0xff;
    }
    this.p = p;
  }

  /**
   * An integer token coded as its difference from `expect`: one bit "exactly as expected", else the zigzag
   * difference by size class. `ctx` is an INT_BLOCK. Returns the integer.
   */
  private intDiff(ctx: number, expect: number): number {
    const rc = this.rc;
    if (ENCODE && this.enc) {
      const v = this.num();
      const z = zigzag(v - expect);
      if (TUNING.IntZeroFlag !== 0) {
        if (rc.bit(ctx, z === 0 ? 1 : 0) === 0) gamma1(rc, ctx + 1, GAMMA_BITS_NARROW, z - 1);
      } else gamma1(rc, ctx + 1, GAMMA_BITS_NARROW, z);
      return v;
    }
    let z: number;
    if (TUNING.IntZeroFlag !== 0) z = rc.bit(ctx, 0) !== 0 ? 0 : 1 + gamma1(rc, ctx + 1, GAMMA_BITS_NARROW, 0);
    else z = gamma1(rc, ctx + 1, GAMMA_BITS_NARROW, 0);
    const v = expect + unzigzag(z);
    this.writeInt(v);
    return v;
  }

  /** A Colyseus string token through the string model. Sets lastStr (its pool id). */
  private stringToken(sf: number, hint: number, role: number, tplIdx: number): void {
    const st = this.strings;
    if (ENCODE && this.enc) {
      const b = this.b;
      let p = this.p;
      const pre = b[p];
      let len: number;
      if (pre < 0xc0) {
        len = pre & 0x1f;
        p += 1;
      } else if (pre === 0xd9) {
        len = b[p + 1];
        p += 2;
      } else {
        len = b[p + 1] | (b[p + 2] << 8);
        p += 3;
      }
      const e = p + len;
      this.lastStr = st.code(sf, st.pool.find(b, p, e), b, p, e, hint, tplIdx, role);
      this.p = e;
      return;
    }
    const id = st.code(sf, ABSENT, this.b, 0, 0, hint, tplIdx, role);
    this.lastStr = id;
    const pool = st.pool;
    const at = pool.start[id];
    const len = pool.start[id + 1] - at;
    this.room(len); // the prefix bytes fit in the token margin
    const b = this.b;
    let p = this.p;
    if (len < 0x20) b[p++] = 0xa0 | len;
    else if (len < 0x100) { b[p++] = 0xd9; b[p++] = len; }
    else { b[p++] = 0xda; b[p++] = len & 0xff; b[p++] = len >>> 8; }
    const bytes = pool.chars;
    for (let i = 0; i < len; i++) b[p + i] = bytes[at + i];
    this.p = p + len;
  }

  // ---------------------------------------------------------------- tables

  private growHandles(): void {
    const cap = this.hCap * 2;
    this.hCap = cap;
    this.hKind = growU8(this.hKind, cap);
    this.hRef = growI32(this.hRef, cap);
    this.hType = growI32(this.hType, cap);
    this.hCg = growI32(this.hCg, cap);
    this.hFid = growI32(this.hFid, cap);
    this.hSlot = growI32(this.hSlot, cap);
    this.hSlotCap = growI32(this.hSlotCap, cap);
    this.hSucc = growI32(this.hSucc, cap);
    this.hNextIdx = growI32(this.hNextIdx, cap);
    this.hLastItem = growI32(this.hLastItem, cap);
    this.hSwLast = growU8(this.hSwLast, cap);
    this.hSkips = growU8(this.hSkips, cap);
    this.hInList = growU8(this.hInList, cap);
    this.hLn = growI32(this.hLn, cap);
    this.hLp = growI32(this.hLp, cap);
    this.hRecent = growI32(this.hRecent, cap * SW_RECENT_MAX);
    this.hRecentN = growU8(this.hRecentN, cap);
    this.hParent = growI32(this.hParent, cap);
    this.hPidx = growI32(this.hPidx, cap);
    this.hList = growI32(this.hList, cap);
    this.hOrderLen = growI32(this.hOrderLen, cap);
    this.hOrderCap = growI32(this.hOrderCap, cap);
    this.hInOrder = growU8(this.hInOrder, cap);
    this.hOrd = growI32(this.hOrd, cap);
    this.hLastKid = growI32(this.hLastKid, cap);
    this.hTpl = growI32(this.hTpl, cap);
    this.hTplCount = growI32(this.hTplCount, cap);
    this.hFh = growI32(this.hFh, cap);
    this.hCar = growI32(this.hCar, cap);
    this.hCarIndex = growI32(this.hCarIndex, cap);
    this.hPortal = growI32(this.hPortal, cap);
    this.hSymIndex = growI32(this.hSymIndex, cap);
    this.hSymCount = growI32(this.hSymCount, cap);
  }

  private newHandle(id: number, kind: number, type: number, cg: number, fid: number): number {
    const h = this.hN++;
    if (h >= this.hCap) this.growHandles();
    this.hKind[h] = kind;
    this.hRef[h] = id;
    this.hType[h] = type;
    this.hCg[h] = cg;
    this.hFid[h] = fid;
    this.hSlot[h] = 0;
    this.hSlotCap[h] = 0;
    this.hSucc[h] = -1;
    this.hNextIdx[h] = 0;
    this.hLastItem[h] = -1;
    this.hSwLast[h] = 0;
    this.hSkips[h] = 0;
    this.hInList[h] = 0;
    this.hLn[h] = -1;
    this.hLp[h] = -1;
    this.hRecentN[h] = 0;
    this.hParent[h] = -1;
    this.hPidx[h] = 0;
    this.hList[h] = -1;
    this.hOrderLen[h] = 0;
    this.hOrderCap[h] = 0;
    this.hInOrder[h] = 0;
    this.hOrd[h] = 0;
    this.hLastKid[h] = 0;
    this.hTpl[h] = -1;
    this.hTplCount[h] = TPL_NONE;
    this.hFh[h] = -1;
    this.hCar[h] = -1;
    this.hCarIndex[h] = 0;
    this.hPortal[h] = -1;
    this.hSymIndex[h] = 0;
    this.hSymCount[h] = 0;
    return h;
  }

  /** Make the refId tables cover id. */
  private ensureRef(id: number): void {
    if (id < this.refCap) return;
    let cap = this.refCap * 2;
    while (cap <= id) cap *= 2;
    const h = new Int32Array(cap).fill(-1);
    h.set(this.handleOf);
    this.handleOf = h;
    this.pendFlag = growU8(this.pendFlag, cap);
    if (ENCODE) {
      this.ovStamp = growI32(this.ovStamp, cap);
      this.ovKind = growU8(this.ovKind, cap);
      this.ovType = growI32(this.ovType, cap);
    }
    this.refCap = cap;
  }

  /** Reserve n fresh slots (value 0, no history, no first value). */
  private allocSlots(n: number): number {
    const base = this.slotUsed;
    this.slotUsed += n;
    if (this.slotUsed > this.sv.length) {
      let cap = this.sv.length * 2;
      while (cap < this.slotUsed) cap *= 2;
      this.sv = growF64(this.sv, cap);
      this.saux = growI32(this.saux, cap);
      this.sinit = growF64(this.sinit, cap);
    }
    this.sv.fill(0, base, base + n);
    this.saux.fill(0, base, base + n);
    this.sinit.fill(NaN, base, base + n);
    return base;
  }

  /** Reserve n zeroed integers in the arena. */
  private iaAlloc(n: number): number {
    const base = this.iaUsed;
    this.iaUsed += n;
    if (this.iaUsed > this.ia.length) {
      let cap = this.ia.length * 2;
      while (cap < this.iaUsed) cap *= 2;
      this.ia = growI32(this.ia, cap);
    }
    this.ia.fill(0, base, base + n);
    return base;
  }

  private succAlloc(n: number): number {
    const base = this.succUsed;
    this.succUsed += n;
    if (this.succUsed > this.succ.length) {
      let cap = this.succ.length * 2;
      while (cap < this.succUsed) cap *= 2;
      const s = new Uint16Array(cap);
      s.set(this.succ);
      this.succ = s;
    }
    this.succ.fill(0, base, base + n);
    return base;
  }

  /** The slot of item `index` of a collection of primitives, growing its slot block as needed. */
  private itemSlot(h: number, index: number): number {
    const i = index < ITEM_SLOTS_MAX ? index : ITEM_SLOTS_MAX - 1;
    if (i >= this.hSlotCap[h]) {
      const n = this.hSlotCap[h];
      let cap = n === 0 ? ITEM_SLOTS_START : n * 2;
      while (cap <= i) cap *= 2;
      const base = this.allocSlots(cap);
      const old = this.hSlot[h];
      for (let k = 0; k < n; k++) {
        this.sv[base + k] = this.sv[old + k];
        this.saux[base + k] = this.saux[old + k];
      }
      this.hSlot[h] = base;
      this.hSlotCap[h] = cap;
    }
    return this.hSlot[h] + i;
  }

  /** Float history of a struct, created on first use. Returns the index of its first float slot. */
  private floatHistory(ref: number): number {
    let base = this.hFh[ref];
    if (base >= 0) return base;
    const n = (this.schema as Schema).fieldCount[this.hType[ref]];
    base = this.fhUsed;
    this.fhUsed += n;
    if (this.fhUsed > this.fcnt.length) {
      let cap = this.fcnt.length * 2;
      while (cap < this.fhUsed) cap *= 2;
      this.fx1 = growF64(this.fx1, cap);
      this.fx2 = growF64(this.fx2, cap);
      this.fx3 = growF64(this.fx3, cap);
      this.fx4 = growF64(this.fx4, cap);
      this.ff0 = growI32(this.ff0, cap);
      this.ff1 = growI32(this.ff1, cap);
      this.ff2 = growI32(this.ff2, cap);
      this.ff3 = growI32(this.ff3, cap);
      this.ff4 = growI32(this.ff4, cap);
      this.fcnt = growU8(this.fcnt, cap);
      this.fscored = growI32(this.fscored, cap);
      this.fscore = growI32(this.fscore, cap * FLOAT_ORDERS);
    }
    for (let i = base; i < base + n; i++) {
      this.fx1[i] = 0;
      this.fx2[i] = 0;
      this.fx3[i] = 0;
      this.fx4[i] = 0;
      this.ff0[i] = 0;
      this.ff1[i] = 0;
      this.ff2[i] = 0;
      this.ff3[i] = 0;
      this.ff4[i] = 0;
      this.fcnt[i] = 0;
      this.fscored[i] = -1;
      const s = i * FLOAT_ORDERS;
      for (let k = 0; k < FORMULA_ORDER; k++) this.fscore[s + k] = SCORE_START;
      this.fscore[s + FORMULA_ORDER] = FORMULA_SCORE_START;
    }
    this.hFh[ref] = base;
    return base;
  }

  // ---------------------------------------------------------------- schema bookkeeping

  /** Index of the field called `name` in type ti, or -1. */
  private findField(s: Schema, ti: number, name: string): number {
    const start = s.fieldStart[ti];
    for (let i = 0; i < s.fieldCount[ti]; i++) if (s.fName[start + i] === name) return i;
    return -1;
  }

  /** Type index of the structs held by the root collection called `name`, or -1. */
  private rootItemType(s: Schema, name: string): number {
    const i = this.findField(s, s.root, name);
    if (i < 0) return -1;
    const fi = s.fieldStart[s.root] + i;
    return s.fVal[fi] !== VAL_PRIM && s.fVal[fi] !== VAL_REF && s.fChildVal[fi] === VAL_REF ? s.fType[fi] : -1;
  }

  /** Game-aware: find the structures of PAC's mini-game by field name, so a renumbered schema still works. */
  private findGameTypes(s: Schema): void {
    for (let c = 0; c < PAC_MINIGAME.CarouselFields.length; c++) {
      const t = this.rootItemType(s, PAC_MINIGAME.CarouselFields[c]);
      if (t < 0) continue;
      const ix = this.findField(s, t, 'x');
      const iy = this.findField(s, t, 'y');
      if (ix < 0 || iy < 0) continue;
      this.tCar[t] = PAC_MINIGAME.CarouselSpeeds[c];
      this.tCarIx[t] = ix;
      this.tCarIy[t] = iy;
      this.tCarId[t] = this.findField(s, t, 'id');
    }
    const at = this.rootItemType(s, PAC_MINIGAME.AvatarField);
    if (at >= 0) {
      const ix = this.findField(s, at, 'x');
      const iy = this.findField(s, at, 'y');
      const tx = this.findField(s, at, 'targetX');
      const ty = this.findField(s, at, 'targetY');
      if (ix >= 0 && iy >= 0 && tx >= 0 && ty >= 0) {
        this.avType = at;
        this.avIx = ix;
        this.avIy = iy;
        this.avTx = tx;
        this.avTy = ty;
      }
    }
    const st = this.rootItemType(s, PAC_MINIGAME.SymbolField);
    if (st >= 0) {
      const ix = this.findField(s, st, 'x');
      const iy = this.findField(s, st, 'y');
      const ip = this.findField(s, st, 'portalId');
      if (ix >= 0 && iy >= 0 && ip >= 0) {
        this.syType = st;
        this.syIx = ix;
        this.syIy = iy;
        this.syPortal = ip;
      }
    }
  }

  /**
   * Start a connection with this type table: every type gets the context group of its topmost ancestor, and the
   * structure table restarts with the root alone. Context tables are kept, so a reconnect reuses what was learned.
   */
  private adoptSchema(schema: Schema, game: boolean): void {
    const n = schema.count;
    const tGroup = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const baseId = schema.idOf[schema.baseOf[i]];
      let g: number;
      if (!game) g = baseId < BOOT_GROUPS ? baseId : BOOT_GROUPS - 1;
      else {
        if (baseId >= this.gameGroup.length) {
          let cap = this.gameGroup.length * 2;
          while (cap <= baseId) cap *= 2;
          this.gameGroup = growI32(this.gameGroup, cap);
        }
        g = this.gameGroup[baseId];
        if (g === 0) {
          g = (this.groupsUsed < GROUP_MAX ? this.groupsUsed++ : GROUP_MAX - 1) + 1;
          this.gameGroup[baseId] = g;
        }
        g -= 1;
      }
      tGroup[i] = g;
    }
    this.tGroup = tGroup;
    this.schema = schema;
    this.tCar = new Float64Array(n);
    this.tCarIx = new Int32Array(n);
    this.tCarIy = new Int32Array(n);
    this.tCarId = new Int32Array(n);
    this.avType = -1;
    this.syType = -1;
    if (game && this.formulas) this.findGameTypes(schema);
    // a fresh structure table
    this.hN = 0;
    this.slotUsed = 0;
    this.iaUsed = 0;
    this.succUsed = 0;
    this.fhUsed = 0;
    this.handleOf.fill(-1);
    this.pendFlag.fill(0);
    this.pendingLen = 0;
    this.pendingHead = 0;
    this.maxRef = 0;
    this.swPairs.clear();
    this.lookalikes.clear();
    this.laN = 0;
    this.portalOf.fill(0);
    this.carGroup = -1;
    this.mgT = -1;
    const start = this.newHandle(-1, KIND_NONE, 0, SW_START_GROUP, 0);
    this.hInList[start] = 1;
    this.swPrev = START;
    this.makeStruct(ROOT_REF, schema.root);
  }

  private makeStruct(id: number, ti: number): number {
    const s = this.schema as Schema;
    const g = this.tGroup[ti];
    const h = this.newHandle(id, KIND_STRUCT, ti, g, g * FIELD_SLOTS);
    this.hSlot[h] = this.allocSlots(s.fieldCount[ti]);
    this.ensureRef(id);
    this.handleOf[id] = h;
    if (this.tCar[ti] !== 0) {
      // structures of one carousel are created in one frame; their creation order is the game's item index
      if (this.carGroup < 0 || this.carBorn !== this.frameNo || this.carType !== ti) {
        this.carGroup = this.carSeq++;
        this.carType = ti;
        this.carBorn = this.frameNo;
        this.carCount = 0;
        if (ENCODE) this.carFull = 0;
        this.mgT = -1; // a new carousel restarts the mini-game clock
      }
      this.hCar[h] = this.carGroup;
      this.hCarIndex[h] = this.carCount++;
    }
    return h;
  }

  private makeColl(id: number, kind: number, fi: number, cid: number): number {
    const h = this.newHandle(id, kind, fi, GROUP_MAX + cid, cid);
    this.ensureRef(id);
    this.handleOf[id] = h;
    return h;
  }

  private pendingPush(id: number): void {
    if (this.pendingLen === this.pending.length) this.pending = growI32(this.pending, this.pending.length * 2);
    this.pending[this.pendingLen++] = id;
    this.pendFlag[id] = 1;
  }

  /** Record that `child` hangs under `parent` at field or item `index` (the first announcement wins). */
  private adopt(parent: number, index: number, child: number): void {
    if (this.hParent[child] < 0 && child !== parent && this.hRef[child] !== ROOT_REF) {
      this.hParent[child] = parent;
      this.hPidx[child] = index;
    }
    if (this.hParent[child] !== parent) return;
    if (this.hKind[parent] === KIND_STRUCT) {
      let kb = this.hList[parent];
      if (kb < 0) {
        kb = this.iaAlloc((this.schema as Schema).fieldCount[this.hType[parent]]);
        this.hList[parent] = kb;
      }
      this.ia[kb + index] = child + 1;
      this.hPidx[child] = index;
    } else if (this.hInOrder[child] === 0) {
      // a collection keeps its structs in order of last visit; a new one goes to the back
      const len = this.hOrderLen[parent];
      if (len === this.hOrderCap[parent]) {
        const cap = len === 0 ? ITEM_SLOTS_START : len * 2;
        const nb = this.iaAlloc(cap);
        const ob = this.hList[parent];
        for (let i = 0; i < len; i++) this.ia[nb + i] = this.ia[ob + i];
        this.hList[parent] = nb;
        this.hOrderCap[parent] = cap;
      }
      this.ia[this.hList[parent] + len] = child;
      this.hOrderLen[parent] = len + 1;
      this.hInOrder[child] = 1;
      this.hOrd[child] = len;
    }
  }

  private orderIndex(coll: number, target: number): number {
    const ob = this.hList[coll];
    const len = this.hOrderLen[coll];
    for (let i = 0; i < len; i++) if (this.ia[ob + i] === target) return i;
    return -1;
  }

  // ---------------------------------------------------------------- validation (encode only)

  /**
   * A canonical integer `number` at vp. Returns it and advances, or NaN when it is anything else.
   * @build encode
   */
  private vInt(): number {
    const b = this.b;
    const p = this.vp;
    const end = this.vend;
    if (p >= end) return NaN;
    const pre = b[p];
    if (pre < 0x80) {
      this.vp = p + 1;
      return pre;
    }
    if (pre >= 0xe0) {
      this.vp = p + 1;
      return pre - 0x100;
    }
    let v: number;
    switch (pre) {
      case 0xcc:
        if (p + 2 > end) return NaN;
        v = b[p + 1];
        if (v < 0x80) return NaN;
        this.vp = p + 2;
        return v;
      case 0xcd:
        if (p + 3 > end) return NaN;
        v = b[p + 1] | (b[p + 2] << 8);
        if (v < 0x100) return NaN;
        this.vp = p + 3;
        return v;
      case 0xce:
        if (p + 5 > end) return NaN;
        v = u32At(b, p + 1);
        if (v < 0x10000) return NaN;
        this.vp = p + 5;
        return v;
      case 0xcf:
        if (p + 9 > end) return NaN;
        v = u32At(b, p + 1) + u32At(b, p + 5) * TWO_POW_32;
        if (v < TWO_POW_32 || v > NUM_INT_MAX) return NaN;
        this.vp = p + 9;
        return v;
      case 0xd0:
        if (p + 2 > end) return NaN;
        v = (b[p + 1] << 24) >> 24;
        if (v >= -0x20) return NaN;
        this.vp = p + 2;
        return v;
      case 0xd1:
        if (p + 3 > end) return NaN;
        v = ((b[p + 1] | (b[p + 2] << 8)) << 16) >> 16;
        if (v >= -0x80) return NaN;
        this.vp = p + 3;
        return v;
      case 0xd2:
        if (p + 5 > end) return NaN;
        v = u32At(b, p + 1) | 0;
        if (v >= -0x8000) return NaN;
        this.vp = p + 5;
        return v;
      case 0xd3:
        if (p + 9 > end) return NaN;
        v = u32At(b, p + 1) + (u32At(b, p + 5) | 0) * TWO_POW_32;
        if (v >= -2147483648 || v < -NUM_INT_MAX) return NaN;
        this.vp = p + 9;
        return v;
      default:
        return NaN;
    }
  }

  /**
   * A string in the encoder's shortest spelling at vp, no longer than STR_MAX. Advances.
   * @build encode
   */
  private vString(): boolean {
    const b = this.b;
    const p = this.vp;
    const end = this.vend;
    if (p >= end) return false;
    const pre = b[p];
    let len: number;
    let start: number;
    if (pre >= 0xa0 && pre < 0xc0) {
      len = pre & 0x1f;
      start = p + 1;
    } else if (pre === 0xd9) {
      if (p + 2 > end) return false;
      len = b[p + 1];
      if (len < 0x20) return false;
      start = p + 2;
    } else if (pre === 0xda) {
      if (p + 3 > end) return false;
      len = b[p + 1] | (b[p + 2] << 8);
      if (len < 0x100) return false;
      start = p + 3;
    } else return false;
    if (start + len > end) return false;
    this.vp = start + len;
    return true;
  }

  /**
   * Remember a float of the frame being validated, for the clock measurement.
   * @build encode
   */
  private floatToken(h: number, index: number, at: number): void {
    if (this.ftN === this.ftH.length) {
      const cap = this.ftN * 2;
      this.ftH = growI32(this.ftH, cap);
      this.ftI = growI32(this.ftI, cap);
      this.ftV = growF64(this.ftV, cap);
    }
    this.ftH[this.ftN] = h;
    this.ftI[this.ftN] = index;
    this.ftV[this.ftN] = this.floatOf(u32At(this.b, at));
    this.ftN++;
  }

  /**
   * The value of one field or item, checked. `h` is the structure's handle, or -1 when it is new this frame.
   * @build encode
   */
  private vValue(op: number, fi: number, item: boolean, h: number, index: number): boolean {
    const b = this.b;
    const s = this.schema as Schema;
    const end = this.vend;
    const val = item ? s.fChildVal[fi] : s.fVal[fi];
    if (val === VAL_REF) {
      const id = this.vInt();
      if (!(id >= 0 && id < REF_MAX)) return false;
      let ti = s.fType[fi];
      if ((op & OP_ADD) === OP_ADD && this.vp < end && b[this.vp] === TYPE_ID) {
        this.vp++;
        const typeId = this.vInt();
        if (!(typeId >= 0 && typeId < s.indexOfId.length)) return false;
        ti = s.indexOfId[typeId];
      }
      if (ti < 0) return false;
      this.ensureRef(id);
      if (this.ovStamp[id] !== this.stamp && this.handleOf[id] < 0) {
        this.ovStamp[id] = this.stamp;
        this.ovKind[id] = KIND_STRUCT;
        this.ovType[id] = ti;
      }
      return true;
    }
    if (val !== VAL_PRIM) {
      const id = this.vInt();
      if (!(id >= 0 && id < REF_MAX)) return false;
      this.ensureRef(id);
      this.ovStamp[id] = this.stamp;
      this.ovKind[id] = s.fKind[fi];
      this.ovType[id] = fi;
      return true;
    }
    const prim = s.fPrim[fi];
    if (prim === PRIM_STRING) return this.vString();
    if (prim === PRIM_NUMBER) {
      if (this.vp >= end) return false;
      const pre = b[this.vp];
      if (pre === 0xca) {
        if (this.vp + 5 > end) return false;
        // only a slot that already holds a float track can give a clock reading
        if (!item && h >= 0 && this.hFh[h] >= 0 && (this.saux[this.hSlot[h] + index] & 3) === NUM_F32 + 1) {
          this.floatToken(h, index, this.vp + 1);
        }
        this.vp += 5;
        return true;
      }
      if (pre === 0xcb) {
        if (this.vp + 9 > end) return false;
        this.vp += 9;
        return true;
      }
      const v = this.vInt();
      return v >= -NUM_INT_MAX && v <= NUM_INT_MAX;
    }
    const w = PRIM_WIDTH[prim];
    if (this.vp + w > end) return false;
    if (prim === PRIM_FLOAT32 && !item && h >= 0 && this.hFh[h] >= 0) this.floatToken(h, index, this.vp);
    this.vp += w;
    return true;
  }

  /**
   * Check that a state body is something the walker reproduces exactly: every token parses, numbers and string
   * prefixes are in the encoder's shortest form, values are inside the limits, and the walk ends on the frame's
   * last byte. Changes no model state. Collects the frame's floats for the clock measurement.
   * @complexity O(tokens in the frame) @alloc none in the steady state
   * @build encode
   */
  private validate(start: number, end: number): boolean {
    const b = this.b;
    const s = this.schema as Schema;
    this.stamp++;
    const stamp = this.stamp;
    this.ftN = 0;
    this.vp = start;
    this.vend = end;
    let h = ROOT;
    let kind = this.hKind[ROOT];
    let type = this.hType[ROOT];
    while (this.vp < end) {
      const head = b[this.vp++];
      if (head === SWITCH_TO_STRUCTURE) {
        const id = this.vInt();
        if (!(id >= 0 && id < this.refCap)) return false;
        if (this.ovStamp[id] === stamp) {
          h = -1;
          kind = this.ovKind[id];
          type = this.ovType[id];
        } else {
          h = this.handleOf[id];
          if (h < 0) return false;
          kind = this.hKind[h];
          type = this.hType[h];
        }
        continue;
      }
      if (kind === KIND_STRUCT) {
        const op = head & OP_MASK;
        const index = head & FIELD_MASK;
        if (index >= s.fieldCount[type]) return false;
        if (op !== OP_DELETE && !this.vValue(op, s.fieldStart[type] + index, false, h, index)) return false;
      } else {
        if (head === OP_CLEAR || (kind === KIND_ARRAY && head === OP_REVERSE)) continue;
        const index = this.vInt();
        if (kind === KIND_ARRAY && head === OP_DELETE_BY_REFID) {
          if (!(index >= 0 && index < REF_MAX)) return false;
          continue;
        }
        if (!(index >= 0 && index <= INDEX_MAX)) return false;
        if (kind === KIND_MAP && (head & OP_ADD) === OP_ADD && !this.vString()) return false;
        if (head !== OP_DELETE && !this.vValue(head, type, true, h, index)) return false;
      }
    }
    return this.vp === end;
  }

  // ---------------------------------------------------------------- state body

  /**
   * Walk one state body in either direction. Encode: this.p .. this.end. Decode: writes from this.p.
   * @complexity O(tokens in the frame) @alloc none in the steady state
   */
  private walkBody(): void {
    const rc = this.rc;
    const enc = ENCODE && this.enc;
    const s = this.schema as Schema;
    let cur = ROOT;
    let isStruct = true;
    let g = this.hCg[ROOT];
    let nf = s.fieldCount[this.hType[ROOT]];
    let prevHead = HEAD_START;
    let prevCode = 0; // per structure: 0 at the start of a visit, else 1 + operation * fields + field
    let pcode = 0; // collections: code of the previous operation in this visit
    let visited = false; // false until the first op of the frame: the first switch is keyed on "frame start"
    for (;;) {
      if (ENCODE) this.stats.tokens++;
      if (!enc) this.room(0);
      const actual = enc ? (this.p < this.end ? this.b[this.p] : HEAD_END) : 0;
      let sym: number;
      if (isStruct) {
        if (MEASURE) rc.role = ROLE.HEAD;
        // Guess the next field marker: what followed this marker last time in this structure, else in any
        // structure of its type. One bit says "as guessed"; only a miss pays for the full 9 bit symbol.
        const gk = g * HEAD_SYMBOLS + prevHead;
        let sb = this.hSucc[cur];
        let pred = sb >= 0 ? this.succ[sb + prevCode] : 0;
        let source = 0;
        if (pred === 0) {
          pred = this.groupSucc[gk];
          source = 1;
        }
        let hit = 0;
        let fbase = 0;
        const sk = g * (HEAD_SYMBOLS + 1) + this.prevStructHead;
        if (pred !== 0) {
          // How sure the guess is depends on what was guessed and where the guess came from. The first field of a
          // visit also depends on what the structure before just changed (a hit, then its meter).
          fbase = prevHead === HEAD_START ? this.ctx(this.headFlagStart, sk, HEAD_FLAGS) : this.ctx(this.headFlag, gk, HEAD_FLAGS);
          hit = rc.bit(fbase + pred * 2 + source, actual + 1 === pred ? 1 : 0);
        }
        if (hit !== 0) sym = pred - 1;
        else {
          // second guess: what followed in any structure of this type in the same situation, when that differs
          const pred2 = prevHead === HEAD_START ? this.groupStartSucc[sk] : this.groupSucc[gk];
          if (TUNING.HeadSecond !== 0 && pred !== 0 && pred2 !== 0 && pred2 !== pred && rc.bit(fbase + HEAD_FLAG_BLOCK + pred2, actual + 1 === pred2 ? 1 : 0) !== 0) sym = pred2 - 1;
          else sym = this.headMissed(gk, pred, actual);
        }
        if (prevHead === HEAD_START) this.groupStartSucc[sk] = sym + 1;
        if (sb < 0) {
          sb = this.succAlloc(OPS_PER_FIELD * nf + 1);
          this.hSucc[cur] = sb;
        }
        this.succ[sb + prevCode] = sym + 1;
        this.groupSucc[gk] = sym + 1;
      } else {
        if (MEASURE) rc.role = ROLE.CHEAD;
        const k = this.hFid[cur] * OP_CODES + pcode;
        const base = this.ctx(this.collCtx, k, COLL_BLOCK);
        const pred = this.collSucc[k];
        let hit = 0;
        if (TUNING.CollFlag !== 0 && pred !== 0) hit = rc.bit(base + opCode(pred - 1), actual + 1 === pred ? 1 : 0);
        if (hit !== 0) sym = pred - 1;
        else {
          sym = tree(rc, base + COLL_TREE_OFF, HEAD_BITS, actual);
          if (sym > HEAD_END) throw new Error(CORRUPT);
        }
        this.collSucc[k] = sym + 1;
        pcode = opCode(sym);
      }
      if (sym === HEAD_END) return;
      if (enc) this.p++;
      else this.b[this.p++] = sym;
      if (sym === SWITCH_TO_STRUCTURE) {
        this.prevStructHead = isStruct ? prevHead + 1 : 0;
        cur = this.switchRef(cur, visited);
        visited = true;
        prevHead = HEAD_START;
        prevCode = 0;
        pcode = 0;
        isStruct = this.hKind[cur] === KIND_STRUCT;
        g = this.hCg[cur];
        if (isStruct) nf = s.fieldCount[this.hType[cur]];
        continue;
      }
      visited = true;
      if (isStruct) {
        this.visitPrev = prevHead + 1; // the field changed just before this one in the same visit (257 = none)
        prevHead = sym;
        const index = sym & FIELD_MASK;
        if (index >= nf) throw new Error(CORRUPT);
        prevCode = 1 + (sym >>> 6) * nf + index;
        const op = sym & OP_MASK;
        if (op !== OP_DELETE) {
          const fi = s.fieldStart[this.hType[cur]] + index;
          if (s.fVal[fi] === VAL_PRIM) this.primitive(s.fPrim[fi], cur, index, this.hFid[cur] + index);
          else this.value(op, fi, false, cur, index, this.hFid[cur] + index);
        }
      } else {
        const kind = this.hKind[cur];
        if (sym === OP_CLEAR || (kind === KIND_ARRAY && sym === OP_REVERSE)) continue;
        if (MEASURE) rc.role = ROLE.INDEX;
        const cid = this.hFid[cur];
        const ib = this.ctx(this.idxCtx, cid, IDX_BLOCK) + (sym >>> 6) * INT_BLOCK;
        if (kind === KIND_ARRAY && sym === OP_DELETE_BY_REFID) {
          this.intDiff(ib, this.maxRef);
          continue;
        }
        const index = this.intDiff(ib, this.hNextIdx[cur]);
        if (index < 0 || index > INDEX_MAX) throw new Error(CORRUPT);
        this.hNextIdx[cur] = index + 1;
        this.visitPrev = 0;
        if (kind === KIND_MAP && (sym & OP_ADD) === OP_ADD) this.stringToken(this.strField(this.keyField, cid), 0, ROLE.KEY_SYM, -1);
        this.value(sym, this.hType[cur], true, cur, index, cid + CID_SPACE);
      }
    }
  }

  /**
   * A field marker that was not the guess. A wrong guess still says something about what comes instead, so the
   * contexts are keyed by it. Most misses are "the visit ended early" or "the visit went on": those are settled by
   * the first question; only a real surprise pays for the operation and the field.
   */
  private headMissed(gk: number, pred: number, actual: number): number {
    const rc = this.rc;
    if (TUNING.HeadChain === 0) {
      const sym = tree2(rc, this.sparse(this.headMiss, gk, pred, HEAD_TREE), this.ctx(this.headTree, gk, HEAD_TREE), HEAD_BITS, actual);
      if (sym > HEAD_END) throw new Error(CORRUPT);
      return sym;
    }
    const hi = this.sparse(this.headMiss, gk, pred, HM_BLOCK);
    const lo = this.ctx(this.headTree, gk, HM_BLOCK);
    if (pred !== SWITCH_TO_STRUCTURE + 1 && rc.bit2(hi + HM_SWITCH, lo + HM_SWITCH, actual === SWITCH_TO_STRUCTURE ? 1 : 0, BACKOFF_MIN_COUNT) !== 0) return SWITCH_TO_STRUCTURE;
    if (pred !== HEAD_END + 1 && rc.bit2(hi + HM_END, lo + HM_END, actual === HEAD_END ? 1 : 0, BACKOFF_MIN_COUNT) !== 0) return HEAD_END;
    const op = tree2(rc, hi + HM_OP, lo + HM_OP, HM_OP_BITS, (actual >>> 6) & 3);
    return (op << 6) | tree2(rc, hi + HM_FIELD, lo + HM_FIELD, HM_FIELD_BITS, actual & FIELD_MASK);
  }

  /** The switch symbol when it is not the pair: a short chain of yes/no questions, most likely answer first. */
  private switchClass(hi: number, lo: number, sym: number): number {
    const rc = this.rc;
    // the plain 6 bit symbol, for measurement; it is also the only form that can say "pair" without the pair bit
    if (TUNING.SwitchChain === 0 || TUNING.SwitchPairFlag === 0) return tree2(rc, hi + SWC_FWDK, lo + SWC_FWDK, SW_BITS, sym);
    if (rc.bit2(hi + SWC_TREE, lo + SWC_TREE, sym === SW_TREE ? 1 : 0, BACKOFF_MIN_COUNT) !== 0) return SW_TREE;
    if (rc.bit2(hi + SWC_RECENT, lo + SWC_RECENT, sym >= SW_RECENT && sym < SW_FWD ? 1 : 0, BACKOFF_MIN_COUNT) !== 0) {
      const r = tree2(rc, hi + SWC_RANK, lo + SWC_RANK, SWC_RANK_BITS, sym - SW_RECENT);
      if (r >= SW_RECENT_MAX) throw new Error(CORRUPT);
      return SW_RECENT + r;
    }
    if (rc.bit2(hi + SWC_FWD, lo + SWC_FWD, sym >= SW_FWD && sym < SW_BACK ? 1 : 0, BACKOFF_MIN_COUNT) !== 0) {
      if (rc.bit2(hi + SWC_FWD0, lo + SWC_FWD0, sym === SW_FWD ? 1 : 0, BACKOFF_MIN_COUNT) !== 0) return SW_FWD;
      const k = tree2(rc, hi + SWC_FWDK, lo + SWC_FWDK, SW_BITS, sym - SW_FWD - 1);
      if (k >= SW_FORWARD - 1) throw new Error(CORRUPT);
      return SW_FWD + 1 + k;
    }
    if (rc.bit2(hi + SWC_BACK, lo + SWC_BACK, sym >= SW_BACK && sym < SW_PENDING ? 1 : 0, BACKOFF_MIN_COUNT) !== 0) {
      const k = tree2(rc, hi + SWC_BACKK, lo + SWC_BACKK, SWC_BACKK_BITS, sym - SW_BACK);
      if (k >= SW_BACKWARD) throw new Error(CORRUPT);
      return SW_BACK + k;
    }
    return SW_PENDING;
  }

  /** Remove a structure from the visiting-order list. */
  private unlink(n: number): void {
    if (this.hInList[n] === 0) return;
    const lp = this.hLp[n];
    const ln = this.hLn[n];
    if (lp >= 0) this.hLn[lp] = ln;
    if (ln >= 0) this.hLp[ln] = lp;
    this.hLn[n] = -1;
    this.hLp[n] = -1;
    this.hInList[n] = 0;
    this.hSkips[n] = 0;
  }

  /** Insert structure n right after a in the visiting-order list. */
  private linkAfter(a: number, n: number): void {
    const an = this.hLn[a];
    this.hLp[n] = a;
    this.hLn[n] = an;
    if (an >= 0) this.hLp[an] = n;
    this.hLn[a] = n;
    this.hInList[n] = 1;
  }

  private recentIndex(from: number, target: number): number {
    const base = from * SW_RECENT_MAX;
    const n = this.hRecentN[from];
    for (let i = 0; i < n; i++) if (this.hRecent[base + i] === target) return i;
    return -1;
  }

  /**
   * The refId after a 0xFF: which structure the patch visits next. Tried in this order, cheapest first:
   *
   *   pair      what followed this same pair of structures last time. A hit in a fight touches the victim, the
   *             attacker, the victim's damage meter and the attacker's, in that order, every time that attacker
   *             swings: after the first two the rest follow. One bit when it is right.
   *   recent    one of the last SW_RECENT_MAX structures that followed this one (a unit's current attackers)
   *   forward   found a few entries ahead in the list of all structures in visiting order (the carousel: every
   *             item, every frame, same order)
   *   backward  found a few entries behind in that list
   *   pending   the oldest structure announced but not yet visited (a new unit's parts arrive in order)
   *   tree      a walk through the schema tree from here (treeWalk)
   *   id        the refId itself, as a difference from the current one
   *
   * Analogy: finishing someone's sentence. Hear "salt and" and you say "pepper". Where it breaks: the first word
   * of each sentence (which unit acts next) has nothing before it to go on, and that is where the bits go.
   *
   * @complexity O(SW_FORWARD) worst case for the list scan, O(1) expected for the pair and recent lookups
   * @alloc none
   */
  private switchRef(cur: number, visited: boolean): number {
    const rc = this.rc;
    const enc = ENCODE && this.enc;
    if (MEASURE) rc.role = ROLE.SWITCH;
    const from = visited ? cur : START;
    const prev2 = visited ? this.swPrev : START;
    while (this.pendingHead < this.pendingLen && this.pendFlag[this.pending[this.pendingHead]] === 0) this.pendingHead++;
    const pend = this.pendingHead < this.pendingLen ? this.pending[this.pendingHead] : -1;
    const pairHit = this.swPairs.get(prev2, from);
    let id = -1;
    let sym = SW_TREE;
    let target = -1;
    if (enc) {
      id = this.num();
      target = this.handleOf[id];
      if (target === pairHit) sym = SW_PAIR;
      else {
        const r = this.recentIndex(from, target);
        if (r >= 0) sym = SW_RECENT + r;
        else {
          let k = 0;
          let n = this.hLn[from];
          while (n >= 0 && n !== target && k < SW_FORWARD - 1) {
            n = this.hLn[n];
            k++;
          }
          if (n === target) sym = SW_FWD + k;
          else {
            k = 0;
            n = this.hLp[from];
            while (n >= 0 && n !== target && k < SW_BACKWARD - 1) {
              n = this.hLp[n];
              k++;
            }
            if (n === target) sym = SW_BACK + k;
            else if (id === pend) sym = SW_PENDING;
          }
        }
      }
    }
    const g = visited ? this.hCg[cur] : SW_START_GROUP;
    const blk = this.ctx(this.swBlock, g, SW_BLOCK);
    const last = this.hSwLast[from];
    const hasPair = pairHit >= 0 ? 1 : 0;
    if (hasPair !== 0 && TUNING.SwitchPairFlag !== 0 && rc.bit(blk + SW_FLAG_OFF + last, sym === SW_PAIR ? 1 : 0) !== 0) sym = SW_PAIR;
    else sym = this.switchClass(blk + SW_HI_OFF + (last * 2 + hasPair) * SW_CLASS_BLOCK, blk + SW_LO_OFF, sym);
    let cls: number;
    if (sym === SW_PAIR) {
      if (ENCODE) this.stats.switches[0]++;
      target = pairHit;
      cls = 1;
    } else if (sym < SW_FWD) {
      if (ENCODE) this.stats.switches[1]++;
      const r = sym - SW_RECENT;
      target = r < this.hRecentN[from] ? this.hRecent[from * SW_RECENT_MAX + r] : -1;
      cls = 2;
    } else if (sym < SW_BACK) {
      if (ENCODE) this.stats.switches[2]++;
      let n = this.hLn[from];
      for (let k = SW_FWD; k < sym && n >= 0; k++) {
        // a structure passed over again and again has gone quiet (a finished fight): drop it from the list
        const skipped = n;
        n = this.hLn[n];
        if (++this.hSkips[skipped] > SW_AGE_LIMIT) this.unlink(skipped);
      }
      target = n;
      cls = sym === SW_FWD ? 3 : 4;
    } else if (sym < SW_PENDING) {
      if (ENCODE) this.stats.switches[3]++;
      let n = this.hLp[from];
      for (let k = SW_BACK; k < sym && n >= 0; k++) n = this.hLp[n];
      target = n;
      cls = 5;
    } else if (sym === SW_PENDING) {
      if (ENCODE) this.stats.switches[4]++;
      target = pend >= 0 ? this.handleOf[pend] : -1;
      cls = 6;
    } else {
      target = this.treeWalk(cur, target, blk, g);
      cls = 7;
      if (target < 0) {
        if (ENCODE) this.stats.switches[6]++;
        const z = gamma1(rc, blk + SW_ID_OFF, GAMMA_BITS_NARROW, enc ? zigzag(id - this.hRef[cur]) : 0);
        if (!enc) id = this.hRef[cur] + unzigzag(z);
        target = id >= 0 && id < this.refCap ? this.handleOf[id] : -1;
      } else if (ENCODE) this.stats.switches[5]++;
    }
    if (target <= START) throw new Error(CORRUPT);
    // unless it was found just ahead in the visiting order, the target now follows `from` there
    if (!(sym >= SW_FWD && sym < SW_BACK) && this.hLn[from] !== target) {
      this.unlink(target);
      this.linkAfter(from, target);
    }
    this.hSkips[target] = 0;
    // remember: after (prev2, from) came target (in the slot the get above found); and target is the most recent
    // follower of from
    this.swPairs.setLast(prev2, from, target);
    const at = this.recentIndex(from, target);
    if (at !== 0) {
      const base = from * SW_RECENT_MAX;
      let n = this.hRecentN[from];
      const last2 = at > 0 ? at : n < SW_RECENT_MAX ? n++ : SW_RECENT_MAX - 1;
      for (let i = last2; i > 0; i--) this.hRecent[base + i] = this.hRecent[base + i - 1];
      this.hRecent[base] = target;
      this.hRecentN[from] = n;
    }
    const tp = this.hParent[target];
    if (TUNING.TreeOrdinal !== 0) {
      // a collection remembers which of its structs was used last: the next tree walk counts from there
      if (tp >= 0 && this.hKind[tp] !== KIND_STRUCT) this.hLastKid[tp] = this.hOrd[target];
    } else if (tp >= 0 && this.hKind[tp] !== KIND_STRUCT) {
      // a visited item moves to the front of its collection's recency order
      const ob = this.hList[tp];
      if (this.hOrderLen[tp] > 0 && this.ia[ob] !== target) {
        const pos = this.orderIndex(tp, target);
        if (pos > 0) {
          for (let i = pos; i > 0; i--) this.ia[ob + i] = this.ia[ob + i - 1];
          this.ia[ob] = target;
        }
      }
    }
    if (!enc) this.writeInt(this.hRef[target]);
    this.hSwLast[from] = cls;
    this.swPrev = from;
    this.pendFlag[this.hRef[target]] = 0;
    return target;
  }

  /**
   * Address the next structure by its place in the schema tree relative to the current one: go up `u` levels, then
   * down child by child. A fight patch jumps between a unit, its status, its damage meter and its target, all a
   * few steps apart in the tree, so the walk is far shorter than the id. Children of a struct are picked by field
   * index; items of a collection by how recently they were visited.
   *
   * Encoding: `target` is the structure to reach; returns it, or -1 when no walk within TREE_FALLBACK levels
   * exists (the caller then codes the id). Decoding: `target` is ignored; returns the structure or -1 the same way.
   * @complexity O(depth x siblings): depth is at most 6 in PAC's schema, a collection holds up to about 20 structs
   * @alloc none
   */
  private treeWalk(cur: number, target: number, blk: number, g: number): number {
    const rc = this.rc;
    const enc = ENCODE && this.enc;
    const chain = this.chain;
    let up = TREE_FALLBACK;
    let left = 0;
    if (enc && target >= 0) {
      // the target's chain of ancestors, then the nearest ancestor of `cur` (or cur itself) on that chain
      let len = 0;
      for (let n = target; n >= 0 && len <= TREE_MAX_DEPTH; n = this.hParent[n]) chain[len++] = n;
      let a = cur;
      for (let u = 0; u < TREE_FALLBACK && a >= 0; u++, a = this.hParent[a]) {
        let at = -1;
        for (let i = 0; i < len; i++) {
          if (chain[i] === a) {
            at = i;
            break;
          }
        }
        if (at < 0) continue;
        // every step down must be findable from its parent the way the decoder will look it up
        let ok = at > 0 || u > 0;
        for (let i = at - 1; i >= 0 && ok; i--) {
          const par = chain[i + 1];
          const c = chain[i];
          if (this.hKind[par] === KIND_STRUCT) ok = this.hList[par] >= 0 && this.ia[this.hList[par] + this.hPidx[c]] === c + 1;
          else ok = this.hInOrder[c] !== 0;
        }
        if (ok) {
          up = u;
          left = at;
        }
        break;
      }
    }
    const curLast = this.hSwLast[cur];
    const upGuess = this.swUpLast[g * SW_CLASSES + curLast];
    if (TUNING.TreeFlag !== 0 && upGuess !== 0 && rc.bit(blk + SW_UPFLAG_OFF + curLast, up + 1 === upGuess ? 1 : 0) !== 0) up = upGuess - 1;
    else up = tree(rc, blk + SW_UP_OFF + curLast * 8, TREE_UP_BITS, up);
    this.swUpLast[g * SW_CLASSES + curLast] = up + 1;
    if (up === TREE_FALLBACK) return -1;
    let n = cur;
    for (let u = 0; u < up; u++) {
      n = this.hParent[n];
      if (n < 0) throw new Error(CORRUPT);
    }
    for (let step = 0; ; step++) {
      const nStruct = this.hKind[n] === KIND_STRUCT;
      const tb = this.ctx(this.treeBlock, this.hCg[n], TREE_STOPS);
      // "is this the one?" is not asked of `cur` itself: a switch never lands where it started
      if (step > 0 || up > 0) {
        if (rc.bit(tb + (step < TREE_STOPS ? step : TREE_STOPS - 1), left === 0 && enc ? 1 : 0) !== 0) return n;
      }
      const s3 = step < TREE_STEPS ? step : TREE_STEPS - 1;
      const want = enc ? chain[--left] : -1;
      // the step down: a struct's child by field index, a collection's by how recently it was visited; one bit
      // when it is the step taken last time from a structure of this kind at this depth
      const rows = this.twRows;
      const e = rows.entry(this.hCg[n], s3 * 8 + up);
      let tc = rows.ctx[e];
      if (tc === 0) {
        tc = rc.alloc(nStruct ? 1 << TREE_KID_BITS : INT_BLOCK);
        rows.ctx[e] = tc;
      }
      const guess = rows.aux[e];
      const ordinal = !nStruct && TUNING.TreeOrdinal !== 0;
      let step1 = 0;
      if (enc) step1 = nStruct ? this.hPidx[want] : ordinal ? zigzag(this.hOrd[want] - this.hLastKid[n]) : this.orderIndex(n, want);
      if (TUNING.TreeFlag !== 0 && guess !== 0 && rc.bit(tc, step1 + 1 === guess ? 1 : 0) !== 0) step1 = guess - 1;
      else step1 = nStruct ? tree(rc, tc, TREE_KID_BITS, step1) : gamma1(rc, tc + 1, GAMMA_BITS_NARROW, step1);
      rows.aux[e] = step1 + 1;
      if (nStruct) {
        if (enc) n = want;
        else {
          const kb = this.hList[n];
          n = kb >= 0 && step1 < (this.schema as Schema).fieldCount[this.hType[n]] ? this.ia[kb + step1] - 1 : -1;
        }
      } else if (ordinal) {
        const ord = this.hLastKid[n] + unzigzag(step1);
        this.hLastKid[n] = ord;
        n = ord >= 0 && ord < this.hOrderLen[n] ? this.ia[this.hList[n] + ord] : -1;
      } else if (enc) n = want;
      else n = step1 < this.hOrderLen[n] ? this.ia[this.hList[n] + step1] : -1;
      if (n < 0) throw new Error(CORRUPT);
    }
  }

  /**
   * A freshly announced refId. The server numbers structures as it builds them, so a unit's parts sit at fixed
   * offsets after the unit, and the units of one team sit a fixed stride apart. The id is predicted as "the id of
   * the announcing structure (or of the collection's previous item) plus the offset seen last time for this field".
   */
  private newRef(fid: number, parent: number): number {
    if (MEASURE) this.rc.role = ROLE.NEWREF;
    const isItem = this.hKind[parent] !== KIND_STRUCT;
    const first = isItem && this.hLastItem[parent] < 0;
    const base = isItem && !first ? this.hLastItem[parent] : this.hRef[parent];
    const key = fid * 2 + (first ? 1 : 0);
    const id = this.intDiff(this.ctx(this.newRefCtx, fid, INT_BLOCK), base + this.refOff[key] + 1);
    if (id < 0 || id >= REF_MAX) throw new Error(CORRUPT);
    this.refOff[key] = id - base - 1;
    if (isItem) this.hLastItem[parent] = id;
    if (id > this.maxRef) this.maxRef = id;
    this.ensureRef(id);
    return id;
  }

  /** The value of one schema field (item false) or collection item (item true). `fi` is the schema field. */
  private value(op: number, fi: number, item: boolean, ref: number, index: number, fid: number): void {
    if (op === OP_DELETE) return;
    const s = this.schema as Schema;
    const val = item ? s.fChildVal[fi] : s.fVal[fi];
    if (val === VAL_PRIM) {
      this.primitive(s.fPrim[fi], ref, index, fid);
      return;
    }
    const rc = this.rc;
    const enc = ENCODE && this.enc;
    const id = this.newRef(fid, ref);
    if (val === VAL_REF) {
      let ti = s.fType[fi];
      if ((op & OP_ADD) === OP_ADD) {
        if (MEASURE) rc.role = ROLE.TYPEID;
        const tc = this.ctx(this.typeCtx, fid, TYPE_BLOCK);
        if (rc.bit(tc, enc && this.p < this.end && this.b[this.p] === TYPE_ID ? 1 : 0) !== 0) {
          let typeId = 0;
          if (enc) {
            this.p++;
            typeId = this.num();
          }
          const hi = tree(rc, tc, BYTE_BITS, typeId >>> 8);
          typeId = hi * BYTE_VALUES + tree(rc, this.sparse(this.typeLo, fid, hi, BYTE_VALUES), BYTE_BITS, typeId & 0xff);
          if (!enc) {
            this.b[this.p++] = TYPE_ID;
            this.writeInt(typeId);
          }
          ti = typeId < s.indexOfId.length ? s.indexOfId[typeId] : -1;
        }
      }
      if (ti < 0) throw new Error(CORRUPT);
      let child = this.handleOf[id];
      if (child < 0) {
        child = this.makeStruct(id, ti);
        this.pendingPush(id);
      }
      this.adopt(ref, index, child);
      return;
    }
    const kind = s.fKind[fi];
    const old = this.handleOf[id];
    if (old >= 0 && this.hKind[old] === kind) {
      // the same collection announced again: its item type follows the announcing field, as the validator assumes
      if (this.hType[old] !== fi) {
        // items of another type: forget the slot memory, it holds values of the old type
        this.hSlotCap[old] = 0;
        this.hType[old] = fi;
      }
      this.hFid[old] = fid;
      this.hCg[old] = GROUP_MAX + fid;
      this.adopt(ref, index, old);
    } else {
      const coll = this.makeColl(id, kind, fi, fid);
      this.pendingPush(id);
      this.adopt(ref, index, coll);
    }
  }

  /**
   * The value a look-alike structure started with in this field, or NaN. Callers ask only for the first write of
   * a slot (see noteString for how a structure gets its look-alike).
   */
  private tplValue(ref: number, index: number): number {
    const t = this.hTpl[ref];
    if (t < 0 || index >= (this.schema as Schema).fieldCount[this.hType[t]]) return NaN;
    return this.sinit[this.hSlot[t] + index];
  }

  /** tplValue when it is a small non-negative integer, else -1. */
  private tplInt(ref: number, index: number): number {
    const tv = this.tplValue(ref, index);
    return tv >= 0 && tv <= TPL_INT_MAX && tv === Math.floor(tv) ? tv : -1;
  }

  /**
   * A string field of a structure was just coded. Structures that share a telling string are look-alikes: every
   * "0025" unit in a fight starts with the stats of the last "0025" unit. The most specific shared string (the one
   * fewest structures have carried) picks the template; a string no earlier structure had (a fresh id) picks none.
   */
  private noteString(ref: number, slot: number, fid: number, strIndex: number): void {
    this.sinit[slot] = strIndex;
    let la = this.lookalikes.get(fid, strIndex);
    if (la !== ABSENT) {
      if (this.laCount[la] < this.hTplCount[ref] && this.laRef[la] !== ref) {
        this.hTpl[ref] = this.laRef[la];
        this.hTplCount[ref] = this.laCount[la];
      }
      this.laCount[la]++;
      this.laRef[la] = ref;
      return;
    }
    la = this.laN++;
    if (la >= this.laRef.length) {
      this.laRef = growI32(this.laRef, la * 2);
      this.laCount = growI32(this.laCount, la * 2);
    }
    this.laRef[la] = ref;
    this.laCount[la] = 1;
    this.lookalikes.swap(fid, strIndex, la);
  }

  /** Game-aware: tie each symbol to the portal it orbits, by the portal's id string (the one just coded). */
  private linkPortal(ref: number, index: number): void {
    const ti = this.hType[ref];
    const id = this.lastStr;
    if (this.tCar[ti] !== 0) {
      if (index !== this.tCarId[ti]) return;
      if (id >= this.portalOf.length) {
        let cap = this.portalOf.length * 2;
        while (cap <= id) cap *= 2;
        this.portalOf = growI32(this.portalOf, cap);
      }
      this.portalOf[id] = ref + 1;
    } else if (ti === this.syType && index === this.syPortal && this.hPortal[ref] < 0) {
      const portal = id < this.portalOf.length ? this.portalOf[id] - 1 : -1;
      if (portal >= 0) {
        this.hPortal[ref] = portal;
        this.hSymIndex[ref] = this.hSymCount[portal]++;
      }
    }
  }

  /** `n` bytes of a fixed-width value with no better model: each in the context of its field and position. */
  private fixedBytes(fid: number, n: number): void {
    const rc = this.rc;
    if (MEASURE) rc.role = ROLE.OTHER;
    const base = this.ctx(this.otherCtx, fid, OTHER_BLOCK);
    if (ENCODE && this.enc) {
      for (let i = 0; i < n; i++) tree(rc, base + i * BYTE_VALUES, BYTE_BITS, this.b[this.p++]);
    } else {
      for (let i = 0; i < n; i++) this.b[this.p++] = tree(rc, base + i * BYTE_VALUES, BYTE_BITS, 0);
    }
  }

  /** One primitive value of a schema field or collection item. */
  private primitive(prim: number, ref: number, index: number, fid: number): void {
    const rc = this.rc;
    const enc = ENCODE && this.enc;
    const isStruct = this.hKind[ref] === KIND_STRUCT;
    const slot = isStruct ? this.hSlot[ref] + index : this.itemSlot(ref, index);
    const a = this.saux[slot];
    const fresh = isStruct && (a & AUX_WRITTEN) === 0; // the first write of a structure's slot
    switch (prim) {
      case PRIM_STRING: {
        const tv = fresh ? this.tplInt(ref, index) : -1;
        this.stringToken(this.strField(this.strFieldOf, fid), a & AUX_MASK, ROLE.STR_SYM, tv);
        const si = this.strings.codedIndex;
        this.saux[slot] = (si + 1) | AUX_WRITTEN;
        if (isStruct) {
          if (fresh) this.noteString(ref, slot, fid, si);
          if (this.formulas) this.linkPortal(ref, index);
        }
        return;
      }
      case PRIM_BOOLEAN:
      case PRIM_UINT8:
      case PRIM_INT8: {
        // the change from the slot's last value, in the context of the previous change and of the field written
        // just before in the same visit
        if (MEASURE) rc.role = ROLE.BYTE;
        const tv = fresh ? this.tplInt(ref, index) : -1;
        const prev = tv >= 0 ? tv : this.sv[slot];
        const last = tv >= 0 ? BYTE_TEMPLATE : a & AUX_MASK; // previous change + 1, 0 = no history
        const rows = this.byteRows;
        const e = rows.entry(fid, last);
        let lo = rows.ctx[e];
        if (lo === 0) {
          lo = rc.alloc(BYTE_BLOCK);
          rows.ctx[e] = lo;
        }
        const hi = TUNING.ByteVisit !== 0 ? this.sparse(this.byteHi, e, this.visitPrev, BYTE_BLOCK) : lo;
        const guess = rows.aux[e]; // the change that followed `last` here last time, plus one (used by ByteFlag)
        let d = 0;
        let v = 0;
        if (enc) {
          v = this.b[this.p++];
          d = (v - prev) & 0xff;
        }
        if (TUNING.ByteFlag !== 0 && guess !== 0 && rc.bit2(hi, lo, d + 1 === guess ? 1 : 0, BACKOFF_MIN_COUNT) !== 0) d = guess - 1;
        else d = tree2(rc, hi, lo, BYTE_BITS, d);
        if (!enc) {
          v = (prev + d) & 0xff;
          this.b[this.p++] = v;
        }
        rows.aux[e] = d + 1;
        this.sv[slot] = v;
        if (fresh) this.sinit[slot] = v;
        this.saux[slot] = (d + 1) | AUX_WRITTEN;
        return;
      }
      case PRIM_UINT16:
      case PRIM_INT16: {
        if (MEASURE) rc.role = ROLE.INT16;
        const tv = fresh ? this.tplInt(ref, index) : -1;
        const prev = tv >= 0 ? tv : this.sv[slot];
        const last = tv >= 0 ? I16_TEMPLATE : a & AUX_MASK; // size class of the previous change + 1
        const rows = this.i16Rows;
        const e = rows.entry(fid, last);
        let lo = rows.ctx[e];
        if (lo === 0) {
          lo = rc.alloc(GAMMA_N);
          rows.ctx[e] = lo;
        }
        const hi = TUNING.Int16Visit !== 0 ? this.sparse(this.i16Hi, e, this.visitPrev, CLASS_N) : lo;
        let z = 0;
        let v = 0;
        if (enc) {
          v = this.b[this.p] | (this.b[this.p + 1] << 8);
          this.p += 2;
          z = zigzag(((v - prev) << 16) >> 16);
        }
        z = gamma2(rc, hi, lo, GAMMA_BITS_NARROW, z);
        if (!enc) {
          if (z > I16_MAX_Z) throw new Error(CORRUPT);
          v = (prev + unzigzag(z)) & 0xffff;
          this.b[this.p++] = v & 0xff;
          this.b[this.p++] = v >>> 8;
        }
        this.sv[slot] = v;
        if (fresh) this.sinit[slot] = v;
        this.saux[slot] = (sizeClass(z) + 1) | AUX_WRITTEN;
        return;
      }
      case PRIM_NUMBER: {
        if (MEASURE) rc.role = ROLE.NUMCLS;
        const lastCls = a & 3; // previous kind + 1
        let cls = 0;
        if (enc) {
          const pre = this.b[this.p];
          cls = pre === 0xca ? NUM_F32 : pre === 0xcb ? NUM_F64 : NUM_INT;
        }
        const cb = this.ctx(this.numClsCtx, fid, NUMCLS_BLOCK) + lastCls * 4;
        if (TUNING.NumClsFlag !== 0 && lastCls !== 0 && rc.bit(cb, cls + 1 === lastCls ? 1 : 0) !== 0) cls = lastCls - 1;
        else cls = tree(rc, cb, 2, cls);
        if (cls === NUM_INT) {
          if (MEASURE) rc.role = ROLE.NUMINT;
          // a look-alike's first value only helps when it was an integer too (a `number` slot can hold either)
          let tv = fresh ? this.tplValue(ref, index) : NaN;
          if (!(tv === Math.floor(tv) && tv >= -NUM_INT_MAX && tv <= NUM_INT_MAX)) tv = NaN;
          const hasT = tv === tv;
          const own = lastCls === NUM_INT + 1 ? this.sv[slot] : 0;
          // a countdown in ms (an avatar's timer) drops by exactly the frame's clock step: once a slot has done
          // that, expect it again
          const coupled = (a >>> 8) & 1;
          const prev = hasT ? tv : coupled !== 0 && this.exactStep > 0 ? own - this.exactStep : own;
          const last = hasT ? NUM_LAST_TEMPLATE : coupled !== 0 ? NUM_LAST_COUPLED : (a >>> 2) & 63;
          const rows = this.numHi;
          const e = rows.entry(fid, last);
          let hi = rows.ctx[e];
          if (hi === 0) {
            hi = rc.alloc(CLASS_W);
            rows.ctx[e] = hi;
          }
          let v = 0;
          let z = 0;
          if (enc) {
            v = this.num();
            z = zigzag(v - prev);
          }
          z = gamma2(rc, hi, this.ctx(this.numLo, fid, GAMMA_W), GAMMA_BITS_WIDE, z);
          if (!enc) {
            v = prev + unzigzag(z);
            if (!(v >= -NUM_INT_MAX && v <= NUM_INT_MAX)) throw new Error(CORRUPT);
            this.writeInt(v);
          }
          const nowCoupled = lastCls === NUM_INT + 1 && this.exactStep > 0 && own - v === this.exactStep ? 1 : 0;
          this.sv[slot] = v;
          if (fresh) this.sinit[slot] = v;
          this.saux[slot] = (cls + 1) | (((sizeClass(z) + 1) & 63) << 2) | (nowCoupled << 8) | AUX_WRITTEN;
        } else if (cls === NUM_F32) {
          if (!enc) this.b[this.p] = 0xca;
          this.p++;
          if (lastCls !== NUM_F32 + 1 && isStruct && this.hFh[ref] >= 0) this.fcnt[this.hFh[ref] + index] = 0; // the slot held an integer: no float track
          this.float32(ref, index, fid, slot);
          this.saux[slot] = (this.saux[slot] & ~3) | (cls + 1);
        } else if (cls === NUM_F64) {
          if (!enc) this.b[this.p] = 0xcb;
          this.p++;
          this.fixedBytes(fid, 8);
          this.saux[slot] = (a & AUX_WRITTEN) | (cls + 1);
        } else throw new Error(CORRUPT);
        return;
      }
      case PRIM_FLOAT32: {
        this.float32(ref, index, fid, slot);
        this.saux[slot] = (this.saux[slot] & ~3) | (NUM_F32 + 1);
        return;
      }
      default:
        this.fixedBytes(fid, PRIM_WIDTH[prim]);
    }
  }

  // ---------------------------------------------------------------- clock and floats

  /**
   * Start of a state or patch frame. The clock hint, measured by the encoder, is one of:
   *   exact  the step of PAC's mini-game clock in whole ms (or the clock itself when it was not known). The
   *          formula predictors use the clock; the curve predictors use the step, bent by AvatarDrag because an
   *          avatar's physics step is not linear in elapsed time.
   *   ratio  no exact clock, so the step is measured from the tracks, relative to the last one, in 1/DL_QUANT
   *          units around the nominal step.
   */
  private beginStateFrame(hasRatio: number, qRatio: number, hasExact: number, qExact: number): void {
    this.frameNo++;
    if (this.frameNo >= this.ft.length) this.ft = growF64(this.ft, this.ft.length * 2);
    this.hasRatio = hasRatio;
    this.hasExact = hasExact;
    if (ENCODE) this.stats.steps[hasRatio + 2 * hasExact]++;
    let step = DL_DEFAULT + (hasRatio !== 0 ? qRatio / DL_QUANT : 0);
    this.exactStep = 0;
    if (hasExact !== 0) {
      const known = this.mgT >= 0;
      const d = known ? qExact : DL_DEFAULT;
      this.mgT = known ? this.mgT + qExact : qExact;
      if (known) this.exactStep = qExact;
      step = d - PAC_MINIGAME.AvatarDrag * d * d;
      this.lastExactFrame = this.frameNo;
    } else if (this.mgT >= 0 && this.floatFrame !== 0) this.mgT = -1; // floats moved without an exact step: clock lost
    this.dl0 = step;
    this.dl = step;
    this.sw = DL_HINT_WEIGHT;
    this.swd = DL_HINT_WEIGHT * step;
  }

  /** End of a state or patch frame: fix this frame's place on the curve clock. */
  private endStateFrame(): void {
    const ft = this.ft;
    const now = ft[this.frameNo - 1] + this.dl;
    ft[this.frameNo] = now;
    // In ratio mode the clock has no natural unit: only ratios of steps matter. After each measured frame the
    // recent past is restretched so this frame's step is exactly DL_DEFAULT, which makes the next frame's hint a
    // plain ratio to this one and stops small biases from compounding into a drifting scale. Curves only use
    // ratios of time differences, so restretching changes no prediction. Not done while exact steps are in the
    // window: those are in real ms and must stay so.
    if (this.hasRatio !== 0 && this.frameNo - this.lastExactFrame > RESCALE_WINDOW) {
      const c = DL_DEFAULT / this.dl;
      if (c > RESCALE_MIN && c < RESCALE_MAX) {
        const first = this.frameNo > RESCALE_WINDOW ? this.frameNo - RESCALE_WINDOW : 0;
        for (let k = this.frameNo - 1; k >= first; k--) ft[k] = now - (now - ft[k]) * c;
      }
    }
  }

  /** Code (or decode) the frame's clock hints, then start the frame. Encode: pass what measureStep found. */
  private codeStep(hasRatio: number, qRatio: number, hasExact: number, qExact: number, floatFrame: number): void {
    const rc = this.rc;
    if (MEASURE) rc.role = ROLE.STEP;
    const mode = tree(rc, this.cStep + this.lastStepMode * STEP_MODES, STEP_BITS, hasRatio + 2 * hasExact + 4 * floatFrame);
    this.lastStepMode = mode;
    hasRatio = mode & 1;
    hasExact = (mode >> 1) & 1;
    this.floatFrame = mode >> 2;
    if (hasRatio !== 0) qRatio = unzigzag(gamma1(rc, this.cStepRatio, GAMMA_BITS_WIDE, ENCODE && this.enc ? zigzag(qRatio) : 0));
    // a step in whole ms, or the absolute clock when it is not known yet
    if (hasExact !== 0) qExact = gamma1(rc, this.cStepExact + (this.mgT >= 0 ? 0 : GAMMA_W), GAMMA_BITS_WIDE, qExact);
    this.beginStateFrame(hasRatio, qRatio, hasExact, qExact);
  }

  /**
   * Predictions at time T from up to four past points (newest first), by order: 0 hold, 1 line, 2 parabola, 3
   * cubic. Fills fPred and fSlope (the change of the prediction per unit of time) and returns how many orders are
   * usable. A track whose last step is much older than its own spacing counts as standing still.
   * @complexity O(1), about 30 float operations @alloc none
   */
  private polyPredict(n: number, t0: number, x0: number, t1: number, x1: number, t2: number, x2: number, t3: number, x3: number, T: number): number {
    const P = this.fPred;
    const S = this.fSlope;
    P[0] = x0;
    S[0] = 0;
    if (n < 2) return 1;
    const gap = t0 - t1;
    const a = T - t0;
    if (!(gap > 0) || !(a > 0) || a > STALE_FACTOR * gap) return 1;
    const d01 = (x0 - x1) / gap;
    P[1] = x0 + d01 * a;
    S[1] = d01;
    if (n < 3 || !(t1 - t2 > 0) || gap > STALE_FACTOR * (t1 - t2)) return 2;
    const bb = T - t1;
    const d12 = (x1 - x2) / (t1 - t2);
    const dd0 = (d01 - d12) / (t0 - t2);
    P[2] = P[1] + dd0 * a * bb;
    S[2] = d01 + dd0 * (a + bb);
    if (n < 4 || !(t2 - t3 > 0) || t1 - t2 > STALE_FACTOR * (t2 - t3)) return 3;
    const c = T - t2;
    const d23 = (x2 - x3) / (t2 - t3);
    const ddd = (dd0 - (d12 - d23) / (t1 - t3)) / (t0 - t3);
    P[3] = P[2] + ddd * a * bb * c;
    S[3] = S[2] + ddd * (a * bb + a * c + bb * c);
    return 4;
  }

  /** The value-ordered integer of a prediction's float32 bits; a prediction that is not finite counts as 0. */
  private predBits(pred: number): number {
    const p32 = Math.fround(pred);
    return monotone(this.bitsOf(p32 - p32 === 0 ? p32 : 0));
  }

  /**
   * Score each order by how well it would have predicted the slot's newest value from the ones before it, now that
   * the frame times around it are final. Done once per new value, so the encoder's look-ahead and the real pass
   * leave the scores in the same state.
   */
  private scoreSlot(slot: number, fh: number): void {
    const n = this.fcnt[fh];
    if (n < 1 || this.fscored[fh] === this.ff0[fh]) return;
    this.fscored[fh] = this.ff0[fh];
    if (n < 3) return;
    const ft = this.ft;
    const orders = this.polyPredict(
      n - 1, ft[this.ff1[fh]], this.fx1[fh], ft[this.ff2[fh]], this.fx2[fh], ft[this.ff3[fh]], this.fx3[fh],
      ft[this.ff4[fh]], this.fx4[fh], ft[this.ff0[fh]],
    );
    if (orders < 2) return;
    const mv = monotone(this.bitsOf(this.sv[slot]));
    const base = fh * FLOAT_ORDERS;
    for (let k = 0; k < orders; k++) {
      const miss = Math.abs(mv - this.predBits(this.fPred[k]));
      this.fscore[base + k] += ((sizeClass(miss) << SCORE_FP) - this.fscore[base + k]) >> SCORE_SHIFT;
    }
  }

  /**
   * Forward prediction of a tracked slot at time T. Returns the chosen order, or -1 when the slot has no history.
   * fPred / fSlope hold every order's prediction; fOrders how many are usable.
   */
  private predictSlot(slot: number, fh: number, T: number): number {
    const n = this.fcnt[fh];
    if (n === 0) return -1;
    if (this.ff0[fh] === this.frameNo) {
      this.fPred[0] = this.sv[slot];
      this.fSlope[0] = 0;
      this.fOrders = 1;
      return 0;
    }
    if (TUNING.ScoreNow === 0) this.scoreSlot(slot, fh);
    const ft = this.ft;
    const orders = this.polyPredict(
      n, ft[this.ff0[fh]], this.sv[slot], ft[this.ff1[fh]], this.fx1[fh], ft[this.ff2[fh]], this.fx2[fh],
      ft[this.ff3[fh]], this.fx3[fh], T,
    );
    this.fOrders = orders;
    // the order that has predicted this slot best lately; ties go to the higher order
    const base = fh * FLOAT_ORDERS;
    let order = orders - 1;
    for (let k = orders - 2; k >= 0; k--) if (this.fscore[base + k] < this.fscore[base + order]) order = k;
    return order;
  }

  /** How much one coordinate's reading of the time step should count: fast movers with a clean record count most. */
  private slotWeight(v: number, slope: number, fh: number, order: number): number {
    const ulp = Math.abs(v) * FLOAT32_EPSILON + FLOAT_MIN_ULP;
    const noise = ulp * POW2[this.fscore[fh * FLOAT_ORDERS + order] >> SCORE_FP];
    return (slope * slope) / (noise * noise);
  }

  /** The carousel formula for one coordinate at clock T. */
  private carouselPredict(ref: number, isX: boolean, T: number): number {
    const a = T * this.tCar[this.hType[ref]] + (TWO_PI * this.hCarIndex[ref]) / this.carCount;
    return isX ? PAC_MINIGAME.CenterX + detCos(a) * PAC_MINIGAME.RadiusX : PAC_MINIGAME.CenterY + detSin(a) * PAC_MINIGAME.RadiusY;
  }

  /**
   * Encoder only: find the whole-ms mini-game clock that reproduces a carousel structure's x and y exactly.
   * Returns the clock, or -1 when no value in the search range fits (a carried item, a reversed carousel).
   * @complexity O(CarouselStepMax) when the clock is known, O(CarouselTMax) at the start of a carousel
   * @build encode
   */
  private solveCarousel(): number {
    const known = this.mgT >= 0;
    // the full-range search is the costly one: allow it a few times per carousel, then stop asking (a carousel
    // that runs backward or at 1.5x speed, PAC's Spinda encounter, never fits whole forward ms)
    if (!known && this.carFull >= CONFIG.CarouselFullSearches) return -1;
    const from = known ? this.mgT + 1 : 0;
    const to = known ? this.mgT + CONFIG.CarouselStepMax : CONFIG.CarouselTMax;
    const maxTries = known ? CONFIG.CarouselSolveTries : CONFIG.CarouselFullTries;
    let tries = 0;
    for (let i = 0; i + 1 < this.ftN && tries < maxTries; i++) {
      const ref = this.ftH[i];
      const ti = this.hType[ref];
      if (this.tCar[ti] === 0 || this.hCar[ref] !== this.carGroup || this.ftH[i + 1] !== ref) continue;
      if (this.ftI[i] !== this.tCarIx[ti] || this.ftI[i + 1] !== this.tCarIy[ti]) continue;
      const x = this.ftV[i];
      const y = this.ftV[i + 1];
      tries++;
      // Step the angle one ms at a time by rotating (cos, sin): four multiplications instead of two trig calls.
      // The rotated pair drifts by far less than CarouselNear over the whole range, so it only screens; a
      // candidate still has to reproduce both coordinates exactly with the real formula.
      const speed = this.tCar[ti];
      const a0 = from * speed + (TWO_PI * this.hCarIndex[ref]) / this.carCount;
      let c = detCos(a0);
      let s = detSin(a0);
      const cw = detCos(speed);
      const sw = detSin(speed);
      for (let t = from; t <= to; t++) {
        const dx = PAC_MINIGAME.CenterX + c * PAC_MINIGAME.RadiusX - x;
        const dy = PAC_MINIGAME.CenterY + s * PAC_MINIGAME.RadiusY - y;
        if (dx < CONFIG.CarouselNear && dx > -CONFIG.CarouselNear && dy < CONFIG.CarouselNear && dy > -CONFIG.CarouselNear &&
          Math.fround(this.carouselPredict(ref, true, t)) === x && Math.fround(this.carouselPredict(ref, false, t)) === y) return t;
        const c2 = c * cw - s * sw;
        s = s * cw + c * sw;
        c = c2;
      }
    }
    if (!known && tries > 0) this.carFull++;
    return -1;
  }

  /**
   * Encoder only: measure this frame's time step from the tracks. Each moving coordinate gives a reading (the
   * step that would make its prediction exact); a majority vote among the readings is robust against a unit that
   * just changed direction. Returns the hint in 1/DL_QUANT ms around the nominal step (never 0).
   * @complexity O(F^2), F floats in the frame (up to about 80) @alloc none in the steady state
   * @build encode
   */
  private measureRatio(): number {
    const T = this.ft[this.frameNo] + DL_DEFAULT; // frameNo is still the previous frame here
    const saved = this.frameNo;
    this.frameNo = saved + 1; // predictSlot treats a slot written in "this" frame as fresh
    if (this.readings.length < this.ftN * 2) this.readings = new Float64Array(this.ftN * 4);
    const rd = this.readings;
    let count = 0;
    let total = 0;
    for (let i = 0; i < this.ftN; i++) {
      const ref = this.ftH[i];
      const index = this.ftI[i];
      const v = this.ftV[i];
      const fh = this.hFh[ref] + index;
      if (this.predictSlot(this.hSlot[ref] + index, fh, T) < 0) continue;
      // the clock reading comes from the highest usable order: a lower order reads a curved track with a bias
      const order = this.fOrders - 1;
      const slope = this.fSlope[order];
      if (slope === 0) continue;
      const est = DL_DEFAULT + (v - this.fPred[order]) / slope;
      if (!(est > 0 && est < DL_MAX)) continue;
      const w = this.slotWeight(v, slope, fh, order);
      rd[count * 2] = est;
      rd[count * 2 + 1] = w;
      count++;
      total += w;
    }
    this.frameNo = saved;
    if (count === 0 || !(total > 0)) return 0;
    // majority vote: the reading that the most coordinates agree with (within DL_CONSENSUS_TOL), then the weighted
    // mean of that group. One fast unit that just turned cannot outvote a carousel.
    let best = 0;
    let bestCount = 0;
    let bestWeight = 0;
    for (let i = 0; i < count; i++) {
      let c = 0;
      let w = 0;
      for (let j = 0; j < count; j++) {
        if (Math.abs(rd[j * 2] - rd[i * 2]) <= DL_CONSENSUS_TOL) {
          c++;
          w += rd[j * 2 + 1];
        }
      }
      if (c > bestCount || (c === bestCount && w > bestWeight)) {
        best = i;
        bestCount = c;
        bestWeight = w;
      }
    }
    let sum = 0;
    for (let j = 0; j < count; j++) {
      if (Math.abs(rd[j * 2] - rd[best * 2]) <= DL_CONSENSUS_TOL) sum += rd[j * 2] * rd[j * 2 + 1];
    }
    const q = Math.floor((sum / bestWeight - DL_DEFAULT) * DL_QUANT + 0.5);
    if (!(q > -TWO_POW_32 && q < TWO_POW_32)) return 0;
    return q === 0 ? 1 : q; // 0 is reserved for "no moving floats"
  }

  /**
   * Encoder only: pick this frame's clock hint from the floats the validator saw, before any of them is coded.
   * An exact carousel clock wins; else the ratio measured from the tracks; else none. Returns 1 for exact.
   * @build encode
   */
  private measureStep(): number {
    this.stepRatioQ = 0;
    this.stepExactQ = 0;
    if (this.ftN === 0) return 0;
    if (this.carGroup >= 0) {
      const T = this.solveCarousel();
      if (T >= 0) {
        this.stepExactQ = this.mgT >= 0 ? T - this.mgT : T;
        return 1;
      }
    }
    this.stepRatioQ = this.measureRatio();
    return 0;
  }

  /**
   * Game-aware prediction of a mini-game coordinate at the exact clock, or NaN when the slot has no formula.
   * Carousel items and portals: center + cos|sin(T * speed + 2 pi index / N) * radius. Symbols: the same turn of
   * radius SymbolRadius around their portal's position. Avatars: straight at their target at AvatarSpeed.
   */
  private formulaPredict(ref: number, index: number): number {
    const ti = this.hType[ref];
    const T = this.mgT;
    if (this.tCar[ti] !== 0) {
      if (this.hCar[ref] !== this.carGroup) return NaN;
      if (index === this.tCarIx[ti]) return this.carouselPredict(ref, true, T);
      if (index === this.tCarIy[ti]) return this.carouselPredict(ref, false, T);
      return NaN;
    }
    if (ti === this.avType) {
      const isX = index === this.avIx;
      const fhb = this.hFh[ref];
      if ((!isX && index !== this.avIy) || !(this.exactStep > 0) || fhb < 0) return NaN;
      // where the avatar stood before this frame: x may already hold this frame's value when y is coded
      const sb = this.hSlot[ref];
      const x0 = this.ff0[fhb + this.avIx] === this.frameNo ? this.fx1[fhb + this.avIx] : this.sv[sb + this.avIx];
      const y0 = this.ff0[fhb + this.avIy] === this.frameNo ? this.fx1[fhb + this.avIy] : this.sv[sb + this.avIy];
      const dx = this.sv[sb + this.avTx] - x0;
      const dy = this.sv[sb + this.avTy] - y0;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (!(dist > PAC_MINIGAME.AvatarStop)) return isX ? x0 : y0;
      const d = this.exactStep;
      const full = PAC_MINIGAME.AvatarSpeed * (d - PAC_MINIGAME.AvatarDrag * d * d);
      const walk = full < dist ? full : dist;
      return isX ? x0 + (dx / dist) * walk : y0 + (dy / dist) * walk;
    }
    if (ti !== this.syType) return NaN;
    const portal = this.hPortal[ref];
    if (portal < 0) return NaN;
    const isX = index === this.syIx;
    if (!isX && index !== this.syIy) return NaN;
    const pt = this.hType[portal];
    const pIndex = isX ? this.tCarIx[pt] : this.tCarIy[pt];
    // the portal's own position: by formula while it rides the carousel, else its last coded value
    const pfh = this.hFh[portal];
    const onCarousel = this.hCar[portal] === this.carGroup && pfh >= 0 &&
      this.fscore[(pfh + pIndex) * FLOAT_ORDERS + FORMULA_ORDER] < FORMULA_TRUST;
    const base = onCarousel ? this.carouselPredict(portal, isX, T) : this.sv[this.hSlot[portal] + pIndex];
    const a = T * PAC_MINIGAME.SymbolSpeed + (TWO_PI * this.hSymIndex[ref]) / this.hSymCount[portal];
    return base + (isX ? detCos(a) : detSin(a)) * PAC_MINIGAME.SymbolRadius;
  }

  /**
   * Four float32 bytes of a schema slot or collection item.
   *
   * Moving things in PAC's mini-game are sampled once per server tick, and the tick length jitters by a few ms.
   * Every coordinate in one frame moved for the same time, so each frame carries a clock hint measured by the
   * encoder (measureStep). Two kinds of prediction use it:
   *   formula  carousel items, portals and the symbols around them are a closed formula of the mini-game clock in
   *            whole ms. With the exact clock they come out bit for bit, at almost no cost.
   *   curve    everything else (avatars, a carried item) extends the slot's own track: hold, line, parabola or
   *            cubic through its last values, read at the frame's time. Each slot uses the order that has fit it
   *            best lately.
   * Without an exact clock the frame carries a measured step ratio and the curves run on that.
   *
   * Analogy: a row of clocks all started by the same starter pistol. Know when the pistol fired and you can say
   * where every hand is. Where it breaks: an item picked up by a player has left the row; it is then tracked by
   * its own curve.
   *
   * What is coded is the difference between the real and predicted bit patterns (as value-ordered integers): one
   * bit when it is zero, else its size class and bits. The round trip is exact whatever the prediction was.
   * @complexity O(1) @alloc the structure's float history on its first float
   */
  private float32(ref: number, index: number, fid: number, slot: number): void {
    const rc = this.rc;
    const enc = ENCODE && this.enc;
    if (MEASURE) rc.role = ROLE.FLOAT;
    const tracked = this.hKind[ref] === KIND_STRUCT;
    let fh = 0;
    let n = 0;
    let order = -1;
    let state = 0; // 0 no history, 1 history but standing still, 2 moving on a curve, 3 formula
    let pred = 0;
    let topOrder = 0;
    let topPred = 0;
    let topSlope = 0;
    let formula = NaN;
    let curves = 0; // curve orders that made a prediction for this value
    const a = this.saux[slot];
    const fresh = tracked && (a & AUX_WRITTEN) === 0;
    if (tracked) {
      fh = this.floatHistory(ref) + index;
      n = this.fcnt[fh];
      order = this.predictSlot(slot, fh, this.ft[this.frameNo - 1] + this.dl);
      if (order >= 0) curves = this.fOrders;
      if (this.hasExact !== 0) formula = this.formulaPredict(ref, index);
    }
    const sbase = fh * FLOAT_ORDERS;
    if (formula === formula && (order < 0 || this.fscore[sbase + FORMULA_ORDER] <= this.fscore[sbase + order])) {
      pred = formula;
      order = FORMULA_ORDER;
      state = 3;
    } else if (order < 0) {
      const tv = fresh ? this.tplValue(ref, index) : NaN;
      pred = tv === tv ? tv : this.fieldLast[fid];
      order = 0;
    } else {
      pred = this.fPred[order];
      state = this.fSlope[order] !== 0 ? 2 : 1;
      if (this.hasRatio !== 0) {
        topOrder = this.fOrders - 1;
        topPred = this.fPred[topOrder];
        topSlope = this.fSlope[topOrder];
      }
    }
    const mp = this.predBits(pred);
    const last = n > 0 ? (a >>> 2) & 63 : 0;
    const key = state * FLOAT_ORDERS + order;
    const loRows = this.floatLo;
    const le = loRows.entry(fid, key);
    let lo = loRows.ctx[le];
    if (lo === 0) {
      lo = rc.alloc(FLOAT_LO_BLOCK);
      loRows.ctx[le] = lo;
    }
    const hiRows = this.floatHi;
    const he = hiRows.entry(fid, last * FLOAT_KEYS + key);
    let hi = hiRows.ctx[he];
    if (hi === 0) {
      hi = rc.alloc(FLOAT_HI_BLOCK);
      hiRows.ctx[he] = hi;
    }
    let bits = 0;
    let z = 0;
    if (enc) {
      bits = u32At(this.b, this.p);
      this.p += 4;
      z = zigzag(monotone(bits) - mp);
    }
    if (TUNING.FloatZeroFlag !== 0) {
      if (rc.bit2(hi, lo, z === 0 ? 1 : 0, BACKOFF_MIN_COUNT) !== 0) z = 0;
      else z = 1 + gamma2(rc, hi + 1, lo + 1, GAMMA_BITS_WIDE, z - 1);
    } else z = gamma2(rc, hi + 1, lo + 1, GAMMA_BITS_WIDE, z);
    if (!enc) {
      const m = mp + unzigzag(z);
      if (!(m >= -SIGN_BIT && m < SIGN_BIT)) throw new Error(CORRUPT);
      bits = unmonotone(m);
      const b = this.b;
      b[this.p++] = bits & 0xff;
      b[this.p++] = (bits >>> 8) & 0xff;
      b[this.p++] = (bits >>> 16) & 0xff;
      b[this.p++] = bits >>> 24;
    }
    const raw = this.floatOf(bits);
    const finite = raw - raw === 0;
    const v = finite ? raw : 0; // the model only ever holds finite values
    this.fieldLast[fid] = v;
    if (!tracked) return;
    if (fresh) this.sinit[slot] = v;
    if (TUNING.ScoreNow !== 0 && curves >= 2) {
      // how well each curve order predicted this value: the next prediction uses the order that has done best
      const mv = monotone(bits);
      for (let k = 0; k < curves; k++) {
        const miss = Math.abs(mv - this.predBits(this.fPred[k]));
        this.fscore[sbase + k] += ((sizeClass(miss) << SCORE_FP) - this.fscore[sbase + k]) >> SCORE_SHIFT;
      }
    }
    if (formula === formula) {
      // score the formula on every value it could have predicted, chosen or not: a picked-up item stops following
      // it at once, and a dropped one starts again
      const miss = Math.abs(monotone(bits) - this.predBits(formula));
      const k = sbase + FORMULA_ORDER;
      this.fscore[k] += ((sizeClass(miss) << SCORE_FP) - this.fscore[k]) >> FORMULA_SCORE_SHIFT;
    }
    if (topSlope !== 0 && finite) {
      // a coordinate that agrees with the stored step sharpens it; one that does not (a unit that turned) is
      // ignored. The reading comes from the highest usable order, which reads a curved track without bias.
      const est = this.dl + (v - topPred) / topSlope;
      if (Math.abs(est - this.dl0) <= DL_REFINE_TOLERANCE) {
        const w = this.slotWeight(v, topSlope, fh, topOrder);
        if (w > 0 && w < DL_HINT_WEIGHT * DL_HINT_WEIGHT) {
          this.sw += w;
          this.swd += w * est;
          this.dl = this.swd / this.sw;
        }
      }
    }
    if (n > 0 && this.ff0[fh] === this.frameNo) {
      this.sv[slot] = v; // a second write in the same frame replaces the first
    } else {
      this.fx4[fh] = this.fx3[fh];
      this.ff4[fh] = this.ff3[fh];
      this.fx3[fh] = this.fx2[fh];
      this.ff3[fh] = this.ff2[fh];
      this.fx2[fh] = this.fx1[fh];
      this.ff2[fh] = this.ff1[fh];
      this.fx1[fh] = this.sv[slot];
      this.ff1[fh] = this.ff0[fh];
      this.ff0[fh] = this.frameNo;
      this.sv[slot] = v;
      if (n < HISTORY_MAX) this.fcnt[fh] = n + 1;
    }
    this.saux[slot] = (a & 3) | ((sizeClass(z) + 1) << 2) | AUX_WRITTEN;
  }

  // ---------------------------------------------------------------- messages (msgpack, syntactic)

  /**
   * Encode only: where the msgpack element at p ends, or -1 when it is not well formed, nests deeper than
   * MSG_DEPTH_MAX, or holds a string longer than STR_MAX. Changes nothing.
   * @build encode
   */
  private mpSkip(p: number, end: number, depth: number): number {
    const b = this.b;
    if (p >= end || depth > MSG_DEPTH_MAX) return -1;
    const m = b[p++];
    if (m < 0x80 || m >= 0xe0 || m === 0xc0 || m === 0xc2 || m === 0xc3) return p;
    let n: number;
    let items = -1;
    if (m < 0x90) items = 2 * (m & 0x0f);
    else if (m < 0xa0) items = m & 0x0f;
    else if (m < 0xc0) p += m & 0x1f;
    else {
      switch (m) {
        case 0xc4: case 0xd9: if (p + 1 > end) return -1; p += 1 + b[p]; break;
        case 0xc5: case 0xda: if (p + 2 > end) return -1; p += 2 + ((b[p] << 8) | b[p + 1]); break;
        case 0xc6:
          if (p + 4 > end) return -1;
          p += 4 + b[p] * 0x1000000 + ((b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]);
          break;
        case 0xc7: if (p + 1 > end) return -1; p += 2 + b[p]; break;
        case 0xc8: if (p + 2 > end) return -1; p += 3 + ((b[p] << 8) | b[p + 1]); break;
        case 0xc9:
          if (p + 4 > end) return -1;
          p += 5 + b[p] * 0x1000000 + ((b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]);
          break;
        case 0xca: case 0xce: case 0xd2: p += 4; break;
        case 0xcb: case 0xcf: case 0xd3: p += 8; break;
        case 0xcc: case 0xd0: p += 1; break;
        case 0xcd: case 0xd1: p += 2; break;
        case 0xd4: p += 2; break;
        case 0xd5: p += 3; break;
        case 0xd6: p += 5; break;
        case 0xd7: p += 9; break;
        case 0xd8: p += 17; break;
        case 0xdc: if (p + 2 > end) return -1; items = (b[p] << 8) | b[p + 1]; p += 2; break;
        case 0xdd:
          if (p + 4 > end) return -1;
          items = b[p] * 0x1000000 + ((b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]);
          p += 4;
          break;
        case 0xde: if (p + 2 > end) return -1; items = 2 * ((b[p] << 8) | b[p + 1]); p += 2; break;
        case 0xdf:
          if (p + 4 > end) return -1;
          items = 2 * (b[p] * 0x1000000 + ((b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]));
          p += 4;
          break;
        default: return -1; // 0xc1 is never used, 0xdb strings are longer than the walker models
      }
    }
    if (items < 0) return p <= end ? p : -1;
    if (items > end - p) return -1;
    n = items;
    for (let i = 0; i < n; i++) {
      p = this.mpSkip(p, end, depth + 1);
      if (p < 0) return -1;
    }
    return p;
  }

  /** The path node for child `code` of `parent`, created on first use. Node 0 is the root of all message types. */
  private pathChild(parent: number, code: number): number {
    let n = this.pathMap.get(parent, code);
    if (n !== ABSENT) return n;
    n = this.pathN++;
    if (n >= this.pLast.length) {
      const cap = n * 2;
      this.pLast = growI32(this.pLast, cap);
      this.pCtx = growI32(this.pCtx, cap);
      this.pStr = growI32(this.pStr, cap);
      this.pNum = growI32(this.pNum, cap);
      const nl = new Uint16Array(cap * MSG_NUM_POS);
      nl.set(this.pNumLast);
      this.pNumLast = nl;
      this.pEnc = growI32(this.pEnc, cap);
    }
    this.pLast[n] = MARK_NONE;
    this.pCtx[n] = this.rc.alloc(BYTE_VALUES);
    this.pStr[n] = 0;
    this.pNum[n] = 0;
    this.pNumLast.fill(0, n * MSG_NUM_POS, (n + 1) * MSG_NUM_POS);
    this.pEnc[n] = 0;
    this.pathMap.swap(parent, code, n);
    return n;
  }

  /** `n` plain bytes of a msgpack element (lengths, number payloads), each in the context of path and position. */
  private msgBytes(path: number, n: number): number {
    const rc = this.rc;
    const enc = ENCODE && this.enc;
    if (MEASURE) rc.role = ROLE.MSGNUM;
    const nb = this.ctx(this.pNum, path, MSG_NUM_POS * BYTE_VALUES);
    let v = 0;
    let prev = 0;
    for (let i = 0; i < n; i++) {
      const lo = nb + i * BYTE_VALUES;
      const mk = path * MSG_NUM_POS + i;
      const guess = this.pNumLast[mk];
      const actual = enc ? this.b[this.p] : 0;
      const before = prev;
      if (TUNING.MsgNumFlag !== 0 && guess !== 0 && rc.bit(lo, actual + 1 === guess ? 1 : 0) !== 0) prev = guess - 1;
      else prev = tree2(rc, this.sparse(this.msgNumHi, mk, before, BYTE_VALUES), lo, BYTE_BITS, actual);
      this.pNumLast[mk] = prev + 1;
      if (!enc) this.b[this.p] = prev;
      this.p++;
      v = v * BYTE_VALUES + prev;
    }
    return v;
  }

  /** The body of a msgpack string (its marker and length are already coded), through the string model. */
  private msgString(path: number, len: number): void {
    const st = this.strings;
    const sf = this.strField(this.pStr, path);
    if (ENCODE && this.enc) {
      const e = this.p + len;
      st.code(sf, st.pool.find(this.b, this.p, e), this.b, this.p, e, len, -1, ROLE.MSTR_SYM);
      this.p = e;
      return;
    }
    const id = st.code(sf, ABSENT, this.b, 0, 0, len, -1, ROLE.MSTR_SYM);
    const pool = st.pool;
    const at = pool.start[id];
    if (pool.start[id + 1] - at !== len) throw new Error(CORRUPT);
    this.room(len);
    const b = this.b;
    const bytes = pool.chars;
    for (let i = 0; i < len; i++) b[this.p + i] = bytes[at + i];
    this.p += len;
  }

  private msgItems(path: number, n: number, map: boolean, depth: number): void {
    for (let i = 0; i < n; i++) {
      if (map) {
        const slot = i > MSG_MAP_POS_MAX ? MSG_MAP_POS_MAX : i;
        this.msgElem(this.pathChild(path, MSG_MAP_CODE + slot * 2), depth);
        this.msgElem(this.pathChild(path, MSG_MAP_CODE + 1 + slot * 2), depth);
      } else {
        const slot = i > MSG_ARRAY_POS_MAX ? MSG_ARRAY_POS_MAX : i;
        this.msgElem(this.pathChild(path, MSG_ARRAY_CODE + slot), depth);
      }
    }
  }

  /** One msgpack element at the cursor, in either direction. `path` identifies its place in the message. */
  private msgElem(path: number, depth: number): void {
    const rc = this.rc;
    const enc = ENCODE && this.enc;
    if (depth > MSG_DEPTH_MAX) throw new Error(CORRUPT);
    if (!enc) this.room(0);
    if (MEASURE) rc.role = ROLE.MSGMARK;
    const last = this.pLast[path];
    const base = this.pCtx[path];
    const actual = enc ? this.b[this.p] : 0;
    let m: number;
    if (last === MARK_NONE) m = tree(rc, base, BYTE_BITS, actual);
    else if (TUNING.MarkFlag !== 0 && rc.bit(base, actual === last ? 1 : 0) !== 0) m = last;
    else m = tree2(rc, this.sparse(this.markHi, path, last, BYTE_VALUES), base, BYTE_BITS, actual);
    this.pLast[path] = m;
    if (!enc) this.b[this.p] = m;
    this.p++;
    if (ENCODE) this.stats.tokens++;
    if (m < 0x80 || m >= 0xe0 || m === 0xc0 || m === 0xc2 || m === 0xc3) return;
    if (m < 0x90) return this.msgItems(path, m & 0x0f, true, depth + 1);
    if (m < 0xa0) return this.msgItems(path, m & 0x0f, false, depth + 1);
    if (m < 0xc0) return this.msgString(path, m & 0x1f);
    switch (m) {
      case 0xd9: return this.msgString(path, this.msgBytes(path, 1));
      case 0xda: return this.msgString(path, this.msgBytes(path, 2));
      case 0xc4: return this.byteRun(this.msgBytes(path, 1), ROLE.RAW, RAW_BIN);
      case 0xc5: return this.byteRun(this.msgBytes(path, 2), ROLE.RAW, RAW_BIN);
      case 0xc6: return this.byteRun(this.msgBytes(path, 4), ROLE.RAW, RAW_BIN);
      case 0xc7: return this.byteRun(this.msgBytes(path, 1) + 1, ROLE.RAW, RAW_BIN);
      case 0xc8: return this.byteRun(this.msgBytes(path, 2) + 1, ROLE.RAW, RAW_BIN);
      case 0xc9: return this.byteRun(this.msgBytes(path, 4) + 1, ROLE.RAW, RAW_BIN);
      case 0xca: case 0xce: case 0xd2: this.msgBytes(path, 4); return;
      case 0xcb: case 0xcf: case 0xd3: this.msgBytes(path, 8); return;
      case 0xcc: case 0xd0: this.msgBytes(path, 1); return;
      case 0xcd: case 0xd1: this.msgBytes(path, 2); return;
      case 0xd4: return this.byteRun(2, ROLE.RAW, RAW_BIN);
      case 0xd5: return this.byteRun(3, ROLE.RAW, RAW_BIN);
      case 0xd6: return this.byteRun(5, ROLE.RAW, RAW_BIN);
      case 0xd7: return this.byteRun(9, ROLE.RAW, RAW_BIN);
      case 0xd8: return this.byteRun(17, ROLE.RAW, RAW_BIN);
      case 0xdc: return this.msgItems(path, this.msgBytes(path, 2), false, depth + 1);
      case 0xdd: return this.msgItems(path, this.msgBytes(path, 4), false, depth + 1);
      case 0xde: return this.msgItems(path, this.msgBytes(path, 2), true, depth + 1);
      case 0xdf: return this.msgItems(path, this.msgBytes(path, 4), true, depth + 1);
      default: throw new Error(CORRUPT);
    }
  }

  // ---------------------------------------------------------------- container

  private frameInt(which: number, v: number): number {
    return gamma1(this.rc, this.cFrameInt + which * GAMMA_W, GAMMA_BITS_WIDE, v);
  }

  /** The bytes of a state-like frame before its offset: one bit when they repeat the last frame of this kind. */
  private prefix(kind: number, n: number): void {
    if (n === 0) return;
    const rc = this.rc;
    const enc = ENCODE && this.enc;
    if (MEASURE) rc.role = ROLE.HS_PREFIX;
    const keep = n <= PREFIX_KEEP;
    const at = kind * PREFIX_KEEP;
    if (TUNING.PrefixFlag !== 0 && keep && this.prefixLen[kind] === n) {
      let same = 1;
      if (enc) {
        for (let i = 0; i < n; i++) {
          if (this.b[this.p + i] !== this.prefixBytes[at + i]) {
            same = 0;
            break;
          }
        }
      }
      if (rc.bit(this.cFlags + FLAG_PREFIX + kind, same) !== 0) {
        if (!enc) {
          this.room(n);
          for (let i = 0; i < n; i++) this.b[this.p + i] = this.prefixBytes[at + i];
        }
        this.p += n;
        return;
      }
    }
    const start = this.p;
    this.byteRun(n, ROLE.HS_PREFIX, RAW_PREFIX + kind);
    if (keep) {
      for (let i = 0; i < n; i++) this.prefixBytes[at + i] = this.b[start + i];
      this.prefixLen[kind] = n;
    } else this.prefixLen[kind] = -1;
  }

  /** The handshake frame carries the game's type table: read it and start a fresh structure table. */
  private afterHandshake(b: Uint8Array, offset: number, end: number): void {
    let schema: Schema | null = null;
    try {
      schema = parseReflection(b, offset, end);
    } catch {
      schema = null;
    }
    if (schema !== null) this.adoptSchema(schema, true);
    else this.schema = null;
  }

  /**
   * Encode only: true when b[start..end) is the handshake body the starting model carries.
   * @build encode
   */
  private isKnownHandshake(start: number, end: number): boolean {
    const hs = this.knownHandshake;
    if (end - start !== hs.length) return false;
    const b = this.b;
    for (let i = 0; i < hs.length; i++) if (b[start + i] !== hs[i]) return false;
    return true;
  }

  /**
   * Encode only: read the frame at pos into the f* fields. False when it is not a clean, shortest-form frame.
   * @build encode
   */
  private readFrame(pos: number, end: number): boolean {
    const b = this.b;
    const kind = b[pos];
    if (kind > KIND_MESSAGE) return false;
    let p = pos + 1;
    const dt = this.varint(p, end);
    if (dt < 0) return false;
    p = this.vEnd;
    this.fKind = kind;
    this.fDt = dt;
    if (kind === KIND_MESSAGE) {
      if (p >= end) return false;
      const tag = b[p++];
      this.fTypeTag = tag;
      if (tag === TYPE_TAG_NUMBER) {
        const t = this.varint(p, end);
        if (t < 0) return false;
        p = this.vEnd;
        this.fTypeNum = t;
      } else if (tag === TYPE_TAG_STRING) {
        const n = this.varint(p, end);
        if (n < 0 || n > STR_MAX) return false;
        p = this.vEnd;
        if (p + n > end) return false;
        this.fTypeStart = p;
        this.fTypeLen = n;
        p += n;
      } else return false;
      if (p >= end) return false;
      const menc = b[p++];
      this.fEnc = menc;
      let len = 0;
      if (menc === ENC_MSGPACK || menc === ENC_BYTES) {
        len = this.varint(p, end);
        if (len < 0) return false;
        p = this.vEnd;
        if (p + len > end) return false;
      } else if (menc !== ENC_NONE) return false;
      this.fLen = len;
      this.fPayload = p;
      this.fEnd = p + len;
      return true;
    }
    const offset = this.varint(p, end);
    if (offset < 0) return false;
    p = this.vEnd;
    const len = this.varint(p, end);
    if (len < 0) return false;
    p = this.vEnd;
    if (p + len > end) return false;
    this.fOffset = offset;
    this.fLen = len;
    this.fPayload = p;
    this.fEnd = p + len;
    return true;
  }

  /**
   * One frame, encode side.
   * @build encode
   */
  private codeFrame(prevKind: number): void {
    const rc = this.rc;
    const b = this.b;
    const kind = this.fKind;
    const len = this.fLen;
    const payload = this.fPayload;
    this.stats.frames++;
    if (MEASURE) rc.role = ROLE.KIND;
    tree(rc, this.cKind + prevKind * KIND_SLOTS, KIND_BITS, kind);
    if (MEASURE) rc.role = ROLE.DT;
    const dk = kind * KIND_PREVS + prevKind;
    gamma2(rc, this.cDtHi + (dk * DT_BUCKETS + dtBucket(this.prevDt)) * CLASS_W, this.cDtLo + dk * GAMMA_W, GAMMA_BITS_WIDE, this.fDt);
    this.prevDt = this.fDt;
    if (kind === KIND_MESSAGE) {
      if (MEASURE) rc.role = ROLE.MSGTYPE;
      rc.bit(this.cFlags + FLAG_TYPETAG, this.fTypeTag);
      let typeKey: number;
      if (this.fTypeTag === TYPE_TAG_STRING) {
        const s = this.fTypeStart;
        const e = s + this.fTypeLen;
        this.strings.code(this.msgTypes, this.strings.pool.find(b, s, e), b, s, e, 0, -1, ROLE.MSGTYPE);
        typeKey = this.strings.codedIndex;
      } else {
        gamma1(rc, this.cMsgNum, GAMMA_BITS_WIDE, this.fTypeNum);
        typeKey = NUM_TYPE_BASE + (this.fTypeNum < NUM_TYPE_SLOTS ? this.fTypeNum : NUM_TYPE_SLOTS - 1);
      }
      const root = this.pathChild(0, typeKey);
      if (MEASURE) rc.role = ROLE.MSGTYPE;
      tree(rc, this.ctx(this.pEnc, root, 1 << ENC_BITS), ENC_BITS, this.fEnc);
      if (this.fEnc === ENC_NONE) return;
      this.p = payload;
      this.end = payload + len;
      const walk = this.fEnc === ENC_MSGPACK && this.mpSkip(payload, this.end, 0) === this.end ? 1 : 0;
      rc.bit(this.cFlags + FLAG_MSGWALK + this.fEnc, walk);
      if (walk !== 0) {
        this.msgElem(root, 0);
        if (this.p !== this.end) throw new Error(INTERNAL);
      } else {
        this.stats.rawFrames++;
        this.stats.rawBytes += len;
        this.frameInt(FI_MSGLEN, len);
        this.byteRun(len, ROLE.RAW, RAW_FRAME);
      }
      return;
    }
    // state-like: offset, the bytes before it, then the schema body
    if (MEASURE) rc.role = ROLE.FRAME;
    const offset = this.fOffset;
    const same = offset === this.lastOffset[kind] ? 1 : 0;
    rc.bit(this.cFlags + FLAG_OFFSET + kind, same);
    if (same === 0) this.frameInt(FI_OFFSET, offset);
    this.lastOffset[kind] = offset;
    const fits = offset <= len ? 1 : 0;
    rc.bit(this.cFlags + FLAG_FITS, fits);
    this.p = payload;
    if (fits === 0) {
      // an offset past the payload: nothing to parse, keep the payload as bytes
      this.stats.rawFrames++;
      this.stats.rawBytes += len;
      this.frameInt(FI_RAWLEN, len);
      this.byteRun(len, ROLE.RAW, RAW_FRAME);
      return;
    }
    this.prefix(kind, offset);
    const body = payload + offset;
    const payloadEnd = payload + len;
    if (PRIOR && kind === KIND_HANDSHAKE && this.knownHandshake.length > 0) {
      // the type table the starting model carries costs one bit instead of the whole table
      if (MEASURE) rc.role = ROLE.FRAME;
      if (rc.bit(this.cFlags + FLAG_HS_KNOWN, this.isKnownHandshake(body, payloadEnd) ? 1 : 0) !== 0) {
        this.afterHandshake(b, body, payloadEnd);
        return;
      }
    }
    if (kind === KIND_HANDSHAKE) this.adoptSchema(bootSchema(), false);
    const ok = this.schema !== null && this.validate(body, payloadEnd);
    if (MEASURE) rc.role = ROLE.FRAME;
    rc.bit(this.cFlags + FLAG_WALKED, ok ? 1 : 0);
    if (ok) {
      this.p = body;
      this.end = payloadEnd;
      const hasExact = this.measureStep();
      this.codeStep(this.stepRatioQ !== 0 ? 1 : 0, this.stepRatioQ, hasExact, this.stepExactQ, this.ftN > 0 ? 1 : 0);
      this.walkBody();
      if (this.p !== this.end) throw new Error(INTERNAL);
      this.endStateFrame();
    } else {
      this.stats.rawFrames++;
      this.stats.rawBytes += payloadEnd - body;
      this.frameInt(FI_BODYLEN, payloadEnd - body);
      this.p = body;
      this.byteRun(payloadEnd - body, ROLE.RAW, RAW_FRAME);
    }
    if (kind === KIND_HANDSHAKE) this.afterHandshake(b, body, payloadEnd);
  }

  /**
   * Encode a whole .colreplay. Returns the coded body, or null when the file does not start with a CLRP header
   * (the caller then stores it as it is).
   * @complexity O(file) @alloc the coded bytes
   * @build encode
   */
  encode(): Uint8Array | null {
    const rc = this.rc;
    const b = this.b;
    if (!hasHeader(b)) return null;
    const metaLen = u32At(b, MAGIC_BYTES + 1);
    const framesStart = HEADER_FIXED_BYTES + metaLen;
    const tStart = trailerStart(b, framesStart);
    const framesEnd = tStart >= 0 ? tStart : b.length;
    if (MEASURE) rc.role = ROLE.META;
    this.frameInt(FI_META, metaLen);
    this.p = HEADER_FIXED_BYTES;
    this.byteRun(metaLen, ROLE.META, RAW_META);
    let pos = framesStart;
    let prevKind = KIND_END;
    while (pos < framesEnd && this.readFrame(pos, framesEnd)) {
      this.codeFrame(prevKind);
      prevKind = this.fKind;
      pos = this.fEnd;
    }
    if (MEASURE) rc.role = ROLE.KIND;
    tree(rc, this.cKind + prevKind * KIND_SLOTS, KIND_BITS, KIND_END);
    // bytes after the last clean frame (a cut or damaged tail), then the trailer summary
    if (MEASURE) rc.role = ROLE.TAIL;
    this.frameInt(FI_JUNK, framesEnd - pos);
    this.p = pos;
    this.byteRun(framesEnd - pos, ROLE.TAIL, RAW_TAIL);
    if (MEASURE) rc.role = ROLE.TAIL;
    rc.bit(this.cFlags + FLAG_TRAILER, tStart >= 0 ? 1 : 0);
    if (tStart >= 0) {
      const n = b.length - TRAILER_FOOTER_BYTES - tStart;
      this.frameInt(FI_TRAILER, n);
      this.p = tStart;
      this.byteRun(n, ROLE.TAIL, RAW_TRAILER);
    }
    return rc.finish();
  }

  /**
   * Decode back to the original .colreplay. Throws when the packed data is damaged.
   * @complexity O(file) @alloc the output, sized up front from the container header
   */
  decode(): Uint8Array {
    const rc = this.rc;
    if (MEASURE) rc.role = ROLE.META;
    const metaLen = this.frameInt(FI_META, 0);
    this.p = 0;
    this.byteRun(metaLen, ROLE.META, RAW_META);
    for (let i = 0; i < MAGIC_BYTES; i++) this.emitByte(MAGIC[i]);
    this.emitByte(VERSION);
    this.emitU32(metaLen);
    this.emit(this.b, 0, metaLen);
    let prevKind = KIND_END;
    for (;;) {
      if (MEASURE) rc.role = ROLE.KIND;
      const kind = tree(rc, this.cKind + prevKind * KIND_SLOTS, KIND_BITS, 0);
      if (kind === KIND_END) break;
      if (kind > KIND_MESSAGE) throw new Error(CORRUPT);
      if (ENCODE) this.stats.frames++;
      if (MEASURE) rc.role = ROLE.DT;
      const dk = kind * KIND_PREVS + prevKind;
      const dt = gamma2(rc, this.cDtHi + (dk * DT_BUCKETS + dtBucket(this.prevDt)) * CLASS_W, this.cDtLo + dk * GAMMA_W, GAMMA_BITS_WIDE, 0);
      this.prevDt = dt;
      this.emitByte(kind);
      this.emitVarint(dt);
      this.p = 0;
      if (kind === KIND_MESSAGE) {
        if (MEASURE) rc.role = ROLE.MSGTYPE;
        const tag = rc.bit(this.cFlags + FLAG_TYPETAG, 0);
        this.emitByte(tag);
        let typeKey: number;
        if (tag === TYPE_TAG_STRING) {
          const id = this.strings.code(this.msgTypes, ABSENT, this.b, 0, 0, 0, -1, ROLE.MSGTYPE);
          typeKey = this.strings.codedIndex;
          const pool = this.strings.pool;
          this.emitVarint(pool.start[id + 1] - pool.start[id]);
          this.emit(pool.chars, pool.start[id], pool.start[id + 1]);
        } else {
          const t = gamma1(rc, this.cMsgNum, GAMMA_BITS_WIDE, 0);
          this.emitVarint(t);
          typeKey = NUM_TYPE_BASE + (t < NUM_TYPE_SLOTS ? t : NUM_TYPE_SLOTS - 1);
        }
        const root = this.pathChild(0, typeKey);
        if (MEASURE) rc.role = ROLE.MSGTYPE;
        const menc = tree(rc, this.ctx(this.pEnc, root, 1 << ENC_BITS), ENC_BITS, 0);
        if (menc > ENC_NONE) throw new Error(CORRUPT);
        this.emitByte(menc);
        if (menc !== ENC_NONE) {
          if (rc.bit(this.cFlags + FLAG_MSGWALK + menc, 0) !== 0) this.msgElem(root, 0);
          else this.byteRun(this.frameInt(FI_MSGLEN, 0), ROLE.RAW, RAW_FRAME);
          this.emitVarint(this.p);
          this.emit(this.b, 0, this.p);
        }
      } else {
        if (MEASURE) rc.role = ROLE.FRAME;
        const same = rc.bit(this.cFlags + FLAG_OFFSET + kind, 0);
        const offset = same !== 0 ? this.lastOffset[kind] : this.frameInt(FI_OFFSET, 0);
        this.lastOffset[kind] = offset;
        const fits = rc.bit(this.cFlags + FLAG_FITS, 0);
        if (fits === 0) this.byteRun(this.frameInt(FI_RAWLEN, 0), ROLE.RAW, RAW_FRAME);
        else {
          this.prefix(kind, offset);
          if (MEASURE) rc.role = ROLE.FRAME;
          if (PRIOR && kind === KIND_HANDSHAKE && this.knownHandshake.length > 0 && rc.bit(this.cFlags + FLAG_HS_KNOWN, 0) !== 0) {
            const hs = this.knownHandshake;
            this.room(hs.length);
            this.b.set(hs, this.p);
            this.p += hs.length;
          } else {
            if (kind === KIND_HANDSHAKE) this.adoptSchema(bootSchema(), false);
            if (MEASURE) rc.role = ROLE.FRAME;
            if (rc.bit(this.cFlags + FLAG_WALKED, 0) !== 0) {
              if (this.schema === null) throw new Error(CORRUPT);
              this.codeStep(0, 0, 0, 0, 0);
              this.walkBody();
              this.endStateFrame();
            } else this.byteRun(this.frameInt(FI_BODYLEN, 0), ROLE.RAW, RAW_FRAME);
          }
        }
        this.emitVarint(offset);
        this.emitVarint(this.p);
        this.emit(this.b, 0, this.p);
        if (fits !== 0 && kind === KIND_HANDSHAKE) this.afterHandshake(this.b, offset, this.p);
      }
      prevKind = kind;
    }
    if (MEASURE) rc.role = ROLE.TAIL;
    const junk = this.frameInt(FI_JUNK, 0);
    this.p = 0;
    this.byteRun(junk, ROLE.TAIL, RAW_TAIL);
    this.emit(this.b, 0, junk);
    if (MEASURE) rc.role = ROLE.TAIL;
    if (rc.bit(this.cFlags + FLAG_TRAILER, 0) !== 0) {
      const n = this.frameInt(FI_TRAILER, 0);
      this.p = 0;
      this.byteRun(n, ROLE.TAIL, RAW_TRAILER);
      this.emit(this.b, 0, n);
      this.emitU32(n);
      for (let i = 0; i < MAGIC_BYTES; i++) this.emitByte(TRAILER_MAGIC[i]);
    }
    if (this.op !== this.out.length) throw new Error(CORRUPT);
    return this.out;
  }
}
