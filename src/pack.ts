/**
 * Pack a replay into a .paczd file: pick the predictor set, run the coder, and write the container header
 * (container.ts) in front of the coded body. An input that is not a replay, or that would not shrink, is stored
 * as it is inside the container, so every input packs and unpacks.
 *
 * The codec reads the type table from the replay's own handshake, so it follows schema changes between game
 * versions by itself. Only the mini-game formulas are tied to a game version: a 6.11.x replay uses them, a replay
 * of any other version is coded with and without them and keeps the smaller, and the choice is written in the
 * header so the unpacker never has to guess.
 *
 * @interacts codec.ts (the coder), container.ts and clrp.ts (header layout), prior.ts (the starting model), crc32.ts
 * @deps      codec.ts, container.ts, clrp.ts, prior.ts, crc32.ts, build.ts (MEASURE)
 * @complexity O(file): one pass to code (two for a game version this build does not name), one crc32 pass
 * @alloc     the packed bytes, plus the coder's tables for the length of the call
 */
import { Codec } from './codec.ts';
import type { CodecStats } from './codec.ts';
import { crc32 } from './crc32.ts';
import { HEADER_FIXED_BYTES, MAGIC_BYTES, VARINT_BASE, VARINT_CONTINUE, hasHeader, u32At, firstHandshakeBody } from './clrp.ts';
import {
  CONTAINER_MAGIC, FORMAT_VERSION, PREDICTORS_SCHEMA, PREDICTORS_PAC_MINIGAME, MODE_CODED, MODE_STORED, MODE_PRIOR,
  U32_BYTES, BITS_PER_BYTE, MAX_ORIGINAL_BYTES, EXPANSION_MAX,
} from './container.ts';
import type { Prior } from './prior.ts';
import { MEASURE } from './build.ts';

/**
 * The game versions whose mini-game formulas this build knows, as the exact text PAC's recorder writes at the
 * start of the meta block's "game" object. Any other version (older, newer, v7's "6.11" with no patch number, or a
 * recorder that orders its keys differently) is coded both ways and keeps the smaller (codeEitherWay).
 */
const GAME_VERSION_MARKS = ['"game":{"version":"6.11.'];

/**
 * True when the replay's meta block names a game version whose mini-game formulas this build knows: such a replay
 * is coded once, with them.
 * @complexity O(meta block) @alloc none
 */
export function knowsGameVersion(src: Uint8Array): boolean {
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

export interface PackOptions {
  /** false: never use the mini-game formulas, whatever the game version (default true). */
  gameAware?: boolean;
  /**
   * Collect bit costs and decision counts by role (slower; for measurement). Only a build with MEASURE does: run
   * from source it works, the packaged library ignores it.
   */
  account?: boolean;
  /** A starting model (parsePrior). Used when it knows the replay's type table; else the replay is packed cold. */
  prior?: Prior | null;
  /** true: use the starting model even when the replay's type table is not the one it was trained on. */
  priorAlways?: boolean;
}

export interface PackResult {
  bytes: Uint8Array;
  /** Which predictor set was used (PREDICTORS_*). */
  predictors: number;
  /** MODE_CODED, MODE_STORED or MODE_PRIOR. */
  mode: number;
  /** Id of the starting model the file needs to be unpacked, or 0 when it needs none. */
  priorId: number;
  /** The coder's counters; null in stored mode. */
  stats: CodecStats | null;
  /**
   * The coder itself, for measurement scripts that read its accounting. Null in stored mode, and always null in a
   * build without MEASURE (the packaged library): there it would only keep the coder's tables alive.
   */
  codec: Codec | null;
  /**
   * Null in normal use. A message when the coder failed on this input and the file was stored instead, or when the
   * starting model did not fit this build and the file was packed cold (the mode says which).
   */
  error: string | null;
}

/** One coding pass with one predictor set: the coder, its body (null when it failed or declined), and why. */
interface Attempt {
  predictors: number;
  prior: Prior | null;
  codec: Codec | null;
  body: Uint8Array | null;
  error: string | null;
}

/**
 * Code `src` once with one predictor set. A starting model that does not fit this build is dropped (packed cold); a
 * coder error leaves body null with the reason in error, so the caller stores the file instead of losing it.
 * @interacts codec.ts @deps codec.ts
 * @complexity O(file) @alloc the coded body and the coder's tables
 */
function codeWith(src: Uint8Array, predictors: number, prior: Prior | null, account: boolean): Attempt {
  const gameAware = predictors === PREDICTORS_PAC_MINIGAME;
  const rawLen = src.length;
  let codec: Codec;
  let body: Uint8Array | null = null;
  let error: string | null = null;
  try {
    codec = new Codec(src, true, { gameAware, account, rawLen, prior });
  } catch (e) {
    // a starting model made for another build of the coder: pack cold and say so, never fail
    error = e instanceof Error ? e.message : String(e);
    prior = null;
    codec = new Codec(src, true, { gameAware, account, rawLen, prior });
  }
  try {
    body = codec.encode();
  } catch (e) {
    // a bug in the coder must never cost a replay: the file is stored as it is, and the caller is told why
    error = e instanceof Error ? e.message : String(e);
  }
  if (body !== null && src.length > (body.length + 1) * EXPANSION_MAX) {
    // shrinks more than the unpacker accepts: store it, so the file can always be unpacked
    error = `shrinks more than ${EXPANSION_MAX} to 1, stored as it is`;
    body = null;
  }
  return { predictors, prior, codec, body, error };
}

/**
 * Pick the predictor set for a replay whose game version this build does not name (a newer or older PAC, or v7,
 * whose recorder writes "version":"6.11" with no patch number). The mini-game formulas may or may not still fit,
 * so both sets are tried and the smaller body wins; a tie keeps the schema set. When the formulas throw on this
 * input, the schema pass stands on its own.
 * @interacts codeWith @deps codec.ts
 * @complexity O(file) twice @alloc both bodies and both coders' tables, for the length of the call
 */
function codeEitherWay(src: Uint8Array, prior: Prior | null, account: boolean): Attempt {
  const schema = codeWith(src, PREDICTORS_SCHEMA, prior, account);
  let game: Attempt | null = null;
  try {
    game = codeWith(src, PREDICTORS_PAC_MINIGAME, prior, account);
  } catch {
    game = null;
  }
  if (game === null || game.body === null) return schema;
  if (schema.body === null || game.body.length < schema.body.length) return game;
  return schema;
}

/**
 * Pack a replay. Any input packs: one that is not a replay, or that would not shrink, is stored as it is. A
 * starting model is used only when it knows the replay's type table (or when forced); a replay it does not know
 * is packed cold, exactly as without it.
 *
 * Predictor set: 6.11.x replays (knowsGameVersion) use the mini-game formulas, one pass. Any other replay is coded
 * both ways and keeps the smaller (codeEitherWay). gameAware: false forces the schema set, one pass.
 * @interacts codec.ts @deps codec.ts
 * @complexity O(file); two coding passes for a replay of a game version this build does not name
 * @alloc the packed bytes and the coder's tables (two of each, briefly, on the two-pass path)
 */
export function packReplay(src: Uint8Array, opts: PackOptions = {}): PackResult {
  const prior = opts.prior != null && (opts.priorAlways === true || priorKnows(opts.prior, src)) ? opts.prior : null;
  const account = opts.account === true;
  let attempt: Attempt;
  if (src.length > MAX_ORIGINAL_BYTES) {
    // the unpacker refuses a coded file this large, so it is stored as it is
    attempt = { predictors: PREDICTORS_SCHEMA, prior: null, codec: null, body: null, error: `larger than ${MAX_ORIGINAL_BYTES} bytes, stored as it is` };
  } else if (opts.gameAware === false || !hasHeader(src)) {
    attempt = codeWith(src, PREDICTORS_SCHEMA, prior, account);
  } else if (knowsGameVersion(src)) {
    attempt = codeWith(src, PREDICTORS_PAC_MINIGAME, prior, account);
  } else {
    attempt = codeEitherWay(src, prior, account);
  }
  const { predictors, codec, body, error } = attempt;
  const stored = body === null || body.length >= src.length;
  const used = stored ? null : attempt.prior;
  const payload = stored ? src : (body as Uint8Array);
  const mode = stored ? MODE_STORED : used !== null ? MODE_PRIOR : MODE_CODED;
  const head: number[] = [...CONTAINER_MAGIC, FORMAT_VERSION, stored ? PREDICTORS_SCHEMA : predictors, mode];
  if (mode === MODE_PRIOR) for (let i = 0; i < U32_BYTES; i++) head.push(((used as Prior).id >>> (i * BITS_PER_BYTE)) & 0xff);
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
  return {
    bytes, predictors: stored ? PREDICTORS_SCHEMA : predictors, mode, priorId: mode === MODE_PRIOR ? (used as Prior).id : 0,
    stats: stored || codec === null ? null : codec.stats, codec: MEASURE && !stored ? codec : null, error,
  };
}

/**
 * True when the starting model was trained on this replay's type table: the body of the replay's first handshake
 * frame is, byte for byte, the one the model carries. A model that carries none knows no replay.
 * @complexity O(type table), about 31 KB compared @alloc none
 */
function priorKnows(prior: Prior, src: Uint8Array): boolean {
  const hs = prior.handshake;
  const at = firstHandshakeBody(src);
  if (hs.length === 0 || at === null || at[1] - at[0] !== hs.length) return false;
  for (let i = 0; i < hs.length; i++) if (src[at[0] + i] !== hs[i]) return false;
  return true;
}
