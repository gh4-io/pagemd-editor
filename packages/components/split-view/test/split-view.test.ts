// Split view's frame (P9): the divider keeps both panes usable. The frame itself runs in a browser (test/e2e/code-view.spec.ts).
import { describe, expect, it } from 'vitest';
import { clampRatio } from '../src/index.ts';

describe('the divider', () => {
  it('keeps each pane at 15 % or more', () => {
    expect(clampRatio(0.5)).toBe(0.5);
    expect(clampRatio(0)).toBe(0.15);
    expect(clampRatio(1)).toBe(0.85);
    expect(clampRatio(Number.NaN)).toBe(0.5);
  });
});
