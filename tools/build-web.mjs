/**
 * Builds the browser copy of the codec: strips the TypeScript types from every file in src/ and writes plain ES
 * modules to web/lib/, with the `.ts` import suffixes turned into `.js`. Uses Node's own type stripper, so there is
 * nothing to install.
 *
 * Usage: node tools/build-web.mjs
 *
 * @interacts src/*.ts (read), web/lib/*.js (written, replaced on every run)
 * @deps node:module stripTypeScriptTypes (Node 22.13 or newer), node:fs, node:path
 * @complexity O(S) where S is the total size of src/ (about 200 KB)
 * @alloc one string per source file, released after it is written
 */
import { stripTypeScriptTypes } from 'node:module';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const OUT = join(ROOT, 'web', 'lib');
/** Matches the module specifier of a relative import or export that ends in .ts. */
const TS_IMPORT = /(from\s+['"]\.{1,2}\/[^'"]+)\.ts(['"])/g;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const names = readdirSync(SRC).filter((n) => n.endsWith('.ts'));
for (const name of names) {
  const ts = readFileSync(join(SRC, name), 'utf8');
  const js = stripTypeScriptTypes(ts, { mode: 'strip' }).replace(TS_IMPORT, '$1.js$2');
  writeFileSync(join(OUT, name.replace(/\.ts$/, '.js')), js);
}
console.log(`built ${names.length} modules into web/lib/`);
