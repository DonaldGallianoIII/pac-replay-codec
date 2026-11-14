/**
 * One packing worker. Takes a file's bytes, decides from the first four bytes whether to pack or unpack, and
 * answers with the result. A packed file is unpacked again here and compared byte for byte with the original
 * before it is handed back, so "exact" on the page is a check that ran, not a promise.
 *
 * Message in:  { id, bytes: ArrayBuffer }                       (the buffer is transferred)
 * Message out: { id, ok: true, kind, out: ArrayBuffer, inSize, outSize, crc, outCrc, stored, note, ms }
 *              crc is the crc32 of the original replay, outCrc the crc32 of the file handed back
 *              { id, ok: false, kind, inSize, error, ms }
 *
 * @interacts app.js (its only caller), lib/index.js (the codec)
 * @deps      lib/index.js: packReplay, unpackReplay, crc32, CONTAINER_MAGIC, MODE_STORED
 * @complexity O(F) per message, F = file size: one pack, one unpack, one compare, up to two crc32 passes
 * @alloc     the packed and the rebuilt copy of one file (about 55 MB of coder tables while packing a 3.4 MB
 *            replay), released when the message is answered
 */
import { packReplay, unpackReplay, crc32, CONTAINER_MAGIC, MODE_STORED } from './lib/index.js';

/** @complexity O(1) */
function isPacked(b) {
  if (b.length < CONTAINER_MAGIC.length) return false;
  for (let i = 0; i < CONTAINER_MAGIC.length; i++) if (b[i] !== CONTAINER_MAGIC[i]) return false;
  return true;
}

/** @complexity O(n) over the shorter array */
function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

self.onmessage = (event) => {
  const { id, bytes } = event.data;
  const src = new Uint8Array(bytes);
  const kind = isPacked(src) ? 'unpack' : 'pack';
  const t0 = performance.now();
  try {
    if (kind === 'unpack') {
      // unpackReplay checks the size and the crc32 stored in the header, and throws rather than return wrong bytes.
      const out = unpackReplay(src);
      const crc = crc32(out);
      const msg = { id, ok: true, kind, out: out.buffer, inSize: src.length, outSize: out.length, crc, outCrc: crc,
        stored: false, note: null, ms: performance.now() - t0 };
      self.postMessage(msg, [out.buffer]);
      return;
    }
    const result = packReplay(src);
    const packed = result.bytes;
    const back = unpackReplay(packed);
    if (!sameBytes(back, src)) throw new Error('round trip did not give the same bytes back, nothing was written');
    const stored = result.mode === MODE_STORED;
    const note = stored ? (result.error ?? 'not a replay this codec knows, kept as it was inside the container') : null;
    const out = packed.slice().buffer;
    const msg = { id, ok: true, kind, out, inSize: src.length, outSize: packed.length, crc: crc32(src),
      outCrc: crc32(packed), stored, note, ms: performance.now() - t0 };
    self.postMessage(msg, [out]);
  } catch (err) {
    self.postMessage({ id, ok: false, kind, inSize: src.length, error: String(err && err.message ? err.message : err),
      ms: performance.now() - t0 });
  }
};
