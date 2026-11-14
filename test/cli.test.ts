/**
 * Tests of the command line tool on the synthetic fixtures: pack, unpack and verify over files and nested
 * folders, the JSON lines, skipping, never touching originals, damaged input, and the exit codes.
 *
 * Run: node --test test/cli.test.ts
 *
 * @interacts runs cli/pac-replay-codec.mjs as a child process; copies test/fixtures/ into a temporary folder that
 *            it removes at the end
 * @deps      cli/pac-replay-codec.mjs, node:test, node:child_process
 * @complexity about 12 runs of the tool on 4 files of 20 KB
 * @alloc     the temporary folder, a few hundred KB
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const CLI = path.join(import.meta.dirname, '..', 'cli', 'pac-replay-codec.mjs');
const FIXTURES = path.join(import.meta.dirname, 'fixtures');
const NAMES = ['synthetic-schema4.colreplay', 'synthetic-schema5.colreplay'];
const EXIT = Object.freeze({ OK: 0, FAILED: 1, USAGE: 2 });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paczd-cli-test-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const sha = (file: string): string => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Run the tool; returns the exit code, stdout lines and stderr. */
function run(...args: string[]): { code: number | null; lines: string[]; err: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return { code: r.status, lines: r.stdout.split('\n').filter(Boolean), err: r.stderr };
}

/** Parse --json output into per-file records and the summary. */
function parse(lines: string[]) {
  const all = lines.map((l) => JSON.parse(l));
  const summary = all.at(-1);
  assert.equal(summary.summary, true, 'the last line is the summary');
  return { files: all.slice(0, -1), summary };
}

/**
 * A fresh tree: two fixtures at the top, the same two again one folder down (renamed), and a text file that is
 * not a replay. Returns the folder and the sha256 of every file in it.
 */
function tree(name: string): { dir: string; before: Map<string, string> } {
  const dir = path.join(TMP, name);
  fs.mkdirSync(path.join(dir, 'deeper'), { recursive: true });
  for (const n of NAMES) {
    fs.copyFileSync(path.join(FIXTURES, n), path.join(dir, n));
    fs.copyFileSync(path.join(FIXTURES, n), path.join(dir, 'deeper', `copy-${n}`));
  }
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a replay\n');
  const before = new Map<string, string>();
  for (const f of listAll(dir)) before.set(f, sha(f));
  return { dir, before };
}

function listAll(dir: string): string[] {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name)).sort();
}

function assertOriginalsUntouched(before: Map<string, string>) {
  for (const [file, hash] of before) {
    assert.ok(fs.existsSync(file), `${file} still exists`);
    assert.equal(sha(file), hash, `${file} is unchanged`);
  }
}

test('pack a folder: recursive, every file exact, outputs next to inputs, originals untouched', () => {
  const { dir, before } = tree('pack');
  const r = run('pack', dir, '--json', '--jobs', '2');
  assert.equal(r.code, EXIT.OK, r.err);
  const { files, summary } = parse(r.lines);
  assert.equal(files.length, 4, 'the four replays, not the text file');
  for (const f of files) {
    assert.equal(f.status, 'packed');
    assert.equal(f.exact, true);
    assert.equal(f.error, null);
    assert.ok(f.ratio > 3, `ratio ${f.ratio}`);
    assert.ok(fs.existsSync(f.out), `${f.out} was written`);
    assert.ok(f.out.endsWith('.paczd'));
    for (const key of ['file', 'out', 'status', 'in_bytes', 'out_bytes', 'ratio', 'exact', 'stored', 'error']) assert.ok(key in f, key);
  }
  assert.deepEqual([summary.files, summary.exact, summary.skipped, summary.failed], [4, 4, 0, 0]);
  assert.ok(summary.ratio > 3);
  assert.ok(fs.existsSync(path.join(dir, 'deeper', 'copy-synthetic-schema4.paczd')));
  assertOriginalsUntouched(before);
});

test('results come in the order the files were found, whatever the thread count', () => {
  const { dir } = tree('order');
  const one = parse(run('verify', dir, '--json', '--jobs', '1').lines).files.map((f) => f.file);
  const four = parse(run('verify', dir, '--json', '--jobs', '4').lines).files.map((f) => f.file);
  assert.deepEqual(four, one);
});

test('pack again: everything is skipped, nothing is replaced', () => {
  const { dir } = tree('again');
  assert.equal(run('pack', dir).code, EXIT.OK);
  const packed = listAll(dir).filter((f) => f.endsWith('.paczd'));
  const hashes = packed.map(sha);
  const stamps = packed.map((f) => fs.statSync(f).mtimeMs);
  const r = run('pack', dir, '--json');
  assert.equal(r.code, EXIT.OK);
  const { files, summary } = parse(r.lines);
  assert.ok(files.every((f) => f.status === 'skipped' && f.error === 'output exists'));
  assert.equal(summary.skipped, 4);
  assert.deepEqual(packed.map(sha), hashes);
  assert.deepEqual(packed.map((f) => fs.statSync(f).mtimeMs), stamps);
});

test('pack skips a file that is already packed, even when named as a replay', () => {
  const { dir } = tree('already');
  run('pack', path.join(dir, NAMES[0]));
  const disguised = path.join(dir, 'disguised.colreplay');
  fs.copyFileSync(path.join(dir, NAMES[0].replace('.colreplay', '.paczd')), disguised);
  const { files } = parse(run('pack', disguised, '--json').lines);
  assert.equal(files[0].status, 'skipped');
  assert.equal(files[0].error, 'already packed');
  assert.ok(!fs.existsSync(path.join(dir, 'disguised.paczd')));
});

test('unpack into -o: the folder layout is kept and every byte comes back', () => {
  const { dir } = tree('unpack');
  assert.equal(run('pack', dir, '-o', path.join(TMP, 'unpack-packed')).code, EXIT.OK);
  const restored = path.join(TMP, 'unpack-restored');
  const r = run('unpack', path.join(TMP, 'unpack-packed'), '-o', restored, '--json');
  assert.equal(r.code, EXIT.OK, r.err);
  const { files, summary } = parse(r.lines);
  assert.equal(summary.exact, 4);
  assert.ok(files.every((f) => f.status === 'unpacked' && f.exact));
  for (const n of NAMES) {
    assert.equal(sha(path.join(restored, n)), sha(path.join(FIXTURES, n)));
    assert.equal(sha(path.join(restored, 'deeper', `copy-${n}`)), sha(path.join(FIXTURES, n)));
  }
});

test('verify: writes nothing; a damaged .paczd and a missing path fail with exit 1', () => {
  const { dir } = tree('verify');
  run('pack', dir);
  const good = path.join(dir, NAMES[1].replace('.colreplay', '.paczd'));
  const bad = path.join(TMP, 'damaged.paczd');
  fs.writeFileSync(bad, fs.readFileSync(good).subarray(0, 2000));
  const filesBefore = listAll(TMP).length;
  const r = run('verify', good, bad, path.join(TMP, 'no-such-file'), '--json');
  assert.equal(r.code, EXIT.FAILED);
  const { files, summary } = parse(r.lines);
  const byFile = new Map(files.map((f) => [path.basename(f.file), f]));
  assert.equal(byFile.get(path.basename(good)).status, 'verified');
  assert.equal(byFile.get(path.basename(good)).exact, true);
  assert.equal(byFile.get('damaged.paczd').status, 'failed');
  assert.match(byFile.get('damaged.paczd').error, /damaged/);
  assert.equal(byFile.get('no-such-file').error, 'no such file or folder');
  assert.deepEqual([summary.exact, summary.failed], [1, 2]);
  assert.equal(listAll(TMP).length, filesBefore, 'verify wrote nothing');
});

test('unpack of a file that is not packed fails, and writes nothing', () => {
  const { dir } = tree('notpacked');
  const r = run('unpack', path.join(dir, NAMES[0]), '--json');
  assert.equal(r.code, EXIT.FAILED);
  assert.equal(parse(r.lines).files[0].error, 'not a .paczd file');
  assert.ok(!fs.existsSync(path.join(dir, 'synthetic-schema4.colreplay.colreplay')));
});

test('human output: one line per file and a summary', () => {
  const { dir } = tree('human');
  const r = run('pack', dir);
  assert.equal(r.code, EXIT.OK);
  assert.equal(r.lines.filter((l) => l.startsWith('ok packed')).length, 4);
  assert.match(r.lines.at(-1) ?? '', /^4 exact, 0 stored, 0 skipped, 0 failed, of 4\./);
});

test('bad usage exits 2 with a message; --help exits 0 with examples', () => {
  for (const args of [[], ['squash', 'x'], ['pack'], ['pack', 'x', '--jobs', '0'], ['pack', 'x', '--jobs'],
    ['pack', 'x', '--fast'], ['verify', 'x', '-o', 'y']]) {
    const r = run(...args);
    assert.equal(r.code, EXIT.USAGE, `${args.join(' ')} is bad usage`);
    assert.match(r.err, /pac-replay-codec: /);
  }
  const h = run('--help');
  assert.equal(h.code, EXIT.OK);
  assert.ok(h.lines.some((l) => l.includes('npx pac-replay-codec pack ./replays')));
});

test('two inputs that would write the same output: the second fails before any work, exit 1', () => {
  const { dir } = tree('collide');
  fs.mkdirSync(path.join(dir, 'other'));
  fs.copyFileSync(path.join(FIXTURES, NAMES[0]), path.join(dir, 'other', NAMES[0]));
  const outDir = path.join(TMP, 'collide-out');
  for (const jobs of ['1', '4']) {
    fs.rmSync(outDir, { recursive: true, force: true });
    const r = run('pack', path.join(dir, NAMES[0]), path.join(dir, 'other', NAMES[0]), '-o', outDir, '--json', '--jobs', jobs);
    assert.equal(r.code, EXIT.FAILED);
    const { files, summary } = parse(r.lines);
    assert.equal(files[0].status, 'packed', 'the first input wins, every time');
    assert.equal(files[1].status, 'failed');
    assert.match(files[1].error, /^output name collides with /);
    assert.deepEqual([summary.exact, summary.failed], [1, 1]);
    assert.deepEqual(fs.readdirSync(outDir), ['synthetic-schema4.paczd']);
  }
});

test('a folder that cannot be read is one failed line; the rest of the run goes on', { skip: process.getuid?.() === 0 ? 'root can read any folder' : false }, () => {
  const { dir } = tree('locked');
  const locked = path.join(dir, 'locked');
  fs.mkdirSync(locked);
  fs.chmodSync(locked, 0o000);
  try {
    const r = run('verify', dir, '--json');
    assert.equal(r.code, EXIT.FAILED);
    const { files, summary } = parse(r.lines);
    const bad = files.filter((f) => f.status === 'failed');
    assert.equal(bad.length, 1);
    assert.match(bad[0].error, /could not read folder/);
    assert.equal(summary.exact, 4, 'the four readable replays were still verified');
  } finally {
    fs.chmodSync(locked, 0o700);
  }
});

test('a file that is not a replay packs as stored: exact, no ratio, left out of the totals', () => {
  const { dir } = tree('stored');
  const r = run('pack', path.join(dir, 'notes.txt'), path.join(dir, NAMES[0]), '--json');
  assert.equal(r.code, EXIT.OK);
  const { files, summary } = parse(r.lines);
  assert.equal(files[0].status, 'stored');
  assert.equal(files[0].stored, true);
  assert.equal(files[0].exact, true);
  assert.equal(files[0].ratio, null);
  assert.equal(files[1].stored, false);
  assert.deepEqual([summary.exact, summary.stored], [1, 1]);
  assert.equal(summary.in_bytes, files[1].in_bytes, 'only the replay is in the totals');
  assert.equal(summary.ratio, files[1].ratio);
});

test('legacy .clrz names: unpack and verify find them in folders and restore .colreplay', () => {
  const { dir } = tree('legacy');
  const packedDir = path.join(TMP, 'legacy-packed');
  assert.equal(run('pack', dir, '-o', packedDir).code, EXIT.OK);
  for (const f of listAll(packedDir)) fs.renameSync(f, f.replace(/\.paczd$/, '.clrz'));
  assert.equal(parse(run('verify', packedDir, '--json').lines).summary.exact, 4);
  const restored = path.join(TMP, 'legacy-restored');
  const r = run('unpack', packedDir, '-o', restored, '--json');
  assert.equal(r.code, EXIT.OK);
  assert.equal(parse(r.lines).summary.exact, 4);
  for (const n of NAMES) assert.equal(sha(path.join(restored, n)), sha(path.join(FIXTURES, n)));
});

