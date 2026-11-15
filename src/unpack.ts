/**
 * Unpack a .paczd file: read the container header (container.ts), then hand the body to the coder or, for a stored
 * file, copy it out. The size and the crc32 of what was rebuilt are checked before anything is returned: a damaged
 * file, or a build whose model drifted from the one that packed it, fails loudly and is never returned.
 *
 * A build without PRIOR (the unpack-only file, build.ts) carries no starting-model loader. It refuses a mode 2
 * file with the error every build gives when the model was not handed in.
 *
 * @interacts codec.ts (the coder), container.ts and clrp.ts (header layout), crc32.ts
 * @deps      codec.ts, container.ts, clrp.ts, crc32.ts, build.ts (PRIOR)
 * @complexity O(file): one pass to decode, one table-driven crc32 pass (about 1 ns per byte)
 * @alloc     the original bytes, plus the coder's tables for the length of the call
 */
import { Codec } from './codec.ts';
import { crc32 } from './crc32.ts';
import { MAGIC_BYTES, VARINT_BASE, VARINT_CONTINUE, VARINT_DATA, VARINT_MAX_BYTES, u32At } from './clrp.ts';
import {
  CONTAINER_MAGIC, FORMAT_VERSION, PREDICTORS_SCHEMA, PREDICTORS_PAC_MINIGAME, MODE_CODED, MODE_STORED, MODE_PRIOR,
  U32_BYTES, FIXED_BYTES, MAX_ORIGINAL_BYTES, EXPANSION_MAX,
} from './container.ts';
import type { Prior } from './prior.ts';
import { PRIOR } from './build.ts';

const NOT_CLRZ = 'not a CLRZ file';
const HEADER_DAMAGED = 'CLRZ header is damaged';

/**
 * Unpack what packReplay made. Throws when the bytes are not a CLRZ container this build reads, when the file
 * needs a starting model that is not among `priors`, or when the rebuilt file fails its size or crc32 check.
 * @param priors every starting model this caller has (parsePrior); a file names the one it needs by id. A build
 *               without PRIOR ignores the list
 * @interacts codec.ts @deps codec.ts
 * @complexity O(file) @alloc the original bytes and the coder's tables
 */
export function unpackReplay(packed: Uint8Array, priors: readonly Prior[] = []): Uint8Array {
  if (packed.length < FIXED_BYTES + 1 + U32_BYTES) throw new Error(NOT_CLRZ);
  for (let i = 0; i < MAGIC_BYTES; i++) if (packed[i] !== CONTAINER_MAGIC[i]) throw new Error(NOT_CLRZ);
  if (packed[MAGIC_BYTES] !== FORMAT_VERSION) throw new Error(`CLRZ format version ${packed[MAGIC_BYTES]} is not supported`);
  const predictors = packed[MAGIC_BYTES + 1];
  const mode = packed[MAGIC_BYTES + 2];
  if (predictors !== PREDICTORS_SCHEMA && predictors !== PREDICTORS_PAC_MINIGAME) throw new Error(`predictor set ${predictors} is not known to this build`);
  if (mode !== MODE_CODED && mode !== MODE_STORED && mode !== MODE_PRIOR) throw new Error(`CLRZ mode ${mode} is not supported`);
  let p = FIXED_BYTES;
  let prior: Prior | null = null;
  if (mode === MODE_PRIOR) {
    if (p + U32_BYTES > packed.length) throw new Error(HEADER_DAMAGED);
    const id = u32At(packed, p);
    p += U32_BYTES;
    if (PRIOR) for (const candidate of priors) if (candidate.id === id) prior = candidate;
    if (prior === null) throw new Error(`this file needs starting model ${id.toString(16).padStart(8, '0')}, which was not given`);
  }
  let rawLen = 0;
  let scale = 1;
  let n = 0;
  let x: number;
  do {
    if (p >= packed.length || n === VARINT_MAX_BYTES) throw new Error(HEADER_DAMAGED);
    x = packed[p++];
    rawLen += (x & VARINT_DATA) * scale;
    scale *= VARINT_BASE;
    n++;
  } while ((x & VARINT_CONTINUE) !== 0);
  if (p + U32_BYTES > packed.length) throw new Error(HEADER_DAMAGED);
  const crc = u32At(packed, p);
  p += U32_BYTES;
  const body = packed.subarray(p);
  let out: Uint8Array;
  if (mode === MODE_STORED) {
    // a stored body is the original itself, so its size claim cannot make the unpacker allocate more than the file
    if (body.length !== rawLen) throw new Error('packed data is damaged');
    out = body.slice();
  } else {
    // checked before the coder allocates rawLen bytes: a crafted header must not exhaust memory
    if (rawLen > MAX_ORIGINAL_BYTES || rawLen > (body.length + 1) * EXPANSION_MAX) throw new Error(HEADER_DAMAGED);
    out = new Codec(body, false, { gameAware: predictors === PREDICTORS_PAC_MINIGAME, account: false, rawLen, prior }).decode();
  }
  if (crc32(out) !== crc) throw new Error('packed data is damaged (crc32 mismatch)');
  return out;
}
