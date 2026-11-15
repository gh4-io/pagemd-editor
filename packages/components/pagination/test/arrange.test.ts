// Pages side by side (P6, amendment 11): where each paper goes; and zoom/fit. Pure.
import { describe, expect, it } from 'vitest';
import type { PageGeometry } from '@pagemd-editor/core';
import { cellHeightOf, placement } from '../src/arrange.ts';
import { PX_PER_MM } from '../src/paginator.ts';
import { clampZoom, columnsFor, MAX_ZOOM, MIN_ZOOM, zoomFor } from '../src/zoom.ts';

const a4: PageGeometry = { width: 210, height: 297, margins: { top: 25, right: 25, bottom: 25, left: 25 } };
const W = 210 * PX_PER_MM;
const H = 297 * PX_PER_MM;

describe('placement', () => {
  it('two per row: even pages left, odd pages right, rows a page height plus the gap down', () => {
    expect(placement(0, 2, a4, 24)).toEqual({ left: 0, top: 0 });
    expect(placement(1, 2, a4, 24)).toEqual({ left: W, top: 0 });
    expect(placement(2, 2, a4, 24)).toEqual({ left: 0, top: H + 24 });
    expect(placement(5, 2, a4, 0)).toEqual({ left: W, top: 2 * H });
  });
});

describe('rows with an overflowing page', () => {
  it('a row is as tall as the tallest page, so a block that cannot split still fits its column', () => {
    expect(cellHeightOf(a4, [{ height: H }, { height: H }])).toBe(H);
    expect(cellHeightOf(a4, [{ height: H }, { height: 1.5 * H }, { height: H }])).toBe(1.5 * H);
    expect(placement(2, 2, a4, 24, 1.5 * H).top).toBe(1.5 * H + 24);
  });
});

describe('zoom and fit', () => {
  it('fit "none" is the zoom itself, kept within bounds', () => {
    expect(zoomFor('none', 1.5, { width: 100, height: 100 }, a4, 1)).toBe(1.5);
    expect(clampZoom(100)).toBe(MAX_ZOOM);
    expect(clampZoom(0.01)).toBe(MIN_ZOOM);
  });

  it('page width fits the row across; one page also fits the height; a spread counts two pages across', () => {
    const avail = { width: W * 2, height: H / 2 };
    expect(zoomFor('page-width', 1, avail, a4, 1)).toBeCloseTo(2);
    expect(zoomFor('one-page', 1, avail, a4, 1)).toBeCloseTo(0.5); // the height decides
    expect(zoomFor('page-width', 1, avail, a4, 2)).toBeCloseTo(1);
    expect(zoomFor('multi-page', 1, avail, a4, 2)).toBeCloseTo(1);
  });

  it('a spread is two columns for side-by-side or for the multi-page fit', () => {
    expect(columnsFor('vertical', 'none')).toBe(1);
    expect(columnsFor('vertical', 'one-page')).toBe(1);
    expect(columnsFor('side-by-side', 'none')).toBe(2);
    expect(columnsFor('vertical', 'multi-page')).toBe(2);
  });
});
