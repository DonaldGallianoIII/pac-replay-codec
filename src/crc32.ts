/**
 * crc32 (the zlib polynomial), eight bytes per step. Used for the checksum of a packed replay's original bytes
 * and for the checksum, and so the id, of a starting model file.
 *
 * @interacts none
 * @deps      none
 * @complexity O(length), about 1 ns per byte
 * @alloc     one 8 KB table, built once when the module loads
 */

const CRC_POLY = 0xedb88320;
const CRC_INIT = 0xffffffff;
const BYTE_VALUES = 256;
const BITS_PER_BYTE = 8;
/** Bytes folded per step ("slicing by 8"): eight table lookups for two 32 bit words instead of one per byte. */
const CRC_SLICES = 8;
const CRC_WORD_BYTES = 4;
const CRC_TABLE = new Uint32Array(BYTE_VALUES * CRC_SLICES);
for (let i = 0; i < BYTE_VALUES; i++) {
  let c = i;
  for (let k = 0; k < BITS_PER_BYTE; k++) c = (c & 1) !== 0 ? (c >>> 1) ^ CRC_POLY : c >>> 1;
  CRC_TABLE[i] = c >>> 0;
}
for (let k = 1; k < CRC_SLICES; k++) {
  for (let i = 0; i < BYTE_VALUES; i++) {
    const prev = CRC_TABLE[(k - 1) * BYTE_VALUES + i];
    CRC_TABLE[k * BYTE_VALUES + i] = (prev >>> BITS_PER_BYTE) ^ CRC_TABLE[prev & 0xff];
  }
}
/** True on a little-endian machine, where a 32 bit view of the bytes reads them in file order. */
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/**
 * crc32 (the zlib polynomial) of b.
 * @interacts none @deps none @complexity O(length) @alloc none (one view object)
 */
export function crc32(b: Uint8Array): number {
  const t = CRC_TABLE;
  let c = CRC_INIT;
  let i = 0;
  if (LITTLE_ENDIAN && b.byteOffset % CRC_WORD_BYTES === 0 && b.length >= CRC_SLICES) {
    // two words per step; t rows 7..4 fold the first word (mixed with the running crc), rows 3..0 the second
    const words = new Uint32Array(b.buffer, b.byteOffset, b.length >>> 2);
    const pairs = words.length - (words.length % 2);
    for (let w = 0; w < pairs; w += 2) {
      const x = c ^ words[w];
      const y = words[w + 1];
      c = t[1792 + (x & 0xff)] ^ t[1536 + ((x >>> 8) & 0xff)] ^ t[1280 + ((x >>> 16) & 0xff)] ^ t[1024 + (x >>> 24)] ^
        t[768 + (y & 0xff)] ^ t[512 + ((y >>> 8) & 0xff)] ^ t[256 + ((y >>> 16) & 0xff)] ^ t[y >>> 24];
    }
    i = pairs * CRC_WORD_BYTES;
  }
  for (; i < b.length; i++) c = t[(c ^ b[i]) & 0xff] ^ (c >>> BITS_PER_BYTE);
  return (c ^ CRC_INIT) >>> 0;
}
