/**
 * Pack and unpack a PAC replay (.colreplay). This is the whole public surface of the codec.
 *
 *   packReplay(original)  -> packed bytes ("CLRZ" container)
 *   unpackReplay(packed)  -> the original bytes, bit for bit, or an error when the packed data is damaged
 *   parsePrior(file)      -> an optional starting model, handed to both calls (see prior.ts)
 *
 * Container (little endian, varint = unsigned LEB128):
 *   "CLRZ" | u8 format version = 1 | u8 predictor set | u8 mode | [u32 prior id] | varint rawLen |
 *   u32 crc32(original) | body
 *   predictor set  0 = schema only, 1 = schema + PAC mini-game 6.11 formulas (see GAME_VERSION_MARK)
 *   mode           0 = coded (body is the range-coded replay), 1 = stored (body is the original bytes),
 *                  2 = coded from a starting model: the u32 prior id follows the mode byte, and the unpacker
 *                  needs that exact prior (prior.ts)
 *
 * The packer picks "stored" when the input is not a replay or when coding would not make it smaller, so every
 * input packs and unpacks. The unpacker checks the size and the crc32 of what it rebuilt before returning it: a
 * damaged file, or a build whose model drifted from the one that packed it, fails loudly and is never returned.
 *
 * The codec reads the type table from the replay's own handshake, so it follows schema changes between game
 * versions by itself. Only the mini-game formulas are tied to a game version: they are used when the replay's
 * meta block names a version this build knows, and the choice is written in the header so the unpacker never has
 * to guess.
 *
 * @interacts codec.ts (the coder), clrp.ts (header layout), prior.ts (the starting model file), crc32.ts
 * @deps      codec.ts, clrp.ts, prior.ts, crc32.ts
 * @complexity O(file): one pass to code, one table-driven crc32 pass (about 1 ns per byte)
 * @alloc     the packed or unpacked bytes, plus the coder's tables for the length of the call
 */
import { Codec } from './codec.js';
import { crc32 } from './crc32.js';

export { crc32 };
                                             
import { HEADER_FIXED_BYTES, MAGIC_BYTES, VARINT_BASE, VARINT_CONTINUE, VARINT_DATA, VARINT_MAX_BYTES, hasHeader, u32At, firstHandshakeBody } from './clrp.js';
import { parsePrior } from './prior.js';
                                        

export { parsePrior };
                      

export const CONTAINER_MAGIC = [0x43, 0x4c, 0x52, 0x5a];
export const FORMAT_VERSION = 1;
export const PREDICTORS_SCHEMA = 0;
export const PREDICTORS_PAC_MINIGAME = 1;
export const MODE_CODED = 0;
export const MODE_STORED = 1;
export const MODE_PRIOR = 2;
const U32_BYTES = 4;
/** An unpacker refuses a header that claims more than this many original bytes per packed byte. */
const EXPANSION_MAX = 65536;
/** magic + version + predictor set + mode */
const FIXED_BYTES = MAGIC_BYTES + 3;
const BITS_PER_BYTE = 8;

/**
 * The game versions whose mini-game formulas this build knows, as the exact text PAC's recorder writes at the
 * start of the meta block's "game" object. Any other version (older, newer, or a recorder that orders its keys
 * differently) is packed with the schema alone.
 */
const GAME_VERSION_MARKS = ['"game":{"version":"6.11.'];

/**
 * True when the replay's meta block names a game version whose mini-game formulas this build knows.
 * @complexity O(meta block) @alloc none
 */
export function knowsGameVersion(src            )          {
  if (!hasHeader(src)) return false;
  const end = HEADER_FIXED_BYTES + u32At(src, MAGIC_BYTES + 1);
  for (const mark of GAME_VERSION_MARKS) {
    const n = mark.length;
    for (let at = HEADER_FIXED_BYTES; at + n <= end; at++) {
      let k = 0;
      while (k < n && src[at + k] === mark.charCodeAt(k)) k++;
      if (k === n) return true;
    }
  }
  return false;
}

                              
                                                                                           
                      
                                                                                 
                    
                                                                                                                   
                       
                                                                                                         
                        
 

                             
                    
                                                     
                     
                                               
               
                                                                                         
                  
                                                   
                           
                                                                                                 
                      
     
                                                                                                                   
                                                                                              
     
                       
 

/**
 * Pack a replay. Any input packs: one that is not a replay, or that would not shrink, is stored as it is. A
 * starting model is used only when it knows the replay's type table (or when forced); a replay it does not know
 * is packed cold, exactly as without it.
 * @interacts codec.ts @deps codec.ts
 * @complexity O(file) @alloc the packed bytes and the coder's tables
 */
export function packReplay(src            , opts              = {})             {
  const predictors = opts.gameAware !== false && knowsGameVersion(src) ? PREDICTORS_PAC_MINIGAME : PREDICTORS_SCHEMA;
  let prior = opts.prior != null && (opts.priorAlways === true || priorKnows(opts.prior, src)) ? opts.prior : null;
  const codecOptions = { gameAware: predictors === PREDICTORS_PAC_MINIGAME, account: opts.account === true, rawLen: src.length };
  let codec       ;
  let body                    = null;
  let error                = null;
  try {
    codec = new Codec(src, true, { ...codecOptions, prior });
  } catch (e) {
    // a starting model made for another build of the coder: pack cold and say so, never fail
    error = e instanceof Error ? e.message : String(e);
    prior = null;
    codec = new Codec(src, true, { ...codecOptions, prior });
  }
  try {
    body = codec.encode();
  } catch (e) {
    // a bug in the coder must never cost a replay: the file is stored as it is, and the caller is told why
    error = e instanceof Error ? e.message : String(e);
  }
  const stored = body === null || body.length >= src.length;
  const payload = stored ? src : (body              );
  const mode = stored ? MODE_STORED : prior !== null ? MODE_PRIOR : MODE_CODED;
  const head           = [...CONTAINER_MAGIC, FORMAT_VERSION, stored ? PREDICTORS_SCHEMA : predictors, mode];
  if (mode === MODE_PRIOR) for (let i = 0; i < U32_BYTES; i++) head.push(((prior         ).id >>> (i * BITS_PER_BYTE)) & 0xff);
  let v = src.length;
  while (v >= VARINT_BASE) {
    head.push((v % VARINT_BASE) | VARINT_CONTINUE);
    v = Math.floor(v / VARINT_BASE);
  }
  head.push(v);
  const crc = crc32(src);
  for (let i = 0; i < U32_BYTES; i++) head.push((crc >>> (i * BITS_PER_BYTE)) & 0xff);
  const bytes = new Uint8Array(head.length + payload.length);
  bytes.set(head);
  bytes.set(payload, head.length);
  return { bytes, predictors: stored ? PREDICTORS_SCHEMA : predictors, mode, priorId: mode === MODE_PRIOR ? (prior         ).id : 0, stats: stored ? null : codec.stats, codec: stored ? null : codec, error };
}

/**
 * True when the starting model was trained on this replay's type table: the body of the replay's first handshake
 * frame is, byte for byte, the one the model carries. A model that carries none knows no replay.
 * @complexity O(type table), about 31 KB compared @alloc none
 */
function priorKnows(prior       , src            )          {
  const hs = prior.handshake;
  const at = firstHandshakeBody(src);
  if (hs.length === 0 || at === null || at[1] - at[0] !== hs.length) return false;
  for (let i = 0; i < hs.length; i++) if (src[at[0] + i] !== hs[i]) return false;
  return true;
}

/**
 * Unpack what packReplay made. Throws when the bytes are not a CLRZ container this build reads, when the file
 * needs a starting model that is not among `priors`, or when the rebuilt file fails its size or crc32 check.
 * @param priors every starting model this caller has (parsePrior); a file names the one it needs by id
 * @interacts codec.ts @deps codec.ts
 * @complexity O(file) @alloc the original bytes and the coder's tables
 */
export function unpackReplay(packed            , priors                   = [])             {
  if (packed.length < FIXED_BYTES + 1 + U32_BYTES) throw new Error('not a CLRZ file');
  for (let i = 0; i < MAGIC_BYTES; i++) if (packed[i] !== CONTAINER_MAGIC[i]) throw new Error('not a CLRZ file');
  if (packed[MAGIC_BYTES] !== FORMAT_VERSION) throw new Error(`CLRZ format version ${packed[MAGIC_BYTES]} is not supported`);
  const predictors = packed[MAGIC_BYTES + 1];
  const mode = packed[MAGIC_BYTES + 2];
  if (predictors !== PREDICTORS_SCHEMA && predictors !== PREDICTORS_PAC_MINIGAME) throw new Error(`predictor set ${predictors} is not known to this build`);
  if (mode !== MODE_CODED && mode !== MODE_STORED && mode !== MODE_PRIOR) throw new Error(`CLRZ mode ${mode} is not supported`);
  let p = FIXED_BYTES;
  let prior               = null;
  if (mode === MODE_PRIOR) {
    if (p + U32_BYTES > packed.length) throw new Error('CLRZ header is damaged');
    const id = u32At(packed, p);
    p += U32_BYTES;
    for (const candidate of priors) if (candidate.id === id) prior = candidate;
    if (prior === null) throw new Error(`this file needs starting model ${id.toString(16).padStart(8, '0')}, which was not given`);
  }
  let rawLen = 0;
  let scale = 1;
  let n = 0;
  let x        ;
  do {
    if (p >= packed.length || n === VARINT_MAX_BYTES) throw new Error('CLRZ header is damaged');
    x = packed[p++];
    rawLen += (x & VARINT_DATA) * scale;
    scale *= VARINT_BASE;
    n++;
  } while ((x & VARINT_CONTINUE) !== 0);
  if (p + U32_BYTES > packed.length) throw new Error('CLRZ header is damaged');
  const crc = u32At(packed, p);
  p += U32_BYTES;
  const body = packed.subarray(p);
  if (rawLen > (body.length + 1) * EXPANSION_MAX) throw new Error('CLRZ header is damaged');
  let out            ;
  if (mode === MODE_STORED) {
    if (body.length !== rawLen) throw new Error('packed data is damaged');
    out = body.slice();
  } else {
    out = new Codec(body, false, { gameAware: predictors === PREDICTORS_PAC_MINIGAME, account: false, rawLen, prior }).decode();
  }
  if (crc32(out) !== crc) throw new Error('packed data is damaged (crc32 mismatch)');
  return out;
}
