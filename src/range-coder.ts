/**
 * Adaptive binary range coder: the entropy coding stage of the replay codec.
 *
 * One class codes in both directions. In encode mode bit(i, b) writes b and returns it; in decode mode it ignores
 * the argument and returns the decoded bit. A walker written once against this class is therefore its own inverse.
 *
 * Every number here is part of the packed format. A port to another language must do the same
 * integer arithmetic step for step, or the two produce different bytes:
 *   state     one u32 per context: probability that the bit is 1 in the high 16 bits (1..65535), number of bits
 *             seen in the low 8 bits (capped at CountLimit). The table stores it XOR STATE_FLIP, so that fresh,
 *             zero-filled memory already means "one half, nothing seen" and a new context costs nothing to set up
 *   split     bound = (range >>> 16) * p. The low 16 bits of range are dropped: pure 32 bit arithmetic in both
 *             languages, for a measured loss under 0.1% of the packed size
 *   update    p moves toward the coded bit by (distance * RATE[count]) >>> 16, RATE[n] = floor(65536 / (n + 1.5)):
 *             a new context learns fast, a settled one moves by about 1/31 of the distance
 *   carry     low is kept below 2^32; an overflow adds one to the bytes already written
 *   output    one byte whenever range drops below 2^24; four bytes of low at the end
 *
 * Analogy: a thermostat that jumps to the first reading and then nudges. Where it breaks: a thermostat tracks one
 * number, this keeps one per context, about a hundred thousand of them.
 *
 * Speed note for this build: range, low and code are 32 bit unsigned values kept as signed 32 bit patterns (`| 0`),
 * compared through `>>> 0` and multiplied with Math.imul. That keeps every one of them a small integer for the
 * engine: no boxed doubles, no float conversions. The arithmetic is the same modulo 2^32.
 *
 * Build flags (build.ts): the encoding half of every method is behind ENCODE, the bit accounting behind MEASURE.
 * A build without one of them drops that code; what the rest reads and writes does not change by a bit.
 *
 * @interacts none (owns its output buffer and its state table)
 * @deps      build.ts (the flags)
 * @complexity O(1) per decision; a 3.4 MB replay is about 6 million decisions
 * @alloc     the state table and the output buffer grow by doubling; both are released with the coder
 */

import { ENCODE, MEASURE } from './build.ts';

/** Probability scale: p is out of 2^16. */
const PROB_BITS = 16;
/** Largest probability value (a 1 bit is never certain). */
const PROB_MAX = 65535;
/** XOR mask between a stored word and its state: a stored 0 is probability one half (0x8000), count 0. */
const STATE_FLIP = 0x80000000;
/** Mask of the observation count inside a state word. */
const COUNT_MASK = 0xff;
/** Renormalize when range falls below 2^24. */
const RANGE_MIN = 16777216;
/** Bits of range, low and code. */
const WORD_TOP_SHIFT = 24;
const BYTE_SHIFT = 8;
/** Bytes of low written at the end, and read ahead at the start of decoding. */
const FLUSH_BYTES = 4;
/** Bytes a decoder may read past the end of its input before it gives up. A sound stream never reads any. */
const PAD_MAX = 4;
/** Most raw bits one raw() call may carry (range keeps at least 8 bits). */
export const RAW_BITS_MAX = 16;

export const CONFIG = {
  /** Contexts settle at rate 1 / (CountLimit + 1.5). Lower adapts faster and codes stable contexts worse. */
  CountLimit: 30,
  /** First size of the state table, in contexts. A replay uses about 3 million; untouched pages cost nothing. */
  InitialContexts: 1 << 22,
  /** First size of the output buffer, in bytes. */
  InitialOut: 1 << 18,
} as const;

/**
 * Backoff rule for two-context bits, part of the packed format. True: once the specific context is in use, the
 * general one stops learning from it (it stays the model of "a context seen for the first time"), which saves its
 * update. False: both always learn. A build with MEASURE can try the other rule per coder (RangeCoder.lazy).
 */
export const LAZY_BACKOFF = true;

const COUNT_LIMIT: number = CONFIG.CountLimit;
const EMPTY = new Uint8Array(0);
/** RATE[n]: the step toward the coded bit after n earlier observations, out of 2^16. */
const RATE = new Uint16Array(COUNT_LIMIT + 1);
for (let n = 0; n <= COUNT_LIMIT; n++) RATE[n] = Math.floor(65536 / (n + 1.5));

/** The coder: one instance per packed stream, encoding (no input) or decoding (the packed bytes). */
export class RangeCoder {
  /** True when encoding. */
  readonly enc: boolean;
  /** Context states, see the module header. */
  st: Uint32Array;
  /** Contexts handed out so far. Context 0 is never handed out. */
  used: number;
  // range, low and code hold unsigned 32 bit values as signed patterns
  private range: number;
  // low, out and outLen exist in a build that encodes
  private low!: number;
  private out!: Uint8Array;
  outLen!: number;
  private readonly inp: Uint8Array;
  private ip: number;
  /** Bytes read past the end of the input (decode). */
  private over: number;
  private code: number;
  // the next five exist in a build with MEASURE
  /** Optional bit accounting: cost in bits by role. Null in normal use. */
  account!: Float64Array | null;
  /** Optional decision counting by role (how many bit() calls). Null in normal use. */
  decisions!: Float64Array | null;
  /** Role the next bits are charged to when accounting is on (set through charge()). */
  role!: number;
  /**
   * Optional observer, for the prior trainer: called with (context, bit, coded) for every modeled decision, where
   * coded is 1 when the bit was coded under that context and 0 when the context only learned from it. Only
   * honoured while accounting is on. Null in normal use.
   */
  watch!: ((i: number, b: number, coded: number) => void) | null;
  /** The backoff rule of this coder (LAZY_BACKOFF unless a measurement run changes it). */
  lazy!: boolean;

  /**
   * @param input packed bytes to decode, or null to encode
   * @complexity O(InitialContexts) @alloc the state table and, when encoding, the output buffer
   */
  constructor(input: Uint8Array | null = null) {
    this.enc = ENCODE && input === null;
    this.st = new Uint32Array(CONFIG.InitialContexts);
    this.used = 1;
    this.range = -1;
    this.inp = input === null ? EMPTY : input;
    this.ip = 0;
    this.over = 0;
    this.code = 0;
    if (ENCODE) {
      this.low = 0;
      this.out = this.enc ? new Uint8Array(CONFIG.InitialOut) : EMPTY;
      this.outLen = 0;
    }
    if (MEASURE) {
      this.account = null;
      this.decisions = null;
      this.role = 0;
      this.watch = null;
      this.lazy = LAZY_BACKOFF;
    }
    if (!(ENCODE && this.enc)) for (let i = 0; i < FLUSH_BYTES; i++) this.code = (this.code << BYTE_SHIFT) | this.next();
  }

  private next(): number {
    return this.ip < this.inp.length ? this.inp[this.ip++] : 0;
  }

  /**
   * The input ran out. A sound stream is read to its last byte and no further, so this only happens on damaged
   * data; a few zero bytes are allowed, then decoding stops. This is also what bounds the work on any input.
   */
  private pad(): number {
    if (++this.over > PAD_MAX) throw new Error('packed data is damaged');
    return 0;
  }

  /**
   * Reserve `count` fresh contexts and return the index of the first.
   * @complexity amortized O(count) @alloc doubles the state table when it is full
   */
  alloc(count: number): number {
    const base = this.used;
    this.used += count;
    if (this.used > this.st.length) {
      let cap = this.st.length;
      while (cap < this.used) cap *= 2;
      const st = new Uint32Array(cap);
      st.set(this.st);
      this.st = st;
    }
    return base;
  }

  /**
   * Double the output buffer.
   * @build encode
   */
  private growOut(): void {
    const o = new Uint8Array(this.out.length * 2);
    o.set(this.out);
    this.out = o;
  }

  /**
   * Add one to the bytes already written (low overflowed 2^32).
   * @build encode
   */
  private carry(): void {
    const out = this.out;
    let i = this.outLen - 1;
    while (out[i] === 0xff) out[i--] = 0;
    out[i]++;
  }

  /**
   * Code one bit under context i. Returns the bit.
   * @complexity O(1) @alloc none
   */
  bit(i: number, b: number): number {
    const st = this.st;
    const s = st[i] ^ STATE_FLIP;
    let p = s >>> PROB_BITS;
    const range = this.range;
    const bound = Math.imul(range >>> PROB_BITS, p);
    let r: number;
    if (ENCODE && this.enc) {
      let low = this.low;
      if (b !== 0) r = bound;
      else {
        low = (low + bound) | 0;
        if (low >>> 0 < bound >>> 0) this.carry();
        r = (range - bound) | 0;
      }
      while (r >>> 0 < RANGE_MIN) {
        if (this.outLen === this.out.length) this.growOut();
        this.out[this.outLen++] = low >>> WORD_TOP_SHIFT;
        low <<= BYTE_SHIFT;
        r <<= BYTE_SHIFT;
      }
      this.low = low;
    } else {
      let code = this.code;
      if (code >>> 0 < bound >>> 0) {
        r = bound;
        b = 1;
      } else {
        code = (code - bound) | 0;
        r = (range - bound) | 0;
        b = 0;
      }
      while (r >>> 0 < RANGE_MIN) {
        code = (code << BYTE_SHIFT) | (this.ip < this.inp.length ? this.inp[this.ip++] : this.pad());
        r <<= BYTE_SHIFT;
      }
      this.code = code;
    }
    this.range = r;
    if (MEASURE && this.account !== null) {
      this.account[this.role] -= Math.log2((b !== 0 ? p : 65536 - p) / 65536);
      if (this.decisions !== null) this.decisions[this.role]++;
      if (this.watch !== null) this.watch(i, b, 1);
    }
    const n = s & COUNT_MASK;
    if (b !== 0) p += ((PROB_MAX - p) * RATE[n]) >>> PROB_BITS;
    else p -= (p * RATE[n]) >>> PROB_BITS;
    st[i] = ((p << PROB_BITS) | (n < COUNT_LIMIT ? n + 1 : n)) ^ STATE_FLIP;
    return b;
  }

  /**
   * Code one bit choosing between a specific context (hi) and a general one (lo): hi is used once it has been seen
   * `minCount` times, both learn every time. Returns the bit.
   * @complexity O(1) @alloc none
   */
  bit2(hi: number, lo: number, b: number, minCount: number): number {
    if (hi === lo) return this.bit(hi, b);
    const st = this.st;
    const useHi = (st[hi] & COUNT_MASK) >= minCount;
    b = this.bit(useHi ? hi : lo, b);
    if (useHi && (MEASURE ? this.lazy : LAZY_BACKOFF)) return b;
    // the context that was not used still learns, without coding
    const other = useHi ? lo : hi;
    if (MEASURE && this.account !== null && this.watch !== null) this.watch(other, b, 0);
    const s = st[other] ^ STATE_FLIP;
    let p = s >>> PROB_BITS;
    const n = s & COUNT_MASK;
    if (b !== 0) p += ((PROB_MAX - p) * RATE[n]) >>> PROB_BITS;
    else p -= (p * RATE[n]) >>> PROB_BITS;
    st[other] = ((p << PROB_BITS) | (n < COUNT_LIMIT ? n + 1 : n)) ^ STATE_FLIP;
    return b;
  }

  /**
   * Code an nbits wide symbol with a bit tree of contexts rooted at `base` (2^nbits contexts): node 1 is the root,
   * the children of node k are 2k and 2k+1. Returns the symbol. Same bits as nbits calls of bit(); written out
   * here so that range, low and code stay in locals for the whole symbol.
   * @complexity O(nbits) @alloc none
   */
  tree(base: number, nbits: number, v: number): number {
    let node = 1;
    if (MEASURE && this.account !== null) {
      for (let k = nbits - 1; k >= 0; k--) node = (node << 1) | this.bit(base + node, (v >>> k) & 1);
      return node - (1 << nbits);
    }
    const st = this.st;
    let r = this.range;
    if (ENCODE && this.enc) {
      let low = this.low;
      for (let k = nbits - 1; k >= 0; k--) {
        const i = base + node;
        const s = st[i] ^ STATE_FLIP;
        let p = s >>> PROB_BITS;
        const n = s & COUNT_MASK;
        const bound = Math.imul(r >>> PROB_BITS, p);
        const b = (v >>> k) & 1;
        if (b !== 0) {
          r = bound;
          p += ((PROB_MAX - p) * RATE[n]) >>> PROB_BITS;
        } else {
          low = (low + bound) | 0;
          if (low >>> 0 < bound >>> 0) this.carry();
          r = (r - bound) | 0;
          p -= (p * RATE[n]) >>> PROB_BITS;
        }
        while (r >>> 0 < RANGE_MIN) {
          if (this.outLen === this.out.length) this.growOut();
          this.out[this.outLen++] = low >>> WORD_TOP_SHIFT;
          low <<= BYTE_SHIFT;
          r <<= BYTE_SHIFT;
        }
        st[i] = ((p << PROB_BITS) | (n < COUNT_LIMIT ? n + 1 : n)) ^ STATE_FLIP;
        node = (node << 1) | b;
      }
      this.low = low;
    } else {
      let code = this.code;
      for (let k = nbits - 1; k >= 0; k--) {
        const i = base + node;
        const s = st[i] ^ STATE_FLIP;
        let p = s >>> PROB_BITS;
        const n = s & COUNT_MASK;
        const bound = Math.imul(r >>> PROB_BITS, p);
        let b: number;
        if (code >>> 0 < bound >>> 0) {
          r = bound;
          b = 1;
          p += ((PROB_MAX - p) * RATE[n]) >>> PROB_BITS;
        } else {
          code = (code - bound) | 0;
          r = (r - bound) | 0;
          b = 0;
          p -= (p * RATE[n]) >>> PROB_BITS;
        }
        while (r >>> 0 < RANGE_MIN) {
          code = (code << BYTE_SHIFT) | (this.ip < this.inp.length ? this.inp[this.ip++] : this.pad());
          r <<= BYTE_SHIFT;
        }
        st[i] = ((p << PROB_BITS) | (n < COUNT_LIMIT ? n + 1 : n)) ^ STATE_FLIP;
        node = (node << 1) | b;
      }
      this.code = code;
    }
    this.range = r;
    return node - (1 << nbits);
  }

  /**
   * Bit tree with backoff: each node is coded under the specific block `hi` once that node has been seen
   * `minCount` times, else under the general block `lo`; both learn. Returns the symbol. Same bits as nbits calls
   * of bit2().
   * @complexity O(nbits) @alloc none
   */
  tree2(hi: number, lo: number, nbits: number, v: number, minCount: number): number {
    let node = 1;
    if ((MEASURE && this.account !== null) || hi === lo) {
      for (let k = nbits - 1; k >= 0; k--) node = (node << 1) | this.bit2(hi + node, lo + node, (v >>> k) & 1, minCount);
      return node - (1 << nbits);
    }
    const st = this.st;
    const lazy = MEASURE ? this.lazy : LAZY_BACKOFF;
    let r = this.range;
    if (ENCODE && this.enc) {
      let low = this.low;
      for (let k = nbits - 1; k >= 0; k--) {
        const ih = hi + node;
        const sh = st[ih] ^ STATE_FLIP;
        let ph = sh >>> PROB_BITS;
        const nh = sh & COUNT_MASK;
        const useHi = nh >= minCount;
        const b = (v >>> k) & 1;
        if (useHi && lazy) {
          // the specific context alone
          const bound = Math.imul(r >>> PROB_BITS, ph);
          if (b !== 0) {
            r = bound;
            ph += ((PROB_MAX - ph) * RATE[nh]) >>> PROB_BITS;
          } else {
            low = (low + bound) | 0;
            if (low >>> 0 < bound >>> 0) this.carry();
            r = (r - bound) | 0;
            ph -= (ph * RATE[nh]) >>> PROB_BITS;
          }
          while (r >>> 0 < RANGE_MIN) {
            if (this.outLen === this.out.length) this.growOut();
            this.out[this.outLen++] = low >>> WORD_TOP_SHIFT;
            low <<= BYTE_SHIFT;
            r <<= BYTE_SHIFT;
          }
          st[ih] = ((ph << PROB_BITS) | (nh < COUNT_LIMIT ? nh + 1 : nh)) ^ STATE_FLIP;
          node = (node << 1) | b;
          continue;
        }
        const il = lo + node;
        const sl = st[il] ^ STATE_FLIP;
        let pl = sl >>> PROB_BITS;
        const nl = sl & COUNT_MASK;
        const bound = Math.imul(r >>> PROB_BITS, useHi ? ph : pl);
        if (b !== 0) {
          r = bound;
          ph += ((PROB_MAX - ph) * RATE[nh]) >>> PROB_BITS;
          pl += ((PROB_MAX - pl) * RATE[nl]) >>> PROB_BITS;
        } else {
          low = (low + bound) | 0;
          if (low >>> 0 < bound >>> 0) this.carry();
          r = (r - bound) | 0;
          ph -= (ph * RATE[nh]) >>> PROB_BITS;
          pl -= (pl * RATE[nl]) >>> PROB_BITS;
        }
        while (r >>> 0 < RANGE_MIN) {
          if (this.outLen === this.out.length) this.growOut();
          this.out[this.outLen++] = low >>> WORD_TOP_SHIFT;
          low <<= BYTE_SHIFT;
          r <<= BYTE_SHIFT;
        }
        st[ih] = ((ph << PROB_BITS) | (nh < COUNT_LIMIT ? nh + 1 : nh)) ^ STATE_FLIP;
        st[il] = ((pl << PROB_BITS) | (nl < COUNT_LIMIT ? nl + 1 : nl)) ^ STATE_FLIP;
        node = (node << 1) | b;
      }
      this.low = low;
    } else {
      let code = this.code;
      for (let k = nbits - 1; k >= 0; k--) {
        const ih = hi + node;
        const sh = st[ih] ^ STATE_FLIP;
        let ph = sh >>> PROB_BITS;
        const nh = sh & COUNT_MASK;
        const useHi = nh >= minCount;
        let b: number;
        if (useHi && lazy) {
          // the specific context alone
          const bound = Math.imul(r >>> PROB_BITS, ph);
          if (code >>> 0 < bound >>> 0) {
            r = bound;
            b = 1;
            ph += ((PROB_MAX - ph) * RATE[nh]) >>> PROB_BITS;
          } else {
            code = (code - bound) | 0;
            r = (r - bound) | 0;
            b = 0;
            ph -= (ph * RATE[nh]) >>> PROB_BITS;
          }
          while (r >>> 0 < RANGE_MIN) {
            code = (code << BYTE_SHIFT) | (this.ip < this.inp.length ? this.inp[this.ip++] : this.pad());
            r <<= BYTE_SHIFT;
          }
          st[ih] = ((ph << PROB_BITS) | (nh < COUNT_LIMIT ? nh + 1 : nh)) ^ STATE_FLIP;
          node = (node << 1) | b;
          continue;
        }
        const il = lo + node;
        const sl = st[il] ^ STATE_FLIP;
        let pl = sl >>> PROB_BITS;
        const nl = sl & COUNT_MASK;
        const bound = Math.imul(r >>> PROB_BITS, useHi ? ph : pl);
        if (code >>> 0 < bound >>> 0) {
          r = bound;
          b = 1;
          ph += ((PROB_MAX - ph) * RATE[nh]) >>> PROB_BITS;
          pl += ((PROB_MAX - pl) * RATE[nl]) >>> PROB_BITS;
        } else {
          code = (code - bound) | 0;
          r = (r - bound) | 0;
          b = 0;
          ph -= (ph * RATE[nh]) >>> PROB_BITS;
          pl -= (pl * RATE[nl]) >>> PROB_BITS;
        }
        while (r >>> 0 < RANGE_MIN) {
          code = (code << BYTE_SHIFT) | (this.ip < this.inp.length ? this.inp[this.ip++] : this.pad());
          r <<= BYTE_SHIFT;
        }
        st[ih] = ((ph << PROB_BITS) | (nh < COUNT_LIMIT ? nh + 1 : nh)) ^ STATE_FLIP;
        st[il] = ((pl << PROB_BITS) | (nl < COUNT_LIMIT ? nl + 1 : nl)) ^ STATE_FLIP;
        node = (node << 1) | b;
      }
      this.code = code;
    }
    this.range = r;
    return node - (1 << nbits);
  }

  /**
   * Code `count` bits (1 to RAW_BITS_MAX) with no model: every value equally likely. Returns the value.
   * @complexity O(1) @alloc none
   */
  raw(count: number, v: number): number {
    let r = (this.range >>> count) | 0;
    if (ENCODE && this.enc) {
      const add = Math.imul(r, v);
      let low = (this.low + add) | 0;
      if (low >>> 0 < add >>> 0) this.carry();
      while (r >>> 0 < RANGE_MIN) {
        if (this.outLen === this.out.length) this.growOut();
        this.out[this.outLen++] = low >>> WORD_TOP_SHIFT;
        low <<= BYTE_SHIFT;
        r <<= BYTE_SHIFT;
      }
      this.low = low;
    } else {
      let code = this.code;
      v = ((code >>> 0) / (r >>> 0)) | 0;
      code = (code - Math.imul(v, r)) | 0;
      while (r >>> 0 < RANGE_MIN) {
        code = (code << BYTE_SHIFT) | (this.ip < this.inp.length ? this.inp[this.ip++] : this.pad());
        r <<= BYTE_SHIFT;
      }
      this.code = code;
    }
    this.range = r;
    if (MEASURE && this.account !== null) this.account[this.role] += count;
    return v;
  }

  /**
   * Finish encoding and return the packed bytes.
   * @complexity O(output) @alloc one exact-size copy
   * @build encode
   */
  finish(): Uint8Array {
    for (let i = 0; i < FLUSH_BYTES; i++) {
      if (this.outLen === this.out.length) this.growOut();
      this.out[this.outLen++] = this.low >>> WORD_TOP_SHIFT;
      this.low <<= BYTE_SHIFT;
    }
    return this.out.slice(0, this.outLen);
  }
}

/**
 * Charge the bits coded from here on to `role`, for the bit accounting. A build without MEASURE drops the call.
 * @complexity O(1) @alloc none
 */
export function charge(rc: RangeCoder, role: number): void {
  if (MEASURE) rc.role = role;
}
