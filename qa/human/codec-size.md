# Manual QA: the smaller codec (1.1.0)

What changed: the package ships three minified files built from `src/` (`web/lib/index.js`, `encode.js`,
`decode.js`) in place of eleven readable modules. The `.paczd` format did not change. This script checks that
claim and the size and speed numbers, from a clone.

A step that fails can be reported as "step 6 did not match".

## Setup

```sh
npm install        # the build tools, and the published 1.0.0 and 1.0.1 the checks compare against
```

You need a folder of real `.colreplay` files for steps 4 to 6. Below it is `~/replays`.

## The automated checks first

1. `node --test test/*.test.ts`
   See at the end: `tests 54`, `pass 49`, `fail 0`, `skipped 5` (Node 22 puts `#` in front of each, Node 24 an
   `ℹ`). The 5 skipped need real replays (step 4).
2. `npx tsc -p tsconfig.json`
   See: no output.
3. `node tools/build-web.mjs --sizes`
   See three lines, then `built 3 files into web/lib/`:
   `index.js 62182 bytes gzip 22360`, `encode.js 55928 bytes gzip 20210`, `decode.js 41945 bytes gzip 15291`.
   Then `git status --short web/lib` prints nothing: the build gives back the committed files, byte for byte.
4. `REPLAY_DIR=~/replays node --test test/*.test.ts`
   See: `pass 54`, `fail 0`, `skipped 0`. About 2 minutes for 20 replays.

## The format did not move

5. `node tools/corpus-check.mjs ~/replays`
   See: `N replays ... : N passed, 0 failed`. Every replay was packed by the published 1.0.0 and 1.0.1 and by
   `index.js` and `encode.js`; the new packs are the bytes of 1.0.1; all three files unpacked what the old
   releases packed; the old releases unpacked the new packs. A failure names the replay and what differed.
   On a busy machine this step is slow, not wrong: about 2 seconds of one core per replay.
6. Pack one replay with the published 1.0.1 and with this clone, and compare by hand:

   ```sh
   mkdir -p /tmp/q && cp ~/replays/$(ls ~/replays | head -1) /tmp/q/a.colreplay
   node node_modules/pac-replay-codec-1.0.1/cli/pac-replay-codec.mjs pack /tmp/q/a.colreplay -o /tmp/q/old
   node cli/pac-replay-codec.mjs pack /tmp/q/a.colreplay -o /tmp/q/new
   cmp /tmp/q/old/a.paczd /tmp/q/new/a.paczd && echo same
   node node_modules/pac-replay-codec-1.0.1/cli/pac-replay-codec.mjs unpack /tmp/q/new/a.paczd -o /tmp/q/back
   cmp /tmp/q/back/a.colreplay /tmp/q/a.colreplay && echo exact
   ```

   See: `same`, then `exact`.

## Size and speed

7. `node tools/consumer-size.mjs`
   See the table. The row "now, unpack only" reads 41,238 minified, 15,457 gzip, 13,672 brotli. The row
   "1.0.1, unpack only" reads 86,670, 28,994, 25,681. The last line says 47% and 32% smaller.
8. `node tools/bench.mjs --replays ~/replays --files 6 --rounds 4 --cpu 3 pac-replay-codec-1.0.1 web/lib/index.js web/lib/encode.js web/lib/decode.js`
   See: the "vs first" columns of the three files at or below 0%, give or take 2% between runs. `--cpu 3` pins
   the runs to one core; without it a shared machine moves the numbers by 5% or more. Another machine gives
   other milliseconds: only the comparison inside one run means anything.

## The three entries, as an app sees them

9. In an empty folder:

   ```sh
   npm init -y >/dev/null && npm install /path/to/this/clone
   node -e "import('pac-replay-codec/decode').then(m => console.log(Object.keys(m)))"
   node -e "import('pac-replay-codec/encode').then(m => console.log(Object.keys(m)))"
   node -e "import('pac-replay-codec').then(m => console.log(Object.keys(m).length))"
   ```

   See: `[ 'unpackReplay' ]`, then `[ 'packReplay', 'unpackReplay' ]`, then `14`.

## The page and the command line still work

10. `python3 -m http.server 8000 --bind 127.0.0.1 --directory web`, open <http://127.0.0.1:8000/>, and walk
    `qa/human/page.md`. Nothing in the page changed; it now loads `web/lib/index.js` as one file. The greyscale
    pass is step 10 of that script.
11. With Playwright at hand, the same walk by a bot: `node qa/bot/page-pack-unpack.mjs`.
    See: `14 of 14 checks held`, and the folder it prints holds `page-color.png` and `page-greyscale.png`. In the
    greyscale one every status still reads from its glyph and word.
12. `node cli/pac-replay-codec.mjs verify ~/replays --json | tail -1`
    See: a summary line with `"failed":0`.

## What to send back

The last line of steps 1, 4, 5, 7 and 12, the table of step 8, and the number of any step that did not match.

## Known gaps

1. Real v7 replays are still untested, as in 1.0.1. Replays relabelled as other versions are tested.
2. The speed numbers come from one machine (Ryzen 9 7950X3D, Node 22). No browser timing was taken.
3. `decode` and `encode` do not load starting models. No model ships and none of the tools ever wrote a file
   that needs one, so nothing in the wild is affected; a file packed with one needs the main entry.
4. The bit accounting (`account`) and `PackResult.codec` work only when the source is run directly.
5. The page bot needs Playwright, which is not a dependency of this repository.
6. Nothing is published. `package.json` says 1.1.0 so the files carry that number.
