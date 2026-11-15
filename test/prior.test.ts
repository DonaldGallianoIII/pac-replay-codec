/**
 * Tests of the starting model (prior) slot: the file format, loading one into the coder, packing and unpacking
 * with it, and what happens with a prior that does not fit. No prior ships with the codec; these tests build a
 * small hand-made one for the synthetic fixture in test/fixtures/.
 *
 * Run: node --test test/prior.test.ts
 *
 * @interacts reads test/fixtures/synthetic-schema5.colreplay; writes nothing
 * @deps      support.ts (the hand-made model), src (index.ts, codec.ts, prior.ts), node:test
 * @complexity about 10 pack and unpack calls on a 20 KB file
 * @alloc     one replay and its packed and unpacked forms at a time
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { packReplay, unpackReplay, parsePrior, MODE_CODED, MODE_PRIOR } from '../src/index.ts';
import { Codec } from '../src/codec.ts';
import { writePrior, levelProbability, SITE, CONTEXTS_UNCHECKED, PROB_LEVELS, COUNT_LEVELS } from '../src/prior.ts';
import { SYNTHETIC, sha, handMadePrior as handMade } from './support.ts';

const SOURCE = SYNTHETIC[1];

/**
 * The format lock for the prior path: sha256 of the hand-made prior file below, and of the synthetic fixture
 * packed with it. They change only when the prior file layout, the loader or the model changes (see the lock in
 * codec.test.ts).
 */
const LOCK = Object.freeze({
  PriorFile: '5b560f6e957d0072bafd58fb1a166f63a82443e093022f191fb10c852f1c96b8',
  Packed: 'eaa2ecb27697c5b86d017407687f89411f72517b4a39f07c3eb8951290034c09',
});

test('format lock: the prior file layout and the bytes packed from it', () => {
  const src = fs.readFileSync(SOURCE);
  const file = writePrior(handMade(src));
  assert.equal(sha(file), LOCK.PriorFile);
  assert.equal(sha(packReplay(src, { prior: parsePrior(file) }).bytes), LOCK.Packed);
});

test('prior file: write, parse, same content; damage is refused', () => {
  const parts = handMade(fs.readFileSync(SOURCE));
  const file = writePrior(parts);
  const prior = parsePrior(file);
  assert.equal(prior.contexts, parts.contexts);
  assert.equal(sha(prior.handshake), sha(parts.handshake));
  assert.deepEqual(Array.from(prior.fieldOwner), parts.fields.map((f) => f.owner));
  assert.deepEqual(Array.from(prior.fieldKey), parts.fields.map((f) => f.key));
  assert.deepEqual(Array.from(prior.fieldDict), [0, 1, 2]);
  assert.deepEqual(Array.from(prior.blockSite), parts.blocks.map((b) => b.site));
  assert.deepEqual(Array.from(prior.blockA), parts.blocks.map((b) => b.a));
  assert.deepEqual(Array.from(prior.blockC), parts.blocks.map((b) => b.c));
  assert.deepEqual(Array.from(prior.ctxIndex), parts.states.map((s) => s.index));
  assert.equal(new TextDecoder().decode(prior.stringBytes.subarray(prior.stringStart[1], prior.stringStart[2])), 'PIKACHU');
  // the id is the checksum at the end of the file
  assert.equal(prior.id, new DataView(file.buffer).getUint32(file.length - 4, true));
  for (const at of [0, 5, 12, Math.floor(file.length / 2), file.length - 1]) {
    const bad = file.slice();
    bad[at] ^= 0x10;
    assert.throws(() => parsePrior(bad), `a flipped bit at byte ${at} is refused`);
  }
  assert.throws(() => parsePrior(file.subarray(0, file.length - 9)));
  assert.throws(() => parsePrior(new Uint8Array(3)));
});

test('state codes: 64 levels mirror around one half, counts stay under the coder limit', () => {
  for (let k = 0; k < 32; k++) {
    assert.equal(levelProbability(k), PROB_LEVELS[k]);
    assert.equal(levelProbability(63 - k), 65536 - PROB_LEVELS[k]);
    if (k > 0) assert.ok(PROB_LEVELS[k] > PROB_LEVELS[k - 1]);
  }
  assert.ok(PROB_LEVELS[31] < 32768);
  for (const c of COUNT_LEVELS) assert.ok(c >= 2 && c <= 30);
});

test('hand-made prior: loads, is used, and the replay round trips', () => {
  const src = fs.readFileSync(SOURCE);
  const prior = parsePrior(writePrior(handMade(src)));
  const cold = packReplay(src);
  const packed = packReplay(src, { prior });
  assert.equal(packed.mode, MODE_PRIOR);
  assert.equal(packed.priorId, prior.id);
  assert.equal(packed.error, null);
  assert.ok(packed.bytes.length < cold.bytes.length, 'the known type table alone saves bytes');
  const back = unpackReplay(packed.bytes, [prior]);
  assert.equal(sha(back), sha(src));
  // cold packing is untouched by the option being absent
  assert.equal(cold.mode, MODE_CODED);
  assert.equal(cold.priorId, 0);
});

test('a prior made for another table layout is refused, not misread', () => {
  const src = fs.readFileSync(SOURCE);
  const parts = handMade(src);
  const wrong = parsePrior(writePrior({ ...parts, contexts: parts.contexts + 64 }));
  assert.throws(() => new Codec(new Uint8Array(0), true, { gameAware: false, account: false, rawLen: 0, prior: wrong }), /does not fit this build/);
  // packReplay never fails: it packs cold, says why, and the file needs no prior
  const packed = packReplay(src, { prior: wrong });
  assert.equal(packed.mode, MODE_CODED);
  assert.equal(packed.priorId, 0);
  assert.match(packed.error ?? '', /does not fit this build/);
  assert.equal(sha(packed.bytes), sha(packReplay(src).bytes));
  assert.equal(sha(unpackReplay(packed.bytes)), sha(src));
  const outside = parsePrior(writePrior({ ...parts, states: [], blocks: [{ site: SITE.BYTE, a: 40000, b: 0, c: 0 }] }));
  assert.throws(() => new Codec(new Uint8Array(0), true, { gameAware: false, account: false, rawLen: 0, prior: { ...outside, contexts: CONTEXTS_UNCHECKED } }), /does not fit this build/);
});
