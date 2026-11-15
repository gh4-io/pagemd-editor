// Print Layout's pages (P6, amendment 6): a ProseMirror plugin that measures the canvas after each change (once
// the keystroke has been painted), lays the flow out on pages (layout.ts) and draws the result: paper behind the
// text (a layer outside the editable content) and gaps between pages (widget decorations: a block gap before the
// first element of a page, or a line gap inside a paragraph that splits). The text column is the page's content
// width, so lines wrap where pagemd's PDF wraps them.
import { isTransparent, type PageGeometry } from '@pagemd-editor/core';
import type { Node, Slice } from 'prosemirror-model';
import { Plugin, PluginKey, type EditorState, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import { layoutPages, type Page } from './layout.ts';
import { canvasElementOf, GAP_CLASS, Measurer, type FramePiecesOf, type MarkerOf, type MeasuredLeaf, type MeasuredLine, type Measurement } from './measure.ts';

/** CSS px per millimetre (96 px per inch). */
export const PX_PER_MM = 96 / 25.4;
/** The class the paged canvas carries (paginationCss). */
export const PAGED_CLASS = 'pmd-paged';
/** The class on marker nodes (PAGEBREAK, SECTION, COVER, LAYOUT chips): they take no room in Print Layout. */
export const MARKER_CLASS = 'pmd-page-marker';
/** P18: a page gap drawn in the template frame (before a piece of the frame), outside the text area. */
export const FRAME_GAP_CLASS = 'pmd-frame-gap';

/**
 * FIX-PGF: the meta of a transaction that brings in the text read again after an outside change (the canvas's `patchDocument`
 * sets it: the same string as the canvas's OUTSIDE_META; a test checks both say the same).
 */
export const OUTSIDE_CHANGE_META = 'pmd-outside-change';

export interface PageSetup {
  page: PageGeometry;
  namedPages?: Record<string, PageGeometry>;
  /** `:::STRING(name)` sources: name → selector (ResolvedStyles.strings). */
  strings?: Record<string, string>;
}

/** One page as drawn, for headers/footers, the status bar ("page N of M") and Read view. */
export interface PageInfo {
  /** 1-based. */
  number: number;
  name: string;
  blank: boolean;
  overflow: boolean;
  geometry: PageGeometry;
  /** Canvas px (not zoomed): where the paper is. */
  top: number;
  height: number;
  width: number;
  /** The named strings' values on this page (the first set on it, else the one carried from before). */
  strings: Record<string, string>;
  /** The document position the page's content starts at (null for a blank page). */
  pos: number | null;
  /** P18: the page holds part of the document's text (not only the template frame's parts, nor nothing). */
  body: boolean;
}

export interface PageLayout {
  pages: PageInfo[];
  /** How long the last run took (measure + layout + draw), ms. */
  ms: number;
}

export interface PaginationOptions {
  /** The app's preset describes its page markers (pagemd's PAGEBREAK, SECTION, COVER, LAYOUT, the frontmatter). */
  markerOf?: MarkerOf;
  /** Called after every run. */
  onLayout?(layout: PageLayout): void;
  /** px between pages (default 24); 0 for pages laid side by side in columns. */
  gap?: number;
  /** P18: the template frame's parts around the text area (components/template-frame), measured as part of the flow. */
  frame?: FramePiecesOf;
}

interface PluginStateValue {
  enabled: boolean;
  setup: PageSetup | null;
  /** Widgets (page gaps) from the last run. */
  gaps: DecorationSet;
  /** Node decorations that follow from the document alone (markers, named-page widths). */
  structure: DecorationSet;
  /** Both together, as the editor view gets them: kept (and moved with the text) so it is not built again for every keystroke (P13b). */
  all: DecorationSet;
}

type Meta = { enabled: boolean; setup: PageSetup | null } | { gaps: DecorationSet };

const key = new PluginKey<PluginStateValue>('pmd-pagination');

/** Pagination for one canvas: `plugin` goes into the canvas's plugins; enable()/disable() follow the view. */
export class Pagination {
  readonly plugin: Plugin<PluginStateValue>;
  readonly #options: PaginationOptions;
  #view: EditorView | null = null;
  #measurer: Measurer | null = null;
  #layer: HTMLElement | null = null;
  #scheduled = false;
  #followUps = 0;
  #layout: PageLayout | null = null;
  #measurement: Measurement | null = null;
  /** Page start positions of the last layout, mapped through every change since (for the incremental re-measure). */
  #pageStarts: number[] = [];
  /** The lowest position changed since the last run, mapped forward; null when nothing changed. */
  #dirtyFrom: number | null = null;
  #listeners: Array<() => void> = [];
  /**
   * Pages on or off, and with which setup: the view's choice (enable / disable), kept here as well as in the editor state. The
   * canvas makes a brand-new editor state whenever it reads the document again (VS Code's undo and redo, any outside change);
   * that state starts from this, so the pages stay (fix run undo-bg-table-split: before, a new state started with the pages
   * off, and only a view switch, which calls enable() again, brought the paper back).
   */
  #mode: { enabled: boolean; setup: PageSetup | null } = { enabled: false, setup: null };

  constructor(options: PaginationOptions = {}) {
    this.#options = options;
    const markerOf = options.markerOf ?? (() => null);
    this.plugin = new Plugin<PluginStateValue>({
      key,
      state: {
        init: (_config, state) => {
          const { enabled, setup } = this.#mode;
          const structure = enabled && setup ? structureDecorations(state.doc, setup, markerOf) : DecorationSet.empty;
          return { enabled, setup, gaps: DecorationSet.empty, structure, all: structure };
        },
        apply: (tr, value, _old, state) => {
          this.mapPageStarts(tr);
          // FIX-PGF (item 3): the text read again after an outside change (VS Code's undo, another program), patched into the same
          // state: measured whole again, as a new state was before (the reuse of the pages before the change is for typing), while
          // the pages drawn now stay on screen until the new layout replaces them.
          if (tr.docChanged && tr.getMeta(OUTSIDE_CHANGE_META)) this.#measurement = null;
          return applyTransaction(tr, value, state, markerOf);
        },
      },
      props: {
        decorations: (state) => {
          const value = key.getState(state);
          if (!value?.enabled) return null;
          return value.all;
        },
      },
      view: (view) => {
        this.#attach(view, markerOf);
        // A new editor state (the document read again) builds this view again: lay the pages out for it (nothing measured
        // before belongs to the new document).
        if (this.#mode.enabled && this.#mode.setup) {
          this.#measurer!.reset(Object.keys(this.#mode.setup.namedPages ?? {}));
          this.#measurement = null;
          this.#pageStarts = [];
          this.#dirtyFrom = null;
          this.schedule();
        }
        return {
          update: (v, prev) => {
            const now = key.getState(v.state);
            if (!now?.enabled) return;
            if (v.state.doc !== prev.doc || now.setup !== key.getState(prev)?.setup || !key.getState(prev)?.enabled) this.schedule();
          },
          destroy: () => this.#detach(),
        };
      },
    });
  }

  /** The last layout, or null before the first run (or while disabled). */
  get layout(): PageLayout | null {
    return this.#layout;
  }

  /** The last measurement (tests). */
  get measurement(): Measurement | null {
    return this.#measurement;
  }

  get enabled(): boolean {
    return this.#view ? (key.getState(this.#view.state)?.enabled ?? false) : false;
  }

  /** Shows pages with `setup` (Print Layout, Read). */
  enable(setup: PageSetup): void {
    this.#dispatch({ enabled: true, setup });
  }

  /** The styles changed (geometry, CSS): forget what was read from CSS and lay out again. */
  setSetup(setup: PageSetup): void {
    if (!this.enabled) return;
    this.#dispatch({ enabled: true, setup });
  }

  /** Back to one continuous column (Web Layout, Draft). */
  disable(): void {
    this.#dispatch({ enabled: false, setup: null });
  }

  /** Lays out again after the browser paints (an image or font finished loading, D17). */
  schedule(): void {
    if (this.#scheduled || !this.#view) return;
    this.#scheduled = true;
    const win = this.#view.dom.ownerDocument.defaultView ?? globalThis;
    // After the frame that shows the keystroke: requestAnimationFrame, then a task.
    win.requestAnimationFrame(() => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        this.#scheduled = false;
        this.run();
      };
      channel.port2.postMessage(null);
    });
  }

  /**
   * Measures, lays out and draws now (tests and benchmarks call this directly). `full`: measure the whole document
   * again instead of only from the edited page on.
   */
  run(options: { full?: boolean } = {}): PageLayout | null {
    const view = this.#view;
    const measurer = this.#measurer;
    const state = view ? key.getState(view.state) : undefined;
    if (!view || !measurer || !state?.enabled || !state.setup) return null;
    const started = performance.now();
    const setup = state.setup;
    const geometry = (name: string): PageGeometry => (name && setup.namedPages?.[name]) || setup.page;
    const contentHeight = (name: string) => px(geometry(name).height - geometry(name).margins.top - geometry(name).margins.bottom);

    const gapElements = new Set<HTMLElement>([...canvasOf(view).querySelectorAll<HTMLElement>(`.${GAP_CLASS}`)]);
    // Incremental (amendment 6): what lies before the page the edit is on was measured last time and hasn't moved.
    const reuse = options.full ? null : this.#reuseFrom();
    const measurement = measurer.measure(gapElements, (el) => Number(el.dataset['h'] ?? 0), reuse ?? undefined);
    this.#measurement = measurement;
    this.#dirtyFrom = null;
    const pages = layoutPages(measurement.leaves, contentHeight);
    const drawn = this.#draw(view, measurer, measurement, pages, geometry, setup);
    const ms = performance.now() - started;
    this.#layout = { pages: drawn.pages, ms };
    this.#pageStarts = drawn.pages.filter((p) => p.pos !== null).map((p) => p.pos!);
    if (drawn.estimated && this.#followUps < 2) {
      this.#followUps++;
      this.schedule(); // a gap's margins were estimated: measure once more to place it exactly
    } else this.#followUps = 0;
    this.#options.onLayout?.(this.#layout);
    return this.#layout;
  }

  /** The last measurement and where the first page touched since then starts, or null to measure everything. */
  #reuseFrom(): { measurement: Measurement; before: number } | null {
    const dirty = this.#dirtyFrom;
    if (!this.#measurement || dirty === null || this.#pageStarts.length < 2) return null;
    let before = 0;
    for (const start of this.#pageStarts) if (start <= dirty) before = start;
    return before > 0 ? { measurement: this.#measurement, before } : null;
  }

  /** Keeps the page starts in step with the document (called from the plugin for every change). */
  mapPageStarts(tr: Transaction): void {
    if (!tr.docChanged) return;
    if (this.#pageStarts.length > 0) this.#pageStarts = this.#pageStarts.map((p) => tr.mapping.map(p, -1));
    let from: number | null = this.#dirtyFrom === null ? null : tr.mapping.map(this.#dirtyFrom, -1);
    tr.mapping.maps.forEach((map) => map.forEach((_a, _b, newStart) => (from = from === null ? newStart : Math.min(from, newStart))));
    this.#dirtyFrom = from;
  }

  #attach(view: EditorView, markerOf: MarkerOf): void {
    this.#view = view;
    this.#measurer = new Measurer(view, markerOf, () => this.#options.frame?.() ?? null); // (read each run: the app sets it later)
    const onAsset = () => {
      if (this.enabled) this.schedule();
    };
    // D17: images change size when they load (or fail); fonts change every line.
    view.dom.addEventListener('load', onAsset, true);
    view.dom.addEventListener('error', onAsset, true);
    const fonts = view.dom.ownerDocument.fonts;
    fonts?.addEventListener?.('loadingdone', onAsset);
    void fonts?.ready?.then(onAsset);
    this.#listeners.push(
      () => view.dom.removeEventListener('load', onAsset, true),
      () => view.dom.removeEventListener('error', onAsset, true),
      () => fonts?.removeEventListener?.('loadingdone', onAsset),
    );
  }

  #detach(): void {
    for (const off of this.#listeners.splice(0)) off();
    this.#layer?.remove();
    this.#layer = null;
    this.#view = null;
    this.#measurer = null;
  }

  #dispatch(meta: Meta): void {
    if ('enabled' in meta) this.#mode = { enabled: meta.enabled, setup: meta.setup };
    const view = this.#view;
    if (!view) return;
    if ('enabled' in meta) {
      const canvas = canvasOf(view);
      if (meta.enabled && meta.setup) {
        this.#measurer?.reset(Object.keys(meta.setup.namedPages ?? {}));
        styleCanvas(canvas, meta.setup.page, true);
      } else {
        styleCanvas(canvas, null, false);
        this.#layer?.remove();
        this.#layer = null;
        this.#layout = null;
      }
      this.#measurement = null;
      this.#pageStarts = [];
      this.#dirtyFrom = null;
    }
    view.dispatch(view.state.tr.setMeta(key, meta).setMeta('addToHistory', false));
  }

  /** Works out every page's place on the canvas and the gaps that put the text there; draws both. */
  #draw(
    view: EditorView,
    measurer: Measurer,
    m: Measurement,
    pages: Page[],
    geometry: (name: string) => PageGeometry,
    setup: PageSetup,
  ): { pages: PageInfo[]; estimated: boolean } {
    const gapPx = this.#options.gap ?? 24;
    const infos: PageInfo[] = [];
    const widgets: Decoration[] = [];
    const frameGaps: Array<{ before: HTMLElement; height: number }> = [];
    let estimated = false;
    let pageTop = 0;
    // real = natural + offset[k] for page k's content
    let prevOffset = m.firstOffset;
    for (let k = 0; k < pages.length; k++) {
      const page = pages[k]!;
      const g = geometry(page.name);
      const height = px(g.height);
      const contentH = px(g.height - g.margins.top - g.margins.bottom);
      let contentTop = pageTop + px(g.margins.top);
      if (k === 0) contentTop = m.firstOffset + page.start; // page 1: below any excluded nodes
      const offset = contentTop - page.start;
      let bottom = pageTop + height;
      if (!page.blank) {
        const contentEnd = page.end + offset;
        bottom = Math.max(contentTop + contentH, contentEnd) + px(g.margins.bottom);
        if (k > 0 && page.first) {
          const leaf = m.leaves[page.first.leaf]!;
          const step = offset - prevOffset;
          if (page.first.line === 0) {
            const previous = m.leaves[page.first.leaf - 1];
            const excess = measurer.excess(leaf, previous);
            estimated ||= excess.estimated;
            const h = Math.max(0, leaf.naturalGap + step - excess.value);
            if (leaf.frame) frameGaps.push({ before: leaf.outer, height: h });
            else widgets.push(gapWidget(leaf.breakPos, h, false));
          } else {
            const line = (leaf.lines?.() as MeasuredLine[] | undefined)?.[page.first.line];
            const pos = line ? linePos(view, leaf, line) : null;
            if (pos !== null) widgets.push(gapWidget(pos, Math.max(0, step), true));
          }
        }
        prevOffset = offset;
      }
      infos.push({
        number: k + 1,
        name: page.name,
        blank: page.blank,
        // Page 1 grows by what the excluded nodes (the frontmatter) take; that isn't an overflow.
        overflow: page.overflow || bottom - pageTop > height + (k === 0 ? m.excludedHeight : 0) + 0.5,
        geometry: g,
        top: pageTop,
        height: bottom - pageTop,
        width: px(g.width),
        strings: {},
        pos: page.first ? startPos(m.leaves, page.first) : null,
        body: holdsText(m.leaves, page, pages[k + 1]),
      });
      pageTop = bottom + gapPx;
    }

    // Draw: paper first (outside ProseMirror), the frame's gaps (P18, outside ProseMirror too), then the gaps (decorations).
    this.#drawPaper(view, infos);
    drawFrameGaps(canvasOf(view), frameGaps);
    const gaps = DecorationSet.create(view.state.doc, widgets);
    const current = key.getState(view.state)?.gaps ?? DecorationSet.empty;
    if (!sameGaps(current, gaps)) view.dispatch(view.state.tr.setMeta(key, { gaps }).setMeta('addToHistory', false));
    if (setup.strings && Object.keys(setup.strings).length > 0) fillStrings(view, infos, setup.strings, m.scale);
    canvasOf(view).dataset['pmdPages'] = String(infos.length);
    return { pages: infos, estimated };
  }

  #drawPaper(view: EditorView, infos: PageInfo[]): void {
    const canvas = canvasOf(view);
    if (!this.#layer || !this.#layer.isConnected) {
      this.#layer = canvas.ownerDocument.createElement('div');
      this.#layer.className = 'pmd-pages';
      this.#layer.setAttribute('aria-hidden', 'true');
      canvas.prepend(this.#layer);
    }
    const layer = this.#layer;
    while (layer.childElementCount > infos.length) layer.lastElementChild!.remove();
    infos.forEach((info, i) => {
      let paper = layer.children[i] as HTMLElement | undefined;
      if (!paper) {
        paper = canvas.ownerDocument.createElement('div');
        paper.className = 'pmd-page';
        layer.append(paper);
      }
      paper.style.top = `${info.top}px`;
      paper.style.height = `${info.height}px`;
      paper.style.width = `${info.width}px`;
      paper.classList.toggle('pmd-page-blank', info.blank);
      paper.classList.toggle('pmd-page-overflow', info.overflow);
      paper.dataset['page'] = String(info.number);
    });
  }
}

// ── plugin state ──

function applyTransaction(tr: Transaction, value: PluginStateValue, state: EditorState, markerOf: MarkerOf): PluginStateValue {
  const meta = tr.getMeta(key) as Meta | undefined;
  if (meta && 'enabled' in meta) {
    const structure = meta.enabled && meta.setup ? structureDecorations(state.doc, meta.setup, markerOf) : DecorationSet.empty;
    return { ...value, enabled: meta.enabled, setup: meta.setup, gaps: DecorationSet.empty, structure, all: structure };
  }
  if (meta && 'gaps' in meta) return { ...value, gaps: meta.gaps, all: together(state.doc, value.structure, meta.gaps) };
  if (!tr.docChanged || !value.enabled) return value;
  const gaps = value.gaps.map(tr.mapping, tr.doc);
  // Typing inside a paragraph cannot change what the structure decorations say: they follow the markers and the named pages between
  // blocks, so they are moved with the text and not worked out again by walking the whole document (P13b: that walk, and building
  // the view's decorations again from both sets, were the costs per keystroke that grew with the page count).
  if (value.setup && staysInsideTextblocks(tr, markerOf)) return { ...value, gaps, structure: value.structure.map(tr.mapping, tr.doc), all: value.all.map(tr.mapping, tr.doc) };
  const structure = value.setup ? structureDecorations(state.doc, value.setup, markerOf) : DecorationSet.empty;
  return { ...value, gaps, structure, all: together(state.doc, structure, gaps) };
}

/** The page gaps and the structure decorations as one set (what the view draws). */
function together(doc: Node, structure: DecorationSet, gaps: DecorationSet): DecorationSet {
  return gaps === DecorationSet.empty ? structure : DecorationSet.create(doc, [...structure.find(), ...gaps.find()]);
}

/**
 * Whether every step of `tr` only changes the inline content of one textblock (typing, deleting inside a paragraph, a mark added)
 * and none of the textblocks touched is a marker: then no block was added, removed, split or joined, so the structure
 * decorations are the same decorations at moved positions. Anything else (a step this does not know, an open slice, a marker)
 * answers false and the caller works the decorations out from the document.
 */
export function staysInsideTextblocks(tr: Transaction, markerOf: MarkerOf): boolean {
  if (tr.steps.length === 0) return false;
  for (let i = 0; i < tr.steps.length; i++) {
    const step = tr.steps[i] as unknown as { from?: number; to?: number; slice?: Slice; gapFrom?: number; mark?: unknown };
    if (typeof step.from !== 'number' || typeof step.to !== 'number') return false;
    const before = tr.docs[i]!;
    if (step.from > before.content.size || step.to > before.content.size) return false;
    const $from = before.resolve(step.from);
    if (!$from.parent.isTextblock || !$from.sameParent(before.resolve(step.to))) return false;
    if (step.slice) {
      if (step.gapFrom !== undefined) return false; // a ReplaceAroundStep wraps or unwraps
      if (step.slice.openStart !== 0 || step.slice.openEnd !== 0) return false;
      for (let c = 0; c < step.slice.content.childCount; c++) if (!step.slice.content.child(c).isInline) return false;
    } else if (!step.mark) return false; // not a replace and not a mark: unknown
    const pos = $from.before();
    if (markerOf($from.parent, pos, before)) return false;
    const after = i + 1 < tr.docs.length ? tr.docs[i + 1]! : tr.doc;
    const mapped = tr.mapping.slice(i, i + 1).map(pos, -1);
    const node = after.nodeAt(mapped);
    if (!node || !node.isTextblock || markerOf(node, mapped, after)) return false;
  }
  return true;
}

/**
 * Decorations that follow from the document alone: marker chips take no room (MARKER_CLASS), and the top-level
 * blocks on a named page whose content area is wider or narrower (LAYOUT(landscape)) get that width.
 */
export function structureDecorations(doc: Node, setup: PageSetup, markerOf: MarkerOf): DecorationSet {
  const decorations: Decoration[] = [];
  const base = setup.page;
  let named: PageGeometry | null = null;
  const walk = (parent: Node, start: number) =>
    parent.forEach((node, offset) => {
      const pos = start + offset;
      const marker = markerOf(node, pos, doc);
      if (marker && marker.kind !== 'excluded') {
        decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: MARKER_CLASS }));
        if (marker.kind === 'layout') {
          const g = setup.namedPages?.[marker.name];
          named = g && contentWidth(g) !== contentWidth(base) ? g : null;
        }
        return;
      }
      if (parent === doc && named) {
        const g: PageGeometry = named;
        decorations.push(
          Decoration.node(pos, pos + node.nodeSize, { style: `width: ${px(contentWidth(g))}px; position: relative; left: ${px(g.margins.left - base.margins.left)}px;` }),
        );
      }
      // (P18: and into the boxes around sections, transparent groups, so their markers take no room either)
      if (node.isBlock && !node.isTextblock && !node.isAtom && (parent === doc || isTransparent(parent))) walk(node, pos + 1);
    });
  walk(doc, 0);
  return DecorationSet.create(doc, decorations);
}

// ── drawing helpers ──

function px(mm: number): number {
  return mm * PX_PER_MM;
}

function contentWidth(g: PageGeometry): number {
  return g.width - g.margins.left - g.margins.right;
}

function canvasOf(view: EditorView): HTMLElement {
  return canvasElementOf(view.dom as HTMLElement);
}

/**
 * The document position a page starts at: its first leaf's (or, inside a split paragraph, that leaf's own). A page that starts
 * with a piece of the template frame (P18) starts, as far as the document goes, where the text next begins (the end for the
 * pieces after the text).
 */
function startPos(leaves: readonly MeasuredLeaf[], first: { leaf: number; line: number }): number {
  const leaf = leaves[first.leaf]!;
  if (!leaf.frame) return first.line === 0 ? leaf.breakPos : leaf.pos;
  for (let i = first.leaf + 1; i < leaves.length; i++) if (!leaves[i]!.frame) return leaves[i]!.breakPos;
  return leaf.breakPos;
}

/** Whether a page holds at least one leaf of the text area (P18: not only pieces of the template frame). */
function holdsText(leaves: readonly MeasuredLeaf[], page: Page, next: Page | undefined): boolean {
  if (!page.first) return false;
  const end = next?.first ? next.first.leaf + (next.first.line > 0 ? 1 : 0) : leaves.length;
  for (let i = page.first.leaf; i < end; i++) if (!leaves[i]!.frame) return true;
  return false;
}

/**
 * P18: page gaps before pieces of the template frame are spacers in the frame itself (it isn't ProseMirror's, so no decoration
 * is needed): each piece that starts a page gets one, sized like a decoration gap; spacers no longer needed go.
 */
function drawFrameGaps(canvas: HTMLElement, gaps: ReadonlyArray<{ before: HTMLElement; height: number }>): void {
  const wanted = new Map(gaps.map((g) => [g.before, Math.round(g.height * 100) / 100]));
  for (const old of [...canvas.querySelectorAll<HTMLElement>(`.${FRAME_GAP_CLASS}`)]) {
    const next = old.nextElementSibling as HTMLElement | null;
    if (!next || !wanted.has(next) || Number(old.dataset['h']) !== wanted.get(next)) old.remove();
    else wanted.delete(next);
  }
  for (const [before, h] of wanted) {
    const el = canvas.ownerDocument.createElement('div');
    el.className = `${GAP_CLASS} ${FRAME_GAP_CLASS}`;
    el.contentEditable = 'false';
    el.setAttribute('aria-hidden', 'true');
    el.style.height = `${h}px`;
    el.dataset['h'] = String(h);
    before.before(el);
  }
}

/** The canvas as a page: the text column is the content width, the paper's margins are padding. */
function styleCanvas(canvas: HTMLElement, page: PageGeometry | null, on: boolean): void {
  canvas.classList.toggle(PAGED_CLASS, on);
  const props = ['width', 'max-width', 'min-width', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'margin-left', 'margin-right', 'box-sizing'];
  if (!on || !page) {
    for (const p of props) canvas.style.removeProperty(p);
    delete canvas.dataset['pmdPages'];
    return;
  }
  const set = (p: string, v: string) => canvas.style.setProperty(p, v, 'important');
  set('box-sizing', 'content-box');
  set('width', `${px(contentWidth(page))}px`);
  set('max-width', 'none');
  set('min-width', '0');
  set('padding-top', `${px(page.margins.top)}px`);
  set('padding-right', `${px(page.margins.right)}px`);
  set('padding-bottom', `${px(page.margins.bottom)}px`);
  set('padding-left', `${px(page.margins.left)}px`);
  set('margin-left', 'auto');
  set('margin-right', 'auto');
}

function gapWidget(pos: number, height: number, inline: boolean): Decoration {
  const h = Math.round(height * 100) / 100;
  return Decoration.widget(
    pos,
    (view) => {
      const el = view.dom.ownerDocument.createElement(inline ? 'span' : 'div');
      el.className = GAP_CLASS;
      el.contentEditable = 'false';
      el.setAttribute('aria-hidden', 'true');
      el.style.height = `${h}px`;
      el.dataset['h'] = String(h);
      return el;
    },
    { side: -1, key: `${inline ? 'l' : 'b'}${h}`, ignoreSelection: true, marks: [] },
  );
}

/** The document position at the start of a line (its first glyph), inside `leaf`'s content, or null. */
function linePos(view: EditorView, leaf: MeasuredLeaf, line: MeasuredLine): number | null {
  const found = view.posAtCoords({ left: line.clientX, top: line.clientY });
  if (!found) return null;
  const start = leaf.pos + 1;
  const end = leaf.pos + leaf.node.nodeSize - 1;
  return found.pos > start && found.pos < end ? found.pos : null;
}

function sameGaps(a: DecorationSet, b: DecorationSet): boolean {
  const sig = (set: DecorationSet) =>
    set
      .find()
      .map((d) => `${d.from}:${(d.spec as { key?: string }).key}`)
      .join(',');
  return sig(a) === sig(b);
}

/** `:::STRING(name)` values per page: the first element on the page that sets it, else the one carried over. */
function fillStrings(view: EditorView, infos: PageInfo[], strings: Record<string, string>, scale: number): void {
  const canvas = canvasOf(view);
  const canvasTop = canvas.getBoundingClientRect().top;
  const tops = infos.map((p) => p.top);
  const pageAt = (y: number) => {
    let lo = 0;
    for (let i = 0; i < tops.length; i++) if (tops[i]! <= y) lo = i;
    return lo;
  };
  for (const [name, selector] of Object.entries(strings)) {
    const found = new Map<number, string>();
    // P18: a string's element may be in the template frame (corporate-sop's `.document-title-string`), not only in the text.
    for (const el of matches(canvas, selector)) {
      if (el.closest('.pmd-pages')) continue; // the papers' own running headers
      const page = pageAt((el.getBoundingClientRect().top - canvasTop) / scale);
      if (!found.has(page)) found.set(page, (el.textContent ?? '').trim());
    }
    let carried = '';
    for (let i = 0; i < infos.length; i++) {
      const value = found.get(i);
      if (value !== undefined) carried = value;
      infos[i]!.strings[name] = value ?? carried;
    }
  }
}

/**
 * The elements a layout's `string-set` selector names. pagemd's selectors can name its HTML template's wrappers
 * (book-wiki: `.book-content h1`), which the canvas doesn't have: when the whole selector matches nothing, its last
 * part (`h1`) is tried.
 */
function matches(root: HTMLElement, selector: string): Element[] {
  const tryAll = (s: string): Element[] => {
    try {
      return [...root.querySelectorAll(s)];
    } catch {
      return [];
    }
  };
  const direct = tryAll(selector);
  if (direct.length > 0) return direct;
  const lastParts = selector
    .split(',')
    .map((s) => s.trim().split(/[\s>+~]+/).pop() ?? '')
    .filter(Boolean)
    .join(', ');
  return lastParts ? tryAll(lastParts) : [];
}
