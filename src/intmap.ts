/**
 * Exact integer-keyed tables for the codec's hot paths: a map from a pair of non-negative integers to an integer,
 * and a pool that gives every distinct byte string one small id. Both are open addressing over typed arrays: no
 * objects per entry, no JavaScript strings, nothing for the garbage collector to trace.
 *
 * These are plain exact maps. The packed bytes do not depend on how they hash or probe, only on what they answer,
 * so a port to another language is free to use its own tables.
 *
 * Recency answers move-to-front ranks in O(log n). Rows is the dense counterpart of PairMap: a two-level table for keys (id, k) where id is small and k is bounded. No hashing
 * at all, two array reads per lookup.
 *
 * @interacts none
 * @deps      none
 * @complexity get, set, intern: O(1) expected, O(length) for the byte hash and compare of intern; Rows.entry O(1)
 * @alloc     tables double when half full; the string pool's byte store doubles when full; Rows adds one row of
 *            `width` integers the first time an id is used
 */

/** Odd multipliers for mixing two keys into a table index (golden-ratio constants; any odd numbers would do). */
const MIX_A = 0x9e3779b1;
const MIX_B = 0x85ebca6b;
/** FNV-1a 32 bit parameters for hashing byte strings. The offset is kept as a signed 32 bit value, like every hash. */
const FNV_OFFSET = 0x811c9dc5 | 0;
const FNV_PRIME = 0x01000193;
/** Value returned for a missing key. */
export const ABSENT = -1;

export const CONFIG = Object.freeze({
  /** First capacity of a PairMap, in entries. Must be a power of two. */
  PairStart: 1 << 12,
  /** First capacity of the string pool's id table. Must be a power of two. */
  PoolStart: 1 << 12,
  /** First size of the string pool's byte store. */
  PoolBytesStart: 1 << 16,
  /** First capacity of a Rows table, in rows. */
  RowsStart: 8,
  /** First capacity of a Recency list, in time slots. Must be a power of two. */
  RecencyStart: 256,
});

/** Integers per PairMap slot: key a, key b, value. One slot is one cache line touch. */
const PAIR_STRIDE = 3;

/** Exact map from (a, b), both >= 0, to an integer >= 0. */
export class PairMap {
  /** Slots of PAIR_STRIDE integers: a (ABSENT when the slot is empty), b, value. */
  private t: Int32Array;
  private mask: number;
  private count: number;
  /** Offset in `t` of the slot the last get() ended on, for setLast(). */
  private last: number;

  constructor(capacity: number = CONFIG.PairStart) {
    this.t = new Int32Array(capacity * PAIR_STRIDE).fill(ABSENT);
    this.mask = capacity - 1;
    this.count = 0;
    this.last = 0;
  }

  /** Offset of the slot that holds (a, b), or of the empty slot where it belongs. */
  private slot(a: number, b: number): number {
    const t = this.t;
    let i = ((Math.imul(a, MIX_A) ^ Math.imul(b, MIX_B)) >>> 7) & this.mask;
    let at = i * PAIR_STRIDE;
    while (t[at] !== ABSENT && (t[at] !== a || t[at + 1] !== b)) {
      i = (i + 1) & this.mask;
      at = i * PAIR_STRIDE;
    }
    return at;
  }

  /** Value stored for (a, b), or ABSENT. @complexity O(1) expected @alloc none */
  get(a: number, b: number): number {
    const at = this.slot(a, b);
    this.last = at;
    return this.t[at] === ABSENT ? ABSENT : this.t[at + 2];
  }

  /**
   * Store v for (a, b), the key of the get() made just before (no other call on this map in between): no second
   * probe. @complexity O(1) @alloc doubles the table when half full
   */
  setLast(a: number, b: number, v: number): void {
    const t = this.t;
    const at = this.last;
    if (t[at] !== ABSENT) {
      t[at + 2] = v;
      return;
    }
    t[at] = a;
    t[at + 1] = b;
    t[at + 2] = v;
    if (++this.count * 2 > this.mask) this.grow();
  }

  /**
   * Store v for (a, b) and return what was there before (ABSENT if nothing).
   * @complexity O(1) expected @alloc doubles the table when half full
   */
  swap(a: number, b: number, v: number): number {
    const old = this.get(a, b);
    this.setLast(a, b, v);
    return old;
  }

  /** Forget every entry, keep the capacity. @complexity O(capacity) @alloc none */
  clear(): void {
    this.t.fill(ABSENT);
    this.count = 0;
  }

  /**
   * Call fn(a, b, value) for every entry, in table order (not insertion order). For the prior trainer, which
   * reads a finished model; nothing in the coding path uses it.
   * @complexity O(capacity) @alloc none
   */
  forEach(fn: (a: number, b: number, v: number) => void): void {
    const t = this.t;
    for (let at = 0; at < t.length; at += PAIR_STRIDE) if (t[at] !== ABSENT) fn(t[at], t[at + 1], t[at + 2]);
  }

  private grow(): void {
    const old = this.t;
    const cap = (this.mask + 1) * 2;
    this.t = new Int32Array(cap * PAIR_STRIDE).fill(ABSENT);
    this.mask = cap - 1;
    for (let j = 0; j < old.length; j += PAIR_STRIDE) {
      if (old[j] === ABSENT) continue;
      const at = this.slot(old[j], old[j + 1]);
      this.t[at] = old[j];
      this.t[at + 1] = old[j + 1];
      this.t[at + 2] = old[j + 2];
    }
  }
}

/**
 * Dense two-level table: one row of `width` entries per id, created the first time the id is used. Each entry
 * holds two integers for the caller: `ctx` (0 = not set yet, typically the base of a block of coder contexts) and
 * `aux` (free use, starts at 0). entry(id, k) returns the entry's index into both arrays.
 */
export class Rows {
  private rowOf: Int32Array;
  ctx: Int32Array;
  aux: Int32Array;
  private used: number;
  private readonly width: number;

  /**
   * @param ids number of distinct ids (the id range is 0 .. ids - 1)
   * @param width entries per row
   * @complexity O(ids) @alloc the id table and room for a few rows
   */
  constructor(ids: number, width: number) {
    this.rowOf = new Int32Array(ids);
    this.width = width;
    this.used = width; // entry 0 is never handed out, so a zero in rowOf means "no row yet"
    this.ctx = new Int32Array(width * CONFIG.RowsStart);
    this.aux = new Int32Array(width * CONFIG.RowsStart);
  }

  /** Index of entry (id, k), 0 <= k < width. @complexity O(1) @alloc a row on the id's first use */
  entry(id: number, k: number): number {
    let r = this.rowOf[id];
    if (r === 0) {
      r = this.used;
      this.used += this.width;
      if (this.used > this.ctx.length) {
        let cap = this.ctx.length * 2;
        while (cap < this.used) cap *= 2;
        const c = new Int32Array(cap);
        c.set(this.ctx);
        this.ctx = c;
        const a = new Int32Array(cap);
        a.set(this.aux);
        this.aux = a;
      }
      this.rowOf[id] = r;
    }
    return r + k;
  }

  /**
   * Call fn(id, k, entry) for every entry whose `ctx` is set. For the prior trainer, which reads a finished
   * model; nothing in the coding path uses it.
   * @complexity O(ids + rows x width) @alloc none
   */
  forEach(fn: (id: number, k: number, entry: number) => void): void {
    const rowOf = this.rowOf;
    for (let id = 0; id < rowOf.length; id++) {
      const r = rowOf[id];
      if (r === 0) continue;
      for (let k = 0; k < this.width; k++) if (this.ctx[r + k] !== 0) fn(id, k, r + k);
    }
  }

  /**
   * Call fn(id, first) for every row in existence, where first is the index of its entry 0 (entry k of the row
   * is first + k, set or not). For the prior trainer.
   * @complexity O(ids) @alloc none
   */
  forEachRow(fn: (id: number, first: number) => void): void {
    const rowOf = this.rowOf;
    for (let id = 0; id < rowOf.length; id++) if (rowOf[id] !== 0) fn(id, rowOf[id]);
  }
}

/**
 * Items (small non-negative integers) ordered by last use. Answers the two questions of a move-to-front list,
 * "how many items were used more recently than this one" and "which item has that rank", in O(log n) instead of
 * O(rank), and gives exactly the same answers.
 *
 * How: every use takes the next free time slot on the "recent" side; an item added as the least recent takes the
 * next slot on the "old" side. A Fenwick tree counts the occupied slots, so a rank is one prefix sum and the
 * inverse is one descent. When either side runs out of slots the occupied ones are packed back to the middle.
 */
export class Recency {
  /** Fenwick tree over slots 1..cap: tree[i] covers (i - lowbit(i), i]. */
  private tree: Int32Array;
  /** slot -> item + 1, 0 = free */
  private itemAt: Int32Array;
  /** item -> slot, 0 = not in the list */
  private slotOf: Int32Array;
  private cap: number;
  /** Lowest and highest slot in use (lo > hi when empty). */
  private lo: number;
  private hi: number;
  /** Number of items in the list. */
  size: number;

  /** @complexity O(RecencyStart) @alloc three small tables */
  constructor() {
    this.cap = CONFIG.RecencyStart;
    this.tree = new Int32Array(this.cap + 1);
    this.itemAt = new Int32Array(this.cap + 1);
    this.slotOf = new Int32Array(CONFIG.RecencyStart);
    this.lo = (this.cap >> 1) + 1;
    this.hi = this.cap >> 1;
    this.size = 0;
  }

  private add(slot: number, d: number): void {
    const t = this.tree;
    for (let i = slot; i <= this.cap; i += i & -i) t[i] += d;
  }

  /** Pack the occupied slots into the middle of a table at least twice their number. */
  private repack(): void {
    const old = this.itemAt;
    let cap = this.cap;
    while (cap < this.size * 4 + 4) cap *= 2;
    const itemAt = new Int32Array(cap + 1);
    const tree = new Int32Array(cap + 1);
    let slot = ((cap - this.size) >> 1) + 1;
    this.lo = slot;
    for (let s = 1; s < old.length; s++) {
      const it = old[s];
      if (it === 0) continue;
      itemAt[slot] = it;
      this.slotOf[it - 1] = slot;
      tree[slot] = 1;
      slot++;
    }
    this.hi = slot - 1;
    // build the Fenwick tree in one pass: push each node's sum to its parent
    for (let i = 1; i <= cap; i++) {
      const j = i + (i & -i);
      if (j <= cap) tree[j] += tree[i];
    }
    this.cap = cap;
    this.itemAt = itemAt;
    this.tree = tree;
  }

  private place(item: number, slot: number): void {
    if (item >= this.slotOf.length) {
      let n = this.slotOf.length * 2;
      while (n <= item) n *= 2;
      const so = new Int32Array(n);
      so.set(this.slotOf);
      this.slotOf = so;
    }
    this.itemAt[slot] = item + 1;
    this.slotOf[item] = slot;
    this.add(slot, 1);
  }

  /** True when the item is in the list. */
  has(item: number): boolean {
    return item < this.slotOf.length && this.slotOf[item] !== 0;
  }

  /**
   * Make `item` the most recent one (adding it when it is new).
   * @complexity O(log n) amortized @alloc doubles the tables when they fill
   */
  touch(item: number): void {
    const from = item < this.slotOf.length ? this.slotOf[item] : 0;
    if (from !== 0) {
      if (from === this.hi) return;
      this.itemAt[from] = 0;
      this.add(from, -1);
    } else this.size++;
    if (this.hi === this.cap) this.repack();
    this.place(item, ++this.hi);
  }

  /**
   * Add a new item as the least recent one.
   * @complexity O(log n) amortized @alloc doubles the tables when they fill
   */
  pushOldest(item: number): void {
    this.size++;
    if (this.lo === 1) this.repack();
    this.place(item, --this.lo);
  }

  /** How many items were used more recently than `item` (which must be in the list). @complexity O(log n) */
  rankOf(item: number): number {
    const t = this.tree;
    let sum = 0;
    for (let i = this.slotOf[item]; i > 0; i -= i & -i) sum += t[i];
    return this.size - sum;
  }

  /** The item with `rank` more recent ones before it, or ABSENT when rank is not below size. @complexity O(log n) */
  itemAtRank(rank: number): number {
    if (rank < 0 || rank >= this.size) return ABSENT;
    // the slot whose prefix count is size - rank: descend the tree
    let want = this.size - rank;
    let pos = 0;
    const t = this.tree;
    let step = 1;
    while (step * 2 <= this.cap) step *= 2;
    for (; step > 0; step >>= 1) {
      const next = pos + step;
      if (next <= this.cap && t[next] < want) {
        pos = next;
        want -= t[next];
      }
    }
    return this.itemAt[pos + 1] - 1;
  }
}

/** Gives every distinct byte string an id 0, 1, 2, ... in order of first appearance, and keeps the bytes. */
export class StringPool {
  private table: Int32Array; // id + 1, 0 = empty
  private hashes: Int32Array; // per id
  private mask: number;
  /** Start of each string in `bytes`, by id; start[count] is the end of the last one. */
  start: Int32Array;
  bytes: Uint8Array;
  count: number;

  constructor() {
    this.table = new Int32Array(CONFIG.PoolStart);
    this.hashes = new Int32Array(CONFIG.PoolStart);
    this.mask = CONFIG.PoolStart - 1;
    this.start = new Int32Array(CONFIG.PoolStart + 1);
    this.bytes = new Uint8Array(CONFIG.PoolBytesStart);
    this.count = 0;
  }

  /** Length in bytes of string `id`. */
  length(id: number): number {
    return this.start[id + 1] - this.start[id];
  }

  /**
   * Id of the string b[s..e), or ABSENT when it has not been added. Does not add.
   * @complexity O(e - s) @alloc none
   */
  find(b: Uint8Array, s: number, e: number): number {
    let h = FNV_OFFSET;
    for (let i = s; i < e; i++) h = Math.imul(h ^ b[i], FNV_PRIME);
    this.lastHash = h;
    const len = e - s;
    const bytes = this.bytes;
    let i = (h >>> 0) & this.mask;
    for (;;) {
      const id = this.table[i] - 1;
      if (id < 0) return ABSENT;
      if (this.hashes[id] === h && this.start[id + 1] - this.start[id] === len) {
        const at = this.start[id];
        let k = 0;
        while (k < len && bytes[at + k] === b[s + k]) k++;
        if (k === len) return id;
      }
      i = (i + 1) & this.mask;
    }
  }

  /** Hash of the string most recently passed to find(), reused by add(). */
  private lastHash = 0;

  /**
   * Add b[s..e), which find() just reported ABSENT, and return its new id.
   * @complexity O(e - s) @alloc doubles the tables or the byte store when full
   */
  add(b: Uint8Array, s: number, e: number): number {
    const id = this.count;
    const len = e - s;
    const at = this.start[id];
    if (at + len > this.bytes.length) {
      let cap = this.bytes.length * 2;
      while (cap < at + len) cap *= 2;
      const nb = new Uint8Array(cap);
      nb.set(this.bytes.subarray(0, at));
      this.bytes = nb;
    }
    for (let k = 0; k < len; k++) this.bytes[at + k] = b[s + k];
    if (id + 2 > this.start.length) {
      const ns = new Int32Array(this.start.length * 2);
      ns.set(this.start);
      this.start = ns;
    }
    this.start[id + 1] = at + len;
    if (id >= this.hashes.length) {
      const nh = new Int32Array(this.hashes.length * 2);
      nh.set(this.hashes);
      this.hashes = nh;
    }
    this.hashes[id] = this.lastHash;
    this.count = id + 1;
    if (this.count * 2 > this.mask) this.rehash();
    else {
      let i = (this.lastHash >>> 0) & this.mask;
      while (this.table[i] !== 0) i = (i + 1) & this.mask;
      this.table[i] = id + 1;
    }
    return id;
  }

  private rehash(): void {
    const cap = (this.mask + 1) * 2;
    this.table = new Int32Array(cap);
    this.mask = cap - 1;
    for (let id = 0; id < this.count; id++) {
      let i = (this.hashes[id] >>> 0) & this.mask;
      while (this.table[i] !== 0) i = (i + 1) & this.mask;
      this.table[i] = id + 1;
    }
  }
}
