/**
 * DOM builders, so the page never needs innerHTML. String children become text nodes, so a file name dropped by
 * the user is escaped by construction.
 *
 * @interacts app.js, chart.js (every node on the page is built here)
 * @deps      none
 * @complexity O(n) over the props and children of the node being built
 * @alloc     one element per call plus one text node per string child; nothing retained here
 */

/**
 * Create an HTML element.
 * @param {string} tag
 * @param {object} [props] class, text, dataset, style (object), attrs, on (event map), or any direct DOM property.
 *                        `html` throws.
 * @param {...any} children nodes, strings, numbers, arrays; null and false are skipped
 * @complexity O(k) over props plus children
 * @alloc one element, one text node per string child
 */
export function el(tag, props = null, ...children) {
  return build(document.createElement(tag), props, children);
}

/** @complexity O(k) over props plus children */
function build(node, props, children) {
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'html') throw new Error('el(): html is not supported, build nodes instead');
      if (key === 'class') node.setAttribute('class', value);
      else if (key === 'text') node.textContent = String(value);
      else if (key === 'dataset') Object.assign(node.dataset, value);
      // Through the CSSOM, which the page's content security policy allows (a style attribute string is blocked).
      else if (key === 'style') Object.assign(node.style, value);
      else if (key === 'attrs') {
        for (const [name, v] of Object.entries(value)) {
          if (v === true) node.setAttribute(name, '');
          else if (v != null && v !== false) node.setAttribute(name, String(v));
        }
      } else if (key === 'on') {
        for (const [event, handler] of Object.entries(value)) node.addEventListener(event, handler);
      } else node[key] = value;
    }
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false || child === '') continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}
