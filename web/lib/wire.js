/**
 * Colyseus schema wire grammar, as far as a replay codec needs it, and the type table every replay carries in its
 * handshake frame. Nothing here is specific to one game or one game version: the table is read from the file.
 *
 * Grammar of a state or patch body (@colyseus/schema 4.0 and 5.0, decoder/Decoder.ts and DecodeOperation.ts):
 *   body   := ( 0xFF number(refId) | op )*              0xFF switches the current structure
 *   struct op     := u8 head, operation = head & 0xC0, field = head % (operation || 255), then value(field type)
 *   map/set/coll  := u8 operation; CLEAR(10) ends; number(index); maps on ADD also string(key); then value(child type)
 *   array op      := u8 operation; CLEAR(10) and REVERSE(15) end; DELETE_BY_REFID(33) number(refId) ends;
 *                    ADD_BY_REFID(129) number(refId); otherwise number(index); then value(child type)
 *   value  := nothing when operation is exactly DELETE(64)
 *           | struct child: number(refId), and on ADD optionally 0xD5 number(typeId)
 *           | primitive by type
 *           | collection: number(refId)
 *
 * The handshake holds the type table as a structure in this same grammar ("reflection"). Two layouts exist:
 *   schema 4   field = {name, type, referencedType}; a collection of primitives is typed "map:uint8"
 *   schema 5   field = {name, type, referencedType, childPrimitive, quantized}; the child primitive has its own
 *              slot, and type "quantized" is an unsigned integer of 8, 16 or 32 bits on the wire
 * Version 5 only appends, so one reader handles both. PAC 6.11 ships schema 4; PAC master and v7 ship schema 5.
 *
 * @interacts none (pure)
 * @deps      none
 * @complexity parseReflection is O(T + F): T types (1,154 in PAC 6.11.2), F fields (290)
 * @alloc     the type table, kept for the life of one replay
 */

// wire markers and operations
export const SWITCH_TO_STRUCTURE = 255;
export const TYPE_ID = 213;
export const OP_ADD = 128;
export const OP_DELETE = 64;
export const OP_CLEAR = 10;
export const OP_REVERSE = 15;
export const OP_DELETE_BY_REFID = 33;
export const OP_MASK = 0xc0;
/** A struct head with operation 0 addresses its field as head % 255. */
export const REPLACE_MODULUS = 255;
/** Most fields a struct can have: the head byte keeps 6 bits for the field index. */
export const FIELDS_MAX = 64;
const FIELD_INDEX_MASK = 63;

// structure kinds
export const KIND_STRUCT = 0;
export const KIND_MAP = 1;
export const KIND_ARRAY = 2;
export const KIND_SET = 3;
export const KIND_COLLECTION = 4;
export const KIND_STREAM = 5;
const COLLECTION_KINDS                         = {
  map: KIND_MAP, array: KIND_ARRAY, set: KIND_SET, collection: KIND_COLLECTION, stream: KIND_STREAM,
};

// value classes of a field or of a collection's items
export const VAL_PRIM = 0;
export const VAL_REF = 1;
export const VAL_COLL = 2;

// primitives
export const PRIM_STRING = 0;
export const PRIM_NUMBER = 1;
export const PRIM_BOOLEAN = 2;
export const PRIM_INT8 = 3;
export const PRIM_UINT8 = 4;
export const PRIM_INT16 = 5;
export const PRIM_UINT16 = 6;
export const PRIM_INT32 = 7;
export const PRIM_UINT32 = 8;
export const PRIM_INT64 = 9;
export const PRIM_UINT64 = 10;
export const PRIM_FLOAT32 = 11;
export const PRIM_FLOAT64 = 12;
export const PRIM_BIGINT64 = 13;
export const PRIM_BIGUINT64 = 14;
const PRIM_IDS                         = {
  string: PRIM_STRING, number: PRIM_NUMBER, boolean: PRIM_BOOLEAN, int8: PRIM_INT8, uint8: PRIM_UINT8,
  int16: PRIM_INT16, uint16: PRIM_UINT16, int32: PRIM_INT32, uint32: PRIM_UINT32, int64: PRIM_INT64,
  uint64: PRIM_UINT64, float32: PRIM_FLOAT32, float64: PRIM_FLOAT64, bigint64: PRIM_BIGINT64, biguint64: PRIM_BIGUINT64,
};
/** Bytes of each primitive on the wire, by id; 0 for the two variable ones (string, number). */
export const PRIM_WIDTH = [0, 0, 1, 1, 1, 2, 2, 4, 4, 8, 8, 4, 8, 8, 8];
/** Wire primitive of a quantized field by its bit width. */
const QUANTIZED_PRIM                         = { 8: PRIM_UINT8, 16: PRIM_UINT16, 32: PRIM_UINT32 };
const QUANTIZED_DEFAULT_BITS = 16;

/** Largest type id the codec accepts (two bytes when coded). */
export const TYPE_ID_MAX = 65535;

/** The type table of one connection, in flat arrays. Type index is dense; type id is the wire's number. */
export class Schema {
  /** Number of types. */
  count = 0;
  /** type id -> type index, -1 when the id is unknown. */
  indexOfId             = new Int32Array(0);
  /** Per type: its wire id. */
  idOf             = new Int32Array(0);
  /** Per type: type index of its topmost ancestor (itself when it extends nothing). */
  baseOf             = new Int32Array(0);
  /** Per type: where its fields start in the field arrays, and how many it has (inherited ones included). */
  fieldStart             = new Int32Array(0);
  fieldCount             = new Int32Array(0);
  /** Per field: VAL_PRIM, VAL_REF or VAL_COLL. */
  fVal             = new Uint8Array(0);
  /** Per field: its primitive (VAL_PRIM), or its items' primitive (VAL_COLL of primitives). */
  fPrim             = new Uint8Array(0);
  /** Per field: collection kind (VAL_COLL). */
  fKind             = new Uint8Array(0);
  /** Per field: VAL_PRIM or VAL_REF of a collection's items (VAL_COLL). */
  fChildVal             = new Uint8Array(0);
  /** Per field: type index of the struct it holds (VAL_REF) or its items are (VAL_COLL of structs), else -1. */
  fType             = new Int32Array(0);
  /** Per field: its name. Used once per schema to find game-aware fields by name, never while coding. */
  fName           = [];
  /** Type index of the root state. */
  root = 0;
}

/** Where the last readNumber or stringStart call ended (the byte after the token). */
export const cursor = { end: 0 };

const scratch = new DataView(new ArrayBuffer(8));

/** Bytes that follow a `number` prefix byte, or -1 when the prefix is not a number. @complexity O(1) @alloc none */
export function numberPayloadBytes(prefix        )         {
  if (prefix < 0x80 || prefix > 0xdf) return 0;
  switch (prefix) {
    case 0xcc: case 0xd0: return 1;
    case 0xcd: case 0xd1: return 2;
    case 0xca: case 0xce: case 0xd2: return 4;
    case 0xcb: case 0xcf: case 0xd3: return 8;
    default: return -1;
  }
}

/**
 * Read a `number` at p (bounded by end). Returns its value; sets cursor.end. Throws on a prefix that is not a
 * number or a payload that runs past `end`.
 * @complexity O(1) @alloc none
 */
export function readNumber(b            , p        , end        )         {
  if (p >= end) throw new Error('number past the end');
  const prefix = b[p];
  if (prefix < 0x80) { cursor.end = p + 1; return prefix; }
  if (prefix > 0xdf) { cursor.end = p + 1; return prefix - 0x100; }
  const n = numberPayloadBytes(prefix);
  if (n < 0 || p + 1 + n > end) throw new Error('bad number');
  cursor.end = p + 1 + n;
  if (prefix === 0xcc) return b[p + 1];
  if (prefix === 0xcd) return b[p + 1] | (b[p + 2] << 8);
  for (let i = 0; i < n; i++) scratch.setUint8(i, b[p + 1 + i]);
  switch (prefix) {
    case 0xce: return scratch.getUint32(0, true);
    case 0xcf: return scratch.getUint32(0, true) + scratch.getUint32(4, true) * 4294967296;
    case 0xd0: return scratch.getInt8(0);
    case 0xd1: return scratch.getInt16(0, true);
    case 0xd2: return scratch.getInt32(0, true);
    case 0xd3: return scratch.getUint32(0, true) + scratch.getInt32(4, true) * 4294967296;
    case 0xca: return scratch.getFloat32(0, true);
    default: return scratch.getFloat64(0, true);
  }
}

/**
 * Span of a `string` at p (bounded by end): returns where the text starts and sets cursor.end. Mirrors
 * decode.string: a prefix under 0xC0 is a fixstr (length = prefix & 0x1f), then 0xD9, 0xDA, 0xDB carry 1, 2, 4
 * length bytes.
 * @complexity O(1) @alloc none
 */
export function stringStart(b            , p        , end        )         {
  if (p >= end) throw new Error('string past the end');
  const prefix = b[p];
  let len        ;
  let start        ;
  if (prefix < 0xc0) { len = prefix & 0x1f; start = p + 1; }
  else if (prefix === 0xd9) { len = b[p + 1]; start = p + 2; }
  else if (prefix === 0xda) { len = b[p + 1] | (b[p + 2] << 8); start = p + 3; }
  else if (prefix === 0xdb) { len = (b[p + 1] | (b[p + 2] << 8) | (b[p + 3] << 16)) + b[p + 4] * 0x1000000; start = p + 5; }
  else throw new Error('bad string prefix');
  if (start + len > end) throw new Error('string past the end');
  cursor.end = start + len;
  return start;
}

/** Sentinel for a number field the reflection did not set. */
const UNSET = -1;
/** Largest integer magnitude the reflection reader accepts: beyond it a double is no longer exact. */
const INT_EXACT_MAX = 9007199254740992;
/** Largest refId the reflection reader accepts. */
const REFLECTION_REF_MAX = 16777216;

                                                                                                                      
                                                                       

// field indexes of the reflection's own structures (both schema versions; version 5 appends)
const BOOT_REFLECTION = 0;
const BOOT_TYPE = 1;
const BOOT_FIELD = 2;
const BOOT_QUANTIZED = 3;

function rawField(name        , type        , referencedType        )           {
  return { name, type, referencedType, childPrimitive: null, bits: UNSET };
}

/**
 * The fixed schema of the reflection itself, so the codec can walk a handshake like any other state frame.
 * @interacts none @deps none @complexity O(1) @alloc a 4 type table
 */
export function bootSchema()         {
  const types            = [
    { id: BOOT_REFLECTION, extendsId: UNSET, fields: [rawField('types', 'array', BOOT_TYPE), rawField('rootType', 'number', UNSET)] },
    { id: BOOT_TYPE, extendsId: UNSET, fields: [rawField('id', 'number', UNSET), rawField('extendsId', 'number', UNSET), rawField('fields', 'array', BOOT_FIELD)] },
    { id: BOOT_FIELD, extendsId: UNSET, fields: [
      rawField('name', 'string', UNSET), rawField('type', 'string', UNSET), rawField('referencedType', 'number', UNSET),
      rawField('childPrimitive', 'string', UNSET), rawField('quantized', 'ref', BOOT_QUANTIZED),
    ] },
    { id: BOOT_QUANTIZED, extendsId: UNSET, fields: [
      rawField('min', 'float64', UNSET), rawField('max', 'float64', UNSET), rawField('bits', 'uint8', UNSET), rawField('mode', 'uint8', UNSET),
    ] },
  ];
  return buildSchema(types, BOOT_REFLECTION);
}

function primId(name        )         {
  const id = PRIM_IDS[name];
  if (id === undefined) throw new Error(`unknown primitive type "${name}"`);
  return id;
}

/** Turn the reflection's types into flat arrays. Parent fields come first, as on the wire. */
function buildSchema(raw           , rootId        )         {
  const s = new Schema();
  const n = raw.length;
  let maxId = 0;
  for (const t of raw) {
    if (t.id < 0 || t.id > TYPE_ID_MAX) throw new Error('bad type id');
    if (t.id > maxId) maxId = t.id;
  }
  s.count = n;
  s.indexOfId = new Int32Array(maxId + 1).fill(-1);
  s.idOf = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    s.indexOfId[raw[i].id] = i;
    s.idOf[i] = raw[i].id;
  }
  // full field lists, parents first. Resolved without recursion: climb to the nearest resolved ancestor, then fill
  // back down. A chain longer than the number of types is a loop.
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const e = raw[i].extendsId;
    parent[i] = e >= 0 && e <= maxId ? s.indexOfId[e] : -1;
  }
  const full                        = new Array                   (n).fill(null);
  const base = new Int32Array(n);
  const chain = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    let len = 0;
    let j = i;
    while (j >= 0 && full[j] === null) {
      if (len === n) throw new Error('type inheritance loop');
      chain[len++] = j;
      j = parent[j];
    }
    while (len > 0) {
      const k = chain[--len];
      const pk = parent[k];
      const list = pk >= 0 ? (full[pk]              ).concat(raw[k].fields) : raw[k].fields;
      if (list.length > FIELDS_MAX) throw new Error('too many fields in a type');
      full[k] = list;
      base[k] = pk >= 0 ? base[pk] : k;
    }
  }
  let total = 0;
  for (let i = 0; i < n; i++) total += (full[i]              ).length;
  s.baseOf = base;
  s.fieldStart = new Int32Array(n);
  s.fieldCount = new Int32Array(n);
  s.fVal = new Uint8Array(total);
  s.fPrim = new Uint8Array(total);
  s.fKind = new Uint8Array(total);
  s.fChildVal = new Uint8Array(total);
  s.fType = new Int32Array(total).fill(-1);
  s.fName = new Array        (total);
  let at = 0;
  for (let i = 0; i < n; i++) {
    const list = full[i]              ;
    s.fieldStart[i] = at;
    s.fieldCount[i] = list.length;
    for (const f of list) {
      s.fName[at] = f.name;
      const typeIndex = f.referencedType >= 0 && f.referencedType <= maxId ? s.indexOfId[f.referencedType] : -1;
      const colon = f.type.indexOf(':');
      const head = colon < 0 ? f.type : f.type.slice(0, colon);
      if (f.type === 'quantized') {
        s.fVal[at] = VAL_PRIM;
        const prim = QUANTIZED_PRIM[f.bits === UNSET ? QUANTIZED_DEFAULT_BITS : f.bits];
        if (prim === undefined) throw new Error('bad quantized width');
        s.fPrim[at] = prim;
      } else if (f.type === 'ref') {
        if (typeIndex < 0) throw new Error('ref field without a type');
        s.fVal[at] = VAL_REF;
        s.fType[at] = typeIndex;
      } else if (Object.hasOwn(COLLECTION_KINDS, head)) {
        s.fVal[at] = VAL_COLL;
        s.fKind[at] = COLLECTION_KINDS[head];
        if (colon >= 0) {
          s.fChildVal[at] = VAL_PRIM;
          s.fPrim[at] = primId(f.type.slice(colon + 1));
        } else if (typeIndex >= 0) {
          s.fChildVal[at] = VAL_REF;
          s.fType[at] = typeIndex;
        } else if (f.childPrimitive !== null) {
          s.fChildVal[at] = VAL_PRIM;
          s.fPrim[at] = primId(f.childPrimitive);
        } else throw new Error('collection field without an item type');
      } else {
        s.fVal[at] = VAL_PRIM;
        s.fPrim[at] = primId(f.type);
      }
      at++;
    }
  }
  const root = rootId >= 0 && rootId <= maxId ? s.indexOfId[rootId] : -1;
  if (root < 0) throw new Error('root type missing');
  s.root = root;
  return s;
}

/** A node of the reflection while it is being read: a struct (type >= 0) or an array (type -1, items of `field`). */
                                                                                                              

function newNode(type        , field        )       {
  return { type, field, nums: [], strs: [], kids: [] };
}

/** An integer `number` at p: any integer spelling, never a float, magnitude below 2^53. Sets cursor.end. */
function readInt(b            , p        , end        )         {
  if (p < end && (b[p] === 0xca || b[p] === 0xcb)) throw new Error('reflection: float where an integer belongs');
  const v = readNumber(b, p, end);
  if (!(v > -INT_EXACT_MAX && v < INT_EXACT_MAX)) throw new Error('reflection: integer out of range');
  return v;
}

/**
 * Decode the reflection in a handshake frame into a type table. Reads both the schema 4 and the schema 5 layout.
 * Throws when the bytes are not a reflection this reader understands (the codec then keeps state frames raw).
 * The reader is strict on purpose: every build must accept and reject exactly the same bytes.
 *
 * @param b the frame bytes  @param offset where the reflection starts  @param end where it ends
 * @interacts none @deps none
 * @complexity O(T + F), T = 1,154 types and F = 290 fields in PAC 6.11.2 @alloc the table and one temporary object
 *             per type and field
 */
export function parseReflection(b            , offset        , end        )         {
  const boot = bootSchema();
  const refs = new Map              ();
  const root = newNode(boot.root, -1);
  refs.set(0, root);
  let cur = root;
  let p = offset;
  // names are kept byte for byte (one char per byte), so comparing them never depends on a text decoder
  const text = (s        , e        )         => {
    let out = '';
    for (let i = s; i < e; i++) out += String.fromCharCode(b[i]);
    return out;
  };
  const refId = ()         => {
    const id = readInt(b, p, end);
    p = cursor.end;
    if (id < 0 || id >= REFLECTION_REF_MAX) throw new Error('reflection: bad refId');
    return id;
  };
  const value = (op        , fi        , item         , index        )       => {
    if (op === OP_DELETE) return;
    const val = item ? boot.fChildVal[fi] : boot.fVal[fi];
    if (val === VAL_REF) {
      const id = refId();
      if ((op & OP_ADD) === OP_ADD && p < end && b[p] === TYPE_ID) {
        readInt(b, p + 1, end);
        p = cursor.end;
      }
      let child = refs.get(id);
      if (child === undefined) {
        child = newNode(boot.fType[fi], -1);
        refs.set(id, child);
      } else if (child.type !== boot.fType[fi]) throw new Error('reflection: refId used for two types');
      cur.kids[index] = child;
    } else if (val === VAL_COLL) {
      const coll = newNode(-1, fi);
      refs.set(refId(), coll);
      cur.kids[index] = coll;
    } else {
      const prim = boot.fPrim[fi];
      if (prim === PRIM_STRING) {
        const s = stringStart(b, p, end);
        cur.strs[index] = text(s, cursor.end);
        p = cursor.end;
      } else if (prim === PRIM_NUMBER) {
        cur.nums[index] = readInt(b, p, end);
        p = cursor.end;
      } else {
        const w = PRIM_WIDTH[prim];
        if (p + w > end) throw new Error('reflection: primitive past the end');
        cur.nums[index] = w === 1 ? b[p] : 0; // only the one-byte fields (bits, mode) are read; min and max are skipped
        p += w;
      }
    }
  };
  while (p < end) {
    const head = b[p++];
    if (head === SWITCH_TO_STRUCTURE) {
      const next = refs.get(refId());
      if (next === undefined) throw new Error('reflection: unknown refId');
      cur = next;
      continue;
    }
    if (cur.type >= 0) {
      const index = head & FIELD_INDEX_MASK;
      if (index >= boot.fieldCount[cur.type]) throw new Error('reflection: unknown field');
      value(head & OP_MASK, boot.fieldStart[cur.type] + index, false, index);
    } else {
      if (head === OP_CLEAR || head === OP_REVERSE) continue;
      const index = readInt(b, p, end);
      p = cursor.end;
      if (head === OP_DELETE_BY_REFID) continue;
      if (index < 0 || index > TYPE_ID_MAX) throw new Error('reflection: bad index');
      value(head, cur.field, true, index);
    }
  }
  const num = (n      , i        )         => {
    const v = n.nums[i];
    return v === undefined ? UNSET : v;
  };
  const str = (n      , i        )                => {
    const v = n.strs[i];
    return v === undefined ? null : v;
  };
  const rawTypes            = [];
  const types = root.kids[0];
  if (types) {
    for (const t of types.kids) {
      if (!t) continue;
      const fields             = [];
      const list = t.kids[2];
      if (list) {
        for (const f of list.kids) {
          if (!f) continue;
          const q = f.kids[4];
          fields.push({
            name: str(f, 0) ?? '', type: str(f, 1) ?? '', referencedType: num(f, 2), childPrimitive: str(f, 3),
            bits: q ? num(q, 2) : UNSET,
          });
        }
      }
      rawTypes.push({ id: num(t, 0), extendsId: num(t, 1), fields });
    }
  }
  if (rawTypes.length === 0) throw new Error('reflection: no types');
  const rootId = num(root, 1);
  return buildSchema(rawTypes, rootId === UNSET ? 0 : rootId);
}
