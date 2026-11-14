/**
 * Sine and cosine that give the same bits on every JavaScript engine and in a port to another language.
 *
 * Why not Math.sin and Math.cos: the language only promises an approximation, and engines differ in the last bit.
 * The game-aware predictor rebuilds PAC's carousel positions with these functions on both the packing and the
 * unpacking side; one differing bit would make the two sides disagree and the file would not unpack.
 *
 * Method: the classic fdlibm kernels (the polynomials V8's own Math.sin and Math.cos use), with a fixed
 * two-step Cody-Waite reduction by pi/2. Only + - * and one truncation are used, all exact IEEE 754 operations,
 * so the result depends on nothing but the input. Accuracy is under one unit in the last place for |x| below
 * REDUCE_LIMIT; it is not correctly rounded and does not need to be: a miss only costs a few packed bits.
 *
 * The kernel polynomials and the split of pi/2 are taken from fdlibm (k_cos.c, k_sin.c, e_rem_pio2.c), which
 * asks that its notice stay with them:
 *
 *   Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
 *   Developed at SunSoft, a Sun Microsystems, Inc. business.
 *   Permission to use, copy, modify, and distribute this software is freely granted, provided that this notice
 *   is preserved.
 *
 * @interacts none
 * @deps      none
 * @complexity O(1): about 25 floating point operations
 * @alloc     none
 */

// cosine kernel coefficients (fdlibm k_cos.c)
const C1 = 4.16666666666666019037e-2;
const C2 = -1.38888888888741095749e-3;
const C3 = 2.48015872894767294178e-5;
const C4 = -2.75573143513906633035e-7;
const C5 = 2.08757232129817482790e-9;
const C6 = -1.13596475577881948265e-11;
// sine kernel coefficients (fdlibm k_sin.c)
const S1 = -1.66666666666666324348e-1;
const S2 = 8.33333333332248946124e-3;
const S3 = -1.98412698298579493134e-4;
const S4 = 2.75573137070700676789e-6;
const S5 = -2.50507602534068634195e-8;
const S6 = 1.58969099521155010221e-10;
// pi/2 split into pieces whose products with a small integer are exact (fdlibm e_rem_pio2.c)
const INV_PIO2 = 6.36619772367581382433e-1;
const PIO2_1 = 1.57079632673412561417;
const PIO2_2 = 6.07710050630396597660e-11;
const PIO2_2T = 2.02226624879595063154e-21;
const HALF = 0.5;
/** Arguments at or below this need no reduction (pi/4). */
const QUARTER_PI = 0.7853981633974483;
/** Above this the two-step reduction is no longer accurate enough; callers never get near it. */
export const REDUCE_LIMIT = 1048576;

/** cos(x + y) for |x| <= pi/4, y the tail of x. */
function kernelCos(x        , y        )         {
  const z = x * x;
  const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
  return 1 - (HALF * z - (z * r - x * y));
}

/** sin(x + y) for |x| <= pi/4, y the tail of x. */
function kernelSin(x        , y        )         {
  const z = x * x;
  const v = z * x;
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  return x - ((z * (HALF * y - v * r) - y) - v * S1);
}

/** Module state of the last reduction: the reduced argument as head + tail. Not shared across calls. */
let redHead = 0;
let redTail = 0;

/**
 * Reduce |x| by multiples of pi/2. Sets redHead and redTail; returns the multiple (as a non-negative integer).
 * @complexity O(1) @alloc none
 */
function reduce(ax        )         {
  const n = Math.floor(ax * INV_PIO2 + HALF);
  const t = ax - n * PIO2_1;
  let w = n * PIO2_2;
  const r = t - w;
  w = n * PIO2_2T - ((t - r) - w);
  redHead = r - w;
  redTail = (r - redHead) - w;
  return n;
}

/**
 * Deterministic cosine. NaN for a non-finite input or |x| above REDUCE_LIMIT.
 * @complexity O(1) @alloc none
 */
export function detCos(x        )         {
  const ax = x < 0 ? -x : x;
  if (ax <= QUARTER_PI) return kernelCos(ax, 0);
  if (!(ax <= REDUCE_LIMIT)) return NaN;
  const q = reduce(ax) % 4;
  if (q === 0) return kernelCos(redHead, redTail);
  if (q === 1) return -kernelSin(redHead, redTail);
  if (q === 2) return -kernelCos(redHead, redTail);
  return kernelSin(redHead, redTail);
}

/**
 * Deterministic sine. NaN for a non-finite input or |x| above REDUCE_LIMIT.
 * @complexity O(1) @alloc none
 */
export function detSin(x        )         {
  const ax = x < 0 ? -x : x;
  let s        ;
  if (ax <= QUARTER_PI) s = kernelSin(ax, 0);
  else {
    if (!(ax <= REDUCE_LIMIT)) return NaN;
    const q = reduce(ax) % 4;
    if (q === 0) s = kernelSin(redHead, redTail);
    else if (q === 1) s = kernelCos(redHead, redTail);
    else if (q === 2) s = -kernelSin(redHead, redTail);
    else s = -kernelCos(redHead, redTail);
  }
  return x < 0 ? -s : s;
}
