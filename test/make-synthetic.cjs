/**
 * Writes a small replay recorded from a schema that is NOT PAC's, using a real @colyseus/schema encoder. It is
 * the test that the codec is self-describing: it has never seen these types, and must still walk every frame.
 *
 * Usage: node test/make-synthetic.cjs PATH_TO_@colyseus/schema OUT.colreplay
 *
 * @interacts loads the Colyseus schema package at the given path; writes one file
 * @deps      @colyseus/schema 4.x or 5.x (not bundled: the path is an argument)
 * @complexity O(Patches) encoder calls, a few hundred
 * @alloc     one file of about 30 KB
 * @rng       seeded LCG (Seed), so the same package version always writes the same bytes
 */
const fs = require('node:fs');
const pkg = process.argv[2];
const out = process.argv[3];
const { Schema, defineTypes, Encoder, Reflection, MapSchema, ArraySchema } = require(pkg);
const version = require(pkg + '/package.json').version;

const CONFIG = Object.freeze({ Seed: 20261113, Patches: 400, LcgA: 1664525, LcgC: 1013904223, PatchMs: 50, ProtocolByte: 15 });
let seed = CONFIG.Seed;
const rnd = (n) => {
  seed = (Math.imul(seed, CONFIG.LcgA) + CONFIG.LcgC) >>> 0;
  return (seed >>> 8) % n;
};

class Part extends Schema {}
defineTypes(Part, { label: 'string', wear: 'uint8', angle: 'float32' });
class Crate extends Schema {}
defineTypes(Crate, { name: 'string', qty: 'uint16', price: 'float32', open: 'boolean', part: Part, notes: ['string'] });
class Fridge extends Crate {}
defineTypes(Fridge, { degrees: 'int8', drift: 'number' });
class Yard extends Schema {}
defineTypes(Yard, { crates: { map: Crate }, tick: 'number', load: 'float32', log: ['string'], sizes: ['uint16'], gate: Part });

const state = new Yard();
state.crates = new MapSchema();
state.log = new ArraySchema();
state.sizes = new ArraySchema();
state.gate = new Part();
state.gate.label = 'north';
state.tick = 0;
const encoder = new Encoder(state);
const copy = (u8) => Buffer.from(u8.slice(0));

const frames = [];
const varint = (v) => {
  const b = [];
  while (v >= 128) { b.push((v % 128) | 128); v = Math.floor(v / 128); }
  b.push(v);
  return Buffer.from(b);
};
const stateFrame = (kind, dt, payload) => {
  const body = Buffer.concat([Buffer.from([CONFIG.ProtocolByte]), payload]);
  frames.push(Buffer.concat([Buffer.from([kind]), varint(dt), varint(1), varint(body.length), body]));
};
const messageFrame = (dt, type, msgpackBytes) => {
  const t = Buffer.from(type);
  frames.push(Buffer.concat([Buffer.from([3]), varint(dt), Buffer.from([1]), varint(t.length), t, Buffer.from([0]), varint(msgpackBytes.length), msgpackBytes]));
};

stateFrame(0, 0, copy(Reflection.encode(encoder)));
stateFrame(1, 3, copy(encoder.encodeAll({ offset: 0 })));
encoder.discardChanges();
const names = ['apples', 'bolts', 'cloth', 'drums', 'eels'];
let made = 0;
for (let i = 0; i < CONFIG.Patches; i++) {
  state.tick += CONFIG.PatchMs + rnd(3) - 1;
  state.load = Math.fround(Math.sin(i / 9) * 40 + 100);
  state.gate.angle = Math.fround(i * 0.25);
  const keys = Array.from(state.crates.keys());
  const roll = rnd(10);
  if (roll < 2 || keys.length < 3) {
    const c = rnd(3) === 0 ? new Fridge() : new Crate();
    c.name = names[rnd(names.length)];
    c.qty = 10 + rnd(500);
    c.price = Math.fround(1 + rnd(1000) / 8);
    c.open = rnd(2) === 1;
    c.part = new Part();
    c.part.label = 'lid';
    c.part.wear = rnd(4);
    c.notes = new ArraySchema();
    if (c instanceof Fridge) { c.degrees = -18 + rnd(5); c.drift = rnd(2) === 0 ? 7 : 0.5 + rnd(9); }
    state.crates.set('crate-' + (made++).toString(16).padStart(4, '0'), c);
    state.log.push('made ' + c.name);
  } else if (roll === 2 && keys.length > 4) {
    state.crates.delete(keys[rnd(keys.length)]);
    if (state.log.length > 6) state.log.shift();
  } else {
    const c = state.crates.get(keys[rnd(keys.length)]);
    c.qty = Math.max(0, c.qty - 1 - rnd(3));
    if (rnd(3) === 0) c.price = Math.fround(c.price * 1.01);
    if (rnd(5) === 0) c.open = !c.open;
    if (rnd(4) === 0) c.part.wear = Math.min(255, c.part.wear + 1);
    if (rnd(6) === 0) c.notes.push('checked ' + i);
    if (c instanceof Fridge && rnd(2) === 0) c.degrees = Math.max(-30, c.degrees - 1);
  }
  if (rnd(7) === 0) state.sizes.push(100 + rnd(5000));
  if (encoder.hasChanges) {
    stateFrame(2, CONFIG.PatchMs + rnd(5) - 2, copy(encoder.encode({ offset: 0 })));
    encoder.discardChanges();
  }
  if (rnd(8) === 0) {
    // {"kind":"scan","at":<uint16>} as msgpack, by hand
    const at = rnd(60000);
    messageFrame(0, 'scan', Buffer.from([0x82, 0xa4, 0x6b, 0x69, 0x6e, 0x64, 0xa4, 0x73, 0x63, 0x61, 0x6e, 0xa2, 0x61, 0x74, 0xcd, at >> 8, at & 255]));
  }
}
const meta = Buffer.from(JSON.stringify({ format: 'colreplay-v1', schemaVersion: 1, game: { version: 'synthetic-' + version, serializerId: 'schema' }, room: 'yard' }));
const metaLen = Buffer.alloc(4);
metaLen.writeUInt32LE(meta.length);
const summary = Buffer.from(JSON.stringify({ frames: frames.length, crates: made }));
const summaryLen = Buffer.alloc(4);
summaryLen.writeUInt32LE(summary.length);
fs.writeFileSync(out, Buffer.concat([Buffer.from('CLRP'), Buffer.from([1]), metaLen, meta, ...frames, summary, summaryLen, Buffer.from('CLTR')]));
console.log(`${out}: schema ${version}, ${frames.length} frames, ${fs.statSync(out).size} bytes`);
