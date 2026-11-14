/**
 * Types for the library entry of pac-replay-codec (web/lib/index.js). Written by hand for the public surface;
 * test/types-check.ts fails the type check if they stop matching src/index.ts.
 *
 * @interacts web/lib/index.js (the module these types describe)
 * @deps      none
 * @complexity O(1): declarations only
 * @alloc     none
 */

/** Counters the coder keeps while packing. */
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
 * An optional starting model, from parsePrior. None ships with this package. A file packed with one can only be
 * unpacked with that exact model, so most users never need this.
 */
export interface Prior {
  /** crc32 of the model file: the number written in the header of a file packed with it. */
  readonly id: number;
  /** The CLRZ format version whose model it fits. */
  readonly model: number;
  /** Coder contexts in existence right after loading. */
  readonly contexts: number;
}

export interface PackOptions {
  /** false: never use the PAC mini-game formulas, whatever the game version (default true). */
  gameAware?: boolean;
  /** Collect bit costs and decision counts by role (slower; for measurement). */
  account?: boolean;
  /** A starting model (parsePrior). Used when it knows the replay's type table; else the replay is packed cold. */
  prior?: Prior | null;
  /** true: use the starting model even when the replay's type table is not the one it was trained on. */
  priorAlways?: boolean;
}

export interface PackResult {
  /** The packed file ("CLRZ" container). */
  bytes: Uint8Array;
  /** Which predictor set was used: PREDICTORS_SCHEMA or PREDICTORS_PAC_MINIGAME. */
  predictors: number;
  /** MODE_CODED, MODE_STORED or MODE_PRIOR. */
  mode: number;
  /** Id of the starting model the file needs to be unpacked, or 0 when it needs none. */
  priorId: number;
  /** The coder's counters; null in stored mode. */
  stats: CodecStats | null;
  /** The coder itself, for measurement scripts; null in stored mode. Not part of the stable API. */
  codec: unknown;
  /**
   * Null in normal use. A message when the coder failed on this input and the file was stored instead, or when the
   * starting model did not fit this build and the file was packed cold (the mode says which).
   */
  error: string | null;
}

/**
 * Pack a replay. Never throws: an input that is not a replay, or that would not shrink, is stored as it is inside
 * the container, so every input packs and unpacks.
 */
export function packReplay(src: Uint8Array, opts?: PackOptions): PackResult;

/**
 * Unpack a .paczd file to the original bytes. Checks the size and the crc32 of what it rebuilt and throws if the
 * packed bytes are damaged; it never returns wrong bytes.
 * @param priors every starting model you have; the file names the one it needs. Leave out when you use none.
 */
export function unpackReplay(packed: Uint8Array, priors?: readonly Prior[]): Uint8Array;

/**
 * True when this build knows the PAC mini-game formulas for the replay's game version (6.11.x). packReplay codes
 * such a replay once, with them; any other replay is coded with and without them and keeps the smaller.
 */
export function knowsGameVersion(src: Uint8Array): boolean;

/** Read a starting model file. Throws if the file is damaged. */
export function parsePrior(file: Uint8Array): Prior;

/** crc32 with the zlib polynomial. */
export function crc32(b: Uint8Array): number;

/** The first four bytes of every .paczd file: "CLRZ". */
export const CONTAINER_MAGIC: number[];
export const FORMAT_VERSION: number;
export const PREDICTORS_SCHEMA: number;
export const PREDICTORS_PAC_MINIGAME: number;
export const MODE_CODED: number;
export const MODE_STORED: number;
export const MODE_PRIOR: number;
/** The largest original a coded file may claim (256 MB); the unpacker refuses more before allocating. */
export const MAX_ORIGINAL_BYTES: number;
/** The most original bytes a coded file may claim per packed byte (1024). */
export const EXPANSION_MAX: number;
