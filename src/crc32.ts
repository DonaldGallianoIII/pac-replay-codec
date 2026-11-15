/**
 * crc32 (the zlib polynomial), one table lookup per byte. Used for the checksum of a packed replay's original
 * bytes and for the checksum, and so the id, of a starting model file.
 *
 * @interacts none
 * @deps      none
 * @complexity O(length), about 1.5 ns per byte: 5 ms for a 3.4 MB replay
 * @alloc     one 1 KB table, built once when the module loads
 */

const CRC_POLY = 0xedb88320;
const CRC_INIT = 0xffffffff;
const BYTE_VALUES = 256;
const BITS_PER_BYTE = 8;
const CRC_TABLE = new Uint32Array(BYTE_VALUES);
for (let i = 0; i < BYTE_VALUES; i++) {
  let c = i;
  for (let k = 0; k < BITS_PER_BYTE; k++) c = (c & 1) !== 0 ? (c >>> 1) ^ CRC_POLY : c >>> 1;
  CRC_TABLE[i] = c;
}

/**
 * crc32 (the zlib polynomial) of b.
 * @interacts none @deps none @complexity O(length) @alloc none
 */
export function crc32(b: Uint8Array): number {
  let c = CRC_INIT;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> BITS_PER_BYTE);
  return (c ^ CRC_INIT) >>> 0;
}
