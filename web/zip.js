/**
 * A minimal zip writer for "download all". Files are stored, not deflated: packed files do not shrink further,
 * and a restored replay is the user's own original. Every entry gets the same fixed timestamp (1980-01-01), so the
 * same inputs always give the same zip.
 *
 * @interacts app.js (download all)
 * @deps      none (the crc32 of each file comes from the worker that made it)
 * @complexity O(N) where N is the number of files (at most ZIP_MAX_ENTRIES): bytes are referenced, not copied
 * @alloc     one Blob that references the file blobs plus about 100 bytes of headers per file
 */
const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const VERSION_NEEDED = 20;
const FLAG_UTF8_NAMES = 0x0800;
const METHOD_STORED = 0;
const DOS_TIME_ZERO = 0;
/** 1980-01-01 in DOS date format: (year - 1980) << 9 | month << 5 | day. */
const DOS_DATE_1980 = (1 << 5) | 1;
const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const END_RECORD_BYTES = 22;
/** Plain zip (not zip64) counts entries in 16 bits and sizes in 32 bits. */
export const ZIP_MAX_ENTRIES = 0xffff;
export const ZIP_MAX_BYTES = 0xffffffff;

/**
 * Build a zip of the given files.
 * @param {{ name: string, blob: Blob, crc: number }[]} files  crc is the crc32 of the blob's bytes, already known
 * @returns {Blob}
 * @complexity O(N): the file bytes are referenced, not read
 * @alloc one header buffer per file, one central header per file, one Blob
 */
export function makeZip(files) {
  if (files.length > ZIP_MAX_ENTRIES) throw new Error(`a zip holds at most ${ZIP_MAX_ENTRIES} files`);
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = f.crc >>> 0;
    const size = f.blob.size;
    const local = new DataView(new ArrayBuffer(LOCAL_HEADER_BYTES));
    local.setUint32(0, SIG_LOCAL, true);
    local.setUint16(4, VERSION_NEEDED, true);
    local.setUint16(6, FLAG_UTF8_NAMES, true);
    local.setUint16(8, METHOD_STORED, true);
    local.setUint16(10, DOS_TIME_ZERO, true);
    local.setUint16(12, DOS_DATE_1980, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(local, name, f.blob);
    central.push({ name, crc, size, offset });
    offset += LOCAL_HEADER_BYTES + name.length + size;
    if (offset > ZIP_MAX_BYTES) throw new Error('the files are too large for one zip, download them one by one');
  }
  const cdStart = offset;
  for (const c of central) {
    const h = new DataView(new ArrayBuffer(CENTRAL_HEADER_BYTES));
    h.setUint32(0, SIG_CENTRAL, true);
    h.setUint16(4, VERSION_NEEDED, true);
    h.setUint16(6, VERSION_NEEDED, true);
    h.setUint16(8, FLAG_UTF8_NAMES, true);
    h.setUint16(10, METHOD_STORED, true);
    h.setUint16(12, DOS_TIME_ZERO, true);
    h.setUint16(14, DOS_DATE_1980, true);
    h.setUint32(16, c.crc, true);
    h.setUint32(20, c.size, true);
    h.setUint32(24, c.size, true);
    h.setUint16(28, c.name.length, true);
    h.setUint32(42, c.offset, true);
    parts.push(h, c.name);
    offset += CENTRAL_HEADER_BYTES + c.name.length;
  }
  const end = new DataView(new ArrayBuffer(END_RECORD_BYTES));
  end.setUint32(0, SIG_END, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, offset - cdStart, true);
  end.setUint32(16, cdStart, true);
  parts.push(end);
  return new Blob(parts, { type: 'application/zip' });
}
