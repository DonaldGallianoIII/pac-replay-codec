/**
 * The page: drop files, pack or unpack them in background workers, show sizes, offer the results for download.
 * The state below is the truth; render functions only project it into the DOM.
 *
 * @interacts index.html (mount points), worker.js (the work), zip.js (download all), chart.js (size bars), dom.js
 * @deps      dom.js, chart.js, zip.js, worker.js (spawned as module workers)
 * @complexity O(N) per render over the N files dropped this session; the codec work is O(F) per file in a worker
 * @alloc     one Blob and one object URL per finished file, kept until "Clear" or page teardown, which revoke them;
 *            one row of nodes per file; WORKER_MAX workers at most, terminated on teardown
 */
import { el } from './dom.js';
import { sizeChart } from './chart.js';
import { makeZip } from './zip.js';

const CONFIG = {
  /** Workers run side by side; each holds about 55 MB while packing. */
  WORKER_MAX: 4,
  /** Leave one core for the page itself. */
  WORKER_SPARE_CORES: 1,
  /** Shown before any file is dropped: the measured result on the 10 benchmark replays (see README). */
  BENCH_RATIO: 11.2,
  PACKED_EXT: '.clrz',
  REPLAY_EXT: '.colreplay',
  THEME_KEY: 'pac-replay-codec.theme',
  ZIP_NAME: 'pac-replay-codec-files.zip',
};
const KB = 1024;
const MB = KB * KB;
const RATIO_DECIMALS = 1;
const PERCENT = 100;
const MS_PER_S = 1000;

/** Per-file status. Every state has a glyph and a word, never a color alone. */
const STATUS = {
  waiting: { glyph: '○', word: 'Waiting' },
  working: { glyph: '◐', word: 'Working' },
  exact: { glyph: '✓', word: 'Exact' },
  stored: { glyph: '=', word: 'Kept as is' },
  failed: { glyph: '✗', word: 'Failed' },
};

/**
 * Everything the page knows. One entry per dropped file, in drop order.
 * @type {{ files: Array<object>, nextId: number }}
 */
const state = { files: [], nextId: 1 };

const pool = createPool(workerCount());
const mounts = {
  hero: document.getElementById('hero'),
  drop: document.getElementById('drop'),
  input: document.getElementById('file-input'),
  progress: document.getElementById('progress'),
  chart: document.getElementById('chart'),
  list: document.getElementById('list'),
  actions: document.getElementById('actions'),
  theme: document.getElementById('theme-toggle'),
  announce: document.getElementById('announce'),
};
/** Screen readers hear the progress at most once per this share of the batch, and once at the end. */
const ANNOUNCE_STEP = 0.1;
let lastAnnounced = -1;

/* ----------------------------------------------------------------- workers */

/** @complexity O(1) */
function workerCount() {
  const cores = navigator.hardwareConcurrency || 2;
  return Math.max(1, Math.min(CONFIG.WORKER_MAX, cores - CONFIG.WORKER_SPARE_CORES));
}

/**
 * A fixed set of workers and a queue. Workers are made on first use and terminated by teardown().
 * @complexity O(1) per enqueue and per finished job
 * @alloc up to `size` workers
 */
function createPool(size) {
  const idle = [];
  const all = [];
  const queue = [];

  function spawn() {
    const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    w.onmessage = (e) => { onResult(e.data); idle.push(w); pump(); };
    w.onerror = (e) => {
      e.preventDefault();
      const job = w.job;
      if (job) onResult({ id: job, ok: false, kind: '?', error: e.message || 'the worker stopped' });
      idle.push(w);
      pump();
    };
    all.push(w);
    return w;
  }

  async function pump() {
    while (queue.length > 0) {
      let w = idle.pop();
      if (!w && all.length < size) w = spawn();
      if (!w) return;
      const entry = queue.shift();
      w.job = entry.id;
      entry.status = 'working';
      renderRow(entry);
      renderSummary();
      try {
        const bytes = await entry.file.arrayBuffer();
        w.postMessage({ id: entry.id, bytes }, [bytes]);
      } catch (err) {
        idle.push(w);
        onResult({ id: entry.id, ok: false, kind: '?', error: `could not read the file: ${err.message}` });
      }
    }
  }

  return {
    add(entry) { queue.push(entry); pump(); },
    cancelWaiting() { queue.length = 0; },
    teardown() { for (const w of all) w.terminate(); all.length = 0; idle.length = 0; queue.length = 0; },
  };
}

/* ------------------------------------------------------------------- state */

/** @complexity O(1) */
function outputName(name, kind) {
  if (kind === 'pack') {
    const base = name.toLowerCase().endsWith(CONFIG.REPLAY_EXT) ? name.slice(0, -CONFIG.REPLAY_EXT.length) : name;
    return base + CONFIG.PACKED_EXT;
  }
  const base = name.toLowerCase().endsWith(CONFIG.PACKED_EXT) ? name.slice(0, -CONFIG.PACKED_EXT.length) : name;
  return base.includes('.') ? base : base + CONFIG.REPLAY_EXT;
}

/** @complexity O(D) over the D files added */
function addFiles(fileList) {
  if (fileList.length === 0) return;
  for (const file of fileList) {
    const entry = { id: state.nextId++, file, name: file.name, inSize: file.size, status: 'waiting', result: null,
      blob: null, url: null, outName: null, row: null };
    state.files.push(entry);
    mounts.list.append(rowNode(entry));
    pool.add(entry);
  }
  renderSummary();
}

/** @complexity O(N) to find the entry */
function onResult(msg) {
  const entry = state.files.find((f) => f.id === msg.id);
  if (!entry) return; // cleared while it was working
  entry.result = msg;
  entry.file = null; // the worker has what it needs; let the browser drop its handle
  if (msg.ok) {
    entry.status = msg.stored ? 'stored' : 'exact';
    entry.outName = outputName(entry.name, msg.kind);
    entry.blob = new Blob([msg.out], { type: 'application/octet-stream' });
    entry.url = URL.createObjectURL(entry.blob);
  } else {
    entry.status = 'failed';
  }
  renderRow(entry);
  renderSummary();
}

/** Asks first when there are results; nothing on the page is saved anywhere else. @complexity O(N) */
function confirmClear() {
  const results = state.files.filter((f) => f.url).length;
  if (results > 0 && !confirm(`Clear ${results} result${results === 1 ? '' : 's'} from the page? Anything not downloaded is gone.`)) return;
  clearAll();
}

/** Tells a screen reader how far the batch is, at most every ANNOUNCE_STEP of it. @complexity O(1) */
function announce(finished, n, t) {
  if (n === 0) { lastAnnounced = -1; return; }
  const step = Math.floor((finished / n) / ANNOUNCE_STEP);
  if (finished !== n && step === lastAnnounced) return;
  if (finished === n && lastAnnounced === Infinity) return;
  lastAnnounced = finished === n ? Infinity : step;
  mounts.announce.textContent = finished === n
    ? `All ${n} done.${t.failed ? ` ${t.failed} failed.` : ''}${t.packs ? ` ${ratioText(t.packIn, t.packOut)} smaller.` : ''}`
    : `${finished} of ${n} done.`;
}

/** Releases every object URL and forgets every file. @complexity O(N) */
function clearAll() {
  pool.cancelWaiting();
  for (const f of state.files) if (f.url) URL.revokeObjectURL(f.url);
  state.files = [];
  mounts.list.replaceChildren();
  renderSummary();
}

/** @complexity O(N) */
function totals() {
  const t = { packIn: 0, packOut: 0, unpackIn: 0, unpackOut: 0, packs: 0, unpacks: 0, stored: 0, done: 0, failed: 0,
    ms: 0 };
  for (const f of state.files) {
    if (f.status === 'failed') t.failed++;
    if (!f.result || !f.result.ok) continue;
    t.done++;
    t.ms += f.result.ms;
    if (f.result.stored) { t.stored++; continue; } // not a replay: kept as is, left out of the size totals
    if (f.result.kind === 'pack') { t.packs++; t.packIn += f.result.inSize; t.packOut += f.result.outSize; }
    else { t.unpacks++; t.unpackIn += f.result.inSize; t.unpackOut += f.result.outSize; }
  }
  return t;
}

/* ------------------------------------------------------------------ render */

/** @complexity O(1) */
export function formatBytes(n) {
  if (n >= MB) return `${(n / MB).toFixed(2)} MB`;
  if (n >= KB) return `${(n / KB).toFixed(1)} KB`;
  return `${n} B`;
}

/** @complexity O(1) */
function ratioText(a, b) {
  return b > 0 ? `${(a / b).toFixed(RATIO_DECIMALS)}×` : '';
}

/** @complexity O(N) through totals() */
function renderSummary() {
  const t = totals();
  const n = state.files.length;
  renderHero(t);
  // progress
  const finished = t.done + t.failed;
  mounts.progress.hidden = n === 0;
  const progressNodes = [
    el('progress', { max: n || 1, value: finished, attrs: { 'aria-label': 'Files finished' } }),
    el('span', { class: 'progress-text', text: finished === n ? `All ${n} done` : `${finished} of ${n} done` }),
  ];
  if (t.failed > 0) progressNodes.push(el('span', { class: 'tag tag-bad', text: `✗ ${t.failed} failed` }));
  if (t.stored > 0) progressNodes.push(el('span', { class: 'tag', text: `= ${t.stored} not a replay, kept as is, not counted` }));
  mounts.progress.replaceChildren(...progressNodes);
  announce(finished, n, t);
  // chart
  mounts.chart.hidden = t.done === 0;
  const bars = [];
  if (t.packs > 0) {
    bars.push({ label: 'Pack: original replays', value: t.packIn, text: formatBytes(t.packIn) });
    bars.push({ label: 'Pack: .clrz files out', value: t.packOut, text: formatBytes(t.packOut), hi: true });
  }
  if (t.unpacks > 0) {
    bars.push({ label: 'Unpack: .clrz files in', value: t.unpackIn, text: formatBytes(t.unpackIn), hi: true });
    bars.push({ label: 'Unpack: replays restored', value: t.unpackOut, text: formatBytes(t.unpackOut) });
  }
  mounts.chart.replaceChildren(
    el('h2', { class: 'section-title', text: 'Size, from zero' }),
    sizeChart(bars),
  );
  // actions
  const ready = state.files.filter((f) => f.url);
  const running = finished < n;
  let label = 'Download';
  if (ready.length === 1 && !running) label = `↓ Download ${ready[0].outName}`;
  else if (running) label = `↓ Download ${ready.length} finished so far (.zip)`;
  else label = `↓ Download all ${ready.length} (.zip)`;
  mounts.actions.hidden = n === 0;
  mounts.actions.replaceChildren(
    el('button', { class: 'btn btn-primary', type: 'button', disabled: ready.length === 0, text: label,
      on: { click: downloadAll } }),
    el('button', { class: 'btn', type: 'button', text: 'Clear', on: { click: confirmClear } }),
  );
}

/** @complexity O(1) */
function renderHero(t) {
  let big;
  let label;
  let sub;
  if (t.packs > 0) {
    big = ratioText(t.packIn, t.packOut);
    label = 'smaller';
    const saved = t.packIn - t.packOut;
    sub = [
      el('span', { class: 'kv' }, el('b', { text: formatBytes(t.packIn) }), ' in'),
      el('span', { class: 'arrow', text: '→', attrs: { 'aria-hidden': 'true' } }),
      el('span', { class: 'kv' }, el('b', { text: formatBytes(t.packOut) }), ' out'),
      el('span', { class: 'kv' }, el('b', { text: formatBytes(saved) }),
        ` saved (${((saved / t.packIn) * PERCENT).toFixed(1)}%)`),
    ];
    if (t.unpacks > 0) sub.push(el('span', { class: 'kv' }, el('b', { text: String(t.unpacks) }), ' restored too'));
  } else if (t.unpacks > 0) {
    big = String(t.unpacks);
    label = t.unpacks === 1 ? 'replay restored' : 'replays restored';
    sub = [el('span', { class: 'kv' }, el('b', { text: formatBytes(t.unpackOut) }), ' rebuilt, size and crc32 checked')];
  } else {
    big = `${CONFIG.BENCH_RATIO}×`;
    label = 'smaller';
    sub = [el('span', { class: 'kv muted', text: 'on the 10 benchmark replays. Drop yours to see your number.' })];
  }
  mounts.hero.replaceChildren(
    el('div', { class: 'hero-line' }, el('span', { class: 'hero-num', text: big }),
      el('span', { class: 'hero-label', text: label })),
    el('div', { class: 'hero-sub' }, sub),
  );
}

/** @complexity O(1) */
function rowNode(entry) {
  entry.row = el('li', { class: 'row' });
  renderRow(entry);
  return entry.row;
}

/** @complexity O(1) */
function renderRow(entry) {
  if (!entry.row) return;
  const s = STATUS[entry.status];
  const r = entry.result;
  const statusNode = el('span', { class: `status status-${entry.status}` },
    el('span', { class: 'glyph', text: s.glyph, attrs: { 'aria-hidden': 'true' } }),
    el('span', { text: s.word }));
  const verb = r ? (r.kind === 'pack' ? 'Pack' : 'Unpack') : '';
  const cells = [
    el('div', { class: 'row-head' },
      el('span', { class: 'row-name', text: entry.name, title: entry.name }),
      statusNode),
  ];
  if (r && r.ok) {
    const smaller = r.kind === 'pack';
    const frac = smaller ? r.outSize / r.inSize : r.inSize / r.outSize;
    cells.push(
      el('div', { class: 'row-sizes' },
        el('span', { class: 'tag', text: verb }),
        el('span', { text: `${formatBytes(r.inSize)} → ${formatBytes(r.outSize)}` }),
        el('b', { text: sizeVerdict(r) }),
        el('span', { class: 'muted', text: `${(r.ms / MS_PER_S).toFixed(2)} s` })),
      miniBar(frac, smaller),
      el('div', { class: 'row-foot' },
        el('span', { class: 'check', text: r.stored ? `= ${r.note}`
          : `✓ exact: verified by checksum (crc32 ${hex(r.crc)})${smaller ? ' and a full unpack, byte for byte' : ''}` }),
        el('a', { class: 'btn btn-small', href: entry.url, download: entry.outName,
          text: `↓ ${r.kind === 'pack' ? '.clrz' : '.colreplay'}`, title: entry.outName,
          attrs: { 'aria-label': `Download ${entry.outName}` } })),
    );
  } else if (r && !r.ok) {
    cells.push(el('div', { class: 'row-foot' }, el('span', { class: 'check bad', text: `✗ ${friendlyError(r.error)}` })),
      el('details', { class: 'raw-error' }, el('summary', { text: 'Exact message' }), el('code', { text: r.error })));
  } else {
    cells.push(el('div', { class: 'row-sizes muted' }, el('span', { text: formatBytes(entry.inSize) })));
  }
  entry.row.replaceChildren(...cells);
  entry.row.dataset.status = entry.status;
}

/**
 * Two stacked bars per row: the bigger file is the full track, the smaller one is the filled part.
 * @complexity O(1)
 */
function miniBar(frac, packed) {
  const pct = Math.max(frac * PERCENT, 0.5);
  return el('div', { class: 'mini', attrs: { role: 'img',
    'aria-label': `${packed ? 'Packed' : 'Packed input'} is ${(frac * PERCENT).toFixed(1)}% of the replay` } },
    el('div', { class: 'mini-track' }),
    el('div', { class: 'mini-fill', style: { width: `${pct}%` } }));
}

/** Plain words and a next step for the codec's common errors; anything else is shown as it came. @complexity O(1) */
function friendlyError(msg) {
  if (/damaged|crc32 mismatch/.test(msg)) return 'This .clrz is damaged or cut short. Pack the original replay again.';
  if (/format version|predictor set|mode \d+ is not supported/.test(msg)) return 'This .clrz was made by a newer version of the codec. Use that version to unpack it.';
  if (/starting model/.test(msg)) return 'This .clrz was packed with a starting model this page does not have.';
  if (/could not read the file/.test(msg)) return 'The browser could not read this file. If it is a folder, drop the folder itself, not its shortcut.';
  return msg;
}

/** @complexity O(1) */
function sizeVerdict(r) {
  if (r.kind === 'unpack') return `${ratioText(r.outSize, r.inSize)} bigger`;
  if (r.stored) return `+${r.outSize - r.inSize} B of header, no gain`;
  return `${ratioText(r.inSize, r.outSize)} smaller`;
}

/** @complexity O(1) */
function hex(n) {
  return (n >>> 0).toString(16).padStart(8, '0');
}

/* ---------------------------------------------------------------- download */

/** @complexity O(N) */
function downloadAll() {
  const ready = state.files.filter((f) => f.blob);
  if (ready.length === 1) { saveUrl(ready[0].url, ready[0].outName); return; }
  const used = new Map();
  const files = ready.map((f) => {
    let name = f.outName;
    const k = used.get(name) || 0;
    used.set(name, k + 1);
    if (k > 0) {
      const dot = name.lastIndexOf('.');
      name = `${name.slice(0, dot)} (${k + 1})${name.slice(dot)}`;
    }
    return { name, blob: f.blob, crc: f.result.outCrc };
  });
  let zip;
  try { zip = makeZip(files); } catch (err) { alert(err.message); return; }
  const url = URL.createObjectURL(zip);
  saveUrl(url, CONFIG.ZIP_NAME);
  // The click has started the download; release the URL on the next turn.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** @complexity O(1) */
function saveUrl(url, name) {
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
}

/* ------------------------------------------------------------------- input */

function wireDrop() {
  const zone = mounts.drop;
  const over = (e) => { e.preventDefault(); zone.classList.add('is-over'); };
  const leave = () => zone.classList.remove('is-over');
  const drop = async (e) => {
    e.preventDefault();
    leave();
    if (!e.dataTransfer) return;
    // Entries must be taken while the event is live; reading them can wait.
    const entries = Array.from(e.dataTransfer.items || [])
      .map((item) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null));
    if (entries.length > 0 && entries.every(Boolean)) addFiles(await filesFromEntries(entries));
    else if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  };
  // The whole window accepts a drop, so a near miss does not open the file in the tab.
  window.addEventListener('dragover', over);
  window.addEventListener('dragleave', (e) => { if (e.target === document.documentElement || !e.relatedTarget) leave(); });
  window.addEventListener('drop', drop);
  mounts.input.addEventListener('change', () => { addFiles(mounts.input.files); mounts.input.value = ''; });
}

/**
 * The files under dropped entries. A file dropped on its own is always taken; inside a dropped folder only
 * .colreplay and .clrz files are, so a folder of mixed things does not fill the list with "kept as is".
 * @complexity O(E) over every entry in the dropped folders
 * @alloc one File handle per kept file
 */
async function filesFromEntries(entries) {
  const out = [];
  const wanted = (name) => {
    const n = name.toLowerCase();
    return n.endsWith(CONFIG.REPLAY_EXT) || n.endsWith(CONFIG.PACKED_EXT);
  };
  const fileOf = (entry) => new Promise((resolve, reject) => entry.file(resolve, reject));
  const readAll = async (dir) => {
    const reader = dir.createReader();
    const all = [];
    // readEntries hands back the folder in batches; an empty batch means the end
    for (;;) {
      const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      if (batch.length === 0) return all;
      all.push(...batch);
    }
  };
  const walk = async (entry, top) => {
    if (entry.isFile) {
      if (top || wanted(entry.name)) out.push(await fileOf(entry));
    } else if (entry.isDirectory) {
      for (const child of await readAll(entry)) await walk(child, false);
    }
  };
  for (const entry of entries) await walk(entry, true);
  return out;
}

/* ------------------------------------------------------------------- theme */

function wireTheme() {
  const root = document.documentElement;
  let saved = null;
  try { saved = localStorage.getItem(CONFIG.THEME_KEY); } catch { /* storage blocked: follow the system */ }
  if (saved === 'light' || saved === 'dark') root.dataset.theme = saved;
  const current = () => root.dataset.theme
    || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  const label = () => {
    const next = current() === 'dark' ? 'light' : 'dark';
    mounts.theme.textContent = current() === 'dark' ? '☾ Dark theme' : '☀ Light theme';
    mounts.theme.setAttribute('aria-label', `Switch to ${next} theme`);
  };
  mounts.theme.addEventListener('click', () => {
    const next = current() === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    try { localStorage.setItem(CONFIG.THEME_KEY, next); } catch { /* not remembered, still switched */ }
    label();
  });
  label();
}

/* --------------------------------------------------------------- lifecycle */

function teardown() {
  pool.teardown();
  for (const f of state.files) if (f.url) URL.revokeObjectURL(f.url);
}

wireDrop();
wireTheme();
renderSummary();
// A page kept in the back/forward cache comes back with its workers and URLs intact, so only a real unload tears down.
window.addEventListener('pagehide', (e) => { if (!e.persisted) teardown(); });
