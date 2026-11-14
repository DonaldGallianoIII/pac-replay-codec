/**
 * Tests of the codec's building blocks against the slow, obviously right way of doing the same thing: the
 * recency list against a plain move-to-front array, the pair map against a Map, the string pool against a list,
 * and the coder's whole-symbol loops against its one-bit-at-a-time path.
 *
 * Run: node --test test/tables.test.ts
 *
 * @interacts none (no files)
 * @deps      src/intmap.ts, src/range-coder.ts, src/symbols.ts, node:test
 * @complexity a few hundred thousand table operations, under a second
 * @alloc     small tables
 * @rng       seeded LCG (Seed): every run draws the same sequence
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PairMap, Recency, StringPool, ABSENT } from '../src/intmap.ts';
import { RangeCoder } from '../src/range-coder.ts';
import { gamma1, gamma2, gammaSlots, zigzag, unzigzag, sizeClass, GAMMA_BITS_WIDE } from '../src/symbols.ts';

const CONFIG = Object.freeze({ Seed: 20261113, LcgA: 1664525, LcgC: 1013904223, RecencyOps: 20000, RecencyItems: 700, PairOps: 60000, Symbols: 40000 });

function lcg(seed: number): (n: number) => number {
  let s = seed;
  return (n: number): number => {
    s = (Math.imul(s, CONFIG.LcgA) + CONFIG.LcgC) >>> 0;
    return (s >>> 8) % n;
  };
}

test('Recency gives the ranks of a move-to-front list', () => {
  const rnd = lcg(CONFIG.Seed);
  const r = new Recency();
  const naive: number[] = []; // most recent first
  let next = 0;
  for (let op = 0; op < CONFIG.RecencyOps; op++) {
    const roll = rnd(10);
    if (naive.length === 0 || (roll === 0 && next < CONFIG.RecencyItems)) {
      const item = next++;
      if (rnd(2) === 0) {
        r.touch(item);
        naive.unshift(item);
      } else {
        r.pushOldest(item);
        naive.push(item);
      }
    } else {
      // mostly recent items, sometimes any item: both short and long ranks get exercised
      const at = rnd(4) === 0 ? rnd(naive.length) : rnd(Math.min(naive.length, 6));
      const item = naive[at];
      assert.equal(r.rankOf(item), at);
      assert.equal(r.itemAtRank(at), item);
      r.touch(item);
      naive.splice(at, 1);
      naive.unshift(item);
    }
    assert.equal(r.size, naive.length);
    if (op % 500 === 0) {
      for (let k = 0; k < naive.length; k++) {
        assert.equal(r.itemAtRank(k), naive[k]);
        assert.equal(r.rankOf(naive[k]), k);
      }
      assert.equal(r.itemAtRank(naive.length), ABSENT);
      assert.equal(r.itemAtRank(-1), ABSENT);
    }
  }
  assert.ok(naive.length > 500, 'the list grew past several table doublings');
});

test('PairMap is an exact map, through growth and clear', () => {
  const rnd = lcg(CONFIG.Seed + 1);
  const m = new PairMap(16);
  const ref = new Map<string, number>();
  for (let op = 0; op < CONFIG.PairOps; op++) {
    const a = rnd(300);
    const b = rnd(300);
    const key = `${a},${b}`;
    const want = ref.get(key) ?? ABSENT;
    const roll = rnd(3);
    if (roll === 0) assert.equal(m.get(a, b), want);
    else if (roll === 1) {
      const v = rnd(1 << 20);
      assert.equal(m.swap(a, b, v), want);
      ref.set(key, v);
    } else {
      const v = rnd(1 << 20);
      assert.equal(m.get(a, b), want);
      m.setLast(a, b, v);
      ref.set(key, v);
    }
  }
  assert.ok(ref.size > 20000);
  for (const [key, v] of ref) {
    const [a, b] = key.split(',').map(Number);
    assert.equal(m.get(a, b), v);
  }
  m.clear();
  assert.equal(m.get(1, 1), ABSENT);
});

test('StringPool: one id per distinct byte string, the empty string included', () => {
  const pool = new StringPool();
  const enc = new TextEncoder();
  const seen: string[] = [];
  const rnd = lcg(CONFIG.Seed + 2);
  for (let i = 0; i < 20000; i++) {
    const text = rnd(50) === 0 ? '' : `k${rnd(9000).toString(36)}`;
    const bytes = enc.encode(`pad${text}`);
    const s = 3;
    const e = bytes.length;
    const known = seen.indexOf(text);
    const id = pool.find(bytes, s, e);
    if (known < 0) {
      assert.equal(id, ABSENT);
      assert.equal(pool.add(bytes, s, e), seen.length);
      seen.push(text);
    } else assert.equal(id, known);
    if (seen.length > 3000) break;
  }
  assert.ok(seen.includes(''));
  const dec = new TextDecoder();
  for (let id = 0; id < seen.length; id++) assert.equal(dec.decode(pool.bytes.subarray(pool.start[id], pool.start[id + 1])), seen[id]);
});

test('the coder: whole-symbol loops write the same bytes as one bit at a time, and decode back', () => {
  const rnd = lcg(CONFIG.Seed + 3);
  const symbols: number[] = [];
  for (let i = 0; i < CONFIG.Symbols; i++) symbols.push(rnd(4) === 0 ? rnd(256) : rnd(7));
  const run = (rc: RangeCoder, slow: boolean, lazy: boolean): number[] => {
    if (slow) rc.account = new Float64Array(1); // accounting forces the one-bit path
    rc.lazy = lazy;
    const lo = rc.alloc(256);
    const hi: number[] = [];
    for (let k = 0; k < 8; k++) hi.push(rc.alloc(256));
    const plain = rc.alloc(64);
    const g = rc.alloc(gammaSlots(GAMMA_BITS_WIDE));
    const out: number[] = [];
    for (let i = 0; i < symbols.length; i++) {
      const v = symbols[i];
      out.push(rc.tree2(hi[i % 8], lo, 8, v, 2));
      out.push(rc.tree(plain, 6, v & 63));
      out.push(rc.bit2(hi[i % 8], lo, v & 1, 2));
      out.push(rc.raw(11, v * 7));
      out.push(gamma1(rc, g, GAMMA_BITS_WIDE, v * 1048583 * (i % 5)));
      out.push(gamma2(rc, plain, g, GAMMA_BITS_WIDE, v));
    }
    return out;
  };
  for (const lazy of [true, false]) {
    const fast = new RangeCoder();
    const want = run(fast, false, lazy);
    const fastBytes = fast.finish();
    const slow = new RangeCoder();
    run(slow, true, lazy);
    assert.deepEqual(Buffer.from(slow.finish()), Buffer.from(fastBytes), 'same packed bytes');
    assert.deepEqual(run(new RangeCoder(fastBytes), false, lazy), want, 'fast decode');
    assert.deepEqual(run(new RangeCoder(fastBytes), true, lazy), want, 'slow decode');
  }
});

test('integers up to 2^52 survive zigzag and the size-class code', () => {
  const values = [0, 1, 2, 3, 255, 256, 65535, 65536, 2 ** 31 - 1, 2 ** 31, 2 ** 32 - 1, 2 ** 32, 2 ** 32 + 1, 2 ** 40 + 12345, 2 ** 52 - 1, 2 ** 52];
  for (const v of values) {
    assert.equal(unzigzag(zigzag(v)), v);
    assert.equal(unzigzag(zigzag(-v)), -v);
    assert.equal(sizeClass(v), v === 0 ? 0 : BigInt(v).toString(2).length); // not Math.log2: it rounds 2^52 - 1 up
  }
  const enc = new RangeCoder();
  const base = enc.alloc(gammaSlots(GAMMA_BITS_WIDE));
  for (const v of values) gamma1(enc, base, GAMMA_BITS_WIDE, v);
  const dec = new RangeCoder(enc.finish());
  const base2 = dec.alloc(gammaSlots(GAMMA_BITS_WIDE));
  for (const v of values) assert.equal(gamma1(dec, base2, GAMMA_BITS_WIDE, 0), v);
});
