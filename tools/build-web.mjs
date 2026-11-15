/**
 * Builds the packaged codec from src/ into web/lib/: one minified ES module per entry, no imports, with a source
 * map next to it. The command line tool, the npm package and the web page all run these files.
 *
 *   web/lib/index.js    packs and unpacks (the library entry)
 *   web/lib/decode.js   unpacks only (pac-replay-codec/decode), for a page that only shows replays
 *
 * How a build gets small, in the order the steps run:
 *   1. flags    src/build.ts says what a build carries (ENCODE, MEASURE, PRIOR). It is swapped for the values in
 *               CONFIG.Builds, so every `if (ENCODE && ...)` in the source becomes a constant.
 *   2. bundle   esbuild joins the modules into one file and lowers the syntax to CONFIG.Target.
 *   3. cut      a method whose doc block says `@build encode` (or measure, prior) is left out of a build that
 *               lacks that capability. Methods are the one thing a minifier cannot drop on its own.
 *   4. minify   terser folds the constants, drops what is now unreachable, and renames every variable and every
 *               property of our own. Two lists say what is not ours to rename: CONFIG.PublicNames (what crosses
 *               the package boundary) and CONFIG.BuiltinNames (members of JavaScript's own objects).
 *   5. checks   on the minified code before renaming, where names are still the source's:
 *               a. nothing may still refer to a method that was cut;
 *               b. a property the code reads but never defines must be on one of the two lists (it can only
 *                  come from outside);
 *               c. a property the code defines that is also the name of a JavaScript built-in member must be on
 *                  a list too, so a call on a typed array can never be renamed along with ours;
 *               d. the code names no host object (window, process, console ...): the codec is pure.
 *               And the final output must parse as CONFIG.EcmaVersion. Any of them failing stops the build.
 * The same source, with every flag on, runs unbuilt under Node for the tests.
 *
 * Usage: node tools/build-web.mjs               write web/lib/
 *        node tools/build-web.mjs --sizes       also print raw, gzip and brotli sizes
 *        node tools/build-web.mjs --plain DIR   also write DIR/<file>.plain.js: minified but not renamed, to read
 *                                               what a build kept
 *
 * @interacts src/*.ts (read), package.json (name and version for the banner), web/lib/ (replaced on every run)
 * @deps      esbuild, terser, acorn (dev dependencies, pinned to exact versions so the output is reproducible),
 *            node:fs, node:path, node:url, node:zlib (only for --sizes)
 * @complexity O(S) per build, S the size of src/ (about 280 KB): two builds, a few seconds in all
 * @alloc     the bundle and its syntax tree, twice per build, released when the build returns
 */
import { build } from 'esbuild';
import { minify } from 'terser';
import { parse } from 'acorn';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const OUT = join(ROOT, 'web', 'lib');

export const CONFIG = Object.freeze({
  /** The packaged builds: entry module, output file, and the value of each flag of src/build.ts. */
  Builds: [
    { out: 'index.js', entry: 'index.ts', flags: { ENCODE: true, MEASURE: false, PRIOR: true } },
    { out: 'decode.js', entry: 'decode.ts', flags: { ENCODE: false, MEASURE: false, PRIOR: false } },
  ],
  /** The module that holds the flags. */
  FlagsModule: 'build.ts',
  /**
   * Syntax level of the output. PAC's client is bundled for ES2016; newer syntax in a dependency (class fields,
   * object spread) would be rewritten there through helper functions, larger and slower than writing it plainly.
   */
  Target: 'es2016',
  EcmaVersion: 2016,
  /** Minifier passes. Size stops moving after three; one more is cheap. */
  MinifyPasses: 4,
  /**
   * Property names that cross the package boundary, so they are never renamed: the options of packReplay, the
   * fields of its result and of the stats in it, and the public fields of a starting model.
   */
  PublicNames: [
    'gameAware', 'account', 'prior', 'priorAlways',
    'bytes', 'predictors', 'mode', 'priorId', 'stats', 'codec', 'error',
    'frames', 'rawFrames', 'rawBytes', 'tokens', 'switches', 'steps',
    'id', 'model', 'contexts',
  ],
  /**
   * Members of JavaScript's own objects that the code uses, never renamed. The checks keep this list honest: the
   * build stops when the code reads a member that is on no list and that it never defines, or defines one that
   * shares a name with a built-in.
   */
  BuiltinNames: [
    // names the language itself looks up on an object, whoever defined them
    'constructor', '__proto__', 'valueOf', 'toJSON', 'then',
    // every array and typed array
    'length', 'set', 'fill', 'subarray', 'slice', 'buffer', 'byteOffset', 'push', 'concat', 'indexOf', 'from',
    // Math
    'floor', 'abs', 'sqrt', 'imul', 'clz32', 'fround', 'log2',
    // Object, Function, String, Number, Error
    'prototype', 'hasOwnProperty', 'call', 'keys', 'charCodeAt', 'fromCharCode', 'toString', 'padStart', 'message',
    // Map (the type table reader keeps structures by refId)
    'get', 'has',
    // DataView (reading a float's bytes)
    'getUint32', 'getInt32', 'getInt16', 'getInt8', 'getFloat32', 'getFloat64', 'setUint8',
    // names of ours that are also built-in members; they stay as they are
    'add', 'clear', 'find', 'raw', 'value', 'name',
  ],
  /** Host objects the codec must never name: it does no I/O and runs anywhere JavaScript does. */
  HostNames: [
    'globalThis', 'window', 'self', 'document', 'navigator', 'process', 'require', 'module', 'console', 'performance',
    'Buffer', 'TextEncoder', 'TextDecoder', 'fetch', 'crypto', 'setTimeout', 'setInterval', 'queueMicrotask', 'URL',
    'Worker', 'postMessage', 'localStorage', 'eval', 'Function',
  ],
});

/**
 * Every member name of JavaScript's standard objects, read from the engine running the build. Used by check c
 * only, never to decide a rename, so the output does not depend on the Node version.
 * @complexity O(built-ins), a few thousand names @alloc one set
 */
function standardMemberNames() {
  const STANDARD = [
    'Object', 'Function', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'Math', 'JSON', 'Reflect', 'Atomics',
    'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef', 'Promise', 'Proxy', 'RegExp', 'Date', 'Error', 'RangeError', 'TypeError',
    'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array',
    'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
    'Iterator',
  ];
  // members that live on instances or on engine-made objects, not on a prototype
  const names = new Set([
    'stack', 'cause', 'lastIndex', 'index', 'input', 'groups', 'done', 'value', 'raw', 'callee', 'caller', 'arguments',
    // the keys of a property descriptor
    'writable', 'enumerable', 'configurable', 'get', 'set',
  ]);
  const take = (o) => {
    for (let at = o; at !== null && at !== undefined; at = Object.getPrototypeOf(at)) {
      for (const n of Object.getOwnPropertyNames(at)) names.add(n);
    }
  };
  for (const g of STANDARD) {
    const o = globalThis[g];
    if (o === undefined) continue;
    take(o);
    if (o.prototype) take(o.prototype);
  }
  take(Object.getPrototypeOf([][Symbol.iterator]()));
  take(Object.getPrototypeOf(new Map().entries()));
  return names;
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
/** Kept at the top of every packaged file: the license, and the fdlibm notice src/trig.ts must carry. */
const BANNER = `/*! ${pkg.name} ${pkg.version} | GPL-3.0-only | ${pkg.homepage.replace(/#.*$/, '')}
 * Sine and cosine kernels from fdlibm: Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
 * Developed at SunSoft, a Sun Microsystems, Inc. business. Permission to use, copy, modify, and distribute this
 * software is freely granted, provided that this notice is preserved. */`;

/**
 * The methods tagged `@build <flag>` in src/, by class. The tag is a line of its own in the doc block right before
 * the method, like the other tags; a mention inside a sentence is not a tag.
 * A scan by pattern, not a parse: a tag it cannot place stops the build, so it never guesses.
 * @returns {Map<string, Map<string, string>>} class name -> method name -> flag name
 * @complexity O(S) @alloc the map
 */
export function scanTags() {
  const CLASS = /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/;
  const MEMBER = /^\s*(?:(?:private|protected|public|readonly|static|override)\s+)*(?:get\s+|set\s+)?(\w+)\s*[(<]/;
  const TAG = /^\s*(?:\/\*\*|\*)\s*@build\s+(\w+)/;
  const tags = new Map();
  for (const name of readdirSync(SRC).filter((n) => n.endsWith('.ts')).sort()) {
    const lines = readFileSync(join(SRC, name), 'utf8').split('\n');
    let cls = null;
    let pending = null; // the flag of a tag whose doc block has not ended yet, or has ended and awaits its method
    let inBlock = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const c = CLASS.exec(line);
      if (c) cls = c[1];
      if (line.includes('/**')) inBlock = true;
      if (inBlock) {
        const t = TAG.exec(line);
        if (t) pending = t[1];
        if (line.includes('*/')) inBlock = false;
        continue;
      }
      if (pending === null || line.trim() === '') continue;
      const m = MEMBER.exec(line);
      if (!m || cls === null) throw new Error(`${name}:${i + 1}: @build ${pending} is not followed by a method of a class`);
      // the tag is written in lower case, the flag it names in upper case
      const flag = pending.toUpperCase();
      if (!(flag in CONFIG.Builds[0].flags)) throw new Error(`${name}:${i + 1}: @build ${pending} names no flag of ${CONFIG.FlagsModule}`);
      if (!tags.has(cls)) tags.set(cls, new Map());
      tags.get(cls).set(m[1], flag);
      pending = null;
    }
  }
  return tags;
}

/** The text of the flags module for one build. @complexity O(1) @alloc one string */
function flagsModule(flags) {
  return Object.entries(flags).map(([k, v]) => `export const ${k} = ${v ? 'true' : 'false'};`).join('\n');
}

/**
 * Step 1 and 2: one file from the entry module, flags set, syntax lowered, nothing renamed yet.
 * @returns {Promise<{ code: string, map: string }>}
 * @complexity O(S) @alloc the bundle and its map
 */
async function bundle(entry, flags, out) {
  const result = await build({
    entryPoints: [join(SRC, entry)],
    outfile: join(OUT, out),
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: CONFIG.Target,
    write: false,
    minify: false,
    treeShaking: true,
    legalComments: 'none',
    charset: 'utf8',
    sourcemap: 'external',
    // the maps name the files of src/ and do not carry their text: the source is the repository
    sourcesContent: false,
    logLevel: 'warning',
    // fields become plain assignments in the constructor: the form ES2016 has, with no helper function
    tsconfigRaw: { compilerOptions: { useDefineForClassFields: false } },
    plugins: [{
      name: 'flags',
      setup(b) {
        b.onLoad({ filter: new RegExp(`[\\\\/]src[\\\\/]${CONFIG.FlagsModule.replace('.', '\\.')}$`) }, () => ({ contents: flagsModule(flags), loader: 'js' }));
      },
    }],
  });
  const js = result.outputFiles.find((f) => f.path.endsWith('.js'));
  const map = result.outputFiles.find((f) => f.path.endsWith('.map'));
  return { code: js.text, map: map.text };
}

/** Call fn(node) for every node of a syntax tree. @complexity O(nodes) @alloc none beyond the recursion */
function walk(node, fn) {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, fn);
    return;
  }
  if (typeof node.type === 'string') fn(node);
  for (const key of Object.keys(node)) if (key !== 'type' && key !== 'start' && key !== 'end') walk(node[key], fn);
}

/**
 * Step 3: blank the tagged methods this build does not carry. Blanked, not deleted: every other character keeps
 * its place, so the bundle's source map stays true.
 * @returns {{ code: string, cut: string[] }} the bundle and the names of the methods that were cut
 * @complexity O(bundle) @alloc one syntax tree and one copy of the bundle
 */
function cutMethods(code, flags, tags) {
  const ast = parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
  const ranges = [];
  const cut = [];
  const seen = new Set();
  const visit = (cls, body) => {
    const wanted = tags.get(cls);
    if (wanted === undefined) return;
    seen.add(cls);
    const have = new Set();
    for (const m of body.body) {
      if (m.type !== 'MethodDefinition' || m.computed) continue;
      have.add(m.key.name);
      const flag = wanted.get(m.key.name);
      if (flag === undefined || flags[flag]) continue;
      ranges.push([m.start, m.end]);
      cut.push(m.key.name);
    }
    for (const name of wanted.keys()) if (!have.has(name)) throw new Error(`@build tag on ${cls}.${name}, but the bundle's ${cls} has no such method`);
  };
  walk(ast, (n) => {
    if ((n.type === 'ClassDeclaration' || n.type === 'ClassExpression') && n.id) visit(n.id.name, n.body);
    else if (n.type === 'VariableDeclarator' && n.init && n.init.type === 'ClassExpression' && !n.init.id && n.id.type === 'Identifier') visit(n.id.name, n.init.body);
  });
  let out = code;
  for (const [s, e] of ranges) out = out.slice(0, s) + out.slice(s, e).replace(/[^\n]/g, ' ') + out.slice(e);
  return { code: out, cut };
}

/** Options of the minifier, shared by the real pass and the unrenamed pass the reference check reads. */
function terserOptions(rename, map) {
  return {
    module: true,
    ecma: CONFIG.EcmaVersion,
    toplevel: true,
    compress: {
      ecma: CONFIG.EcmaVersion,
      module: true,
      toplevel: true,
      passes: CONFIG.MinifyPasses,
      pure_getters: true,
      keep_fargs: false,
      hoist_props: true,
      // floating point is part of the packed format: never reorder or merge arithmetic
      unsafe_math: false,
      // the public calls return real booleans
      booleans_as_integers: false,
    },
    // builtins: true lets terser rename names it would otherwise spare for being some browser API's; the two
    // lists and the checks are what make that safe here
    mangle: rename ? { module: true, toplevel: true, properties: { builtins: true, reserved: [...CONFIG.PublicNames, ...CONFIG.BuiltinNames], keep_quoted: true } } : false,
    format: { ecma: CONFIG.EcmaVersion, comments: false, preamble: rename ? BANNER : undefined },
    sourceMap: map === null ? false : { content: map, asObject: true, includeSources: false },
  };
}

/**
 * Step 5, checks a to d, on the minified code before renaming (dead code is gone, names are still the source's).
 * @returns {Promise<string>} that unrenamed code, for --plain
 * @complexity O(bundle) @alloc one syntax tree and three sets of names
 */
async function checkNames(code, cut, out) {
  const plain = await minify(code, terserOptions(false, null));
  const cutNames = new Set(cut);
  const reserved = new Set([...CONFIG.PublicNames, ...CONFIG.BuiltinNames]);
  const hosts = new Set(CONFIG.HostNames);
  const used = new Set(); // read as obj.name somewhere
  const defined = new Set(); // made by the code: a method, an object literal key, or the target of obj.name = ...
  const stillCut = new Set();
  const hostHits = new Set();
  const keyName = (k) => (k.type === 'Identifier' ? k.name : String(k.value));
  walk(parse(plain.code, { ecmaVersion: 'latest', sourceType: 'module' }), (n) => {
    if (n.type === 'MemberExpression' && !n.computed) {
      used.add(n.property.name);
      if (cutNames.has(n.property.name)) stillCut.add(n.property.name);
      if (n.object.type === 'Identifier' && hosts.has(n.object.name)) hostHits.add(n.object.name);
    } else if ((n.type === 'MethodDefinition' || n.type === 'Property') && !n.computed) {
      defined.add(keyName(n.key));
      if (cutNames.has(keyName(n.key))) stillCut.add(keyName(n.key));
    } else if (n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression' && !n.left.computed) {
      defined.add(n.left.property.name);
    } else if ((n.type === 'CallExpression' || n.type === 'NewExpression') && n.callee.type === 'Identifier' && hosts.has(n.callee.name)) {
      hostHits.add(n.callee.name);
    }
  });
  const fail = (what, names) => {
    if (names.length > 0) throw new Error(`${out}: ${what}: ${names.sort().join(', ')}`);
  };
  fail('still refers to methods that were cut from this build', [...stillCut]);
  fail('reads properties it never defines and that are on neither list (CONFIG.PublicNames, CONFIG.BuiltinNames)', [...used].filter((n) => !defined.has(n) && !reserved.has(n)));
  const standard = standardMemberNames();
  fail('defines properties named like a JavaScript built-in member; rename them or add them to CONFIG.BuiltinNames', [...defined].filter((n) => standard.has(n) && !reserved.has(n)));
  fail('names a host object; the codec must stay pure', [...hostHits]);
  return plain.code;
}

/**
 * Build every entry of CONFIG.Builds in memory.
 * @returns {Promise<{ out: string, code: string, map: string, plain: string }[]>} plain is the minified code
 *          before renaming, for reading what the build kept
 * @complexity O(S) per build @alloc the outputs
 */
export async function buildAll() {
  const tags = scanTags();
  const outputs = [];
  for (const { out, entry, flags } of CONFIG.Builds) {
    const joined = await bundle(entry, flags, out);
    const { code, cut } = cutMethods(joined.code, flags, tags);
    const plain = await checkNames(code, cut, out);
    const small = await minify(code, terserOptions(true, joined.map));
    // the last check: the output is ES2016 and nothing newer
    parse(small.code, { ecmaVersion: CONFIG.EcmaVersion, sourceType: 'module' });
    outputs.push({ out, code: `${small.code}\n`, map: JSON.stringify(small.map), plain });
  }
  return outputs;
}

/** raw, gzip -9 and brotli 11 sizes of one output. @complexity O(n) @alloc the two compressed copies */
export function sizes(code) {
  const b = Buffer.from(code);
  return {
    raw: b.length,
    gzip: zlib.gzipSync(b, { level: 9 }).length,
    brotli: zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: b.length } }).length,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outputs = await buildAll();
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const plainAt = process.argv.indexOf('--plain');
  for (const { out, code, map, plain } of outputs) {
    writeFileSync(join(OUT, out), code);
    writeFileSync(join(OUT, `${out}.map`), map);
    if (plainAt >= 0) writeFileSync(join(process.argv[plainAt + 1], `${out.replace(/\.js$/, '')}.plain.js`), plain);
    if (process.argv.includes('--sizes')) {
      const s = sizes(code);
      console.log(`web/lib/${out.padEnd(10)} ${String(s.raw).padStart(6)} bytes   gzip ${String(s.gzip).padStart(6)}   brotli ${String(s.brotli).padStart(6)}`);
    }
  }
  console.log(`built ${outputs.length} files into web/lib/`);
}
