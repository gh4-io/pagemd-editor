// HTML the document or its profile brings onto the canvas, drawn as the browser draws it (P18): a profile's template
// (components/template-frame) and, in the views styled by the profile, a raw HTML block (preset-commonmark). The webview's own
// policy runs only its own scripts (nonce), but a frame's `srcdoc` or an event attribute must not even reach the page: what a
// template or an HTML block may not bring is taken out first. Parsing uses the browser's inert `<template>` element (nothing
// loads or runs while it is parsed). DOM types only: callers pass their own document.

/** Elements the canvas never draws from a template or an HTML block (scripts, frames, plug-ins, document-level tags; `<style>`
 * in a template comes as scoped CSS). */
export const DROPPED_ELEMENTS: ReadonlySet<string> = new Set(['script', 'noscript', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'link', 'meta', 'base', 'style', 'title', 'template']);
/** Attributes holding an address: a `javascript:` (or `vbscript:`) one is dropped. */
const URL_ATTRIBUTES: ReadonlySet<string> = new Set(['href', 'src', 'action', 'formaction', 'xlink:href', 'poster', 'background', 'data', 'cite', 'longdesc']);
/** Landmark elements lose their landmark role: the editor's own region is the page's main landmark (P13b). */
const LANDMARKS: ReadonlySet<string> = new Set(['main', 'header', 'footer', 'nav', 'aside']);

/** Whether attribute `name` with `value` may stay: no event handlers, no script addresses, no `srcdoc`. */
export function keepsAttribute(name: string, value: string): boolean {
  const n = name.toLowerCase();
  if (n.startsWith('on') || n === 'srcdoc') return false;
  // eslint-disable-next-line no-control-regex
  if (URL_ATTRIBUTES.has(n) && /^(?:javascript|vbscript):/i.test(value.replace(/[\u0000- ]/g, ''))) return false;
  return true;
}

/** Removes, in place, what may not be drawn (DROPPED_ELEMENTS, `keepsAttribute`), and takes landmarks' roles away. */
export function sanitize(root: DocumentFragment | Element): void {
  for (const el of [...root.querySelectorAll('*')]) {
    const tag = el.tagName.toLowerCase();
    if (DROPPED_ELEMENTS.has(tag)) {
      el.remove();
      continue;
    }
    for (const attr of [...el.attributes]) if (!keepsAttribute(attr.name, attr.value)) el.removeAttribute(attr.name);
    if (LANDMARKS.has(tag) && !el.hasAttribute('role')) el.setAttribute('role', 'none');
  }
}

/** `html` parsed inertly in `doc` and made safe (`sanitize`), ready to insert. */
export function safeFragment(doc: Document, html: string): DocumentFragment {
  const holder = doc.createElement('template');
  holder.innerHTML = html;
  sanitize(holder.content);
  return holder.content;
}
