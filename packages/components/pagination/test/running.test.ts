// Running headers and footers for one page (P6, amendment 7, R-147): pure, no DOM.
import { describe, expect, it } from 'vitest';
import { fill, runningFor, type RunningPage } from '../src/running.ts';

const page = (number: number, extra: Partial<RunningPage> = {}): RunningPage => ({ number, total: 12, blank: false, strings: {}, ...extra });

describe('fill', () => {
  it('replaces :::PAGE, :::PAGES and :::STRING(name); a string never set is blank', () => {
    expect(fill(':::PAGE of :::PAGES', page(3))).toBe('3 of 12');
    expect(fill('Ch: :::STRING(chapter-title)', page(2, { strings: { 'chapter-title': 'Intro' } }))).toBe('Ch: Intro');
    expect(fill('[:::STRING(none)]', page(2))).toBe('[]');
  });
});

describe('runningFor', () => {
  const styles = { header: { left: 'Acme', right: ':::PAGE' }, footer: { center: ':::PAGE of :::PAGES' } };

  it('fills left, center and right per page', () => {
    expect(runningFor(styles, page(4))).toEqual({
      header: { left: 'Acme', center: '', right: '4', span: false },
      footer: { left: '', center: '4 of 12', right: '', span: false },
    });
  });

  it('shows nothing on a blank page, and nothing for an absent header', () => {
    expect(runningFor(styles, page(2, { blank: true }))).toEqual({ header: null, footer: null });
    expect(runningFor({ footer: { center: 'x' } }, page(2)).header).toBeNull();
  });

  it('first-page rules: false hides both, an object replaces or hides each part; later pages are unaffected', () => {
    expect(runningFor({ ...styles, firstPage: false }, page(1))).toEqual({ header: null, footer: null });
    expect(runningFor({ ...styles, firstPage: false }, page(2)).header?.left).toBe('Acme');
    const first = runningFor({ ...styles, firstPage: { header: false, footer: { center: 'Cover' } } }, page(1));
    expect(first.header).toBeNull();
    expect(first.footer?.center).toBe('Cover');
    expect(runningFor({ ...styles, firstPage: { header: false } }, page(1)).footer?.center).toBe('1 of 12');
  });

  it('inside/outside flip by page side: page 1 is a right page (inside left, outside right)', () => {
    const book = { footer: { inside: 'IN', outside: 'OUT' } };
    expect(runningFor(book, page(1)).footer).toMatchObject({ left: 'IN', right: 'OUT' });
    expect(runningFor(book, page(2)).footer).toMatchObject({ left: 'OUT', right: 'IN' });
    expect(runningFor(book, page(3)).footer).toMatchObject({ left: 'IN', right: 'OUT' });
  });

  it('inside/outside fall back to left/right when not given (pagemd: var(--outside, var(--left)))', () => {
    expect(runningFor({ header: { left: 'L', right: 'R', outside: 'OUT' } }, page(2)).header).toMatchObject({ left: 'OUT', right: 'R' });
  });

  it('a spanning text uses the whole width: left and right stay empty', () => {
    expect(runningFor({ header: { center: 'Wide :::PAGE', spansWidth: true } }, page(5)).header).toEqual({ left: '', center: 'Wide 5', right: '', span: true });
  });

  it('a page whose texts are all empty after filling draws no box', () => {
    expect(runningFor({ header: { center: ':::STRING(x)' } }, page(2)).header).toBeNull();
  });
});

// P21: page types (named pages) with their own header and footer boxes, on top of the plain page's, box by box.
// The table is pagemd's PDF for the session-41 fixture (docs/phases/P21.md "What pagemd's PDF does").
describe('runningFor: page types (P21)', () => {
  // As style-pagemd resolves the session-41 layout: the plain page, :first, `@page wide` and `@page wide:first`
  const styles = {
    header: { left: 'MAIN HEADER', right: 'MAIN RIGHT' },
    footer: { center: 'Page :::PAGE of :::PAGES' },
    firstPage: { header: { right: 'MAIN RIGHT' }, footer: false as const },
    namedRunning: {
      wide: { header: { left: 'WIDE HEADER' }, footer: { center: 'Wide page :::PAGE' }, first: { header: { left: 'WIDE FIRST' } } },
    },
  };
  const total = 5;
  const at = (number: number, name: string, firstOfType: boolean) => runningFor(styles, { number, total, blank: false, strings: {}, name, firstOfType });
  const text = (r: ReturnType<typeof runningFor>) => [r.header?.left ?? '', r.header?.right ?? '', r.footer?.center ?? ''];

  it('the PDF table: page 1 plain first, 2 plain, 3 wide (first of its run), 4 wide, 5 plain again', () => {
    expect(text(at(1, '', true))).toEqual(['', 'MAIN RIGHT', '']);
    expect(text(at(2, '', false))).toEqual(['MAIN HEADER', 'MAIN RIGHT', 'Page 2 of 5']);
    expect(text(at(3, 'wide', true))).toEqual(['WIDE FIRST', 'MAIN RIGHT', 'Wide page 3']);
    expect(text(at(4, 'wide', false))).toEqual(['WIDE HEADER', 'MAIN RIGHT', 'Wide page 4']);
    expect(text(at(5, '', false))).toEqual(['MAIN HEADER', 'MAIN RIGHT', 'Page 5 of 5']);
  });

  it('a box the page type does not write is inherited, box by box (MAIN RIGHT stays on wide pages)', () => {
    expect(at(4, 'wide', false).header).toEqual({ left: 'WIDE HEADER', center: '', right: 'MAIN RIGHT', span: false });
  });

  it('null clears an inherited box; a page type that clears everything shows nothing', () => {
    const clear = { ...styles, namedRunning: { quiet: { header: { left: null }, footer: { center: null } } } };
    const r = runningFor(clear, { number: 2, total, blank: false, strings: {}, name: 'quiet', firstOfType: true });
    expect(r.header).toEqual({ left: '', center: '', right: 'MAIN RIGHT', span: false });
    expect(r.footer).toBeNull();
  });

  it('first of a run: a second run of the same type starts again with name:first', () => {
    expect(at(6, 'wide', true).header?.left).toBe('WIDE FIRST');
    expect(at(7, 'wide', false).header?.left).toBe('WIDE HEADER');
  });

  it('the page name is matched in lower case; an unknown type or the plain page uses no named layer', () => {
    expect(text(at(4, 'Wide', false))[0]).toBe('WIDE HEADER');
    expect(text(at(4, 'legal', false))).toEqual(['MAIN HEADER', 'MAIN RIGHT', 'Page 4 of 5']);
    expect(text(at(4, '', false))).toEqual(['MAIN HEADER', 'MAIN RIGHT', 'Page 4 of 5']);
  });

  it('the spec order on the document\'s page 1 when it is a page type: the name beats :first, name:first beats both', () => {
    expect(text(at(1, 'wide', true))).toEqual(['WIDE FIRST', 'MAIN RIGHT', 'Wide page 1']);
  });

  it('a blank page shows neither; inside/outside still flip for boxes the page type does not write', () => {
    expect(runningFor(styles, { number: 3, total, blank: true, strings: {}, name: 'wide', firstOfType: false })).toEqual({ header: null, footer: null });
    const book = { footer: { inside: 'IN', outside: 'OUT' }, namedRunning: { wide: { footer: { center: 'W' } } } };
    expect(runningFor(book, { number: 2, total, blank: false, strings: {}, name: 'wide', firstOfType: false }).footer).toEqual({ left: 'OUT', center: 'W', right: 'IN', span: false });
    expect(runningFor(book, { number: 3, total, blank: false, strings: {}, name: 'wide', firstOfType: false }).footer).toEqual({ left: 'IN', center: 'W', right: 'OUT', span: false });
  });

  it('a spanning text stops spanning when the page type writes left or right', () => {
    const span = { header: { center: 'All across', spansWidth: true }, namedRunning: { wide: { header: { left: 'L' } } } };
    expect(runningFor(span, { number: 2, total, blank: false, strings: {}, name: 'wide', firstOfType: false }).header).toEqual({ left: 'L', center: 'All across', right: '', span: false });
  });

  it('control: without namedRunning a wide page shows the plain page (the code before P21)', () => {
    const { namedRunning: _, ...plain } = styles;
    expect(text(runningFor(plain, { number: 3, total, blank: false, strings: {}, name: 'wide', firstOfType: true }))).toEqual(['MAIN HEADER', 'MAIN RIGHT', 'Page 3 of 5']);
  });
});
