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
 *   4. minify   terser folds the constants, drops what is now unreachable, and renames everything that does not
 *               cross the package boundary (CONFIG.PublicNames lists what does).
 *   5. checks   nothing that is left may still refer to a method that was cut, and the output must parse as
 *               CONFIG.EcmaVersion. Either failing stops the build.
 * The same source, with every flag on, runs unbuilt under Node for the tests.
 *
 * Usage: node tools/build-web.mjs            write web/lib/
 *        node tools/build-web.mjs --sizes    also print raw, gzip and brotli sizes
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
});

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
    mangle: rename ? { module: true, toplevel: true, properties: { reserved: CONFIG.PublicNames, keep_quoted: true } } : false,
    format: { ecma: CONFIG.EcmaVersion, comments: false, preamble: rename ? BANNER : undefined },
    sourceMap: map === null ? false : { content: map, asObject: true, includeSources: false },
  };
}

/**
 * Step 5, first half: after dead code is gone, no property anywhere may carry the name of a method that was cut.
 * Read from a minified but unrenamed copy, where names are still the source's.
 * @complexity O(bundle) @alloc one syntax tree
 */
async function checkNoReference(code, cut, out) {
  if (cut.length === 0) return;
  const plain = await minify(code, terserOptions(false, null));
  const names = new Set(cut);
  const hits = new Set();
  walk(parse(plain.code, { ecmaVersion: 'latest', sourceType: 'module' }), (n) => {
    if (n.type === 'MemberExpression' && !n.computed && names.has(n.property.name)) hits.add(n.property.name);
    else if ((n.type === 'MethodDefinition' || n.type === 'Property') && !n.computed && names.has(n.key.name)) hits.add(n.key.name);
  });
  if (hits.size > 0) throw new Error(`${out}: still refers to methods that were cut from this build: ${[...hits].sort().join(', ')}`);
}

/**
 * Build every entry of CONFIG.Builds in memory.
 * @returns {Promise<{ out: string, code: string, map: string }[]>}
 * @complexity O(S) per build @alloc the outputs
 */
export async function buildAll() {
  const tags = scanTags();
  const outputs = [];
  for (const { out, entry, flags } of CONFIG.Builds) {
    const joined = await bundle(entry, flags, out);
    const { code, cut } = cutMethods(joined.code, flags, tags);
    await checkNoReference(code, cut, out);
    const small = await minify(code, terserOptions(true, joined.map));
    // step 5, second half: the output is ES2016 and nothing newer
    parse(small.code, { ecmaVersion: CONFIG.EcmaVersion, sourceType: 'module' });
    outputs.push({ out, code: `${small.code}\n`, map: JSON.stringify(small.map) });
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
  for (const { out, code, map } of outputs) {
    writeFileSync(join(OUT, out), code);
    writeFileSync(join(OUT, `${out}.map`), map);
    if (process.argv.includes('--sizes')) {
      const s = sizes(code);
      console.log(`web/lib/${out.padEnd(10)} ${String(s.raw).padStart(6)} bytes   gzip ${String(s.gzip).padStart(6)}   brotli ${String(s.brotli).padStart(6)}`);
    }
  }
  console.log(`built ${outputs.length} files into web/lib/`);
}
