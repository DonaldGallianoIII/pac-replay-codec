/**
 * Symbol coders on top of the binary range coder: bit trees for small alphabets and a size-class coder for
 * integers of unknown size. All of them work in both directions (see range-coder.ts): pass the value when
 * encoding, read the return value when decoding.
 *
 * These layouts are part of the packed format; a port must mirror them:
 *   tree      an n bit symbol walks a binary tree of contexts rooted at `base`; node 1 is the root, the children
 *             of node k are 2k and 2k+1, so a tree needs 2^n contexts
 *   gamma     an integer v >= 0 is its size class (0 for 0, else position of the highest bit plus one) as a tree
 *             symbol, then the bits below the highest one: the top GAMMA_MODELED of them under contexts chosen by
 *             class, the rest raw
 *
 * @interacts range-coder.ts (codes bits)
 * @deps      range-coder.ts
 * @complexity O(bits) per symbol: n for a tree symbol, classBits + 2 for most gamma coded integers
 * @alloc     none
 */
import { RangeCoder, RAW_BITS_MAX } from './range-coder.ts';

/** Bits below the leading one that get their own contexts; the rest are coded raw. */
export const GAMMA_MODELED = 2;
/** Contexts per size class for those modeled bits (a 2 bit tree: nodes 1 to 3, slot 0 unused). */
export const GAMMA_CLASS_SLOTS = 4;
/** Size-class tree widths: 6 bits cover every integer below 2^53, 5 bits cover 32 bit differences. */
export const GAMMA_BITS_WIDE = 6;
export const GAMMA_BITS_NARROW = 5;
/** A two-context symbol uses the specific context once it has been seen this many times. */
export const BACKOFF_MIN_COUNT = 2;

/** Exact powers of two as doubles, built by doubling (no pow call), for bit slicing above 2^32. */
const POW2 = new Float64Array(64);
POW2[0] = 1;
for (let i = 1; i < 64; i++) POW2[i] = POW2[i - 1] * 2;

/** Contexts a gamma coder needs for a size-class tree of `classBits` bits. @complexity O(1) @alloc none */
export function gammaSlots(classBits: number): number {
  return (1 << classBits) + (1 << classBits) * GAMMA_CLASS_SLOTS;
}

/**
 * Code an nbits wide symbol with a bit tree rooted at `base` (needs 2^nbits contexts). Returns the symbol.
 * @complexity O(nbits) @alloc none
 */
export function tree(rc: RangeCoder, base: number, nbits: number, v: number): number {
  return rc.tree(base, nbits, v);
}

/**
 * Bit tree with backoff: each node uses the specific block `hi` once it has history, else the general `lo`;
 * both learn. Returns the symbol.
 * @complexity O(nbits) @alloc none
 */
export function tree2(rc: RangeCoder, hi: number, lo: number, nbits: number, v: number): number {
  return rc.tree2(hi, lo, nbits, v, BACKOFF_MIN_COUNT);
}

/**
 * Size class of a non-negative integer below 2^53: 0 for 0, else the position of its highest bit plus one.
 * @complexity O(1) @alloc none
 */
export function sizeClass(v: number): number {
  if (v < 4294967296) return v === 0 ? 0 : 32 - Math.clz32(v);
  return 64 - Math.clz32(Math.floor(v / 4294967296));
}

/**
 * Code a non-negative integer below 2^53. The size class is a tree symbol of `classBits` bits rooted at
 * `classBase`; the modeled bits below the leading one use contexts at `tailBase + class * GAMMA_CLASS_SLOTS`.
 * A caller that wants the class tree in a specific context and the tail in a shared one passes two bases.
 * Returns the integer.
 * @complexity O(classBits + GAMMA_MODELED) coded bits plus one raw call per 16 further bits @alloc none
 */
export function gamma(rc: RangeCoder, classBase: number, classBits: number, tailBase: number, v: number): number {
  const cls = tree(rc, classBase, classBits, rc.enc ? sizeClass(v) : 0);
  return gammaTail(rc, tailBase, cls, v);
}

/**
 * gamma() with the usual block layout: the class tree at `base`, the tail contexts right after it. The block is
 * gammaSlots(classBits) contexts. Returns the integer.
 * @complexity as gamma @alloc none
 */
export function gamma1(rc: RangeCoder, base: number, classBits: number, v: number): number {
  const cls = tree(rc, base, classBits, rc.enc ? sizeClass(v) : 0);
  return gammaTail(rc, base + (1 << classBits), cls, v);
}

/**
 * Gamma with backoff on the size class: the class tree uses the specific block `hi` (2^classBits contexts) once it
 * has history, else the general block `lo` (gammaSlots(classBits) contexts, whose tail part codes the lower bits).
 * Returns the integer.
 * @complexity as gamma @alloc none
 */
export function gamma2(rc: RangeCoder, hi: number, lo: number, classBits: number, v: number): number {
  const cls = tree2(rc, hi, lo, classBits, rc.enc ? sizeClass(v) : 0);
  return gammaTail(rc, lo + (1 << classBits), cls, v);
}

/**
 * The bits of a gamma coded integer below its leading one. `cls` is its size class. Returns the integer.
 * @complexity GAMMA_MODELED coded bits plus one raw call per 16 further bits (at most 4 calls) @alloc none
 */
export function gammaTail(rc: RangeCoder, tailBase: number, cls: number, v: number): number {
  if (cls <= 1) return cls; // 0 and 1 have nothing below the leading bit
  let rest = cls - 1;
  let out = 1;
  const modeled = rest < GAMMA_MODELED ? rest : GAMMA_MODELED;
  const mb = tailBase + cls * GAMMA_CLASS_SLOTS;
  let node = 1;
  for (let k = 0; k < modeled; k++) {
    const shift = rest - 1 - k;
    // bits below 32 can be read from the low word with integer shifts; higher ones need exact division
    const want = rc.enc ? (shift < 32 ? (v >>> shift) & 1 : Math.floor(v / POW2[shift]) % 2) : 0;
    const b = rc.bit(mb + node, want);
    node = (node << 1) | b;
    out = out * 2 + b;
  }
  rest -= modeled;
  while (rest > 0) {
    const take = rest < RAW_BITS_MAX ? rest : RAW_BITS_MAX;
    const shift = rest - take;
    const want = rc.enc ? (shift + take <= 32 ? (v >>> shift) & ((1 << take) - 1) : Math.floor(v / POW2[shift]) % POW2[take]) : 0;
    out = out * POW2[take] + rc.raw(take, want);
    rest -= take;
  }
  return out;
}

/** Map a signed integer to a non-negative one (0, -1, 1, -2, ...). Exact below 2^52 in magnitude. @complexity O(1) @alloc none */
export function zigzag(v: number): number {
  return v >= 0 ? v * 2 : -v * 2 - 1;
}

/** The inverse of zigzag. @complexity O(1) @alloc none */
export function unzigzag(z: number): number {
  // the low bit survives the 32 bit truncation of `&`, so this is exact for every integer below 2^53
  return (z & 1) === 0 ? z / 2 : -(z + 1) / 2;
}
