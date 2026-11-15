/**
 * Types for the unpack-only entry of pac-replay-codec (web/lib/decode.js, imported as "pac-replay-codec/decode").
 * Written by hand; test/types-check.ts fails the type check if they stop matching src/decode.ts.
 *
 * @interacts web/lib/decode.js (the module these types describe)
 * @deps      none
 * @complexity O(1): declarations only
 * @alloc     none
 */

/**
 * Unpack a .paczd file to the original bytes. Checks the size and the crc32 of what it rebuilt and throws if the
 * packed bytes are damaged; it never returns wrong bytes.
 *
 * This entry carries no packer and no starting-model loader. A file packed with a starting model (none ships with
 * this package) is refused with an error; unpack those with the main entry, "pac-replay-codec".
 */
export function unpackReplay(packed: Uint8Array): Uint8Array;
