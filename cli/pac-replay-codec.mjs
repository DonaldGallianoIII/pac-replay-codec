#!/usr/bin/env node
/**
 * pac-replay-codec: pack, unpack or verify replays from the command line, many at once, on several threads.
 *
 * Rules it keeps, whatever the flags:
 *   1. It never deletes or changes an input file, and never replaces an existing output file.
 *   2. A pack counts only after the packed bytes were unpacked again and matched the original byte for byte.
 *   3. Results print in the order the files were found, so two runs on the same inputs print the same lines.
 *
 * Exit codes: 0 every file exact, stored or skipped, 1 at least one file failed, 2 bad usage.
 *
 * @interacts cli/worker.mjs (one worker thread per job slot), the file system (walks the inputs, writes outputs)
 * @deps      node:worker_threads, node:fs, node:path, node:os, cli/worker.mjs
 * @complexity O(E + sum of F) where E is the entries walked in the input folders and F each file's size; the
 *            codec work is spread over `--jobs` threads
 * @alloc     one job record per file found; each worker holds one file's worth of buffers at a time
 */
import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const EXIT = Object.freeze({ OK: 0, FAILED: 1, USAGE: 2 });
const EXT = Object.freeze({ replay: '.colreplay', packed: '.clrz' });
const COMMANDS = new Set(['pack', 'unpack', 'verify']);
const KB = 1024;
const MB = KB * KB;
const RATIO_DECIMALS = 2;

const HELP = `pac-replay-codec: pack Pokemon Auto Chess replays up to 12.4x smaller, exact bytes back.
(Smaller files compress slightly worse.)

Usage:
  pac-replay-codec pack   <files or folders> [-o outdir] [--jobs N] [--json]
  pac-replay-codec unpack <files or folders> [-o outdir] [--jobs N] [--json]
  pac-replay-codec verify <files or folders>             [--jobs N] [--json]

  pack     .colreplay -> .clrz. Each one is unpacked again and compared byte for byte before it counts.
  unpack   .clrz -> .colreplay. Size and crc32 are checked before anything is written.
  verify   writes nothing. A .clrz must unpack exact; a .colreplay must pack and come back exact.

  Folders are walked recursively: pack takes .colreplay files, unpack and verify take .clrz and .colreplay.
  Outputs go next to each input, or under -o outdir with the folder layout kept.
  Originals are never deleted. An output that already exists is skipped, never replaced.
  Two inputs that would write the same output: the second one fails and nothing is written for it.
  Files that are already packed are skipped by pack.

Options:
  -o, --out DIR   write outputs under DIR
  -j, --jobs N    threads to use (default: cores minus 1, here ${defaultJobs()})
  --json          one JSON line per file, then one summary line
  -h, --help      this text

JSON line per file:
  {"file","out","status","in_bytes","out_bytes","ratio","exact","stored","error"}
  status is packed, stored, unpacked, verified, skipped or failed. ratio is original size / packed size.
  stored: not a replay, kept as it was inside the container (exact, but no ratio and not in the totals).
Summary line:
  {"summary":true,"files","exact","stored","skipped","failed","in_bytes","out_bytes","ratio"}

Exit codes: 0 all exact, stored or skipped, 1 some failed, 2 bad usage.

Examples:
  npx pac-replay-codec pack ./replays
  npx pac-replay-codec pack ./replays -o ./packed --jobs 4
  npx pac-replay-codec unpack ./packed -o ./restored
  npx pac-replay-codec verify ./packed --json
  npx pac-replay-codec pack game1.colreplay game2.colreplay --json | jq -c 'select(.status == "failed")'
`;

/** @complexity O(1) */
function defaultJobs() {
  const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, cores - 1);
}

class UsageError extends Error {}

/**
 * @param {string[]} argv the arguments after the script name
 * @returns {{ help: boolean, cmd: string, inputs: string[], out: string | null, jobs: number, json: boolean }}
 * @complexity O(A) over the arguments
 */
function parseArgs(argv) {
  const opts = { help: false, cmd: '', inputs: [], out: null, jobs: defaultJobs(), json: false };
  const value = (i, flag) => {
    if (i + 1 >= argv.length || argv[i + 1].startsWith('-')) throw new UsageError(`${flag} needs a value`);
    return argv[i + 1];
  };
  let onlyPaths = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (onlyPaths || !a.startsWith('-') || a === '-') {
      if (!opts.cmd) {
        if (!COMMANDS.has(a)) throw new UsageError(`unknown command "${a}" (use pack, unpack or verify)`);
        opts.cmd = a;
      } else opts.inputs.push(a);
    } else if (a === '--') onlyPaths = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--json') opts.json = true;
    else if (a === '-o' || a === '--out') opts.out = value(i++, a);
    else if (a === '-j' || a === '--jobs') {
      const raw = value(i++, a);
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) throw new UsageError(`--jobs must be a whole number of 1 or more, got "${raw}"`);
      opts.jobs = n;
    } else throw new UsageError(`unknown option "${a}"`);
  }
  if (opts.help) return opts;
  if (!opts.cmd) throw new UsageError('no command given');
  if (opts.inputs.length === 0) throw new UsageError('no files or folders given');
  if (opts.cmd === 'verify' && opts.out) throw new UsageError('verify writes nothing, so it takes no -o');
  return opts;
}

/** @complexity O(1) */
function wantedInFolder(cmd, name) {
  const n = name.toLowerCase();
  if (cmd === 'pack') return n.endsWith(EXT.replay);
  if (cmd === 'unpack') return n.endsWith(EXT.packed);
  return n.endsWith(EXT.packed) || n.endsWith(EXT.replay);
}

/** @complexity O(1) */
function outputName(cmd, name) {
  if (cmd === 'pack') {
    const base = name.toLowerCase().endsWith(EXT.replay) ? name.slice(0, -EXT.replay.length) : name;
    return base + EXT.packed;
  }
  const base = name.toLowerCase().endsWith(EXT.packed) ? name.slice(0, -EXT.packed.length) : name;
  return path.extname(base) ? base : base + EXT.replay;
}

/**
 * Every file the command will touch, in a stable order: inputs in the order given, folder contents sorted by name.
 * A file reached twice is listed once. Symbolic links to folders are not followed, so a link loop cannot hang it.
 * Problems found here become failed jobs in their place in the order, decided before any thread starts: a path
 * that does not exist, a folder that cannot be read, and a second input whose output path another input already
 * claimed (otherwise one would silently win a race and the other be reported as skipped).
 * @returns {object[]} jobs; a job with `fail` set is reported failed and never sent to a worker
 * @complexity O(E log E) over the E entries walked
 * @alloc one job record per file, one set entry per input and per output path
 */
function collect(opts) {
  const jobs = [];
  const seen = new Set();
  const outs = new Map();
  const fail = (shown, error) => jobs.push({ id: jobs.length, cmd: opts.cmd, file: null, out: null, shown, fail: error });
  const add = (file, rel) => {
    const abs = path.resolve(file);
    if (seen.has(abs)) return;
    seen.add(abs);
    const outName = outputName(opts.cmd, path.basename(abs));
    let out = null;
    if (opts.cmd !== 'verify') {
      out = opts.out ? path.join(path.resolve(opts.out), path.dirname(rel), outName) : path.join(path.dirname(abs), outName);
      if (outs.has(out)) {
        fail(file, `output name collides with ${outs.get(out)}`);
        return;
      }
      outs.set(out, file);
    }
    jobs.push({ id: jobs.length, cmd: opts.cmd, file: abs, out, shown: file, fail: null });
  };
  const walk = (dir, root) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      fail(dir, `could not read folder (${err.code || err.message})`);
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, root);
      else if ((e.isFile() || (e.isSymbolicLink() && safeIsFile(full))) && wantedInFolder(opts.cmd, e.name)) {
        add(full, path.relative(root, full));
      }
    }
  };
  for (const input of opts.inputs) {
    let st;
    try {
      st = fs.statSync(input);
    } catch {
      fail(input, 'no such file or folder');
      continue;
    }
    if (st.isDirectory()) walk(input, input);
    else add(input, path.basename(input));
  }
  return jobs;
}

/** @complexity O(1) */
function safeIsFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * The original and the packed size of a result, whichever side was the input.
 * @complexity O(1)
 */
function sides(r) {
  return r.packed_input ? { original: r.out_bytes, packed: r.in_bytes } : { original: r.in_bytes, packed: r.out_bytes };
}

/** Always original over packed, so a bigger number is a better result in every command. @complexity O(1) */
function ratioOf(r) {
  const { original, packed } = sides(r);
  if (!original || !packed) return null;
  return Number((original / packed).toFixed(RATIO_DECIMALS));
}

/** @complexity O(1) */
function human(n) {
  if (n == null) return '?';
  if (n >= MB) return `${(n / MB).toFixed(2)} MB`;
  if (n >= KB) return `${(n / KB).toFixed(1)} KB`;
  return `${n} B`;
}

/**
 * One finished file as the JSON record the help text promises. A pack of something that is not a replay is kept
 * as it was inside the container: it is reported as `stored`, like the page's "kept as is", and left out of the
 * summary ratio.
 * @complexity O(1)
 */
function record(job, r) {
  const status = r.stored && r.status === 'packed' ? 'stored' : r.status;
  return { file: job.shown, out: job.out, status, in_bytes: r.in_bytes, out_bytes: r.out_bytes,
    ratio: r.stored ? null : ratioOf(r), exact: r.exact, stored: r.stored === true, error: r.error };
}

/** @complexity O(1) */
function humanLine(rec) {
  const mark = rec.status === 'failed' ? 'x' : rec.status === 'skipped' ? '-' : rec.stored ? '=' : 'ok';
  const sizes = rec.out_bytes != null ? `  ${human(rec.in_bytes)} -> ${human(rec.out_bytes)}` : '';
  const ratio = rec.ratio != null && rec.status !== 'skipped' ? `  ${rec.ratio}x` : '';
  const why = rec.error ? `  (${rec.error})` : rec.stored ? '  exact, not a replay: kept as it was' : rec.exact ? '  exact' : '';
  return `${mark.padEnd(2)} ${rec.status.padEnd(8)} ${rec.file}${sizes}${ratio}${why}`;
}

/**
 * Run the jobs on `n` worker threads and call `emit` with each result in job order.
 * @complexity O(J) bookkeeping over the J jobs; the work itself is in the workers
 * @alloc up to `n` worker threads, all terminated before the promise settles
 */
function runPool(jobs, n, emit) {
  return new Promise((resolve) => {
    if (jobs.length === 0) { resolve(); return; }
    const results = new Array(jobs.length);
    // jobs that already failed in collect() have their result now; only the others go to a thread
    for (const j of jobs) {
      if (j.fail) results[j.id] = { id: j.id, status: 'failed', in_bytes: null, out_bytes: null, packed_input: false,
        exact: false, stored: false, error: j.fail };
    }
    const queue = jobs.filter((j) => !j.fail);
    let next = 0;
    let printed = 0;
    let done = 0;
    const workers = [];
    const flush = () => {
      while (printed < jobs.length && results[printed] !== undefined) emit(jobs[printed], results[printed++]);
    };
    const finish = (w, r) => {
      results[r.id] = r;
      done++;
      flush();
      if (next < queue.length) give(w);
      if (done === queue.length) {
        for (const x of workers) x.terminate();
        resolve();
      }
    };
    const give = (w) => {
      const job = queue[next++];
      w.current = job.id;
      w.postMessage({ id: job.id, cmd: job.cmd, file: job.file, out: job.out });
    };
    const spawn = () => {
      const w = new Worker(new URL('./worker.mjs', import.meta.url));
      w.on('message', (r) => finish(w, r));
      w.on('error', (err) => {
        // a crashed thread fails its current file; a fresh thread takes over the rest of its share
        const fresh = spawn();
        workers[workers.indexOf(w)] = fresh;
        finish(fresh, { id: w.current, status: 'failed', in_bytes: null, out_bytes: null, packed_input: false,
          exact: false, stored: false, error: `worker crashed: ${err.message}` });
      });
      return w;
    };
    if (queue.length === 0) { flush(); resolve(); return; }
    const size = Math.min(n, queue.length);
    for (let i = 0; i < size; i++) {
      const w = spawn();
      workers.push(w);
      give(w);
    }
  });
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    process.stderr.write(`pac-replay-codec: ${err.message}\nRun pac-replay-codec --help for usage.\n`);
    return EXIT.USAGE;
  }
  if (opts.help) {
    process.stdout.write(HELP);
    return EXIT.OK;
  }
  const jobs = collect(opts);
  const sum = { summary: true, files: 0, exact: 0, stored: 0, skipped: 0, failed: 0, in_bytes: 0, out_bytes: 0,
    ratio: null };
  const out = (rec) => process.stdout.write((opts.json ? JSON.stringify(rec) : humanLine(rec)) + '\n');
  if (!opts.json && jobs.length === 0) process.stderr.write('pac-replay-codec: no matching files found\n');
  await runPool(jobs, opts.jobs, (job, r) => {
    if (r.in_bytes == null && job.file && safeIsFile(job.file)) r.in_bytes = fs.statSync(job.file).size;
    const rec = record(job, r);
    sum.files++;
    if (rec.status === 'failed') sum.failed++;
    else if (rec.status === 'skipped') sum.skipped++;
    else if (rec.stored) sum.stored++;
    else if (rec.exact) {
      sum.exact++;
      // the summary's in_bytes and out_bytes are original and packed totals, in the direction of ratio
      const s = sides(r);
      sum.in_bytes += s.original;
      sum.out_bytes += s.packed;
    }
    out(rec);
  });
  if (sum.out_bytes > 0) sum.ratio = Number((sum.in_bytes / sum.out_bytes).toFixed(RATIO_DECIMALS));
  if (opts.json) process.stdout.write(JSON.stringify(sum) + '\n');
  else {
    process.stdout.write(`\n${sum.exact} exact, ${sum.stored} stored, ${sum.skipped} skipped, ${sum.failed} failed, of ${sum.files}` +
      (sum.ratio ? `. ${human(sum.in_bytes)} of replays as ${human(sum.out_bytes)} packed, ${sum.ratio}x.` : '.') + '\n');
  }
  return sum.failed > 0 ? EXIT.FAILED : EXIT.OK;
}

main().then((code) => { process.exitCode = code; }, (err) => {
  process.stderr.write(`pac-replay-codec: ${err && err.stack ? err.stack : err}\n`);
  process.exitCode = EXIT.FAILED;
});
