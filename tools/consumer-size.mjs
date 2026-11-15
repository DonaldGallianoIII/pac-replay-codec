/**
 * How much code an app takes on when it imports the codec: the size table of the README, before and after.
 *
 * "Before" is pac-replay-codec 1.0.1 as published (a dev dependency). "After" is the packaged files of this
 * repository. Each entry is bundled the way PAC's client is built (esbuild, bundle, minify, target ES2016) and
 * measured raw, gzip -9 and brotli 11. The first column is what the entry needs on disk in the npm package.
 *
 * Usage: node tools/consumer-size.mjs            the table, as Markdown
 *        node tools/consumer-size.mjs --json     the same numbers as JSON
 *
 * @interacts reads web/lib/*.js (run tools/build-web.mjs first) and node_modules/pac-replay-codec-1.0.1; writes
 *            nothing
 * @deps      esbuild (dev dependency), node:zlib, node:fs, node:path
 * @complexity five small bundles, about a second
 * @alloc     the bundles, in memory
 */
import { build } from 'esbuild';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = Object.freeze({
  /** PAC's client build: esbuild.js in the game's repository bundles and minifies for ES2016. */
  Target: 'es2016',
  Before: path.join(ROOT, 'node_modules', 'pac-replay-codec-1.0.1', 'web', 'lib'),
  After: path.join(ROOT, 'web', 'lib'),
});

const gzip = (b) => zlib.gzipSync(b, { level: 9 }).length;
const brotli = (b) => zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: b.length } }).length;

/** Bytes on disk of the modules an entry needs: one packaged file, or every module of the 1.0.1 library. */
function onDisk(dir, files) {
  return files.reduce((sum, f) => sum + fs.statSync(path.join(dir, f)).size, 0);
}

/** What esbuild emits for an app that imports `names` from `file`, license comment kept as esbuild does by default. */
async function bundled(dir, file, names) {
  const result = await build({
    stdin: { contents: `export { ${names.join(', ')} } from './${file}';`, resolveDir: dir, loader: 'js' },
    bundle: true, format: 'esm', minify: true, target: CONFIG.Target, treeShaking: true, write: false, logLevel: 'silent',
  });
  const out = Buffer.from(result.outputFiles[0].contents);
  return { min: out.length, gzip: gzip(out), brotli: brotli(out) };
}

if (!fs.existsSync(CONFIG.Before)) {
  console.error('pac-replay-codec 1.0.1 is not installed: run npm install (it is a dev dependency)');
  process.exit(1);
}
const beforeFiles = fs.readdirSync(CONFIG.Before).filter((n) => n.endsWith('.js'));
const rows = [
  { when: '1.0.1', what: 'unpack only', how: "import { unpackReplay } from 'pac-replay-codec'", disk: onDisk(CONFIG.Before, beforeFiles), ...(await bundled(CONFIG.Before, 'index.js', ['unpackReplay'])) },
  { when: '1.0.1', what: 'pack and unpack', how: "import { packReplay, unpackReplay } from 'pac-replay-codec'", disk: onDisk(CONFIG.Before, beforeFiles), ...(await bundled(CONFIG.Before, 'index.js', ['packReplay', 'unpackReplay'])) },
  { when: 'now', what: 'unpack only', how: "import { unpackReplay } from 'pac-replay-codec/decode'", disk: onDisk(CONFIG.After, ['decode.js']), ...(await bundled(CONFIG.After, 'decode.js', ['unpackReplay'])) },
  { when: 'now', what: 'pack and unpack', how: "import { packReplay, unpackReplay } from 'pac-replay-codec/encode'", disk: onDisk(CONFIG.After, ['encode.js']), ...(await bundled(CONFIG.After, 'encode.js', ['packReplay', 'unpackReplay'])) },
  { when: 'now', what: 'pack and unpack, with starting models', how: "import { packReplay, unpackReplay, parsePrior } from 'pac-replay-codec'", disk: onDisk(CONFIG.After, ['index.js']), ...(await bundled(CONFIG.After, 'index.js', ['packReplay', 'unpackReplay', 'parsePrior'])) },
];

if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 2));
else {
  const n = (v) => v.toLocaleString('en-US');
  console.log('| Version | What the app imports | In the package | Minified | gzip | brotli |');
  console.log('| --- | --- | ---: | ---: | ---: | ---: |');
  for (const r of rows) console.log(`| ${r.when} | ${r.what} | ${n(r.disk)} | ${n(r.min)} | ${n(r.gzip)} | ${n(r.brotli)} |`);
  const pct = (a, b) => `${Math.round((1 - b / a) * 100)}%`;
  console.log('');
  console.log(`Unpack only, gzip: ${n(rows[0].gzip)} to ${n(rows[2].gzip)} bytes (${pct(rows[0].gzip, rows[2].gzip)} smaller). Pack and unpack, gzip: ${n(rows[1].gzip)} to ${n(rows[3].gzip)} bytes (${pct(rows[1].gzip, rows[3].gzip)} smaller).`);
}
