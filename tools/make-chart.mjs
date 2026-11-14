/**
 * Draws docs/compressors.svg from docs/compressors.json: one horizontal bar per compressor, all from zero on one
 * scale, each labelled with its name and its ratio. The codec's bar is told apart by its label, a heavier outline
 * and a darker fill, so the chart reads the same in greyscale.
 *
 * Usage: node tools/make-chart.mjs
 *
 * @interacts docs/compressors.json (read), docs/compressors.svg (written)
 * @deps      node:fs, node:path
 * @complexity O(R) over the R rows (13)
 * @alloc     one string, the SVG
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LAYOUT = Object.freeze({
  width: 820, labelWidth: 230, valueWidth: 70, rowHeight: 30, barHeight: 18, top: 56, bottom: 70, side: 16,
  tickStep: 2, fontSize: 14, titleSize: 18,
});
const COLORS = Object.freeze({ bg: '#ffffff', ink: '#15181c', muted: '#4f565e', bar: '#b9bec5', hi: '#006b80',
  rule: '#c9cdd3' });

const data = JSON.parse(readFileSync(join(ROOT, 'docs', 'compressors.json'), 'utf8'));
const L = LAYOUT;
const max = Math.ceil(Math.max(...data.rows.map((r) => r.ratio)) / L.tickStep) * L.tickStep;
const plotX = L.side + L.labelWidth;
const plotW = L.width - plotX - L.valueWidth - L.side;
const height = L.top + data.rows.length * L.rowHeight + L.bottom;
const x = (v) => plotX + (v / max) * plotW;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const parts = [];
parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${L.width}" height="${height}" viewBox="0 0 ${L.width} ${height}" font-family="DejaVu Sans Mono, Consolas, monospace" font-size="${L.fontSize}" role="img" aria-labelledby="t d">`);
parts.push(`<title id="t">How many times smaller than the raw replay, by compressor</title>`);
parts.push(`<desc id="d">${esc(data.rows.map((r) => `${r.label} ${r.ratio}x`).join(', '))}. ${esc(data.notes.join(' '))}</desc>`);
parts.push(`<rect width="100%" height="100%" fill="${COLORS.bg}"/>`);
parts.push(`<text x="${L.side}" y="28" font-size="${L.titleSize}" font-weight="700" fill="${COLORS.ink}">Times smaller than the raw replay (higher is better)</text>`);
for (let t = 0; t <= max; t += L.tickStep) {
  parts.push(`<line x1="${x(t)}" y1="${L.top - 8}" x2="${x(t)}" y2="${height - L.bottom + 4}" stroke="${COLORS.rule}" stroke-width="1"/>`);
  parts.push(`<text x="${x(t)}" y="${height - L.bottom + 22}" text-anchor="middle" fill="${COLORS.muted}">${t}x</text>`);
}
data.rows.forEach((r, i) => {
  const y = L.top + i * L.rowHeight;
  const weight = r.highlight ? 700 : 400;
  const label = r.highlight ? `▶ ${r.label}` : r.label;
  parts.push(`<text x="${plotX - 10}" y="${y + L.barHeight - 4}" text-anchor="end" font-weight="${weight}" fill="${COLORS.ink}">${esc(label)}</text>`);
  parts.push(`<rect x="${plotX}" y="${y}" width="${x(r.ratio) - plotX}" height="${L.barHeight}" fill="${r.highlight ? COLORS.hi : COLORS.bar}"${r.highlight ? ` stroke="${COLORS.ink}" stroke-width="2"` : ''}/>`);
  parts.push(`<text x="${x(r.ratio) + 8}" y="${y + L.barHeight - 4}" font-weight="${weight}" fill="${COLORS.ink}">${r.ratio.toFixed(2)}x</text>`);
});
parts.push(`<line x1="${plotX}" y1="${L.top - 8}" x2="${plotX}" y2="${height - L.bottom + 4}" stroke="${COLORS.ink}" stroke-width="1.5"/>`);
data.notes.forEach((line, i) => {
  parts.push(`<text x="${L.side}" y="${height - 26 + i * 16}" font-size="12" fill="${COLORS.muted}">${esc(line)}</text>`);
});
parts.push('</svg>');
writeFileSync(join(ROOT, 'docs', 'compressors.svg'), parts.join('\n') + '\n');
console.log(`wrote docs/compressors.svg (${data.rows.length} rows)`);
