// The ruler's margin arithmetic (P6, amendment 9): snapping and limits. The handles and the drag are exercised in
// the browser (test/e2e/print-layout.spec.ts).
import { describe, expect, it } from 'vitest';
import type { PageGeometry } from '@pagemd-editor/core';
import { MIN_BODY_MM, sameMargins, snapMm, withMargin } from '../src/index.ts';

const a4: PageGeometry = { width: 210, height: 297, margins: { top: 25, right: 25, bottom: 25, left: 25 } };

describe('withMargin', () => {
  it('sets one margin, snapped to half a millimetre, the others kept', () => {
    expect(withMargin(a4, 'left', 19.8).margins).toEqual({ top: 25, right: 25, bottom: 25, left: 20 });
    expect(withMargin(a4, 'bottom', 12.3).margins.bottom).toBe(12.5);
    expect(snapMm(7.26)).toBe(7.5);
  });

  it('never goes negative, and leaves the text area its minimum size', () => {
    expect(withMargin(a4, 'top', -5).margins.top).toBe(0);
    expect(withMargin(a4, 'left', 500).margins.left).toBe(210 - 25 - MIN_BODY_MM);
    expect(withMargin(a4, 'bottom', 500).margins.bottom).toBe(297 - 25 - MIN_BODY_MM);
  });

  it('knows an unchanged page', () => {
    expect(sameMargins(a4, withMargin(a4, 'right', 25.1))).toBe(true);
    expect(sameMargins(a4, withMargin(a4, 'right', 30))).toBe(false);
  });
});
