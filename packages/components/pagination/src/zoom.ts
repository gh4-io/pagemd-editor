// Zoom and fit (P6, amendment 11): the factor the canvas is zoomed by, from the window and the page. Pure.
import type { PageFit, PageGeometry } from '@pagemd-editor/core';
import { PX_PER_MM } from './paginator.ts';

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 4;
/** The zoom steps the status bar offers (1 = 100 %). */
export const ZOOM_STEPS: readonly number[] = [0.5, 0.75, 1, 1.25, 1.5, 2];

export const clampZoom = (z: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/** The pages a row holds for `fit`: 'multi-page' always shows a two-page spread. */
export function columnsFor(arrangement: 'vertical' | 'side-by-side', fit: PageFit): number {
  return arrangement === 'side-by-side' || fit === 'multi-page' ? 2 : 1;
}

/**
 * The zoom for `fit` in a window of `avail` px (the scrolling area, without its own padding): 'page-width' fits a row
 * of `columns` pages across, 'one-page' fits one row in both directions, 'multi-page' is the spread's width. `zoom`
 * when `fit` is 'none'.
 */
export function zoomFor(fit: PageFit, zoom: number, avail: { width: number; height: number }, page: PageGeometry, columns: number): number {
  if (fit === 'none') return clampZoom(zoom);
  const w = page.width * PX_PER_MM * columns;
  const h = page.height * PX_PER_MM;
  const byWidth = avail.width / w;
  if (fit === 'one-page') return clampZoom(Math.min(byWidth, avail.height / h));
  return clampZoom(byWidth);
}
