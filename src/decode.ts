/**
 * The unpack-only entry of the codec (pac-replay-codec/decode): for a page that shows replays and never packs
 * one. Built with the encoder left out (tools/build-web.mjs), so it is a little over half the size of the full
 * library.
 *
 *   unpackReplay(packed)  -> the original bytes, bit for bit, or an error when the packed data is damaged
 *
 * It reads every file packReplay writes without a starting model, which is every file the command line tool and
 * the web page have ever written. A file packed with a starting model (mode 2 in the header) is refused here with
 * the same error the full library gives when the model is not handed in; unpack those with the main entry.
 *
 * @interacts unpack.ts (unpackReplay)
 * @deps      unpack.ts
 * @complexity O(1): one re-export @alloc none
 */
export { unpackReplay } from './unpack.ts';
