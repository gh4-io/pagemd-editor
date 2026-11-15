// P21: which pages start a run of their page type, and the note where pagemd's PDF prints a page type at another size
// than the canvas draws it (until C11). Pure, no DOM (the drawing is checked by test/e2e/page-types.spec.ts).
import { describe, expect, it } from 'vitest';
import type { PageGeometry } from '@pagemd-editor/core';
import { firstsOfType, pdfSizeNotes, PDF_FLATTENS_PAGE_SIZES, sizeLabel, sizeNoteText } from '../src/headers.ts';

const LETTER: PageGeometry = { width: 215.9, height: 279.4, margins: { top: 25.4, right: 25.4, bottom: 25.4, left: 25.4 } };
const LANDSCAPE: PageGeometry = { width: 279.4, height: 215.9, margins: { top: 12.7, right: 19.05, bottom: 12.7, left: 19.05 } };
const LEGAL: PageGeometry = { width: 215.9, height: 355.6, margins: { top: 38.1, right: 38.1, bottom: 38.1, left: 38.1 } };
const NARROW: PageGeometry = { width: 215.9, height: 279.4, margins: { top: 25.4, right: 50, bottom: 25.4, left: 50 } };
const page = (name: string, geometry: PageGeometry, blank = false) => ({ name, geometry, blank });

describe('firstsOfType', () => {
  it('the first page of each run of a type, blank pages skipped (wide, plain, wide again)', () => {
    const pages = [page('', LETTER), page('wide', LANDSCAPE), page('wide', LANDSCAPE), page('', LETTER), page('wide', LANDSCAPE, true), page('wide', LANDSCAPE), page('wide', LANDSCAPE)];
    expect(firstsOfType(pages)).toEqual([true, true, false, true, false, true, false]);
  });

  it('control: "page number 1 only" would miss the second run', () => {
    const pages = [page('', LETTER), page('wide', LANDSCAPE), page('', LETTER), page('wide', LANDSCAPE)];
    expect(firstsOfType(pages)[3]).toBe(true);
  });
});

describe('pdfSizeNotes', () => {
  it('lists exactly the page types in use whose sheet size differs (wide landscape, legal), once each, in order', () => {
    const notes = pdfSizeNotes([page('', LETTER), page('wide', LANDSCAPE), page('wide', LANDSCAPE), page('legal', LEGAL), page('default', LETTER)], LETTER);
    expect(notes.map((n) => n.name)).toEqual(['wide', 'legal']);
    expect(notes[0]).toEqual({ name: 'wide', drawn: { width: 279.4, height: 215.9 }, pdf: { width: 215.9, height: 279.4 } });
  });

  it('a page type that differs only in margins gives no note', () => {
    expect(pdfSizeNotes([page('', LETTER), page('narrow', NARROW)], LETTER)).toEqual([]);
  });

  it('a page type the document never uses gives no note (the notes come from the pages, not the layout)', () => {
    expect(pdfSizeNotes([page('', LETTER), page('', LETTER)], LETTER)).toEqual([]);
  });

  it('0.5 mm is the same size', () => {
    expect(pdfSizeNotes([page('x', { ...LETTER, width: 216.3 })], LETTER)).toEqual([]);
    expect(pdfSizeNotes([page('x', { ...LETTER, width: 216.5 })], LETTER).length).toBe(1);
  });

  it('the switch is on until pagemd prints true page sizes (C11)', () => {
    expect(PDF_FLATTENS_PAGE_SIZES).toBe(true);
  });
});

describe('sizeLabel and the status bar note', () => {
  it('inches for inch sizes, millimetres otherwise, with the orientation', () => {
    expect(sizeLabel(LETTER)).toBe('8.5 × 11 in, portrait');
    expect(sizeLabel(LANDSCAPE)).toBe('11 × 8.5 in, landscape');
    expect(sizeLabel(LEGAL)).toBe('8.5 × 14 in, portrait');
    expect(sizeLabel({ width: 210, height: 297 })).toBe('210 × 297 mm, portrait');
  });

  it('one plain sentence; none for no notes', () => {
    expect(sizeNoteText([])).toBe('');
    const notes = pdfSizeNotes([page('wide', LANDSCAPE)], LETTER);
    expect(sizeNoteText(notes)).toBe('Page type "wide" (11 × 8.5 in, landscape) is drawn as your layout says; pagemd\'s PDF currently prints every page at the plain page\'s size (8.5 × 11 in, portrait). This will change when pagemd is fixed.');
    expect(sizeNoteText(pdfSizeNotes([page('wide', LANDSCAPE), page('legal', LEGAL)], LETTER))).toMatch(/^Page types "wide" \(11 × 8\.5 in, landscape\), "legal" \(8\.5 × 14 in, portrait\) are drawn/);
  });
});
