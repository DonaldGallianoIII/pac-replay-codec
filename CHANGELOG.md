# Changelog

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
