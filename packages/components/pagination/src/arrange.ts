// Pages side by side (P6, amendment 11): one editable flow can't be split into columns by moving pages around, so the
// canvas becomes a CSS multi-column container as tall as one page (`column-height`), wrapping into rows of `columns`
// pages. The pagination keeps measuring the flow as one column (it is switched off for the measuring, `suspend()`),
// and its page gaps become column breaks: with `gap: 0` every page is exactly one page tall, so the browser's
// column fills line up with the pages. The paper moves to where its column is (`place()`).
import type { PageGeometry } from '@pagemd-editor/core';
import { papersOf } from './headers.ts';
import { PX_PER_MM, type PageInfo } from './paginator.ts';

/** The class the canvas carries while pages are in columns. */
export const COLUMNS_CLASS = 'pmd-columns';

export interface Placement {
  left: number;
  top: number;
}

/**
 * Where page `index` (0-based) lies, as papers: `columns` per row, each cell `cellHeight` px tall (a page's height, or
 * the tallest page's when one overflows), `rowGap` px between rows. Cells are as wide as the page.
 */
export function placement(index: number, columns: number, page: PageGeometry, rowGap: number, cellHeight = page.height * PX_PER_MM): Placement {
  return { left: (index % columns) * page.width * PX_PER_MM, top: Math.floor(index / columns) * (cellHeight + rowGap) };
}

/** The row height for `pages`: one page's height, or the tallest page's when one is taller (an overflowing block). */
export function cellHeightOf(page: PageGeometry, pages: ReadonlyArray<{ height: number; blank?: boolean }>): number {
  return pages.reduce((h, p) => Math.max(h, p.height), page.height * PX_PER_MM);
}

export class PageArranger {
  readonly #canvas: HTMLElement;
  readonly #flow: () => HTMLElement | null;
  #columns = 1;
  #page: PageGeometry | null = null;
  #rowGap = 24;
  /** The row height: a page's, or the tallest page's (columns are as tall as the tallest page, so an overflowing one still fits). */
  #cell = 0;
  #suspended = false;

  constructor(canvas: HTMLElement, flow: () => HTMLElement | null) {
    this.#canvas = canvas;
    this.#flow = flow;
  }

  get columns(): number {
    return this.#columns;
  }

  get rowGap(): number {
    return this.#rowGap;
  }

  /** The height of a row of pages, canvas px. */
  get cellHeight(): number {
    return this.#cell || (this.#page ? this.#page.height * PX_PER_MM : 0);
  }

  /** `columns` pages per row (1 = the usual vertical column) for pages of `page`'s size. Call after the pagination set its canvas size. */
  apply(columns: number, page: PageGeometry, rowGap = 24): void {
    this.#columns = Math.max(1, Math.floor(columns));
    this.#page = page;
    this.#rowGap = rowGap;
    this.#cell = page.height * PX_PER_MM;
    this.#style(true);
  }

  /** Not paged at all (Web Layout, Draft): forget the page and leave the canvas as the pagination leaves it. */
  release(): void {
    this.#columns = 1;
    this.#page = null;
    this.#suspended = false;
    this.#style(false);
  }

  /** Back to one column, for the measuring (the pagination measures the flow as one tall column). */
  suspend(): void {
    if (this.#columns === 1 || this.#suspended) return;
    this.#suspended = true;
    this.#style(false);
  }

  resume(): void {
    if (!this.#suspended) return;
    this.#suspended = false;
    this.#style(true);
  }

  /** Moves the papers (and so their headers and guides) to where their columns are. */
  place(pages: readonly PageInfo[]): void {
    const page = this.#page;
    if (page && this.#columns > 1) {
      const cell = cellHeightOf(page, pages);
      if (Math.abs(cell - this.#cell) > 0.01) {
        this.#cell = cell;
        this.#style(!this.#suspended);
      }
    }
    papersOf(this.#canvas).forEach((paper, i) => {
      if (this.#columns === 1 || !page) {
        paper.style.left = '0px';
        const info = pages[i];
        if (info) paper.style.top = `${info.top}px`;
        return;
      }
      const at = placement(i, this.#columns, page, this.#rowGap, this.#cell);
      paper.style.left = `${at.left}px`;
      paper.style.top = `${at.top}px`;
      paper.style.width = `${page.width * PX_PER_MM}px`;
      paper.style.height = `${pages[i]?.height ?? page.height * PX_PER_MM}px`;
    });
  }

  /** Where page `index` is now (canvas px, not zoomed): its paper's place. */
  topOf(index: number, pages: readonly PageInfo[]): number {
    if (this.#columns === 1 || !this.#page) return pages[index]?.top ?? 0;
    return placement(index, this.#columns, this.#page, this.#rowGap, this.#cell).top;
  }

  #style(on: boolean): void {
    const canvas = this.#canvas;
    const flow = this.#flow();
    const page = this.#page;
    const active = on && this.#columns > 1 && page !== null;
    canvas.classList.toggle(COLUMNS_CLASS, active);
    if (flow) {
      const props = ['column-count', 'column-gap', 'column-height', 'column-wrap', 'column-fill', 'row-gap'];
      if (!active || !page) for (const p of props) flow.style.removeProperty(p);
      else {
        const mm = (v: number) => `${v * PX_PER_MM}px`;
        flow.style.setProperty('column-count', String(this.#columns));
        flow.style.setProperty('column-gap', mm(page.margins.left + page.margins.right));
        flow.style.setProperty('column-height', `${this.#cell || page.height * PX_PER_MM}px`);
        flow.style.setProperty('column-wrap', 'wrap');
        flow.style.setProperty('column-fill', 'auto');
        flow.style.setProperty('row-gap', `${this.#rowGap}px`);
      }
    }
    if (!page) return;
    // The pagination sizes the canvas for one column; `columns` pages side by side need `columns` times that
    // (and the gaps between), one column again while measuring.
    const content = page.width - page.margins.left - page.margins.right;
    const gaps = (this.#columns - 1) * (page.margins.left + page.margins.right);
    canvas.style.setProperty('width', `${(active ? this.#columns * content + gaps : content) * PX_PER_MM}px`, 'important');
  }
}

/**
 * Structural CSS while in columns: the page gaps hold no height (a column break does the work: `break-after`), and
 * the frontmatter, which isn't part of any page (it would make page 1 taller than a column), is hidden by the app.
 */
export const arrangeCss = `
.pmd-canvas.${COLUMNS_CLASS} .pmd-page-gap { height: 0 !important; break-after: column; }
`;
