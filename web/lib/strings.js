/**
 * String model of the replay codec. Strings in a replay are names from a small set (actions, unit names, item
 * names) or identifiers (random UUIDs, player ids) that repeat after their first appearance. Every distinct byte
 * string gets one id from a pool; each string field keeps its own dictionary over those ids.
 *
 * Coding one string in field f (this order is part of the packed format; a port must mirror it):
 *   1. look-alike   when the caller knows what a look-alike structure had here: one bit "same again"
 *   2. small field  (up to SMALL_MAX distinct values) one bit "the value that followed `hint` last time", else the
 *                   dictionary index as a 6 bit symbol (0 = new to the field)
 *      large field  the move-to-front rank plus one as a gamma symbol (0 = new to the field)
 *   3. new to the field: one bit "known to the pool"; if so its recency rank among all strings, else the literal:
 *                   one bit "UUID" then 122 raw bits, or the length and each byte under (field, position,
 *                   previous byte)
 *
 * A canonical version 4 UUID has exactly 122 random bits, so it is stored as 122 raw bits and nothing is learned
 * from it: that is both the smallest and the fastest way to carry it.
 *
 * A starting model (prior.ts) may fill the pool and the field dictionaries before the first string is coded
 * (preloadPool, preloadField). From then on a preloaded string is coded like one the file itself brought in.
 *
 * @interacts range-coder.ts through symbols.ts; intmap.ts (the pool and one sparse context map)
 * @deps      symbols.ts, intmap.ts
 * @complexity O(log n) per string for its recency rank (n distinct values of the field), O(length) for the pool
 * @alloc     per distinct string per field: a few integers. Nothing per coded string.
 */
import { RangeCoder } from './range-coder.js';
import { tree2, gamma, gammaSlots, GAMMA_BITS_NARROW } from './symbols.js';
import { PairMap, StringPool, Recency, ABSENT } from './intmap.js';

/** Longest string the model accepts, in bytes (the walker never offers a longer one). */
const STR_MAX = 65535;
/** A field with more distinct values than this switches from dictionary indexes to move-to-front ranks. */
const SMALL_MAX = 62;
const SMALL_BITS = 6;
/** Hints (the slot's previous index plus one, or a message string's length) are clamped to this. */
export const HINT_MAX = 66;
const HINT_COLS = HINT_MAX + 1;
/** Literal bytes: positions at and beyond this share one context. */
const POS_MAX = 47;
const BYTE_BITS = 8;
const BYTE_SLOTS = 1 << BYTE_BITS;
// canonical lowercase version 4 UUID: 8-4-4-4-12 hex digits, version digit '4', variant digit 8, 9, a or b
const UUID_LEN = 36;
const UUID_VERSION_POS = 14;
const UUID_VARIANT_POS = 19;
const UUID_DASHES = [8, 13, 18, 23];
const UUID_VARIANT_BITS = 2;
const NIBBLE_BITS = 4;
const CHAR_DASH = 0x2d;
const CHAR_4 = 0x34;
const HEX = [0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x61, 0x62, 0x63, 0x64, 0x65, 0x66];
/** First value of the two variant bits' digit ('8'). */
const VARIANT_BASE = 8;

/** Contexts newField() reserves for one field: three single flags, the hint flags, the index tree, three gamma blocks. */
const FIELD_CONTEXTS = 3 + HINT_COLS + (1 << SMALL_BITS) + 3 * gammaSlots(GAMMA_BITS_NARROW);

export const CONFIG = Object.freeze({
  /** First capacity of the per-field tables, in fields. */
  FieldsStart: 256,
  /** First capacity of one field's dictionary. */
  DictStart: 16,
});

/** Role offsets for bit accounting, added to the caller's base role. */
export const ROLE_SYM = 0;
export const ROLE_GLOBAL = 1;
export const ROLE_LITERAL = 2;

function hexValue(c        )         {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  return -1;
}

/** True when b[s..e) is a canonical lowercase version 4 UUID. */
function isUuid(b            , s        , e        )          {
  if (e - s !== UUID_LEN) return false;
  for (let i = 0; i < UUID_LEN; i++) {
    const c = b[s + i];
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      if (c !== CHAR_DASH) return false;
    } else if (hexValue(c) < 0) return false;
  }
  if (b[s + UUID_VERSION_POS] !== CHAR_4) return false;
  const variant = hexValue(b[s + UUID_VARIANT_POS]);
  return variant >= VARIANT_BASE && variant < VARIANT_BASE + (1 << UUID_VARIANT_BITS);
}

/** The string model of one replay: the pool, every field dictionary, and the global recency order. */
export class StringModel {
                   rc            ;
           pool            ;
  /** Number of fields created. */
          fields        ;
  // per field
          count            ; // distinct values
          large            ; // 1 once the field uses move-to-front ranks
          idxOf              ; // pool id -> index + 1, 0 = not in the field
          idOf              ; // index -> pool id
          mtf                    ; // large fields: their values by last use
          next            ; // small fields: per hint, the index + 1 that followed it last time
          ctxTpl            ;
          ctxNext            ; // base of HINT_COLS flag contexts
          ctxSmallLo            ;
          ctxSmallHi            ; // base of a lazily filled table of HINT_COLS blocks, see smallHi
          ctxLarge            ;
          ctxInPool            ;
          ctxPoolRank            ;
          ctxUuid            ;
          ctxLen            ;
          smallHi            ; // (field, hint) -> context base, 0 = not yet allocated
  /** Every pool string by last time it was new to a field. */
                   gmtf         ;
                   litHi         ;
                   litLo        ;
                   scratch            ;
  /** Index (in its field) of the string just coded, for the caller's slot memory. */
  lastIndex        ;
  /** Literal strings coded and their bytes, for the report. */
  literals        ;
  literalBytes        ;

  constructor(rc            ) {
    this.rc = rc;
    this.pool = new StringPool();
    this.fields = 0;
    const n = CONFIG.FieldsStart;
    this.count = new Int32Array(n);
    this.large = new Uint8Array(n);
    this.idxOf = [];
    this.idOf = [];
    this.mtf = [];
    this.next = new Int32Array(n * HINT_COLS);
    this.ctxTpl = new Int32Array(n);
    this.ctxNext = new Int32Array(n);
    this.ctxSmallLo = new Int32Array(n);
    this.ctxSmallHi = new Int32Array(n);
    this.ctxLarge = new Int32Array(n);
    this.ctxInPool = new Int32Array(n);
    this.ctxPoolRank = new Int32Array(n);
    this.ctxUuid = new Int32Array(n);
    this.ctxLen = new Int32Array(n);
    this.smallHi = new Int32Array(n * HINT_COLS);
    this.gmtf = new Recency();
    this.litHi = new PairMap();
    this.litLo = rc.alloc(BYTE_SLOTS * BYTE_SLOTS);
    this.scratch = new Uint8Array(1 << 16);
    this.lastIndex = -1;
    this.literals = 0;
    this.literalBytes = 0;
  }

  /**
   * Create a field dictionary and return its number.
   * @complexity O(1) amortized @alloc the field's contexts and two small tables
   */
  newField()         {
    const f = this.fields++;
    if (f >= this.count.length) this.growFields();
    const rc = this.rc;
    this.idxOf.push(new Int32Array(CONFIG.DictStart));
    this.idOf.push(new Int32Array(CONFIG.DictStart));
    this.mtf.push(null);
    // one run of FIELD_CONTEXTS contexts, in this order
    this.ctxTpl[f] = rc.alloc(1);
    this.ctxNext[f] = rc.alloc(HINT_COLS);
    this.ctxSmallLo[f] = rc.alloc(1 << SMALL_BITS);
    this.ctxLarge[f] = rc.alloc(gammaSlots(GAMMA_BITS_NARROW));
    this.ctxInPool[f] = rc.alloc(1);
    this.ctxPoolRank[f] = rc.alloc(gammaSlots(GAMMA_BITS_NARROW));
    this.ctxUuid[f] = rc.alloc(1);
    this.ctxLen[f] = rc.alloc(gammaSlots(GAMMA_BITS_NARROW));
    return f;
  }

          growFields()       {
    const cap = this.count.length * 2;
    const i32 = (a            , per        )             => {
      const n = new Int32Array(cap * per);
      n.set(a);
      return n;
    };
    this.count = i32(this.count, 1);
    const large = new Uint8Array(cap);
    large.set(this.large);
    this.large = large;
    this.next = i32(this.next, HINT_COLS);
    this.ctxTpl = i32(this.ctxTpl, 1);
    this.ctxNext = i32(this.ctxNext, 1);
    this.ctxSmallLo = i32(this.ctxSmallLo, 1);
    this.ctxSmallHi = i32(this.ctxSmallHi, 1);
    this.ctxLarge = i32(this.ctxLarge, 1);
    this.ctxInPool = i32(this.ctxInPool, 1);
    this.ctxPoolRank = i32(this.ctxPoolRank, 1);
    this.ctxUuid = i32(this.ctxUuid, 1);
    this.ctxLen = i32(this.ctxLen, 1);
    this.smallHi = i32(this.smallHi, HINT_COLS);
  }

  /** Number of distinct values field f has held. */
  size(f        )         {
    return this.count[f];
  }

  /** Number of fields created so far. */
  get fieldCount()         {
    return this.fields;
  }

  /**
   * First index and number of the contexts that learn the bytes of literal strings whatever their field. A
   * starting model never sets these: literals are ids and player names, and their letter statistics stay out.
   */
  get literalContexts()                                   {
    return { first: this.litLo, count: BYTE_SLOTS * BYTE_SLOTS };
  }

  /**
   * First index and number of the contexts field f owns outright (its flags, its index and rank trees, its
   * literal length tree; not its hint blocks). For the prior trainer.
   * @complexity O(1) @alloc one small object
   */
  fieldContexts(f        )                                   {
    return { first: this.ctxTpl[f], count: FIELD_CONTEXTS };
  }

  /**
   * Load the vocabulary of a starting model into the still empty pool: string i gets pool id i, and string 0
   * counts as the most recently used.
   * @param bytes the strings, back to back @param start where each begins; start[count] is the end of the last
   * @complexity O(bytes) @alloc the pool's tables
   */
  preloadPool(bytes            , start            , count        )       {
    if (this.pool.count !== 0) throw new Error('the string pool is not empty');
    for (let id = 0; id < count; id++) {
      if (this.pool.find(bytes, start[id], start[id + 1]) !== ABSENT) throw new Error('starting model lists a string twice');
      this.pool.add(bytes, start[id], start[id + 1]);
      this.gmtf.pushOldest(id);
    }
  }

  /**
   * Give field f its starting dictionary: pool ids ids[from..to), which become indexes 0, 1, 2, ... of the
   * field. In a field past SMALL_MAX values index 0 counts as the most recently used.
   * @complexity O(to - from) @alloc the field's dictionary
   */
  preloadField(f        , ids            , from        , to        )       {
    if (this.count[f] !== 0) throw new Error('the field already has values');
    for (let i = from; i < to; i++) {
      const id = ids[i];
      const map = this.idxOf[f];
      if (id >= this.pool.count || (id < map.length && map[id] !== 0)) throw new Error('starting model dictionary is not valid');
      this.append(f, id);
    }
    if (this.large[f] !== 0) {
      const m = new Recency();
      for (let i = this.count[f] - 1; i >= 0; i--) m.touch(i);
      this.mtf[f] = m;
    }
  }

  /**
   * Base of the index contexts of field f after hint h (0 to HINT_MAX), created on first use.
   * @complexity O(1) @alloc 64 contexts the first time
   */
  hintBlock(f        , h        )         {
    const nk = f * HINT_COLS + h;
    let hi = this.smallHi[nk];
    if (hi === 0) {
      hi = this.rc.alloc(1 << SMALL_BITS);
      this.smallHi[nk] = hi;
    }
    return hi;
  }

  /**
   * Call fn(field, hint, base) for every hint block in existence. For the prior trainer.
   * @complexity O(fields x HINT_MAX) @alloc none
   */
  forEachHintBlock(fn                                              )       {
    for (let f = 0; f < this.fields; f++) {
      for (let h = 0; h < HINT_COLS; h++) {
        const base = this.smallHi[f * HINT_COLS + h];
        if (base !== 0) fn(f, h, base);
      }
    }
  }

  /** Pool id of value `idx` of field f. */
  idAt(f        , idx        )         {
    return this.idOf[f][idx];
  }

  /** Append pool id `id` to field f and return its new index. */
          append(f        , id        )         {
    const idx = this.count[f]++;
    let ids = this.idOf[f];
    if (idx >= ids.length) {
      const n = new Int32Array(ids.length * 2);
      n.set(ids);
      this.idOf[f] = ids = n;
    }
    ids[idx] = id;
    let map = this.idxOf[f];
    if (id >= map.length) {
      let cap = map.length * 2;
      while (cap <= id) cap *= 2;
      const n = new Int32Array(cap);
      n.set(map);
      this.idxOf[f] = map = n;
    }
    map[id] = idx + 1;
    if (this.large[f] !== 0) (this.mtf[f]           ).touch(idx);
    else if (this.count[f] > SMALL_MAX) {
      // the field outgrew the small form: from now on it is coded by recency rank
      this.large[f] = 1;
      const m = new Recency();
      for (let i = 0; i < this.count[f]; i++) m.touch(i);
      this.mtf[f] = m;
    }
    return idx;
  }

  /**
   * Code one string of field f.
   * Encoding: `id` is the string's pool id, or ABSENT with its bytes at b[s..e). Decoding: pass ABSENT.
   * Returns the pool id; this.lastIndex is its index in the field.
   * @param hint small non-negative context hint (0 = none), clamped to HINT_MAX
   * @param tplIdx index (in this field) of the string a look-alike structure had here, or -1
   * @param role base role for bit accounting
   * @complexity O(log n + length) @alloc a dictionary entry when the string is new to the field
   */
  code(f        , id        , b            , s        , e        , hint        , tplIdx        , role        )         {
    const rc = this.rc;
    const enc = rc.enc;
    rc.role = role + ROLE_SYM;
    const cnt = this.count[f];
    let idx = -1;
    if (enc && id !== ABSENT) {
      const map = this.idxOf[f];
      if (id < map.length) idx = map[id] - 1;
    }
    if (tplIdx >= 0 && tplIdx < cnt) {
      if (rc.bit(this.ctxTpl[f], idx === tplIdx ? 1 : 0) !== 0) {
        if (this.large[f] !== 0) (this.mtf[f]           ).touch(tplIdx);
        this.lastIndex = tplIdx;
        return this.idOf[f][tplIdx];
      }
    }
    if (this.large[f] === 0) {
      const h = hint > HINT_MAX ? HINT_MAX : hint;
      const nk = f * HINT_COLS + h;
      const pred = this.next[nk];
      let hit = 0;
      if (pred !== 0) hit = rc.bit(this.ctxNext[f] + h, idx + 1 === pred ? 1 : 0);
      if (hit !== 0) idx = pred - 1;
      else {
        const sym = tree2(rc, this.hintBlock(f, h), this.ctxSmallLo[f], SMALL_BITS, idx + 1);
        if (sym > 0) {
          idx = sym - 1;
          if (idx >= cnt) throw new Error('packed data is damaged');
        } else {
          id = this.codeNew(f, id, b, s, e, role);
          idx = this.append(f, id);
        }
      }
      this.next[nk] = idx + 1;
      this.lastIndex = idx;
      return this.idOf[f][idx];
    }
    // large field: recency rank, most recent = 0
    const m = this.mtf[f]           ;
    const rank = enc && idx >= 0 ? m.rankOf(idx) : -1;
    const base = this.ctxLarge[f];
    const sym = gamma(rc, base, GAMMA_BITS_NARROW, base + (1 << GAMMA_BITS_NARROW), rank + 1);
    if (sym > 0) {
      idx = m.itemAtRank(sym - 1);
      if (idx === ABSENT) throw new Error('packed data is damaged');
      m.touch(idx);
    } else {
      id = this.codeNew(f, id, b, s, e, role);
      idx = this.append(f, id);
    }
    this.lastIndex = idx;
    return this.idOf[f][idx];
  }

  /** A string new to its field: from the pool by recency rank, or as a literal. Returns its pool id. */
          codeNew(f        , id        , b            , s        , e        , role        )         {
    const rc = this.rc;
    const enc = rc.enc;
    rc.role = role + ROLE_GLOBAL;
    const known = rc.bit(this.ctxInPool[f], id !== ABSENT ? 1 : 0);
    if (known !== 0) {
      const g = this.gmtf;
      const base = this.ctxPoolRank[f];
      const rank = gamma(rc, base, GAMMA_BITS_NARROW, base + (1 << GAMMA_BITS_NARROW), enc ? g.rankOf(id) : 0);
      id = g.itemAtRank(rank);
      if (id === ABSENT) throw new Error('packed data is damaged');
      g.touch(id);
      return id;
    }
    rc.role = role + ROLE_LITERAL;
    const lit = this.scratch;
    let n        ;
    const uuid = rc.bit(this.ctxUuid[f], enc && isUuid(b, s, e) ? 1 : 0);
    if (uuid !== 0) {
      n = UUID_LEN;
      for (let i = 0; i < UUID_LEN; i++) {
        if (i === UUID_DASHES[0] || i === UUID_DASHES[1] || i === UUID_DASHES[2] || i === UUID_DASHES[3]) lit[i] = CHAR_DASH;
        else if (i === UUID_VERSION_POS) lit[i] = CHAR_4;
        else if (i === UUID_VARIANT_POS) lit[i] = HEX[VARIANT_BASE + rc.raw(UUID_VARIANT_BITS, enc ? hexValue(b[s + i]) - VARIANT_BASE : 0)];
        else lit[i] = HEX[rc.raw(NIBBLE_BITS, enc ? hexValue(b[s + i]) : 0)];
      }
    } else {
      const base = this.ctxLen[f];
      n = gamma(rc, base, GAMMA_BITS_NARROW, base + (1 << GAMMA_BITS_NARROW), enc ? e - s : 0);
      if (n > STR_MAX) throw new Error('literal string too long');
      let prev = 0;
      for (let i = 0; i < n; i++) {
        const pos = i > POS_MAX ? POS_MAX : i;
        const ka = f * (POS_MAX + 1) + pos;
        let hi = this.litHi.get(ka, prev);
        if (hi === ABSENT) {
          hi = rc.alloc(BYTE_SLOTS);
          this.litHi.swap(ka, prev, hi);
        }
        prev = tree2(rc, hi, this.litLo + prev * BYTE_SLOTS, BYTE_BITS, enc ? b[s + i] : 0);
        lit[i] = prev;
      }
    }
    this.literals++;
    this.literalBytes += n;
    // the pool keeps the decoded bytes; when encoding they equal b[s..e)
    if (this.pool.find(lit, 0, n) !== ABSENT && !enc) throw new Error('literal already in the pool');
    if (enc) {
      this.pool.find(b, s, e);
      id = this.pool.add(b, s, e);
    } else id = this.pool.add(lit, 0, n);
    this.gmtf.touch(id);
    return id;
  }
}
