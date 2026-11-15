# Changelog

## 1.1.0 (not published yet)

Smaller code, same format. Every file packed by 1.0.0 or 1.0.1 unpacks, 1.0.0 and 1.0.1 unpack every file this
version packs, and this version packs to the same bytes as 1.0.1.

- **Two new entries for web apps.** `pac-replay-codec/decode` is `unpackReplay` alone, for a page that shows
  replays. `pac-replay-codec/encode` is `packReplay` plus `unpackReplay`, for a page that saves replays packed
  and checks each pack. The main entry is unchanged in what it offers.
- **Size, as an app's bundler emits it** (esbuild, bundle and minify, target ES2016):

  | What the app imports | 1.0.1 minified | gzip | 1.1.0 minified | gzip |
  | --- | ---: | ---: | ---: | ---: |
  | unpack only | 86,670 | 28,994 | 41,238 | 15,457 |
  | pack and unpack | 89,105 | 29,977 | 54,887 | 20,345 |

  The main entry with starting models is 60,776 bytes minified, 22,364 gzip.
- **Speed.** Not slower. Measured on 10 real replays pinned to one core, against 1.0.1: packing is 5% faster
  (182 ms a replay against 192), unpacking with the main entry 3% faster (158 ms against 163), unpacking with
  `decode` 8% faster (151 ms).
- **The package ships minified files** (`web/lib/index.js`, `encode.js`, `decode.js`), ES2016, no imports,
  `"sideEffects": false`. The TypeScript source is in the repository, and the build writes source maps from it.
- **Not in the packaged files any more:** the bit accounting behind the `account` option, and the coder object in
  `PackResult.codec` (now always null). Both were for measurement and neither was part of the stable API. They
  work when the source is run directly.
- `decode` and `encode` do not load starting models. They refuse a file packed with one, with the error the main
  entry gives when the model is not handed in. No model ships, and the command line tool and the page never wrote
  such a file.
- The checksum is a little slower (a smaller table): about 3 ms more per 3 MB replay, counted in the speed above.
- Two rare unpack errors ("literal string too long", "literal already in the pool") now read "packed data is
  damaged", like every other sign of a damaged file.
- Tests: every build is held against the published 1.0.0 and 1.0.1 (`test/compat.test.ts`), and
  `tools/corpus-check.mjs` runs the same check over a folder of real replays.

## 1.0.1

- **Other game versions keep the mini-game formulas when they still fit.** A replay whose game version is not
  6.11.x (v7 writes `"version":"6.11"` with no patch number) used to be packed with the schema alone. It is now
  coded both ways and the smaller is kept; if the formulas throw on it, the schema pass is used. On 10 sample
  6.11 replays relabelled `"6.11"`: 11.54x instead of 9.18x, and packing takes about twice as long.
- 6.11.x replays pack to the same bytes as 1.0.0 (one pass, formulas on). No format change: the predictor set was
  already in the header, so 1.0.0 unpacks files from 1.0.1 and the other way round.

## 1.0.0

First public release.

- **Format version 1 of `.paczd`** (container magic `CLRZ`). Files named `.clrz` by pre-release builds are the same
  format and are read too. Lossless: every packed file unpacks to the exact original bytes, checked by
  size and crc32. The format is locked by the sha256 tests in `test/codec.test.ts`; see [FORMAT.md](FORMAT.md).
- **Size.** On 100 sample replays packed one by one: worst 10.2x, median 11.4x, best 12.4x smaller than the raw
  file. Smaller files compress slightly worse.
- **Web page** (`web/`). Drop replays or folders to pack, drop `.paczd` to unpack. Runs in the browser and
  makes no network requests. Every pack is unpacked again and compared byte for byte before it is offered.
- **Command line tool** `pac-replay-codec`: `pack`, `unpack` and `verify` over files and folders, on several
  threads, with `--json` output for scripts and AI agents. Never deletes or replaces a file.
- **Library**: `packReplay` and `unpackReplay`, no dependencies, Node and browsers.
- Self-describing: the type table is read from each replay, so other game versions pack exactly. The PAC
  mini-game formulas are used for game version 6.11 only. Replays from v7 are not yet tested.
- The format has a slot for an optional starting model. None ships with this release.
