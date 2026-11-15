/**
 * The packing entry of the codec (pac-replay-codec/encode): for a page that saves replays packed. It packs, and it
 * unpacks, so that a pack can be unpacked again and compared with the original before anyone trusts it. That check
 * is how every tool in this repository uses the codec, and a page should do the same.
 *
 *   packReplay(original)  -> { bytes, ... } the packed file ("CLRZ" container); never fails, see pack.ts
 *   unpackReplay(packed)  -> the original bytes, bit for bit, or an error when the packed data is damaged
 *
 * Built without the starting-model loader (tools/build-web.mjs): no model ships, so a page has nothing to load.
 * packReplay here ignores the `prior` options, and unpackReplay refuses a file packed with a starting model, with
 * the error every build gives when the model is not handed in. The main entry does both.
 *
 * @interacts pack.ts (packReplay), unpack.ts (unpackReplay)
 * @deps      pack.ts, unpack.ts
 * @complexity O(1): two re-exports @alloc none
 */
export { packReplay } from './pack.ts';
export type { PackOptions, PackResult } from './pack.ts';
export { unpackReplay } from './unpack.ts';
