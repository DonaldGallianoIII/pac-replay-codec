/**
 * Pack and unpack a PAC replay (.colreplay). This is the whole public surface of the codec.
 *
 *   packReplay(original)  -> packed bytes ("CLRZ" container), pack.ts
 *   unpackReplay(packed)  -> the original bytes, bit for bit, or an error when the packed data is damaged, unpack.ts
 *   parsePrior(file)      -> an optional starting model, handed to both calls (see prior.ts)
 *
 * The container layout is in container.ts. The packer picks "stored" when the input is not a replay or when coding
 * would not make it smaller, so every input packs and unpacks. The unpacker checks the size and the crc32 of what
 * it rebuilt before returning it: a damaged file, or a build whose model drifted from the one that packed it,
 * fails loudly and is never returned.
 *
 * A page that only unpacks takes decode.ts instead (pac-replay-codec/decode): the same unpackReplay, built without
 * the packer.
 *
 * @interacts pack.ts, unpack.ts, container.ts (the constants), prior.ts (the starting model file), crc32.ts
 * @deps      pack.ts, unpack.ts, container.ts, prior.ts, crc32.ts
 * @complexity O(1): re-exports only
 * @alloc     none
 */
export { packReplay, knowsGameVersion } from './pack.ts';
export type { PackOptions, PackResult } from './pack.ts';
export { unpackReplay } from './unpack.ts';
export { parsePrior } from './prior.ts';
export type { Prior } from './prior.ts';
export { crc32 } from './crc32.ts';
export {
  CONTAINER_MAGIC, FORMAT_VERSION, PREDICTORS_SCHEMA, PREDICTORS_PAC_MINIGAME, MODE_CODED, MODE_STORED, MODE_PRIOR,
  MAX_ORIGINAL_BYTES, EXPANSION_MAX,
} from './container.ts';
