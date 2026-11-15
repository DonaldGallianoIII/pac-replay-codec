/**
 * What a build of the codec carries. Run from source (the tests, measurement scripts), every flag is on. For the
 * packaged files tools/build-web.mjs swaps this module for the values of its own table, so each test of a flag
 * becomes a constant and the code behind an off flag is dropped:
 *
 *   web/lib/index.js    ENCODE and PRIOR on, MEASURE off     packs, unpacks, loads starting models
 *   web/lib/encode.js   ENCODE on                             packs and unpacks
 *   web/lib/decode.js   every flag off                        unpacks only
 *
 * A flag guards code the usual way, `if (ENCODE && ...)`. A method that only one capability needs says so in its
 * doc block with `@build encode` (or measure, prior), and the build leaves it out of a file without that
 * capability; the build stops if anything that is left still calls it.
 *
 * A flag never changes what a build writes or reads: two builds that can both do a thing do it bit for bit alike.
 *
 * @interacts tools/build-web.mjs (replaces this module in a packaged build)
 * @deps      none
 * @complexity O(1): three constants
 * @alloc     none
 */

/** The build can pack: the reader of the original, the validator, the clock measurement, the encoding half of the coder. */
export const ENCODE: boolean = true;
/** The build keeps the measuring tools: bit accounting by role, and the hooks a starting-model trainer reads. */
export const MEASURE: boolean = true;
/** The build can load a starting model (prior.ts). */
export const PRIOR: boolean = true;
