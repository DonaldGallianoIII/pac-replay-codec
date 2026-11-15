/**
 * Types for the packing entry of pac-replay-codec (web/lib/encode.js, imported as "pac-replay-codec/encode").
 * Written by hand; test/types-check.ts fails the type check if they stop matching src/encode.ts.
 *
 * This entry packs, and unpacks so a pack can be checked. It carries no starting-model loader: no model ships with
 * the package, so a page has nothing to load. The main entry, "pac-replay-codec", has it.
 *
 * @interacts web/lib/encode.js (the module these types describe)
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

export interface PackOptions {
  /** false: never use the PAC mini-game formulas, whatever the game version (default true). */
  gameAware?: boolean;
}

export interface PackResult {
  /** The packed file ("CLRZ" container). */
  bytes: Uint8Array;
  /** Which predictor set was used: 0 the schema alone, 1 the schema plus the PAC mini-game formulas. */
  predictors: number;
  /** 0 coded, 1 stored (the input was not a replay, or would not shrink, and sits in the container as it is). */
  mode: number;
  /** Always 0 here: this entry packs without a starting model. */
  priorId: number;
  /** The coder's counters; null in stored mode. */
  stats: CodecStats | null;
  /** Always null here. */
  codec: unknown;
  /** Null in normal use. A message when the coder failed on this input and the file was stored instead. */
  error: string | null;
}

/**
 * Pack a replay. Never throws: an input that is not a replay, or that would not shrink, is stored as it is inside
 * the container, so every input packs and unpacks.
 */
export function packReplay(src: Uint8Array, opts?: PackOptions): PackResult;

/**
 * Unpack a .paczd file to the original bytes. Checks the size and the crc32 of what it rebuilt and throws if the
 * packed bytes are damaged; it never returns wrong bytes. Use it right after packReplay to check a pack: unpack
 * it and compare with the original before the original is let go.
 */
export function unpackReplay(packed: Uint8Array): Uint8Array;
