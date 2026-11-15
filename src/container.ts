/**
 * The .paczd container ("CLRZ"): the numbers of its header, shared by the packer (pack.ts) and the unpacker
 * (unpack.ts).
 *
 * Layout (little endian, varint = unsigned LEB128):
 *   "CLRZ" | u8 format version = 1 | u8 predictor set | u8 mode | [u32 prior id] | varint rawLen |
 *   u32 crc32(original) | body
 *   predictor set  0 = schema only, 1 = schema + PAC mini-game 6.11 formulas
 *   mode           0 = coded (body is the range-coded replay), 1 = stored (body is the original bytes),
 *                  2 = coded from a starting model: the u32 prior id follows the mode byte, and the unpacker
 *                  needs that exact prior (prior.ts)
 *
 * @interacts none (constants only)
 * @deps      clrp.ts (MAGIC_BYTES)
 * @complexity O(1) @alloc one four-element array
 */
import { MAGIC_BYTES } from './clrp.ts';

export const CONTAINER_MAGIC = [0x43, 0x4c, 0x52, 0x5a];
export const FORMAT_VERSION = 1;
export const PREDICTORS_SCHEMA = 0;
export const PREDICTORS_PAC_MINIGAME = 1;
export const MODE_CODED = 0;
export const MODE_STORED = 1;
export const MODE_PRIOR = 2;
export const U32_BYTES = 4;
export const BITS_PER_BYTE = 8;
const MB = 1024 * 1024;
/**
 * The largest original a coded file may claim: 256 MB, about 50 times the largest real replay (5 MB). The
 * unpacker refuses a bigger claim before it allocates anything, so a crafted file cannot exhaust memory. The
 * packer stores a bigger input as it is instead of coding it, so every file it writes can be unpacked.
 */
export const MAX_ORIGINAL_BYTES = 256 * MB;
/**
 * The most original bytes a coded file may claim per packed byte. Real replays reach about 15; 1024 leaves wide
 * room. Same rule as above: the unpacker refuses more, the packer stores rather than write more.
 */
export const EXPANSION_MAX = 1024;
/** magic + version + predictor set + mode */
export const FIXED_BYTES = MAGIC_BYTES + 3;
