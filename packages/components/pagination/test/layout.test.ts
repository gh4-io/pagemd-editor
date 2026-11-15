// The pure page layout (P6, amendment 6): no DOM, made-up leaves.
import { describe, expect, it } from 'vitest';
import { layoutPages, type Leaf, type Page } from '../src/layout.ts';

/** Leaves stacked top to bottom: each [height, options], with a 10 px gap between them. */
function stack(...specs: Array<number | [number, Partial<Leaf> & { lineHeight?: number }]>): Leaf[] {
  const leaves: Leaf[] = [];
  let y = 0;
  for (const spec of specs) {
    const [height, extra] = typeof spec === 'number' ? [spec, {}] : spec;
    const { lineHeight, ...rest } = extra;
    const top = y;
    const leaf: Leaf = { top, bottom: top + height, marginTop: 10, breakBefore: 'auto', breakAfter: 'auto', avoidInside: false, page: '', orphans: 2, widows: 2, ...rest };
    if (lineHeight) {
      const count = Math.round(height / lineHeight);
      leaf.lines = () => Array.from({ length: count }, (_, k) => ({ top: top + k * lineHeight, bottom: top + (k + 1) * lineHeight }));
    }
    leaves.push(leaf);
    y += height + 10;
  }
  return leaves;
}

const H = 100;
const firsts = (pages: Page[]) => pages.map((p) => (p.blank ? 'blank' : p.first ? `${p.first.leaf}${p.first.line ? `:${p.first.line}` : ''}` : '-'));

describe('layoutPages', () => {
  it('an empty document has one page', () => {
    expect(layoutPages([], () => H)).toHaveLength(1);
  });

  it('moves a leaf that does not fit to the next page', () => {
    // 0..40, 50..90, 100..140: the third ends at 140 > 100 + the first's kept margin (start -10).
    const pages = layoutPages(stack(40, 40, 40), () => H);
    expect(firsts(pages)).toEqual(['0', '2']);
    expect(pages[1]!.start).toBe(100); // an unforced break drops the top margin
  });

  it('PAGEBREAK and break-before/after: page force a new page, keeping the top margin', () => {
    const pages = layoutPages(stack(10, [10, { breakAfter: 'page' }], 10, [10, { breakBefore: 'page' }]), () => H);
    expect(firsts(pages)).toEqual(['0', '2', '3']);
    expect(pages[1]!.start).toBe(40 - 10);
    expect(pages[1]!.forced).toBe(true);
  });

  it('a forced break at the very start adds no empty page', () => {
    expect(firsts(layoutPages(stack([10, { breakBefore: 'page' }], 10), () => H))).toEqual(['0']);
  });

  it('left/right breaks add a blank page to land on the right side (page 1 is a right page)', () => {
    expect(firsts(layoutPages(stack(10, [10, { breakBefore: 'right' }]), () => H))).toEqual(['0', 'blank', '1']);
    expect(firsts(layoutPages(stack(10, [10, { breakBefore: 'left' }]), () => H))).toEqual(['0', '1']);
    expect(firsts(layoutPages(stack(10, [10, { breakBefore: 'page' }], [10, { breakBefore: 'left' }]), () => H))).toEqual(['0', '1', 'blank', '2']);
  });

  it("a change of named page (LAYOUT) starts a new page with that page's height", () => {
    const pages = layoutPages(stack(10, [60, { page: 'landscape' }], [60, { page: 'landscape' }], 10), (name) => (name === 'landscape' ? 70 : H));
    expect(firsts(pages)).toEqual(['0', '1', '2', '3']);
    expect(pages.map((p) => p.name)).toEqual(['', 'landscape', 'landscape', '']);
  });

  it('splits a paragraph between lines, keeping orphans and widows', () => {
    // A 10-line paragraph (12 px lines) after a 40 px block: page 1 has room for lines up to y = 90.
    const pages = layoutPages(stack(40, [120, { lineHeight: 12 }]), () => H);
    expect(firsts(pages)).toEqual(['0', '1:3']);
    expect(pages[1]!.start).toBe(50 + 36);
    // Only one line would fit: fewer than 2 orphans, so the whole paragraph moves.
    expect(firsts(layoutPages(stack(70, [120, { lineHeight: 12 }]), () => H))).toEqual(['0', '1', '1:8']);
    // Widows: 9 of 10 lines would fit, leaving 1; two are kept for the next page.
    expect(firsts(layoutPages(stack([120, { lineHeight: 12, top: 0 }]), () => 108 + 10))[1]).toBe('0:8');
  });

  it('never splits a leaf with break-inside: avoid; moves it instead', () => {
    expect(firsts(layoutPages(stack(40, [120, { lineHeight: 12, avoidInside: true }]), () => 200))).toEqual(['0']);
    expect(firsts(layoutPages(stack(40, [80, { lineHeight: 12, avoidInside: true }]), () => H))).toEqual(['0', '1']);
  });

  it('a leaf taller than a page that cannot split overflows its own page; the next leaf starts a new one', () => {
    const pages = layoutPages(stack(20, 250, 20), () => H);
    expect(firsts(pages)).toEqual(['0', '1', '2']);
    expect(pages.map((p) => p.overflow)).toEqual([false, true, false]);
  });

  it('keeps a heading (break-after: avoid) with the leaf that moves', () => {
    const pages = layoutPages(stack(30, [10, { breakAfter: 'avoid' }], 50), () => H);
    expect(firsts(pages)).toEqual(['0', '1']);
    expect(pages[0]!.end).toBe(30);
  });

  it('but splits a paragraph after a heading rather than moving both, when enough lines fit', () => {
    const pages = layoutPages(stack(30, [10, { breakAfter: 'avoid' }], [60, { lineHeight: 12 }]), () => H);
    expect(firsts(pages)).toEqual(['0', '2:2']); // lines end at 72, 84 | 96 (page 1 ends at -10 + 100)
  });

  it('moves an avoid group as one when it fits a page; splits it like anything else when it does not', () => {
    expect(firsts(layoutPages(stack(40, [20, { group: 1 }], [30, { group: 1 }]), () => H))).toEqual(['0', '1']);
    expect(firsts(layoutPages(stack(40, [60, { group: 1 }], [60, { group: 1 }]), () => H))).toEqual(['0', '1', '2']);
  });

  it('a long paragraph alone spans several pages', () => {
    const pages = layoutPages(stack([360, { lineHeight: 12 }]), () => H);
    expect(firsts(pages)).toEqual(['0', '0:7', '0:15', '0:23']); // 7 lines, then 8 a page (100 / 12)
    expect(pages.every((p) => !p.overflow)).toBe(true);
  });
});
