import { describe, expect, it } from 'vitest';
import { ViewState, type ResolvedStyles } from '@pagemd-editor/core';
import { statusParts, VIEW_LABELS } from '../src/index.ts';

const page = { width: 210, height: 297, margins: { top: 25, right: 25, bottom: 25, left: 25 } };
const defaultStyles = (): ResolvedStyles => ({ css: '', page, usingDefault: true, sources: [] });

describe('status bar', () => {
  it('Draft shows the view and the zoom; no page layout notes', () => {
    const view = new ViewState({ mode: 'draft' });
    expect(statusParts(view.value, { styles: defaultStyles() })).toEqual(['Draft', '100 %']);
  });

  it('page views add the page number, profile and "Using default layout" (ADR-0014)', () => {
    const view = new ViewState({ mode: 'print', zoom: 1.25 });
    expect(statusParts(view.value, { styles: defaultStyles(), page: { current: 2, total: 9 }, profile: 'sop' })).toEqual([
      'Page 2 of 9',
      'Print Layout',
      'sop',
      '125 %',
      'Using default layout',
    ]);
  });

  it('names every view mode', () => {
    expect(Object.keys(VIEW_LABELS).sort()).toEqual(['code', 'draft', 'preview', 'print', 'read', 'split', 'web']);
  });

  it('shows the resolved layout alongside "Using default layout" when both apply (R-128)', () => {
    const view = new ViewState({ mode: 'web' });
    const styles: ResolvedStyles = { ...defaultStyles(), layout: { path: '/pagemd/layouts/letter.css', bundled: true } };
    expect(statusParts(view.value, { styles })).toEqual(['Web Layout', '100 %', 'Using default layout', 'Layout: letter (pagemd)']);
  });

  it('a workspace layout is shown without the "(pagemd)" marker', () => {
    const view = new ViewState({ mode: 'web' });
    const styles: ResolvedStyles = { ...defaultStyles(), usingDefault: false, layout: { path: '/work/.pagemd/layouts/doc.css', bundled: false } };
    expect(statusParts(view.value, { styles })).toEqual(['Web Layout', '100 %', 'Layout: doc']);
  });

  it('appends notes (amendment 9), already formatted by the app', () => {
    const view = new ViewState({ mode: 'web' });
    expect(statusParts(view.value, { styles: { ...defaultStyles(), usingDefault: false }, notes: ['Profile not found: x'] })).toEqual(['Web Layout', '100 %', 'Profile not found: x']);
  });

  // StatusBar's DOM rendering (the clickable view name, R-132) has no DOM in this Vitest environment (no jsdom/
  // happy-dom in this repo); it is exercised in the browser by test/e2e/webview.spec.ts instead.
});

describe('page views: zoom, fit and arrangement controls (P6, amendment 11)', () => {
  it('shows the fit by name while fitting, instead of the percentage', () => {
    const view = new ViewState({ mode: 'print', fit: 'one-page' });
    expect(statusParts(view.value, { styles: defaultStyles() })).toEqual(['Print Layout', 'One page', 'Using default layout']);
  });

  it('lists the page arrangement only when the app gave controls for it (Print Layout, Read)', () => {
    const view = new ViewState({ mode: 'print', pageArrangement: 'side-by-side' });
    const controls = { onArrangement: () => {} };
    expect(statusParts(view.value, { styles: defaultStyles(), controls, page: { current: 1, total: 2 } })).toEqual(['Page 1 of 2', 'Print Layout', '100 %', 'Side by side', 'Using default layout']);
    expect(statusParts(view.value, { styles: defaultStyles() })).not.toContain('Side by side');
  });

  it('Read always fits one page to the window, whatever the zoom says', () => {
    expect(statusParts(new ViewState({ mode: 'read' }).value, {})[1]).toBe('One page');
  });
});
