/**
 * Bot QA for the page: drives the real page in a headless browser the way a person would, with the packaged codec
 * it ships (web/lib/). Written when web/lib/ became minified files, to prove the page still packs and unpacks
 * exactly with them.
 *
 * What it does, and what must hold at each step:
 *   1. loads the page                         no console error, no failed request, nothing fetched from elsewhere
 *   2. gives it the two synthetic replays     both rows read "Exact", as packs
 *   3. downloads both .paczd files            byte for byte what web/lib/index.js packs under Node, and what the
 *                                             published 1.0.1 packs when it is installed
 *   4. gives the .paczd files back            both rows read "Exact", as unpacks; the downloads are the originals
 *   5. gives it a text file and a cut .paczd  "Kept as is" and "Failed"
 *   6. takes two screenshots                  color, and greyscale for the "does it still read" check by eye
 *
 * Usage: node qa/bot/page-pack-unpack.mjs [OUT_DIR]
 *        Screenshots go to OUT_DIR (default: a new folder under the system temp folder; the path is printed).
 *        Exit code 0: every step held. 1: a step did not, and says which.
 *
 * Needs Playwright with a Chromium, which this repository does not depend on. Either `npm install --no-save
 * playwright && npx playwright install chromium`, or point PLAYWRIGHT_MODULE at an installed playwright or
 * playwright-core folder.
 *
 * @interacts serves web/ on 127.0.0.1 (a free port, closed at the end); starts and closes one headless browser;
 *            reads test/fixtures/; writes two PNG files and the downloads into OUT_DIR
 * @deps      playwright or playwright-core (not a dependency, see above); web/lib/index.js;
 *            node_modules/pac-replay-codec-1.0.1 when installed; node:http, node:fs, node:path, node:os
 * @complexity four small files packed or unpacked in the page; a few seconds
 * @alloc     the browser, the server and the downloads; all released at the end
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = path.join(ROOT, 'web');
const FIXTURES = ['synthetic-schema4.colreplay', 'synthetic-schema5.colreplay'].map((n) => path.join(ROOT, 'test', 'fixtures', n));
const CONFIG = Object.freeze({ StepTimeoutMs: 30000, CutBytes: 300, Viewport: { width: 1100, height: 1400 } });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf', '.txt': 'text/plain' };

/** Playwright's chromium launcher, from wherever it is installed. */
async function loadChromium() {
  const candidates = [process.env.PLAYWRIGHT_MODULE, 'playwright', 'playwright-core'].filter(Boolean);
  for (const c of candidates) {
    try {
      const spec = fs.existsSync(c) ? pathToFileURL(path.join(c, 'index.mjs')).href : c;
      const m = await import(spec);
      return (m.chromium ?? m.default.chromium);
    } catch {
      // try the next one
    }
  }
  throw new Error('Playwright not found: npm install --no-save playwright, or set PLAYWRIGHT_MODULE to its folder');
}

/** A static server for web/. @returns {Promise<{ url: string, close: () => void }>} */
function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(WEB, rel.endsWith('/') ? `${rel}index.html` : rel);
    if (!file.startsWith(WEB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() }));
  });
}

const steps = [];
const check = (ok, what) => {
  steps.push({ ok, what });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
};
const same = (a, b) => a.length === b.length && Buffer.compare(a, b) === 0;

const outDir = process.argv[2] ? path.resolve(process.argv[2]) : fs.mkdtempSync(path.join(os.tmpdir(), 'paczd-page-qa-'));
fs.mkdirSync(outDir, { recursive: true });
const chromium = await loadChromium();
const site = await serve();
const browser = await chromium.launch();
let exitCode = 1;
try {
  const page = await browser.newPage({ viewport: CONFIG.Viewport, acceptDownloads: true });
  page.setDefaultTimeout(CONFIG.StepTimeoutMs);
  const consoleErrors = [];
  const failedRequests = [];
  const foreign = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  page.on('requestfailed', (r) => failedRequests.push(r.url()));
  page.on('request', (r) => { if (!r.url().startsWith(site.url) && !r.url().startsWith('blob:') && !r.url().startsWith('data:')) foreign.push(r.url()); });

  // 1. the page loads
  await page.goto(site.url);
  await page.waitForSelector('#file-input', { state: 'attached' });
  check(consoleErrors.length === 0, `the page loads without a console error${consoleErrors.length ? `: ${consoleErrors[0]}` : ''}`);

  /** Rows whose status is `status`, as { name, text } in page order. */
  const rows = (status) => page.$$eval(`#list .row[data-status="${status}"]`, (els) => els.map((e) => ({ name: e.querySelector('.row-name').textContent, text: e.textContent })));
  /** Click the download link of the row called `name` and return the bytes. */
  const download = async (name) => {
    const link = page.locator('#list .row', { has: page.locator('.row-name', { hasText: name }) }).locator('a[download]').first();
    const [dl] = await Promise.all([page.waitForEvent('download'), link.click()]);
    const to = path.join(outDir, dl.suggestedFilename());
    await dl.saveAs(to);
    return { file: to, bytes: fs.readFileSync(to) };
  };

  // 2. two replays in: packed and exact
  await page.setInputFiles('#file-input', FIXTURES);
  await page.waitForFunction((n) => document.querySelectorAll('#list .row[data-status="exact"]').length === n, FIXTURES.length);
  const packedRows = await rows('exact');
  check(packedRows.length === FIXTURES.length && packedRows.every((r) => r.text.includes('Pack') && r.text.includes('byte for byte')), 'two replays dropped: both rows read Exact, packed and unpacked again in the page');

  // 3. the downloads are what the codec packs under Node, and what 1.0.1 packed
  const lib = await import(pathToFileURL(path.join(WEB, 'lib', 'index.js')).href);
  let published = null;
  try {
    published = await import('pac-replay-codec-1.0.1');
  } catch {
    published = null;
  }
  const packs = [];
  for (const f of FIXTURES) {
    const original = new Uint8Array(fs.readFileSync(f));
    const got = await download(path.basename(f));
    packs.push(got.file);
    check(same(got.bytes, Buffer.from(lib.packReplay(original).bytes)), `${path.basename(got.file)} from the page is byte for byte what web/lib/index.js packs under Node`);
    if (published !== null) check(same(got.bytes, Buffer.from(published.packReplay(original).bytes)), `${path.basename(got.file)} is byte for byte what the published 1.0.1 packs`);
  }
  if (published === null) console.log('note the published 1.0.1 is not installed (npm install): that comparison was skipped');
  await page.screenshot({ path: path.join(outDir, 'page-color.png'), fullPage: true });
  // greyscale the way DevTools does it (Rendering, Emulate vision deficiencies, Achromatopsia). A style tag would
  // be the short way, and the page's own security policy refuses it, as it should.
  const devtools = await page.context().newCDPSession(page);
  await devtools.send('Emulation.setEmulatedVisionDeficiency', { type: 'achromatopsia' });
  await page.screenshot({ path: path.join(outDir, 'page-greyscale.png'), fullPage: true });
  await devtools.send('Emulation.setEmulatedVisionDeficiency', { type: 'none' });

  // 4. the packed files back in: unpacked and exact, and the downloads are the originals
  await page.setInputFiles('#file-input', packs);
  await page.waitForFunction((n) => document.querySelectorAll('#list .row[data-status="exact"]').length === n, FIXTURES.length * 2);
  // a row's verb is in its tag: "Pack" or "Unpack". (The foot of a pack row also says "unpack", so match the tag.)
  const unpacked = page.locator('#list .row[data-status="exact"]', { has: page.locator('.row-sizes .tag', { hasText: /^Unpack$/ }) });
  check((await unpacked.count()) === FIXTURES.length, 'two .paczd files dropped: both rows read Exact, as unpacks');
  for (let i = 0; i < FIXTURES.length; i++) {
    const link = unpacked.nth(i).locator('a[download]').first();
    const [dl] = await Promise.all([page.waitForEvent('download'), link.click()]);
    const to = path.join(outDir, `restored-${i}-${dl.suggestedFilename()}`);
    await dl.saveAs(to);
    const back = fs.readFileSync(to);
    check(FIXTURES.some((f) => same(back, fs.readFileSync(f))), `${dl.suggestedFilename()} from the page is one of the originals, byte for byte`);
  }

  // 5. a file that is not a replay is kept as it is; a cut packed file fails with a reason
  const text = path.join(outDir, 'notes.txt');
  fs.writeFileSync(text, 'not a replay\n'.repeat(40));
  const cut = path.join(outDir, 'cut.paczd');
  fs.writeFileSync(cut, fs.readFileSync(packs[0]).subarray(0, CONFIG.CutBytes));
  await page.setInputFiles('#file-input', [text, cut]);
  await page.waitForFunction(() => document.querySelectorAll('#list .row[data-status="stored"]').length === 1 && document.querySelectorAll('#list .row[data-status="failed"]').length === 1);
  check((await rows('stored'))[0].text.includes('Kept as is'), 'a text file reads Kept as is');
  check((await rows('failed'))[0].text.includes('Failed'), 'a cut .paczd reads Failed, with a reason');

  check(failedRequests.length === 0, `no request failed${failedRequests.length ? `: ${failedRequests[0]}` : ''}`);
  check(foreign.length === 0, `nothing was fetched from anywhere but the page's own folder${foreign.length ? `: ${foreign[0]}` : ''}`);
  check(consoleErrors.length === 0, `no console error by the end${consoleErrors.length ? `: ${consoleErrors[0]}` : ''}`);
  exitCode = steps.every((s) => s.ok) ? 0 : 1;
} finally {
  await browser.close();
  site.close();
}
console.log(`${steps.filter((s) => s.ok).length} of ${steps.length} checks held. Screenshots and downloads: ${outDir}`);
process.exit(exitCode);
