// The page layout itself (P6, amendment 6): which piece of the document starts each page. Pure: no DOM, no
// ProseMirror; the measuring layer (measure.ts) turns the canvas into `Leaf`s first. Distances are CSS px in the
// "natural" flow: the document as one long column with no page gaps (measure.ts removes the gaps it added itself).
//
// The rules, following CSS fragmentation the way pagemd's PDF (Paged.js) applies it:
// - a leaf that doesn't fit on the page moves to the next one, unless it can split between lines (a paragraph,
//   not `break-inside: avoid`), keeping at least `orphans` lines before the break and `widows` after;
// - `break-before`/`break-after: page | left | right` force a new page (`left`/`right` add a blank page to reach
//   the right side: page 1 is a right page); so does a change of named page (LAYOUT, a section's `page:`);
// - `break-after: avoid` (headings) / `break-before: avoid` keep a leaf with the next one when that one moves;
// - leaves in one `break-inside: avoid` group (an ancestor that avoids breaks) move together when they fit on a page;
// - a leaf taller than a whole page, that can't split, stays on its own page and makes it overflow.
// A forced break keeps the leaf's top margin at the top of the new page; an unforced one drops it (CSS: margins
// adjoining an unforced break are truncated).

export type BreakValue = 'auto' | 'avoid' | 'page' | 'left' | 'right';

/** One line box of a splittable leaf, natural px. */
export interface Line {
  top: number;
  bottom: number;
}

/** One unbreakable-or-line-splittable piece of the flow (a paragraph, heading, table, image, list item's text…). */
export interface Leaf {
  /** Where a break before this leaf would go: the top of the outermost element it starts (natural px). */
  top: number;
  bottom: number;
  /** That element's top margin, kept at the top of a page after a forced break. */
  marginTop: number;
  breakBefore: BreakValue;
  breakAfter: BreakValue;
  /** `break-inside: avoid` on the leaf itself: never split between its lines. */
  avoidInside: boolean;
  /** Leaves sharing a group (an ancestor with `break-inside: avoid`) stay together when the group fits a page. */
  group?: number;
  /** The named page in effect ('' = the document's own page). */
  page: string;
  /** Its line boxes, top to bottom (natural px), for a leaf that may split; read only when needed. */
  lines?: () => readonly Line[];
  orphans: number;
  widows: number;
}

/** Where a page's content starts: at a leaf, or inside one (from line `line` on). */
export interface PageStart {
  leaf: number;
  line: number;
}

export interface Page {
  /** The named page ('' = the document's own). */
  name: string;
  /** Empty, added to land the next page on the left or right side. */
  blank: boolean;
  /** null for a blank page (and for the one page of an empty document). */
  first: PageStart | null;
  /** Natural px where this page's content area begins (the first leaf's top, or its kept margin above it). */
  start: number;
  /** Natural px where its content ends. */
  end: number;
  /** True when a single leaf taller than the page made it overflow. */
  overflow: boolean;
  /** The page started by a forced break (its first leaf keeps its top margin). */
  forced: boolean;
}

/** The content area's height, in px, for a named page ('' = the document's own). */
export type ContentHeight = (name: string) => number;

const isForced = (b: BreakValue): boolean => b === 'page' || b === 'left' || b === 'right';
const sideOf = (b: BreakValue): 'left' | 'right' | null => (b === 'left' || b === 'right' ? b : null);

/** Lays `leaves` out on pages. Always returns at least one page. */
export function layoutPages(leaves: readonly Leaf[], contentHeight: ContentHeight): Page[] {
  if (leaves.length === 0) return [{ name: '', blank: false, first: null, start: 0, end: 0, overflow: false, forced: false }];
  const pages: Page[] = [];
  const open = (leaf: number, line: number, start: number, forced: boolean, side: 'left' | 'right' | null): Page => {
    const name = leaves[leaf]!.page;
    // Page numbers count from 1 and page 1 is a right page: right pages are odd. A blank page fixes the side.
    if (side && pages.length > 0 && (side === 'right') !== ((pages.length + 1) % 2 === 1)) {
      pages.push({ name, blank: true, first: null, start, end: start, overflow: false, forced: true });
    }
    const page: Page = { name, blank: false, first: { leaf, line }, start, end: start, overflow: false, forced };
    pages.push(page);
    return page;
  };

  const first = leaves[0]!;
  let page = open(0, 0, first.top - first.marginTop, true, null);
  let i = 0;
  while (i < leaves.length) {
    const leaf = leaves[i]!;
    const startsHere = page.first !== null && page.first.leaf === i;
    if (i > 0 && !startsHere) {
      const prev = leaves[i - 1]!;
      if (isForced(leaf.breakBefore) || isForced(prev.breakAfter) || leaf.page !== prev.page) {
        page = open(i, 0, leaf.top - leaf.marginTop, true, sideOf(leaf.breakBefore) ?? sideOf(prev.breakAfter));
        continue;
      }
    }
    const height = contentHeight(page.name);
    if (leaf.bottom - page.start <= height + EPSILON) {
      page.end = leaf.bottom;
      i++;
      continue;
    }

    // An avoid group (an ancestor with break-inside: avoid) that fits on one page moves as one; one that doesn't
    // fit behaves as if it allowed breaks.
    const group = groupRange(leaves, i);
    const groupFits = group !== null && leaves[group.to]!.bottom - leaves[group.from]!.top <= contentHeight(leaves[group.from]!.page) + EPSILON;
    const fromLine = startsHere ? page.first!.line : 0;

    // 1. Split between lines (a paragraph that allows it).
    const lines = !leaf.avoidInside && !groupFits && leaf.lines ? leaf.lines() : null;
    if (lines && lines.length - fromLine > 1) {
      let fitted = 0;
      while (fromLine + fitted < lines.length && lines[fromLine + fitted]!.bottom - page.start <= height + EPSILON) fitted++;
      if (fromLine + fitted === lines.length) {
        // Every line fits; only the leaf's own padding/border runs over. Keep it here.
        page.end = leaf.bottom;
        i++;
        continue;
      }
      let n = fitted;
      const after = lines.length - fromLine - n;
      if (after < leaf.widows) n = lines.length - fromLine - leaf.widows;
      if (!startsHere && fromLine === 0 && n < leaf.orphans) n = 0;
      if (startsHere && n < 1) n = 1; // a page must take something: at least one line
      if (n > 0) {
        page.end = lines[fromLine + n - 1]!.bottom;
        page = open(i, fromLine + n, lines[fromLine + n]!.top, false, null);
        continue; // the rest of this leaf, on the new page
      }
    }

    // 2. Taller than a whole page and can't split (further): it overflows its page.
    if (startsHere) {
      page.end = leaf.bottom;
      page.overflow = true;
      i++;
      if (i < leaves.length) page = open(i, 0, leaves[i]!.top, false, null);
      continue;
    }

    // 3. Move to the next page, taking along the rest of its avoid group and the leaves that must stay with it
    //    (break-after: avoid on a heading, break-before: avoid), as long as something stays on this page.
    let j = i;
    if (group && groupFits) j = Math.min(j, group.from);
    const pageFirst = page.first?.leaf ?? 0;
    while (j - 1 > pageFirst && (leaves[j - 1]!.breakAfter === 'avoid' || leaves[j]!.breakBefore === 'avoid')) j--;
    if (j <= pageFirst || (page.first && page.first.line > 0 && j === page.first.leaf)) j = i;
    if (j < i) page.end = leaves[j - 1]!.bottom;
    page = open(j, 0, leaves[j]!.top, false, null); // an unforced break: the top margin is dropped
    i = j;
  }
  return pages;
}

const EPSILON = 0.5;

/** The leaves sharing leaf `i`'s avoid group, or null. */
function groupRange(leaves: readonly Leaf[], i: number): { from: number; to: number } | null {
  const id = leaves[i]!.group;
  if (id === undefined) return null;
  let from = i;
  while (from > 0 && leaves[from - 1]!.group === id) from--;
  let to = i;
  while (to + 1 < leaves.length && leaves[to + 1]!.group === id) to++;
  return { from, to };
}
