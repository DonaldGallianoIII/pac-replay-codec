/**
 * Speed of the codec: milliseconds to pack and to unpack one replay, for one or more builds side by side. Used to
 * hold a change to the speed budget (no more than 10% slower than the published release without saying so).
 *
 * Each build runs in its own process, so one build's compiled code and garbage never touch another's timing.
 * The builds take turns, round after round, so a busy minute on the machine hits all of them alike. A build that
 * cannot pack (the unpack-only file) is handed files packed by the first build that can.
 *
 * Usage: node tools/bench.mjs --replays DIR [--files 10] [--rounds 5] [--passes 3] BUILD [BUILD ...]
 *        BUILD is a module that exports unpackReplay and maybe packReplay, as a path or a package name:
 *        node tools/bench.mjs --replays ~/replays pac-replay-codec-1.0.1 web/lib/index.js web/lib/decode.js
 *
 * The numbers are wall-clock time and depend on the machine: compare builds within one run, never across runs.
 *
 * @interacts reads the first --files .colreplay files of --replays; starts one child process per build per round
 * @deps      node:child_process, node:fs, node:path; the builds named on the command line
 * @complexity rounds x builds x (1 warm-up + passes) x files pack and unpack calls
 * @alloc     per child: the replays and their packed forms, plus the coder's tables during a call
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CONFIG = Object.freeze({ Files: 10, Rounds: 5, Passes: 3 });
const SELF = fileURLToPath(import.meta.url);

/** A build's module specifier: a file path becomes a file URL, a package name stays. */
function specifier(build) {
  return fs.existsSync(build) ? pathToFileURL(path.resolve(build)).href : build;
}

/** The replays of one run, read once per process. @complexity O(bytes) @alloc the files */
function readReplays(dir, count) {
  return fs.readdirSync(dir).filter((n) => n.endsWith('.colreplay')).sort().slice(0, count)
    .map((n) => new Uint8Array(fs.readFileSync(path.join(dir, n))));
}

/** Child process: time one build and print one JSON line. */
async function child(build, packer, dir, files, passes) {
  const lib = await import(specifier(build));
  const srcs = readReplays(dir, files);
  const pack = typeof lib.packReplay === 'function' ? lib.packReplay : null;
  const packed = srcs.map((s) => (pack ?? packer.packReplay)(s).bytes); // also the warm-up for packing
  for (const p of packed) lib.unpackReplay(p); // warm-up for unpacking
  let packMs = Infinity;
  let unpackMs = Infinity;
  for (let k = 0; k < passes; k++) {
    if (pack !== null) {
      const t0 = performance.now();
      for (const s of srcs) pack(s);
      packMs = Math.min(packMs, performance.now() - t0);
    }
    const t0 = performance.now();
    for (const p of packed) lib.unpackReplay(p);
    unpackMs = Math.min(unpackMs, performance.now() - t0);
  }
  console.log(JSON.stringify({ pack: pack === null ? null : packMs / srcs.length, unpack: unpackMs / srcs.length }));
}

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  if (at < 0) return fallback;
  return args.splice(at, 2)[1];
};
const childOf = option('--child', null);
const dir = option('--replays', '');
const files = Number(option('--files', CONFIG.Files));
const rounds = Number(option('--rounds', CONFIG.Rounds));
const passes = Number(option('--passes', CONFIG.Passes));

if (childOf !== null) {
  const packerName = option('--packer', null);
  await child(childOf, packerName === null ? null : await import(specifier(packerName)), dir, files, passes);
} else {
  const builds = args;
  if (dir === '' || builds.length === 0) {
    console.error('usage: node tools/bench.mjs --replays DIR [--files 10] [--rounds 5] [--passes 3] BUILD [BUILD ...]');
    process.exit(2);
  }
  // the first build is the packer for builds that cannot pack; it must be able to
  const results = builds.map(() => ({ pack: [], unpack: [] }));
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < builds.length; i++) {
      const run = spawnSync(process.execPath, [SELF, '--child', builds[i], '--packer', builds[0], '--replays', dir, '--files', String(files), '--passes', String(passes)], { encoding: 'utf8' });
      if (run.status !== 0) {
        console.error(run.stderr);
        process.exit(1);
      }
      const t = JSON.parse(run.stdout.trim().split('\n').pop());
      if (t.pack !== null) results[i].pack.push(t.pack);
      results[i].unpack.push(t.unpack);
    }
  }
  const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
  const show = (a) => (a.length === 0 ? '      n/a        ' : `${Math.min(...a).toFixed(1).padStart(6)} ${median(a).toFixed(1).padStart(6)}`);
  const base = results[0];
  const versus = (a, b) => (a.length === 0 || b.length === 0 ? '' : `${((median(a) / median(b) - 1) * 100).toFixed(1).padStart(6)}%`);
  console.log(`${files} replays, ${rounds} rounds of ${passes} passes each; ms per replay, best and median of the rounds`);
  console.log(`${'build'.padEnd(34)} pack best median  vs first   unpack best median  vs first`);
  for (let i = 0; i < builds.length; i++) {
    console.log(`${builds[i].padEnd(34)}      ${show(results[i].pack)}  ${versus(results[i].pack, base.pack).padStart(8)}        ${show(results[i].unpack)}  ${versus(results[i].unpack, base.unpack).padStart(8)}`);
  }
}
