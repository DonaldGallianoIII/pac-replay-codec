/**
 * The frozen-format proof on a folder of real replays, on every core: each replay is packed by the published
 * 1.0.0 and 1.0.1 and by the packaged files of this repository, and unpacked in both directions.
 *
 * For every .colreplay under the folder it checks, and fails the run on the first thing that does not hold:
 *   same bytes   web/lib/index.js and web/lib/encode.js pack to exactly the bytes 1.0.1 packs
 *   new reads old   index.js, encode.js and decode.js unpack what 1.0.0 and 1.0.1 packed, to the original
 *   old reads new   1.0.0 and 1.0.1 unpack what this repository packs, to the original
 *
 * Usage: node tools/corpus-check.mjs DIR [--jobs N] [--limit N] [--json]
 *        Exit code 0: every replay passed. 1: at least one did not (each is named). 2: bad usage.
 *
 * The published packages are dev dependencies (npm install). Nothing is written; replays are only read.
 *
 * @interacts reads the .colreplay files under DIR; starts worker threads that load web/lib/*.js and the two
 *            published packages
 * @deps      node:worker_threads, node:fs, node:path, node:os, node:crypto; web/lib (built);
 *            node_modules/pac-replay-codec-1.0.0 and -1.0.1
 * @complexity per replay: 4 packs and 8 unpacks (about 1.5 s of one core for a 3.4 MB replay); N replays over
 *            J workers, so about 1.5 N / J seconds
 * @alloc     per worker: one replay, its packed forms and one coder's tables (about 55 MB) at a time
 */
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.join(path.dirname(SELF), '..');
const CONFIG = Object.freeze({
  /** The packaged files under test: what each can do decides which checks it takes part in. */
  Builds: ['index.js', 'encode.js', 'decode.js'],
  /** The published releases, oldest first; the last one is the reference for "same bytes". */
  Releases: ['1.0.0', '1.0.1'],
  /** Cores left for the rest of the machine. */
  SpareCores: 2,
});

const same = (a, b) => a.length === b.length && Buffer.compare(a, b) === 0;

/** Worker: load every build once, then answer one result per file path. */
async function work() {
  const builds = [];
  for (const name of CONFIG.Builds) builds.push({ name: `web/lib/${name}`, lib: await import(pathToFileURL(path.join(ROOT, 'web', 'lib', name)).href) });
  const releases = [];
  for (const version of CONFIG.Releases) releases.push({ name: `published ${version}`, lib: await import(`pac-replay-codec-${version}`) });
  const latest = releases[releases.length - 1];
  parentPort.on('message', (file) => {
    const problems = [];
    let size = 0;
    let packedSize = 0;
    try {
      const src = new Uint8Array(fs.readFileSync(file));
      size = src.length;
      const want = latest.lib.packReplay(src).bytes;
      packedSize = want.length;
      for (const b of builds) {
        if (typeof b.lib.packReplay !== 'function') continue;
        const got = b.lib.packReplay(src).bytes;
        if (!same(got, want)) problems.push(`${b.name} packs ${got.length} bytes, ${latest.name} packs ${want.length}, and they differ`);
      }
      // what each release packed, unpacked by every build; and what this repository packs (the bytes of the
      // latest release, checked just above) unpacked by every release
      const packs = [[latest.name, want]];
      for (const r of releases) {
        if (r === latest) continue;
        const old = r.lib.packReplay(src).bytes;
        if (!same(old, want)) packs.push([r.name, old]);
      }
      for (const [packedBy, packed] of packs) {
        for (const b of builds) {
          if (!same(b.lib.unpackReplay(packed), src)) problems.push(`${b.name} does not unpack what ${packedBy} packed`);
        }
      }
      for (const r of releases) {
        if (!same(r.lib.unpackReplay(want), src)) problems.push(`${r.name} does not unpack what this repository packs`);
      }
    } catch (err) {
      problems.push(`threw: ${err && err.message ? err.message : String(err)}`);
    }
    parentPort.postMessage({ file, size, packedSize, problems });
  });
  parentPort.postMessage({ ready: true });
}

/** Every .colreplay under dir, sorted by path. @complexity O(entries) @alloc the list */
function findReplays(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.colreplay')) out.push(full);
    }
  };
  walk(dir);
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const at = args.indexOf(name);
    if (at < 0) return fallback;
    return args.splice(at, 2)[1];
  };
  const json = args.includes('--json');
  if (json) args.splice(args.indexOf('--json'), 1);
  const jobs = Number(option('--jobs', Math.max(1, os.cpus().length - CONFIG.SpareCores)));
  const limit = Number(option('--limit', Infinity));
  const dir = args[0];
  if (!dir || !fs.existsSync(dir)) {
    console.error('usage: node tools/corpus-check.mjs DIR [--jobs N] [--limit N] [--json]');
    process.exit(2);
  }
  const files = findReplays(dir).slice(0, limit);
  const results = new Array(files.length);
  let next = 0;
  let done = 0;
  await new Promise((resolve, reject) => {
    const workers = [];
    for (let i = 0; i < Math.min(jobs, files.length); i++) {
      const w = new Worker(SELF, { workerData: { worker: true } });
      workers.push(w);
      const feed = () => {
        if (next < files.length) {
          w.index = next;
          w.postMessage(files[next++]);
        } else w.terminate();
      };
      w.on('message', (m) => {
        if (!m.ready) {
          results[w.index] = m;
          done++;
          if (!json && (m.problems.length > 0 || done % 100 === 0 || done === files.length)) {
            process.stderr.write(`${done}/${files.length}${m.problems.length > 0 ? `  FAILED ${m.file}: ${m.problems.join('; ')}` : ''}\n`);
          }
          if (done === files.length) resolve();
        }
        feed();
      });
      w.on('error', reject);
    }
    if (files.length === 0) resolve();
  });
  const failed = results.filter((r) => r.problems.length > 0);
  const bytes = results.reduce((s, r) => s + r.size, 0);
  const packedBytes = results.reduce((s, r) => s + r.packedSize, 0);
  // one digest over every file's name and sizes, so two runs over the same folder can be compared at a glance
  const digest = crypto.createHash('sha256').update(results.map((r) => `${path.basename(r.file)} ${r.size} ${r.packedSize}`).join('\n')).digest('hex').slice(0, 16);
  const summary = {
    folder: dir, replays: results.length, passed: results.length - failed.length, failed: failed.length,
    original_bytes: bytes, packed_bytes: packedBytes, ratio: packedBytes > 0 ? Number((bytes / packedBytes).toFixed(2)) : null,
    builds: CONFIG.Builds, releases: CONFIG.Releases, digest,
  };
  if (json) console.log(JSON.stringify({ summary, failed }));
  else {
    console.log(`${summary.replays} replays, ${(bytes / 1e6).toFixed(1)} MB: ${summary.passed} passed, ${summary.failed} failed`);
    console.log(`packed ${(packedBytes / 1e6).toFixed(1)} MB, ${summary.ratio}x; builds ${CONFIG.Builds.join(', ')} against published ${CONFIG.Releases.join(' and ')}`);
    for (const r of failed) console.log(`FAILED ${r.file}: ${r.problems.join('; ')}`);
  }
  process.exit(failed.length > 0 ? 1 : 0);
}

if (isMainThread) await main();
else if (workerData && workerData.worker) await work();
