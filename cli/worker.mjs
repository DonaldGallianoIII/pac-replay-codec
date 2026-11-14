/**
 * One command line worker thread. Takes one job, reads the file itself, does the work, writes the output (never
 * over an existing file), and answers with one result. Packing counts only after the packed bytes have been
 * unpacked again and compared byte for byte with the original.
 *
 * Job in:     { id, cmd: 'pack' | 'unpack' | 'verify', file, out }   out is null for verify
 * Result out: { id, status, in_bytes, out_bytes, packed_input, exact, stored, error }
 *             packed_input: the input was a .clrz, so in_bytes is the packed size and out_bytes the original
 *             status: 'packed' | 'unpacked' | 'verified' | 'skipped' | 'failed'
 *
 * @interacts cli/pac-replay-codec.mjs (its only caller), the file system (reads `file`, writes `out` once)
 * @deps      web/lib/index.js (the codec as plain JavaScript), node:fs, node:path, node:worker_threads
 * @complexity O(F) per job, F = file size: pack, unpack and compare, or one unpack
 * @alloc     the file, its packed and its rebuilt copy (about 55 MB of coder tables while packing a 3.4 MB
 *            replay), released when the job is answered
 */
import { parentPort } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { packReplay, unpackReplay, CONTAINER_MAGIC, MODE_STORED } from '../web/lib/index.js';

/** @complexity O(1) */
export function isPacked(b) {
  if (b.length < CONTAINER_MAGIC.length) return false;
  for (let i = 0; i < CONTAINER_MAGIC.length; i++) if (b[i] !== CONTAINER_MAGIC[i]) return false;
  return true;
}

/** @complexity O(n) */
function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

let tmpCount = 0;

/**
 * Write `bytes` to `out` only if `out` does not exist yet. The bytes go to a temporary file first and are then
 * hard-linked into place, so a crash never leaves a half-written output, and an existing file is never replaced.
 * @returns {boolean} false when `out` already existed
 * @complexity O(n) to write
 * @alloc none beyond the write buffer the system keeps
 */
function writeNew(out, bytes, id) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = `${out}.tmp-${process.pid}-${id}-${tmpCount++}`;
  fs.writeFileSync(tmp, bytes, { flag: 'wx' });
  try {
    fs.linkSync(tmp, out);
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    // A file system without hard links: check, then rename. A race with another writer is possible only here.
    if (fs.existsSync(out)) return false;
    fs.renameSync(tmp, out);
    return true;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** @complexity O(F), see the module note */
function run(job) {
  const { id, cmd, file, out } = job;
  const src = new Uint8Array(fs.readFileSync(file));
  const packed = isPacked(src);
  const base = { id, in_bytes: src.length, out_bytes: null, packed_input: packed, exact: false, stored: false, error: null };

  if (cmd === 'pack') {
    if (packed) return { ...base, status: 'skipped', error: 'already packed' };
    if (fs.existsSync(out)) return { ...base, status: 'skipped', error: 'output exists' };
    const result = packReplay(src);
    const back = unpackReplay(result.bytes);
    if (!sameBytes(back, src)) return { ...base, status: 'failed', error: 'round trip did not give the same bytes back, nothing written' };
    if (!writeNew(out, result.bytes, id)) return { ...base, status: 'skipped', error: 'output exists' };
    return { ...base, status: 'packed', out_bytes: result.bytes.length, exact: true, stored: result.mode === MODE_STORED };
  }

  if (!packed) {
    if (cmd === 'verify') {
      // A plain replay: check that it would pack and come back exact. Nothing is written.
      const result = packReplay(src);
      const ok = sameBytes(unpackReplay(result.bytes), src);
      return { ...base, status: ok ? 'verified' : 'failed', out_bytes: result.bytes.length, exact: ok,
        stored: result.mode === MODE_STORED, error: ok ? null : 'round trip did not give the same bytes back' };
    }
    return { ...base, status: 'failed', error: 'not a .clrz file' };
  }

  // unpackReplay checks the size and the crc32 in the header and throws rather than return wrong bytes.
  const original = unpackReplay(src);
  if (cmd === 'verify') return { ...base, status: 'verified', out_bytes: original.length, exact: true };
  if (fs.existsSync(out)) return { ...base, status: 'skipped', out_bytes: original.length, error: 'output exists' };
  if (!writeNew(out, original, id)) return { ...base, status: 'skipped', out_bytes: original.length, error: 'output exists' };
  return { ...base, status: 'unpacked', out_bytes: original.length, exact: true };
}

parentPort.on('message', (job) => {
  let result;
  try {
    result = run(job);
  } catch (err) {
    result = { id: job.id, status: 'failed', in_bytes: null, out_bytes: null, packed_input: false, exact: false, stored: false,
      error: String(err && err.message ? err.message : err) };
  }
  parentPort.postMessage(result);
});
