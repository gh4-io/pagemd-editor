// The measuring layer (P6, amendment 6): the rendered canvas as `Leaf`s for layoutPages(). It walks the
// ProseMirror document, descending into containers (lists, quotes, wrappers) down to leaves (paragraphs, headings,
// tables, images…), reads each one's box and computed `break-*` values, and works out the "natural" flow: where
// everything would be with no page gaps. The gaps this package drew itself are known, so natural positions come
// from real ones without taking the gaps out of the page (no extra layout pass).
//
// Real positions are in canvas px (0 = the top of page 1), divided by the canvas's own scale (zoom). Natural ones
// are px from the top of the ProseMirror element with every page gap removed.
import type { Node } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import type { BreakValue, Leaf, Line } from './layout.ts';

/**
 * A page-related marker in the document, as the app's preset describes it (pagemd's PAGEBREAK, SECTION/COVER
 * start and end, LAYOUT). Markers are atoms drawn as chips; the chips take no room in Print Layout (paginationCss).
 * - `wrapper-start`/`wrapper-end`: pagemd wraps what's between in `<div class="…">` (SECTION's class, `cover`);
 *   that class's computed `break-before`/`break-after`/`break-inside`/`page` apply to what's between.
 * - `layout`: LAYOUT(name): pagemd's `<div class="page-<name>">`, whose `page:` (by pagemd's own layouts:
 *   `.page-landscape { page: landscape }`) names the page for what follows.
 * - `excluded`: shown on the canvas but not in pagemd's output (the frontmatter): takes no room on page 1.
 */
export type PageMarker =
  | { kind: 'pagebreak' }
  | { kind: 'wrapper-start'; className: string }
  | { kind: 'wrapper-end' }
  | { kind: 'layout'; name: string }
  | { kind: 'excluded' };

/** `pos` is the node's position in `doc` (the excluded frontmatter is told apart by where it is). */
export type MarkerOf = (node: Node, pos: number, doc: Node) => PageMarker | null;

/**
 * P18: the template's parts above and below the text area (components/template-frame's `pieces()`), in page order; null or
 * empty lists when the canvas has no template frame. They flow on the pages like unbreakable blocks.
 */
export type FramePiecesOf = () => { before: readonly HTMLElement[]; after: readonly HTMLElement[] } | null;

/** The canvas element (`.pmd-canvas`) holding the text area: not always its parent since P18 (a template frame sits between). */
export function canvasElementOf(pm: HTMLElement): HTMLElement {
  return (pm.closest('.pmd-canvas') as HTMLElement | null) ?? pm.parentElement ?? pm;
}

/** A leaf with what the renderer needs to draw a page break before it. */
export interface MeasuredLeaf extends Leaf {
  /** The ProseMirror position before the outermost node this leaf starts (where a block gap goes). */
  breakPos: number;
  /** The leaf node's own position. */
  pos: number;
  node: Node;
  element: HTMLElement;
  /** The outermost element the leaf starts (its first descendant chain). */
  outer: HTMLElement;
  /** Natural distance from the previous leaf's bottom to this leaf's top, as measured without a gap between. */
  naturalGap: number;
  /** P18: a piece of the template frame (outside the text area): a page break before it is a spacer in the frame. */
  frame?: true;
  /** Where its bottom was on the canvas when measured (canvas px), to check a reused measurement still holds. */
  realBottom: number;
}

/** Information about the page gaps drawn last time, to take them out of real positions. */
export interface DrawnGap {
  /** The element in the canvas. */
  element: HTMLElement;
  /** Its height, px. */
  height: number;
  /** The leaf it comes before (block gap), or the leaf it is inside (line gap). */
  inline: boolean;
}

/** A line box with where its first glyph is on screen now (client px), to find its document position. */
export interface MeasuredLine extends Line {
  clientX: number;
  clientY: number;
}

/** One measured flow plus what's needed to draw it. */
export interface Measurement {
  leaves: MeasuredLeaf[];
  /** real (canvas px) − natural for the first leaf: where page 1's flow begins on the canvas. */
  firstOffset: number;
  /** Natural px between the canvas content top and the first leaf: room taken by `excluded` nodes on page 1. */
  excludedHeight: number;
  /** canvas px per layout px (zoom). */
  scale: number;
}

/** Computed CSS for one element, cached until the styles change. */
interface Computed {
  breakBefore: BreakValue;
  breakAfter: BreakValue;
  breakInsideAvoid: boolean;
  marginTop: number;
  orphans: number;
  widows: number;
  page: string;
  /** P18: whether a container's children stack (see `stacks`). */
  display: string;
}

export class Measurer {
  readonly #view: EditorView;
  readonly #markerOf: MarkerOf;
  #computed = new WeakMap<Element, Computed>();
  #gaps = new WeakMap<Element, number>();
  #excess = new WeakMap<Element, number>();
  #probes = new Map<string, Computed>();
  #probeHost: HTMLElement | null = null;
  /** Page names that exist (the profile's named pages). */
  #named: ReadonlySet<string> = new Set();
  readonly #frame: FramePiecesOf | undefined;

  constructor(view: EditorView, markerOf: MarkerOf, frame?: FramePiecesOf) {
    this.#view = view;
    this.#markerOf = markerOf;
    this.#frame = frame;
  }

  /** The styles changed: forget everything read from CSS. */
  reset(named: Iterable<string>): void {
    this.#computed = new WeakMap();
    this.#gaps = new WeakMap();
    this.#excess = new WeakMap();
    this.#probes.clear();
    this.#named = new Set(named);
  }

  /**
   * Measures the flow. `gaps` are the page gaps on the canvas now (block gaps before their leaf's outer element;
   * line gaps inside a leaf), so their height can be taken out. `reuse`: the last measurement, and the position
   * before which nothing changed since (the start of the page the edit is on): leaves wholly before it keep their
   * measured boxes, so only the edited page and what follows are read from the canvas again.
   */
  measure(gaps: ReadonlySet<HTMLElement>, gapHeight: (el: HTMLElement) => number, reuse?: { measurement: Measurement; before: number }): Measurement {
    const view = this.#view;
    const pm = view.dom as HTMLElement;
    const canvas = canvasElementOf(pm);
    const canvasRect = canvas.getBoundingClientRect();
    const scale = canvas.offsetWidth > 0 ? canvasRect.width / canvas.offsetWidth : 1;
    const pmRect = pm.getBoundingClientRect();
    const toCanvas = (clientY: number) => (clientY - canvasRect.top) / scale;
    const pieces = this.#frame?.() ?? null;
    const framed = pieces !== null && (pieces.before.length > 0 || pieces.after.length > 0);
    // The flow starts at the text area's top; with a template frame (P18), at the top of the canvas's content box (the page's
    // content area), where the frame starts.
    const canvasStyle = framed ? getComputedStyle(canvas) : null;
    const flowTop = canvasStyle ? (parseFloat(canvasStyle.borderTopWidth) || 0) + (parseFloat(canvasStyle.paddingTop) || 0) : toCanvas(pmRect.top);

    const doc = view.state.doc;
    const frameItem = (element: HTMLElement, pos: number): RawItem => ({ kind: 'leaf', node: doc, pos, element, outer: element, breakPos: pos, breakBefore: 'auto', breakAfter: 'auto', page: '', group: undefined, frame: true });
    const raw = [...(pieces?.before ?? []).map((el) => frameItem(el, 0)), ...this.#collect(doc), ...(pieces?.after ?? []).map((el) => frameItem(el, doc.content.size))];
    const leaves: MeasuredLeaf[] = [];
    // Running offset: real (canvas) − natural, i.e. the room the gaps drawn so far take, plus the canvas's own top.
    let offset = flowTop;
    let excludedHeight = 0;
    let firstOffset = flowTop;
    let prevBottomReal: number | null = null;
    let prevBottomNatural = 0;

    let reused = 0;
    // Leaves not laid out (display: none, e.g. a print rule hiding an editor-only placeholder) take no room anywhere.
    const items = raw.filter((i): i is Extract<RawItem, { kind: 'leaf' }> => i.kind === 'leaf' && i.element.getClientRects().length > 0 && i.outer.getClientRects().length > 0);
    if (reuse && raw.length > 0) {
      const old = reuse.measurement.leaves;
      while (reused < items.length && reused < old.length) {
        const item = items[reused]!;
        const was = old[reused]!;
        const end = item.frame ? (item.pos === 0 ? 0 : Number.POSITIVE_INFINITY) : item.pos + item.node.nodeSize;
        if ((item.frame ? was.element !== item.element : was.node !== item.node) || was.pos !== item.pos || !!was.frame !== !!item.frame || end > reuse.before || !was.element.isConnected) break;
        leaves.push({ ...was, breakBefore: item.breakBefore === 'auto' ? was.breakBefore : strongest(item.breakBefore, was.breakBefore), page: item.page, ...(item.group !== undefined ? { group: item.group } : {}) });
        reused++;
      }
      if (reused > 0) {
        // Something above the edit can change too (a live table of contents lists the headings): if the last
        // reused leaf moved, measure everything.
        const last = leaves[reused - 1]!;
        const bottomNow = toCanvas(last.element.getBoundingClientRect().bottom);
        if (Math.abs(bottomNow - last.realBottom) > 0.5) {
          leaves.length = 0;
          reused = 0;
        } else {
          excludedHeight = reuse.measurement.excludedHeight;
          firstOffset = reuse.measurement.firstOffset;
          prevBottomReal = bottomNow;
          prevBottomNatural = last.bottom;
          offset = prevBottomReal - prevBottomNatural;
        }
      }
    }

    let sideGroups = 0;
    for (const item of items.slice(reused)) {
      const { node, pos, element, outer, breakPos } = item;
      const outerRect = outer.getBoundingClientRect();
      const leafRect = element.getBoundingClientRect();
      const outerTopReal = toCanvas(outerRect.top);
      const before = previousGap(outer, gaps);
      const style = this.#style(outer);
      const own = outer === element ? style : this.#style(element);

      let topNatural: number;
      let naturalGap: number;
      let marginTop = style.marginTop;
      if (prevBottomReal === null && framed) {
        // P18: with a template frame the flow starts at the page's content top; the room above the first piece (the template's
        // own padding) is part of the page, like a margin (the frontmatter card is out of the flow there, so nothing is excluded).
        topNatural = Math.max(0, outerTopReal - flowTop);
        marginTop = topNatural;
        excludedHeight = 0;
        offset = flowTop;
        firstOffset = offset;
        naturalGap = topNatural;
      } else if (prevBottomReal === null) {
        // The first leaf: anything above it inside the flow (excluded nodes, the frontmatter) takes no room.
        topNatural = style.marginTop;
        excludedHeight = Math.max(0, outerTopReal - flowTop - style.marginTop);
        offset = outerTopReal - topNatural;
        firstOffset = offset;
        naturalGap = topNatural;
      } else if (before) {
        // A block gap drawn before this leaf: its natural gap was measured before the gap was there. What the
        // real distance has beyond the gap's own height is the two margins that no longer collapse (excess).
        this.#excess.set(outer, outerTopReal - prevBottomReal - gapHeight(before));
        naturalGap = this.#gaps.get(outer) ?? Math.max(style.marginTop, marginBottomOf(prevElement(outer)));
        topNatural = prevBottomNatural + naturalGap;
        offset = outerTopReal - topNatural;
      } else {
        naturalGap = outerTopReal - prevBottomReal;
        this.#gaps.set(outer, naturalGap);
        topNatural = outerTopReal - offset;
      }

      // Line gaps inside this leaf shift what's below them.
      const inner = innerGaps(element, gaps);
      const bottomReal = toCanvas(leafRect.bottom);
      let innerHeight = 0;
      for (const gap of inner) innerHeight += gapHeight(gap);
      const bottomNatural = bottomReal - offset - innerHeight;
      const leafTopNatural = toCanvas(leafRect.top) - offset;

      const leaf: MeasuredLeaf = {
        top: topNatural,
        bottom: Math.max(bottomNatural, topNatural),
        marginTop,
        breakBefore: strongest(item.breakBefore, style.breakBefore, outer === element ? 'auto' : own.breakBefore),
        breakAfter: strongest(item.breakAfter, own.breakAfter),
        avoidInside: own.breakInsideAvoid,
        page: item.page,
        orphans: own.orphans,
        widows: own.widows,
        breakPos,
        pos,
        node,
        element,
        outer,
        naturalGap,
        realBottom: bottomReal,
      };
      if (item.group !== undefined) leaf.group = item.group;
      if (item.frame) {
        leaf.frame = true;
        leaf.avoidInside = true; // a piece of the frame is never split
      }
      // Boxes side by side (P18: the brochure's panels are table cells): a box that starts above the previous one's bottom
      // stands beside it, not under it. They move together, and the row ends at the lowest of them.
      const prevLeaf = leaves[leaves.length - 1];
      if (prevLeaf && !item.frame && !prevLeaf.frame && leaf.top < prevLeaf.bottom - 1 && toCanvas(leafRect.top) < (prevBottomReal ?? 0) - 1) {
        const group = prevLeaf.group ?? -++sideGroups;
        prevLeaf.group = group;
        leaf.group = group;
        leaf.avoidInside = true;
        prevLeaf.avoidInside = true;
        if (prevLeaf.bottom > leaf.bottom) leaf.bottom = prevLeaf.bottom;
      }
      if (node.isTextblock && !item.frame) {
        const leafOffset = offset;
        const contentTop = leafTopNatural;
        leaf.lines = memo(() => lineBoxes(element, gaps, gapHeight, toCanvas, leafOffset, contentTop, Math.max(bottomNatural, topNatural)));
      }
      leaves.push(leaf);
      offset += innerHeight;
      prevBottomReal = leaf.group !== undefined && leaf.group < 0 ? Math.max(bottomReal, prevBottomReal ?? bottomReal) : bottomReal;
      prevBottomNatural = leaf.bottom;
    }
    return { leaves, firstOffset, excludedHeight, scale };
  }

  /** The leaves in document order, with what markers and containers say about breaks (no DOM reads but styles). */
  #collect(doc: Node): RawItem[] {
    const view = this.#view;
    const items: RawItem[] = [];
    const wrappers: Array<{ computed: Computed; group?: number }> = [];
    let layoutPage = '';
    let pendingBefore: BreakValue = 'auto';
    let groups = 0;

    const pageNow = (): string => {
      for (let i = wrappers.length - 1; i >= 0; i--) if (wrappers[i]!.computed.page) return wrappers[i]!.computed.page;
      return layoutPage;
    };
    const groupNow = (containerGroups: Array<number | undefined>): number | undefined => {
      for (const w of wrappers) if (w.group !== undefined) return w.group;
      for (const g of containerGroups) if (g !== undefined) return g;
      return undefined;
    };
    const lastItem = (): Extract<RawItem, { kind: 'leaf' }> | undefined => {
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i]!;
        if (item.kind === 'leaf') return item;
      }
      return undefined;
    };

    const walk = (parent: Node, contentStart: number, pending: Outer | null, containerGroups: Array<number | undefined>): void => {
      let first = true;
      parent.forEach((node, offset) => {
        const pos = contentStart + offset;
        const marker = this.#markerOf(node, pos, doc);
        if (marker) {
          if (marker.kind === 'excluded') {
            if (!items.some((i) => i.kind === 'leaf')) items.push({ kind: 'excluded' });
          } else if (marker.kind === 'pagebreak') pendingBefore = 'page';
          else if (marker.kind === 'layout') {
            const page = this.#probe(`page-${marker.name}`).page || (this.#named.has(marker.name) ? marker.name : '');
            layoutPage = page === 'default' && !this.#named.has('default') ? '' : page;
          } else if (marker.kind === 'wrapper-start') {
            const computed = this.#probe(marker.className);
            const entry: { computed: Computed; group?: number } = { computed };
            if (computed.breakInsideAvoid) entry.group = ++groups;
            wrappers.push(entry);
            pendingBefore = strongest(pendingBefore, computed.breakBefore);
          } else if (marker.kind === 'wrapper-end') {
            const closed = wrappers.pop();
            if (closed && isForcedValue(closed.computed.breakAfter)) pendingBefore = strongest(pendingBefore, closed.computed.breakAfter);
            else if (closed?.computed.breakAfter === 'avoid') {
              const last = lastItem();
              if (last) last.breakAfter = strongest(last.breakAfter, 'avoid');
            }
          }
          return; // markers aren't leaves (first stays as it is: a zero-height chip starts nothing)
        }
        const element = view.nodeDOM(pos);
        if (!(element instanceof HTMLElement)) return;
        const outer: Outer = (first ? pending : null) ?? { pos, element };
        first = false;
        if (descends(node) && stacks(this.#style(element).display)) {
          const computed = this.#style(element);
          const group = computed.breakInsideAvoid ? ++groups : undefined;
          const before = items.length;
          pendingBefore = strongest(pendingBefore, computed.breakBefore);
          walk(node, pos + 1, outer, [...containerGroups, group]);
          if (items.length > before) {
            const last = lastItem();
            if (last) last.breakAfter = strongest(last.breakAfter, computed.breakAfter);
          }
          return;
        }
        items.push({
          kind: 'leaf',
          node,
          pos,
          element,
          outer: outer.element,
          breakPos: outer.pos,
          breakBefore: pendingBefore,
          breakAfter: 'auto',
          page: pageNow(),
          group: groupNow(containerGroups),
        });
        pendingBefore = 'auto';
      });
    };
    walk(doc, 0, null, []);
    return items;
  }

  #style(element: Element): Computed {
    let found = this.#computed.get(element);
    if (!found) {
      found = readComputed(getComputedStyle(element));
      this.#computed.set(element, found);
    }
    return found;
  }

  /**
   * The real distance a block gap of height 0 would leave between the previous leaf and `outer`: the measured one
   * when a gap was drawn there before, else the natural gap plus the smaller of the two margins (they stop
   * collapsing once something is between them). `estimated` tells which.
   */
  excess(leaf: MeasuredLeaf, previous: MeasuredLeaf | undefined): { value: number; estimated: boolean } {
    const known = this.#excess.get(leaf.outer);
    if (known !== undefined) return { value: known, estimated: false };
    const prevMargin = marginBottomOf(prevElement(leaf.outer));
    void previous;
    return { value: leaf.naturalGap + Math.min(prevMargin, leaf.marginTop), estimated: true };
  }

  /** The computed styles a wrapper `<div class="…">` would get inside the canvas (SECTION, cover, LAYOUT). */
  #probe(className: string): Computed {
    const key = className.trim();
    let found = this.#probes.get(key);
    if (found) return found;
    const pm = this.#view.dom as HTMLElement;
    const host = canvasElementOf(pm);
    if (!this.#probeHost || !this.#probeHost.isConnected) {
      this.#probeHost = host.ownerDocument.createElement('div');
      this.#probeHost.className = 'pmd-page-probes';
      this.#probeHost.setAttribute('aria-hidden', 'true');
      host.append(this.#probeHost);
    }
    const probe = host.ownerDocument.createElement('div');
    if (key) probe.className = key;
    this.#probeHost.append(probe);
    found = readComputed(getComputedStyle(probe));
    probe.remove();
    this.#probes.set(key, found);
    return found;
  }
}

interface Outer {
  pos: number;
  element: HTMLElement;
}

type RawItem =
  | {
      kind: 'leaf';
      node: Node;
      pos: number;
      element: HTMLElement;
      outer: HTMLElement;
      breakPos: number;
      breakBefore: BreakValue;
      breakAfter: BreakValue;
      page: string;
      group: number | undefined;
      frame?: true;
    }
  | { kind: 'excluded' };

/**
 * Whether a container with `display` lays its children out one under another (P18): a table cell, a flex or grid box or an
 * inline block (the brochure's panels) doesn't, so it is measured as one piece.
 */
export function stacks(display: string): boolean {
  return display === 'block' || display === 'list-item' || display === 'flow-root' || display === '';
}

/** Containers whose children are blocks laid out one under another (lists, items, quotes, wrappers). */
function descends(node: Node): boolean {
  if (node.isTextblock || node.isAtom || node.isLeaf || node.childCount === 0) return false;
  const role = node.type.spec['tableRole'] as string | undefined;
  if (role || /table/i.test(node.type.name)) return false;
  return node.firstChild?.isBlock ?? false;
}

export function breakValue(value: string): BreakValue {
  switch (value) {
    case 'page':
    case 'always':
      return 'page';
    case 'left':
    case 'verso':
      return 'left';
    case 'right':
    case 'recto':
      return 'right';
    case 'avoid':
    case 'avoid-page':
      return 'avoid';
    default:
      return 'auto';
  }
}

const isForcedValue = (b: BreakValue): boolean => b === 'page' || b === 'left' || b === 'right';

/** The value that wins when several apply at one break: a side, then a forced break, then avoid. */
export function strongest(...values: BreakValue[]): BreakValue {
  const rank = (b: BreakValue) => (b === 'left' || b === 'right' ? 3 : b === 'page' ? 2 : b === 'avoid' ? 1 : 0);
  return values.reduce((a, b) => (rank(b) > rank(a) ? b : a), 'auto');
}

function readComputed(s: CSSStyleDeclaration): Computed {
  const px = (v: string) => (v.endsWith('px') ? parseFloat(v) : 0);
  const int = (v: string, fallback: number) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const page = s.getPropertyValue('page').trim();
  return {
    breakBefore: breakValue(s.getPropertyValue('break-before') || s.getPropertyValue('page-break-before')),
    breakAfter: breakValue(s.getPropertyValue('break-after') || s.getPropertyValue('page-break-after')),
    breakInsideAvoid: /avoid/.test(s.getPropertyValue('break-inside') || s.getPropertyValue('page-break-inside')),
    marginTop: px(s.marginTop),
    orphans: int(s.getPropertyValue('orphans'), 2),
    widows: int(s.getPropertyValue('widows'), 2),
    page: page && page !== 'auto' ? page : '',
    display: s.display,
  };
}

function marginBottomOf(element: Element | null): number {
  if (!element) return 0;
  const v = getComputedStyle(element).marginBottom;
  return v.endsWith('px') ? parseFloat(v) : 0;
}

/** The element before `el` in the flow, skipping page gaps. */
function prevElement(el: Element): Element | null {
  let prev = el.previousElementSibling;
  while (prev && prev.classList.contains(GAP_CLASS)) prev = prev.previousElementSibling;
  return prev;
}

/** The page gap drawn right before `outer` (a block gap), if any. */
function previousGap(outer: Element, gaps: ReadonlySet<HTMLElement>): HTMLElement | null {
  const prev = outer.previousElementSibling;
  return prev instanceof HTMLElement && gaps.has(prev) ? prev : null;
}

/** The line gaps inside a leaf. */
function innerGaps(element: HTMLElement, gaps: ReadonlySet<HTMLElement>): HTMLElement[] {
  if (gaps.size === 0) return [];
  return [...element.querySelectorAll<HTMLElement>(`.${GAP_CLASS}`)].filter((g) => gaps.has(g));
}

/** The class page gaps carry (also styled by paginationCss). */
export const GAP_CLASS = 'pmd-page-gap';

function memo<T>(fn: () => T): () => T {
  let done = false;
  let value: T;
  return () => {
    if (!done) {
      value = fn();
      done = true;
    }
    return value;
  };
}

/**
 * A textblock's line boxes, natural px. Lines come from the client rects of its text and inline elements (not
 * the page gaps), grouped by vertical overlap; line boxes meet halfway between one line's glyphs and the next's,
 * the first starts at the block's top and the last ends at its bottom. Below a line gap, real positions are
 * shifted up by that gap's height.
 */
function lineBoxes(
  element: HTMLElement,
  gaps: ReadonlySet<HTMLElement>,
  gapHeight: (el: HTMLElement) => number,
  toCanvas: (clientY: number) => number,
  offset: number,
  top: number,
  bottom: number,
): MeasuredLine[] {
  const doc = element.ownerDocument;
  const inner = innerGaps(element, gaps).map((g) => ({ top: toCanvas(g.getBoundingClientRect().top), height: gapHeight(g) }));
  const natural = (y: number) => {
    let shift = 0;
    for (const g of inner) if (y >= g.top) shift += g.height;
    return y - offset - shift;
  };
  const rects: Array<{ top: number; bottom: number; x: number; y: number }> = [];
  const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) => {
      if (n instanceof HTMLElement && n.classList.contains(GAP_CLASS)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const range = doc.createRange();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === 3) {
      if (!n.nodeValue) continue;
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) if (r.height > 0) rects.push({ top: natural(toCanvas(r.top)), bottom: natural(toCanvas(r.bottom)), x: r.left + 1, y: (r.top + r.bottom) / 2 });
    } else if (n instanceof HTMLImageElement || (n instanceof HTMLElement && n.getAttribute('contenteditable') === 'false' && getComputedStyle(n).display.startsWith('inline'))) {
      const r = n.getBoundingClientRect();
      if (r.height > 0) rects.push({ top: natural(toCanvas(r.top)), bottom: natural(toCanvas(r.bottom)), x: r.left + 1, y: (r.top + r.bottom) / 2 });
    }
  }
  const rect = element.getBoundingClientRect();
  if (rects.length === 0) return [{ top, bottom, clientX: rect.left + 1, clientY: rect.top + 1 }];
  rects.sort((a, b) => a.top - b.top || a.x - b.x);
  const lines: Array<{ top: number; bottom: number; x: number; y: number }> = [];
  for (const r of rects) {
    const last = lines[lines.length - 1];
    const mid = (r.top + r.bottom) / 2;
    if (last && mid < last.bottom) {
      last.top = Math.min(last.top, r.top);
      last.bottom = Math.max(last.bottom, r.bottom);
      if (r.x < last.x) {
        last.x = r.x;
        last.y = r.y;
      }
    } else lines.push({ ...r });
  }
  // Glyph boxes to line boxes: boundaries halfway between lines; the ends at the block's own edges.
  const out: MeasuredLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const lineTop = i === 0 ? Math.min(top, lines[0]!.top) : (lines[i - 1]!.bottom + lines[i]!.top) / 2;
    const lineBottom = i === lines.length - 1 ? Math.max(bottom, lines[i]!.bottom) : (lines[i]!.bottom + lines[i + 1]!.top) / 2;
    out.push({ top: lineTop, bottom: lineBottom, clientX: lines[i]!.x, clientY: lines[i]!.y });
  }
  return out;
}
