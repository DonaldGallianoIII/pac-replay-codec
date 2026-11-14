/**
 * PAC's .colreplay container ("CLRP"), as far as the codec needs it: the constants of the layout and the two
 * helpers that find its edges. It follows upstream app/public/src/game/replay-format.ts (decodeReplayV1).
 *
 * Layout (little endian, varint = unsigned LEB128):
 *   "CLRP" | u8 version=1 | u32 metaLen | meta JSON | frames | optional trailer
 *   frame:   u8 kind (0 handshake, 1 state, 2 patch, 3 message) | varint tDelta
 *            state-like: varint offset | varint len | len bytes
 *            message:    u8 typeTag (0 number, 1 string) | type | u8 enc (0 msgpack, 1 bytes, 2 none) | [varint len | bytes]
 *   trailer: summary JSON | u32 summaryLen | "CLTR"
 *
 * The codec rebuilds every varint in its shortest form, so a frame whose varints are longer than needed ends the
 * frame list and the rest of the file is kept as plain bytes. PAC's recorder always writes the shortest form.
 *
 * @interacts none (pure over the bytes it is given)
 * @deps      none
 * @complexity O(1) per call
 * @alloc     none
 */

export const MAGIC = [0x43, 0x4c, 0x52, 0x50];
export const TRAILER_MAGIC = [0x43, 0x4c, 0x54, 0x52];
export const VERSION = 1;
/** magic 4 + version 1 + metaLen 4 */
export const HEADER_FIXED_BYTES = 9;
/** u32 summaryLen + magic 4 */
export const TRAILER_FOOTER_BYTES = 8;
export const MAGIC_BYTES = 4;
export const KIND_HANDSHAKE = 0;
export const KIND_STATE = 1;
export const KIND_PATCH = 2;
export const KIND_MESSAGE = 3;
export const TYPE_TAG_NUMBER = 0;
export const TYPE_TAG_STRING = 1;
export const ENC_MSGPACK = 0;
export const ENC_BYTES = 1;
export const ENC_NONE = 2;
export const VARINT_CONTINUE = 0x80;
export const VARINT_DATA = 0x7f;
export const VARINT_BASE = 128;
/** Longest varint the codec accepts: 7 bytes hold 49 bits, exact in a double. */
export const VARINT_MAX_BYTES = 7;

/** Little-endian u32 at p. @complexity O(1) @alloc none */
export function u32At(b: Uint8Array, p: number): number {
  return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16)) + b[p + 3] * 0x1000000;
}

/**
 * True when the file starts with a CLRP header whose meta block fits inside it.
 * @complexity O(1) @alloc none
 */
export function hasHeader(b: Uint8Array): boolean {
  if (b.length < HEADER_FIXED_BYTES) return false;
  for (let i = 0; i < MAGIC_BYTES; i++) if (b[i] !== MAGIC[i]) return false;
  if (b[MAGIC_BYTES] !== VERSION) return false;
  return HEADER_FIXED_BYTES + u32At(b, MAGIC_BYTES + 1) <= b.length;
}

/**
 * Where the trailer summary starts, or -1 when the file has no trailer. A trailer is: the magic at the very end,
 * a u32 length before it, and that many bytes before the length, none of them before `framesStart`. The summary
 * is not parsed: whatever bytes are there are kept.
 * @complexity O(1) @alloc none
 */
export function trailerStart(b: Uint8Array, framesStart: number): number {
  const L = b.length;
  if (L - framesStart < TRAILER_FOOTER_BYTES) return -1;
  for (let i = 0; i < MAGIC_BYTES; i++) if (b[L - MAGIC_BYTES + i] !== TRAILER_MAGIC[i]) return -1;
  const lenPos = L - TRAILER_FOOTER_BYTES;
  const summaryLen = u32At(b, lenPos);
  const start = lenPos - summaryLen;
  if (summaryLen === 0 || start < framesStart) return -1;
  return start;
}

/**
 * Where the body of the first frame starts and ends when that frame is a handshake (the type table every replay
 * opens with), or null. Used to see, before anything is coded, whether a starting model knows this type table.
 * @returns [start, end) offsets into b, or null when the first frame is not a well-formed handshake
 * @complexity O(1) @alloc one small array
 */
export function firstHandshakeBody(b: Uint8Array): [number, number] | null {
  if (!hasHeader(b)) return null;
  let p = HEADER_FIXED_BYTES + u32At(b, MAGIC_BYTES + 1);
  if (p >= b.length || b[p] !== KIND_HANDSHAKE) return null;
  p++;
  // three varints: time delta, offset of the body inside the payload, payload length
  const v = [0, 0, 0];
  for (let k = 0; k < v.length; k++) {
    let scale = 1;
    let n = 0;
    let x: number;
    do {
      if (p >= b.length || n === VARINT_MAX_BYTES) return null;
      x = b[p++];
      v[k] += (x & VARINT_DATA) * scale;
      scale *= VARINT_BASE;
      n++;
    } while ((x & VARINT_CONTINUE) !== 0);
  }
  const offset = v[1];
  const len = v[2];
  if (offset > len || p + len > b.length) return null;
  return [p + offset, p + len];
}
