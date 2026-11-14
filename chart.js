/**
 * The size chart: horizontal bars that all start at zero on one shared scale. Every bar carries its name and its
 * value as text, so nothing depends on telling the fills apart.
 *
 * @interacts app.js (calls sizeChart on every summary render)
 * @deps      dom.js
 * @complexity O(B) over the B bars (four at most on this page)
 * @alloc     a few nodes per bar, replaced on the next render
 */
import { el } from './dom.js';

const PERCENT = 100;
/** A bar that would round to nothing still shows as a sliver, so its row never looks empty. */
const MIN_VISIBLE_PCT = 0.5;
const TICKS = [0, 0.25, 0.5, 0.75, 1];

/**
 * @param {{ label: string, value: number, text: string, hi?: boolean }[]} bars
 * @returns {HTMLElement}
 * @complexity O(B)
 * @alloc one figure with a row per bar
 */
export function sizeChart(bars) {
  const max = Math.max(1, ...bars.map((b) => b.value));
  const rows = bars.map((b) => {
    const pct = Math.max((b.value / max) * PERCENT, MIN_VISIBLE_PCT);
    const share = ((b.value / max) * PERCENT).toFixed(1);
    return el('div', { class: `bar-row${b.hi ? ' is-hi' : ''}` },
      el('div', { class: 'bar-label' },
        el('span', { class: 'bar-name', text: b.label }),
        el('span', { class: 'bar-value', text: b.text })),
      el('div', { class: 'bar-track', attrs: { 'aria-hidden': 'true' } },
        el('div', { class: 'bar-fill', style: { width: `${pct}%` } }),
        el('span', { class: 'bar-share', text: `${share}%` })));
  });
  const axis = el('div', { class: 'bar-axis', attrs: { 'aria-hidden': 'true' } },
    TICKS.map((t) => el('span', { class: 'tick', style: { left: `${t * PERCENT}%` }, text: `${t * PERCENT}%` })));
  const summary = bars.map((b) => `${b.label}: ${b.text}`).join('. ');
  return el('figure', { class: 'bars', attrs: { role: 'group', 'aria-label': `Sizes. ${summary}.` } },
    rows, axis,
    el('figcaption', { class: 'muted', text: 'Each bar is drawn from zero on the same scale. The largest is 100%.' }));
}
