/// <reference path="./pagemd-modules.d.ts" />
// A profile's HTML template for the canvas (P18, R-228). pagemd renders a document by filling its template: `{{content}}`
// becomes the document's HTML, `{{styles}}` the CSS, `{{metadata.x}}` the properties. The canvas does the same with the same
// code (@pagemd/theme-kit's fillTemplate), except that `{{content}}` becomes an empty slot element (the webview puts the
// editable text area there) and `{{styles}}` becomes nothing (the profile's CSS reaches the canvas on its own, scoped).
// What the canvas needs from the result: the `<body>`'s content and classes (the canvas stands for the body), and the CSS of
// the template's own `<style>` blocks (OQ-39), wherever they are. HTML comments go first, so a `<style>` or `{{content}}`
// written inside a comment counts for nothing, as in the browser. No DOM here (this runs on the host): the webview parses
// the body with the browser's own parser (components/template-frame).
import { fillTemplate, templateData } from '@pagemd/theme-kit';
import { TEMPLATE_SLOT, type PageTemplate } from '@pagemd-editor/core';

export interface TemplateParts {
  /** null when the template has no `{{content}}` in its body (pagemd's page would hold no text either). */
  template: PageTemplate | null;
  /** The template's own `<style>` CSS, in order (a `media` attribute becomes an `@media` block); '' for none. */
  css: string;
  /** Tokens with no value and no default (pagemd warns about them and writes nothing). */
  missing: string[];
}

const SLOT_HTML = `<${TEMPLATE_SLOT}></${TEMPLATE_SLOT}>`;
const COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
const STYLE = /<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi;

/** The template `text` filled for `metadata` (and `profile`), split into what the canvas draws and what it styles with. */
export function templateParts(text: string, metadata: Record<string, unknown>, profile: Record<string, unknown> = {}): TemplateParts {
  const { html, missing } = fillTemplate(text, templateData({ content: SLOT_HTML, styles: '', metadata, profile }));
  const page = html.replace(COMMENT, '');

  const sheets: string[] = [];
  for (const m of page.matchAll(STYLE)) {
    const css = m[2]!.trim();
    if (!css) continue;
    const media = attribute(m[1]!, 'media');
    sheets.push(media && media.trim() !== '' && media.trim().toLowerCase() !== 'all' ? `@media ${media} {\n${css}\n}` : css);
  }

  const body = bodyOf(page);
  const inner = body.inner.replace(STYLE, '');
  const template: PageTemplate | null = inner.includes(SLOT_HTML) ? { html: inner.trim(), ...(body.className ? { bodyClass: body.className } : {}) } : null;
  return { template, css: sheets.join('\n'), missing };
}

/** The content of `<body>` and its classes; without a body tag, everything after the head (the browser's own rule). */
function bodyOf(page: string): { inner: string; className: string } {
  const open = /<body\b([^>]*)>/i.exec(page);
  if (open) {
    const start = open.index + open[0].length;
    const close = page.toLowerCase().lastIndexOf('</body');
    return { inner: page.slice(start, close >= start ? close : page.length), className: (attribute(open[1]!, 'class') ?? '').trim().replace(/\s+/g, ' ') };
  }
  const withoutHead = page.replace(/<head\b[\s\S]*?<\/head\s*>/i, '').replace(/<!doctype[^>]*>/i, '').replace(/<\/?html\b[^>]*>/gi, '');
  return { inner: withoutHead, className: '' };
}

/** An attribute's value in a tag's attribute text (quoted either way, or bare); undefined when absent. */
function attribute(attrs: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(attrs);
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : undefined;
}
