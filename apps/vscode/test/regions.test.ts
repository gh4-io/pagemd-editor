// P13b (R-208): the rule behind F6 / Shift+F6, without a browser: which region the key goes to, and when it is left to VS Code.
// The keys in a real page are checked in test/e2e/keyboard.spec.ts.
import { describe, expect, it } from 'vitest';
import { nextRegion } from '../webview/regions.ts';

describe('nextRegion (F6 = +1, Shift+F6 = -1)', () => {
  it('goes to the next region and the previous one', () => {
    expect(nextRegion(5, 0, 1)).toBe(1);
    expect(nextRegion(5, 2, 1)).toBe(3);
    expect(nextRegion(5, 3, -1)).toBe(2);
  });

  it('hands the key to VS Code past the last region (F6) and before the first (Shift+F6): null, never a wrap-around', () => {
    expect(nextRegion(5, 4, 1)).toBeNull();
    expect(nextRegion(5, 0, -1)).toBeNull();
    expect(nextRegion(1, 0, 1)).toBeNull();
    expect(nextRegion(1, 0, -1)).toBeNull();
  });

  it('starts at the edge when the focus is in none of the regions (-1): the first for F6, the last for Shift+F6', () => {
    expect(nextRegion(4, -1, 1)).toBe(0);
    expect(nextRegion(4, -1, -1)).toBe(3);
  });

  it('leaves the key alone when nothing is shown', () => {
    expect(nextRegion(0, -1, 1)).toBeNull();
    expect(nextRegion(0, 0, -1)).toBeNull();
  });
});
