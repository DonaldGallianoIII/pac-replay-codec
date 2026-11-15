/**
 * Where the bytes of a packaged file come from: reads web/lib/<name>.js and its source map and adds up the
 * minified bytes by the function or method of src/ they were made from. For deciding what to shrink next.
 *
 * Usage: node tools/size-report.mjs [decode.js] [--top 60]
 *
 * The count is of minified characters before gzip, so it ranks code by weight, not by what it costs on the wire:
 * repetitive code compresses better than its share here suggests.
 *
 * @interacts reads web/lib/<name>.js, web/lib/<name>.js.map (run tools/build-web.mjs first) and src/*.ts
 * @deps      acorn (dev dependency), node:module stripTypeScriptTypes (Node 22.13 or newer), node:fs, node:path
 * @complexity O(M + S): M mapping segments (about 20,000), S the size of src/
 * @alloc     one syntax tree per source file, released at exit
 */
import { parse } from 'acorn';
import { stripTypeScriptTypes } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIB = join(ROOT, 'web', 'lib');
const CONFIG = Object.freeze({ Top: 60, Default: 'decode.js' });
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const args = process.argv.slice(2);
const topAt = args.indexOf('--top');
const top = topAt >= 0 ? Number(args.splice(topAt, 2)[1]) : CONFIG.Top;
const name = args[0] ?? CONFIG.Default;
const code = readFileSync(join(LIB, name), 'utf8');
const map = JSON.parse(readFileSync(join(LIB, `${name}.map`), 'utf8'));

/** The named ranges of one source file: top-level functions, class members, other top-level statements. */
function rangesOf(file) {
  const text = stripTypeScriptTypes(readFileSync(file, 'utf8'), { mode: 'strip' });
  const ast = parse(text, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
  const ranges = [];
  const add = (label, n) => ranges.push({ label, from: n.loc.start, to: n.loc.end });
  for (const node of ast.body) {
    const d = node.type === 'ExportNamedDeclaration' && node.declaration ? node.declaration : node;
    if (d.type === 'FunctionDeclaration') add(d.id.name, d);
    else if (d.type === 'ClassDeclaration') {
      for (const m of d.body.body) add(`${d.id.name}.${m.key ? (m.key.name ?? m.key.value) : '?'}`, m);
    } else if (d.type === 'VariableDeclaration') {
      for (const v of d.declarations) add(`${v.id.name ?? 'const'} (constant)`, v);
    } else add(`(top level, line ${d.loc.start.line})`, d);
  }
  return ranges;
}

const before = (a, b) => a.line < b.line || (a.line === b.line && a.column <= b.column);
const sources = map.sources.map((s) => resolve(LIB, s));
const ranges = sources.map(rangesOf);
const labelAt = (source, line, column) => {
  const at = { line: line + 1, column };
  for (const r of ranges[source]) if (before(r.from, at) && before(at, r.to)) return r.label;
  return '(between declarations)';
};

const sizes = new Map();
const add = (key, n) => sizes.set(key, (sizes.get(key) ?? 0) + n);
const lines = code.split('\n');
let source = 0;
let srcLine = 0;
let srcCol = 0;
map.mappings.split(';').forEach((group, genLine) => {
  let genCol = 0;
  const segs = [];
  for (const seg of group.split(',')) {
    if (seg === '') continue;
    const vals = [];
    let shift = 0;
    let value = 0;
    for (const ch of seg) {
      const d = BASE64.indexOf(ch);
      value += (d & 31) << shift;
      if (d & 32) shift += 5;
      else {
        vals.push(value & 1 ? -(value >> 1) : value >> 1);
        value = 0;
        shift = 0;
      }
    }
    genCol += vals[0];
    if (vals.length >= 4) {
      source += vals[1];
      srcLine += vals[2];
      srcCol += vals[3];
      segs.push([genCol, source, srcLine, srcCol]);
    }
  }
  const text = lines[genLine] ?? '';
  if (segs.length === 0) {
    add('(banner and unmapped)', text.length + 1);
    return;
  }
  if (segs[0][0] > 0) add('(banner and unmapped)', segs[0][0]);
  for (let i = 0; i < segs.length; i++) {
    const end = i + 1 < segs.length ? segs[i + 1][0] : text.length;
    const file = map.sources[segs[i][1]].replace(/^.*\//, '');
    add(`${file}  ${labelAt(segs[i][1], segs[i][2], segs[i][3])}`, end - segs[i][0]);
  }
});

const rows = [...sizes].sort((a, b) => b[1] - a[1]);
const total = rows.reduce((s, r) => s + r[1], 0);
console.log(`web/lib/${name}: ${code.length} characters, ${total} placed`);
for (const [label, n] of rows.slice(0, top)) console.log(String(n).padStart(6), label);
const byFile = new Map();
for (const [label, n] of rows) {
  const file = label.split('  ')[0];
  byFile.set(file, (byFile.get(file) ?? 0) + n);
}
console.log('by file');
for (const [file, n] of [...byFile].sort((a, b) => b[1] - a[1])) console.log(String(n).padStart(6), file);
