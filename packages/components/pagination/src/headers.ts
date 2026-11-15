// Draws the running headers and footers (P6, amendment 7) into each paper of Print Layout and Read: read-only text in
// the top and bottom margins, from the page's own layout data. Outside ProseMirror, like the paper itself.
import type { PageGeometry, ResolvedStyles } from '@pagemd-editor/core';
import type { PageInfo } from './paginator.ts';
import { PX_PER_MM } from './paginator.ts';
import { runningFor, type RunningBoxes } from './running.ts';

export const HEADER_CLASS = 'pmd-page-header';
export const FOOTER_CLASS = 'pmd-page-footer';

/** The papers the pagination drew (`.pmd-pages > .pmd-page`), in page order. */
export function papersOf(canvas: HTMLElement): HTMLElement[] {
  return [...canvas.querySelectorAll<HTMLElement>(':scope > .pmd-pages > .pmd-page')];
}

/** Brings every paper's header and footer up to date with `pages` (and removes them when `styles` is null). */
export function drawRunning(canvas: HTMLElement, pages: readonly PageInfo[], styles: (Pick<ResolvedStyles, 'header' | 'footer' | 'firstPage' | 'marginFontSize'> & Pick<Partial<ResolvedStyles>, 'namedRunning'>) | null): void {
  const firsts = firstsOfType(pages);
  papersOf(canvas).forEach((paper, i) => {
    const info = pages[i];
    const shown = info && styles
      ? runningFor(styles, { number: info.number, total: pages.length, blank: info.blank, strings: info.strings, name: info.name, firstOfType: firsts[i] })
      : { header: null, footer: null };
    sync(paper, HEADER_CLASS, shown.header, info, 'top', styles?.marginFontSize);
    sync(paper, FOOTER_CLASS, shown.footer, info, 'bottom', styles?.marginFontSize);
  });
}

/**
 * P21: which pages start a run of their page type (`@page name:first`, as Paged.js reads it: the first page of each
 * run, not only the document's first). Blank pages are skipped when looking at the page before.
 */
export function firstsOfType(pages: readonly Pick<PageInfo, 'name' | 'blank'>[]): boolean[] {
  let previous: string | null = null;
  return pages.map((p) => {
    if (p.blank) return false;
    const first = previous === null || previous !== p.name;
    previous = p.name;
    return first;
  });
}

function sync(paper: HTMLElement, cls: string, boxes: RunningBoxes | null, info: PageInfo | undefined, side: 'top' | 'bottom', fontSize: string | undefined): void {
  let el = paper.querySelector<HTMLElement>(`:scope > .${cls}`);
  if (!boxes || !info) {
    el?.remove();
    return;
  }
  if (!el) {
    el = paper.ownerDocument.createElement('div');
    el.className = cls;
    for (const part of ['left', 'center', 'right']) {
      const box = paper.ownerDocument.createElement('span');
      box.dataset['box'] = part;
      el.append(box);
    }
    paper.append(el);
  }
  const g = info.geometry;
  const m = g.margins;
  el.style.left = `${m.left * PX_PER_MM}px`;
  el.style.width = `${(g.width - m.left - m.right) * PX_PER_MM}px`;
  el.style.height = `${m[side] * PX_PER_MM}px`;
  el.style[side] = '0';
  el.style[side === 'top' ? 'bottom' : 'top'] = '';
  el.style.fontSize = fontSize ?? '9pt';
  el.classList.toggle('pmd-running-span', boxes.span);
  for (const part of ['left', 'center', 'right'] as const) {
    const box = el.querySelector<HTMLElement>(`:scope > [data-box="${part}"]`)!;
    if (box.textContent !== boxes[part]) box.textContent = boxes[part];
  }
}

// ── P21: where the canvas and pagemd's PDF differ in page size (until C11) ──

/**
 * pagemd's PDF prints every page at the plain page's size today (Paged.js; research multi-file-layering 3.3), while the
 * canvas draws each page type as its layout says. The one switch to turn the note off when pagemd is fixed (C11 removes
 * it as one of its acceptance criteria).
 */
export const PDF_FLATTENS_PAGE_SIZES = true;

export const SIZE_TAG_CLASS = 'pmd-page-size-tag';

/** A page type in use whose drawn sheet differs in size from the plain page (the size pagemd's PDF prints it at). */
export interface PdfSizeNote {
  /** The page type, as LAYOUT wrote it. */
  name: string;
  drawn: { width: number; height: number };
  pdf: { width: number; height: number };
}

/**
 * The page types in use (on at least one drawn page) whose sheet is more than 0.5 mm wider or taller than the plain
 * page's: pagemd's PDF prints them at the plain page's size. A type that differs only in margins, or one the document
 * never uses, gives nothing. Empty while PDF_FLATTENS_PAGE_SIZES is off.
 */
export function pdfSizeNotes(pages: readonly Pick<PageInfo, 'name' | 'geometry'>[], page: Pick<PageGeometry, 'width' | 'height'>): PdfSizeNote[] {
  if (!PDF_FLATTENS_PAGE_SIZES) return [];
  const out = new Map<string, PdfSizeNote>();
  for (const p of pages) {
    if (!p.name || out.has(p.name)) continue;
    const g = p.geometry;
    if (Math.abs(g.width - page.width) > 0.5 || Math.abs(g.height - page.height) > 0.5) {
      out.set(p.name, { name: p.name, drawn: { width: g.width, height: g.height }, pdf: { width: page.width, height: page.height } });
    }
  }
  return [...out.values()];
}

/**
 * A sheet size in words: "8.5 × 11 in, portrait" when both sides are whole or half inches (within 0.5 mm), else
 * "210 × 297 mm, portrait". Plain measurements, no paper names (those are pagemd's to know).
 */
export function sizeLabel(size: { width: number; height: number }): string {
  const orientation = size.width > size.height + 0.5 ? 'landscape' : 'portrait';
  const inches = [size.width, size.height].map((mm) => mm / 25.4);
  const halfInches = inches.every((v) => Math.abs(v * 2 - Math.round(v * 2)) * 25.4 / 2 <= 0.5);
  const fmt = (v: number, digits: number) => String(Number(v.toFixed(digits)));
  const text = halfInches
    ? `${fmt(Math.round(inches[0]! * 2) / 2, 1)} × ${fmt(Math.round(inches[1]! * 2) / 2, 1)} in`
    : `${fmt(size.width, 0)} × ${fmt(size.height, 0)} mm`;
  return `${text}, ${orientation}`;
}

/**
 * The status bar's note for the page types drawn at another size than pagemd's PDF prints them (R-238), in plain
 * words, or '' for none. The status bar is a live region, so a screen reader hears it when it appears.
 */
export function sizeNoteText(notes: readonly PdfSizeNote[]): string {
  if (notes.length === 0) return '';
  const types = notes.map((n) => `"${n.name}" (${sizeLabel(n.drawn)})`).join(', ');
  const which = notes.length === 1 ? `Page type ${types} is` : `Page types ${types} are`;
  return `${which} drawn as your layout says; pagemd's PDF currently prints every page at the plain page's size (${sizeLabel(notes[0]!.pdf)}). This will change when pagemd is fixed.`;
}

/**
 * Print Layout only: a small tag in the grey gap above each sheet pagemd's PDF prints at another size ("PDF prints this
 * page at 8.5 × 11 in, portrait"). Outside the paper, never part of the document, not focusable, hidden from screen
 * readers (the status bar says it once, in words). `notes` empty (or another view) removes every tag.
 */
export function drawSizeTags(canvas: HTMLElement, pages: readonly Pick<PageInfo, 'name'>[], notes: readonly PdfSizeNote[]): void {
  const byName = new Map(notes.map((n) => [n.name, n]));
  papersOf(canvas).forEach((paper, i) => {
    const note = byName.get(pages[i]?.name ?? '');
    let tag = paper.querySelector<HTMLElement>(`:scope > .${SIZE_TAG_CLASS}`);
    if (!note) {
      tag?.remove();
      return;
    }
    if (!tag) {
      tag = paper.ownerDocument.createElement('div');
      tag.className = SIZE_TAG_CLASS;
      tag.setAttribute('aria-hidden', 'true');
      paper.append(tag);
    }
    const text = `PDF prints this page at ${sizeLabel(note.pdf)}`;
    if (tag.textContent !== text) tag.textContent = text;
  });
}

/** Structural CSS for the running text (editor UI; the font comes from the document's own CSS by inheritance). */
export const runningCss = `
.pmd-canvas .${HEADER_CLASS}, .pmd-canvas .${FOOTER_CLASS} { position: absolute; display: grid; grid-template-columns: 1fr auto 1fr;
  align-items: center; box-sizing: border-box; pointer-events: none; user-select: none; color: #444; line-height: 1.2; white-space: pre; overflow: hidden; }
.pmd-canvas .${HEADER_CLASS} > [data-box="left"], .pmd-canvas .${FOOTER_CLASS} > [data-box="left"] { text-align: left; }
.pmd-canvas .${HEADER_CLASS} > [data-box="center"], .pmd-canvas .${FOOTER_CLASS} > [data-box="center"] { text-align: center; }
.pmd-canvas .${HEADER_CLASS} > [data-box="right"], .pmd-canvas .${FOOTER_CLASS} > [data-box="right"] { text-align: right; }
.pmd-canvas .pmd-running-span { grid-template-columns: 1fr; }
.pmd-canvas .pmd-running-span > [data-box="left"], .pmd-canvas .pmd-running-span > [data-box="right"] { display: none; }
.pmd-canvas .${SIZE_TAG_CLASS} { position: absolute; left: 0; bottom: 100%; margin-bottom: 3px; font: 11px/1.2 var(--vscode-font-family, sans-serif);
  color: var(--vscode-descriptionForeground, #555); white-space: nowrap; pointer-events: none; user-select: none; }
`;
