// Print Layout and Read around the pagination (P6, amendments 7, 9, 10, 11): everything drawn or decided per page
// that isn't the pagination's own measuring: the paper's running headers/footers and guides, pages side by side, the
// zoom and fit, the rulers, Read's one-page or spread window, and "Page N of M". Runs after every pagination run.
import type { Canvas } from '@pagemd-editor/canvas';
import type { PageGeometry, ResolvedStyles, ViewMode, ViewState } from '@pagemd-editor/core';
import {
  arrangeCss,
  columnsFor,
  drawRunning,
  drawSizeTags,
  PageArranger,
  PRINT_CLASS,
  papersOf,
  pdfSizeNotes,
  runningCss,
  zoomFor,
  type PageLayout,
  type PageSetup,
  type Pagination,
  type PaginationOptions,
  type PdfSizeNote,
} from '@pagemd-editor/pagination';
import { flipped, readViewCss, ReadView, windowOf, type Flip } from '@pagemd-editor/read-view';
import { drawGuides, Ruler, rulerCss } from '@pagemd-editor/ruler';

export const pagedViewCss = `${runningCss}${arrangeCss}${rulerCss}${readViewCss}
.pmd-canvas.pmd-print { transform-origin: top center; }
`;

/** Page 1 of a document with frontmatter (not part of any page) is hidden while pages are in columns or in Read. */
const HIDE_FRONTMATTER = 'pmd-hide-frontmatter';

export interface PagedViewOptions {
  scroller: HTMLElement;
  app: HTMLElement;
  canvas: Canvas;
  pagination: Pagination;
  /** The object given to the Pagination: `gap` is changed here (0 for pages in columns). */
  paginationOptions: PaginationOptions;
  /** P18: the element pages in columns arrange (the template frame's outermost element holding the text, or the text area). */
  flow?(): HTMLElement;
  view: ViewState;
  styles(): ResolvedStyles;
  setup(): PageSetup;
  /** True when the document has a pagemd profile to write a layout file for. */
  canCreateLayout(): boolean;
  /** How many top-level blocks the frontmatter makes. */
  frontmatterBlocks(): number;
  /** Sets the CSS that hides them (the app owns the style element). */
  hideFrontmatter(css: string): void;
  /** "Page N of M" for the status bar, or null when the view has no pages. */
  onPage(page: { current: number; total: number } | null): void;
  /** A margin drag ended with these margins. */
  onMarginChange(page: PageGeometry): void | Promise<void>;
  /**
   * P21: the page types in use that pagemd's PDF prints at another size than drawn (empty when none, or no pages), for
   * the status bar's note. Called after every pagination run and when the view leaves pages.
   */
  onSizeNotes?(notes: readonly PdfSizeNote[]): void;
}

export class PagedView {
  readonly #o: PagedViewOptions;
  readonly #arranger: PageArranger;
  readonly #ruler: Ruler;
  readonly #read: ReadView;
  #mode: ViewMode = 'print';
  #paged = false;
  #layout: PageLayout | null = null;
  #readIndex = 0;
  #frontmatter = -1;
  #frame = 0;

  constructor(options: PagedViewOptions) {
    this.#o = options;
    const o = options;
    this.#arranger = new PageArranger(o.canvas.element, () => o.flow?.() ?? (o.canvas.view.dom as HTMLElement));
    this.#ruler = new Ruler(o.app, o.scroller, { onChange: (page) => o.onMarginChange(page) });
    this.#read = new ReadView(o.scroller, o.canvas.element, { onFlip: (flip) => this.flip(flip) });

    // The pagination measures the flow as one tall column: while it does, pages in columns are put back in one.
    const run = o.pagination.run.bind(o.pagination);
    o.pagination.run = (runOptions) => {
      this.#syncFrontmatter();
      this.#arranger.suspend();
      let layout: PageLayout | null = null;
      try {
        layout = run(runOptions);
      } finally {
        this.#arranger.resume();
      }
      if (layout) this.#afterLayout(layout);
      return layout;
    };

    o.view.onChange(() => this.refresh());
    o.scroller.addEventListener('scroll', () => this.#soon());
    const Resize = o.scroller.ownerDocument.defaultView?.ResizeObserver;
    if (Resize) new Resize(() => this.#soon(true)).observe(o.scroller);
  }

  /** The last page layout (null when the view isn't paged or nothing is measured yet). */
  get layout(): PageLayout | null {
    return this.#layout;
  }

  get readIndex(): number {
    return this.#readIndex;
  }

  get columns(): number {
    return this.#arranger.columns;
  }

  /** The view (or the document's styles) changed: set everything up again for `mode`. */
  setMode(mode: ViewMode, paged: boolean, editable: boolean): void {
    this.#mode = mode;
    this.#paged = paged;
    this.#o.canvas.setEditable(editable);
    this.refresh();
  }

  /** The styles changed (page geometry, headers): lay out again. */
  restyle(): void {
    if (!this.#paged) return;
    this.#apply();
  }

  /** The view state changed (zoom, fit, arrangement, ruler): apply it, with a new layout when the page arrangement did. */
  refresh(): void {
    this.#apply();
  }

  flip(flip: Flip): void {
    const total = this.#layout?.pages.length ?? 0;
    this.#readIndex = flipped(this.#readIndex, flip, total, this.#columns() > 1);
    this.#showRead();
    this.#chrome();
  }

  /** Read (P9): show the page (or spread) holding document position `pos`, e.g. an Outline entry; elsewhere nothing to do. */
  showPos(pos: number): void {
    const pages = this.#layout?.pages;
    if (this.#mode !== 'read' || !pages || pages.length === 0) return;
    let index = 0;
    pages.forEach((page, i) => {
      if (page.pos !== null && page.pos <= pos) index = i;
    });
    this.#readIndex = index;
    this.#showRead();
    this.#chrome();
  }

  // ── the settings that follow from the view state ──

  #fit(): 'none' | 'one-page' | 'multi-page' | 'page-width' {
    const fit = this.#o.view.value.fit;
    return this.#mode === 'read' && fit === 'none' ? 'one-page' : fit;
  }

  #columns(): number {
    const v = this.#o.view.value;
    return this.#paged ? columnsFor(v.pageArrangement, this.#fit()) : 1;
  }

  #apply(): void {
    const o = this.#o;
    const canvas = o.canvas.element;
    if (!this.#paged) {
      o.pagination.disable();
      this.#arranger.release();
      this.#read.leave();
      this.#ruler.show(false);
      this.#layout = null;
      canvas.classList.remove(PRINT_CLASS, HIDE_FRONTMATTER);
      canvas.style.removeProperty('zoom');
      drawRunning(canvas, [], null);
      drawSizeTags(canvas, [], []);
      drawGuides(papersOf(canvas), [], false);
      o.onPage(null);
      o.onSizeNotes?.([]);
      return;
    }
    const columns = this.#columns();
    const reading = this.#mode === 'read';
    const gap = columns > 1 || reading ? 0 : 24;
    const setup = o.setup();
    o.paginationOptions.gap = gap;
    canvas.classList.add(PRINT_CLASS);
    canvas.classList.toggle(HIDE_FRONTMATTER, reading || columns > 1);
    // (Re)start the pagination (it resets what it sized), then size the canvas for the arrangement.
    o.pagination.enable(setup);
    this.#arranger.apply(columns, setup.page, 24);
    if (reading) this.#read.enter();
    else this.#read.leave();
    this.#ruler.show(!reading && o.view.value.panels.ruler);
    this.#zoom();
    this.#chrome();
  }

  /** Applies the zoom (or what the fit works out to) to the canvas. */
  #zoom(): number {
    const o = this.#o;
    const scroller = o.scroller;
    const reading = this.#mode === 'read';
    const padding = reading ? 24 : 0;
    const z = zoomFor(this.#fit(), o.view.value.zoom, { width: Math.max(1, scroller.clientWidth), height: Math.max(1, scroller.clientHeight - padding) }, o.setup().page, this.#columns());
    o.canvas.element.style.setProperty('zoom', z === 1 ? '' : String(z));
    return z;
  }

  #syncFrontmatter(): void {
    const count = this.#o.frontmatterBlocks();
    if (count === this.#frontmatter) return;
    this.#frontmatter = count;
    this.#o.hideFrontmatter(count > 0 ? `.pmd-canvas.${HIDE_FRONTMATTER} .ProseMirror > :nth-child(-n+${count}) { display: none !important; }` : '');
  }

  // ── after each pagination run ──

  #afterLayout(layout: PageLayout): void {
    this.#layout = layout;
    const o = this.#o;
    const canvas = o.canvas.element;
    this.#arranger.place(layout.pages);
    drawRunning(canvas, layout.pages, this.#mode === 'draft' ? null : o.styles());
    // P21: where pagemd's PDF prints a page type at the plain page's size: a note (Print Layout and Read) and, in Print
    // Layout only, a tag above each such sheet
    const sizeNotes = this.#mode === 'draft' ? [] : pdfSizeNotes(layout.pages, o.styles().page);
    drawSizeTags(canvas, layout.pages, this.#mode === 'print' ? sizeNotes : []);
    o.onSizeNotes?.(sizeNotes);
    const guides = this.#mode === 'print' && o.view.value.panels.ruler;
    drawGuides(papersOf(canvas), layout.pages.map((p) => p.geometry), guides);
    if (this.#mode === 'read') {
      this.#readIndex = windowOf(this.#readIndex, layout.pages.length, this.#columns() > 1).first;
      this.#showRead();
    }
    this.#zoom();
    this.#chrome();
  }

  #showRead(): void {
    const layout = this.#layout;
    if (!layout || layout.pages.length === 0) return;
    const spread = this.#columns() > 1;
    const { first, last } = windowOf(this.#readIndex, layout.pages.length, spread);
    const top = this.#arranger.topOf(first, layout.pages);
    const height = spread ? this.#arranger.cellHeight : layout.pages.slice(first, last + 1).reduce((h, p) => Math.max(h, p.height), 0);
    this.#read.show(top, height);
  }

  #soon(refit = false): void {
    const win = this.#o.scroller.ownerDocument.defaultView;
    if (!win || this.#frame) return;
    this.#frame = win.requestAnimationFrame(() => {
      this.#frame = 0;
      if (refit && this.#paged) {
        this.#zoom();
        this.#showRead();
      }
      this.#chrome();
    });
  }

  /** "Page N of M" and the rulers, from where the papers are on screen now. */
  #chrome(): void {
    const layout = this.#layout;
    const o = this.#o;
    if (!this.#paged || !layout || layout.pages.length === 0) {
      o.onPage(this.#paged ? { current: 1, total: 1 } : null);
      this.#ruler.update(null);
      return;
    }
    const papers = papersOf(o.canvas.element);
    const total = layout.pages.length;
    let current = this.#mode === 'read' ? windowOf(this.#readIndex, total, this.#columns() > 1).first : 0;
    if (this.#mode !== 'read') {
      const top = o.scroller.getBoundingClientRect().top;
      for (let i = 0; i < papers.length; i++) {
        current = i;
        if (papers[i]!.getBoundingClientRect().bottom > top + 8) break;
      }
    }
    o.onPage({ current: current + 1, total });
    const paper = papers[current];
    const info = layout.pages[current];
    if (!paper || !info || this.#mode === 'read') {
      this.#ruler.update(null);
      return;
    }
    const r = paper.getBoundingClientRect();
    this.#ruler.update({ rect: { left: r.left, top: r.top, width: r.width, height: r.height }, geometry: info.geometry, draggable: info.name === '' && o.canCreateLayout() });
  }
}
