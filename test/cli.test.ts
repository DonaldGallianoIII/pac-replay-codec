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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'clrz-cli-test-'));
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
    assert.ok(f.out.endsWith('.clrz'));
    for (const key of ['file', 'out', 'status', 'in_bytes', 'out_bytes', 'ratio', 'exact', 'error']) assert.ok(key in f, key);
  }
  assert.deepEqual([summary.files, summary.exact, summary.skipped, summary.failed], [4, 4, 0, 0]);
  assert.ok(summary.ratio > 3);
  assert.ok(fs.existsSync(path.join(dir, 'deeper', 'copy-synthetic-schema4.clrz')));
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
  const packed = listAll(dir).filter((f) => f.endsWith('.clrz'));
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
  fs.copyFileSync(path.join(dir, NAMES[0].replace('.colreplay', '.clrz')), disguised);
  const { files } = parse(run('pack', disguised, '--json').lines);
  assert.equal(files[0].status, 'skipped');
  assert.equal(files[0].error, 'already packed');
  assert.ok(!fs.existsSync(path.join(dir, 'disguised.clrz')));
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

test('verify: writes nothing; a damaged .clrz and a missing path fail with exit 1', () => {
  const { dir } = tree('verify');
  run('pack', dir);
  const good = path.join(dir, NAMES[1].replace('.colreplay', '.clrz'));
  const bad = path.join(TMP, 'damaged.clrz');
  fs.writeFileSync(bad, fs.readFileSync(good).subarray(0, 2000));
  const filesBefore = listAll(TMP).length;
  const r = run('verify', good, bad, path.join(TMP, 'no-such-file'), '--json');
  assert.equal(r.code, EXIT.FAILED);
  const { files, summary } = parse(r.lines);
  const byFile = new Map(files.map((f) => [path.basename(f.file), f]));
  assert.equal(byFile.get(path.basename(good)).status, 'verified');
  assert.equal(byFile.get(path.basename(good)).exact, true);
  assert.equal(byFile.get('damaged.clrz').status, 'failed');
  assert.match(byFile.get('damaged.clrz').error, /damaged/);
  assert.equal(byFile.get('no-such-file').error, 'no such file or folder');
  assert.deepEqual([summary.exact, summary.failed], [1, 2]);
  assert.equal(listAll(TMP).length, filesBefore, 'verify wrote nothing');
});

test('unpack of a file that is not packed fails, and writes nothing', () => {
  const { dir } = tree('notpacked');
  const r = run('unpack', path.join(dir, NAMES[0]), '--json');
  assert.equal(r.code, EXIT.FAILED);
  assert.equal(parse(r.lines).files[0].error, 'not a .clrz file');
  assert.ok(!fs.existsSync(path.join(dir, 'synthetic-schema4.colreplay.colreplay')));
});

test('human output: one line per file and a summary', () => {
  const { dir } = tree('human');
  const r = run('pack', dir);
  assert.equal(r.code, EXIT.OK);
  assert.equal(r.lines.filter((l) => l.startsWith('ok packed')).length, 4);
  assert.match(r.lines.at(-1) ?? '', /^4 exact, 0 skipped, 0 failed, of 4\./);
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
