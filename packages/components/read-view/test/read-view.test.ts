// Read view's page arithmetic and keys (P6, amendment 10): pure. The window and the flips are exercised in the
// browser (test/e2e/print-layout.spec.ts).
import { describe, expect, it } from 'vitest';
import { flipForClick, flipForKey, flipped, windowOf } from '../src/index.ts';

const key = (k: string, extra: object = {}) => ({ key: k, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...extra });

describe('windowOf', () => {
  it('one page, or a spread of pages 1+2, 3+4, …; the last spread of an odd count is a single page', () => {
    expect(windowOf(3, 9, false)).toEqual({ first: 3, last: 3 });
    expect(windowOf(3, 9, true)).toEqual({ first: 2, last: 3 });
    expect(windowOf(8, 9, true)).toEqual({ first: 8, last: 8 });
    expect(windowOf(99, 9, false)).toEqual({ first: 8, last: 8 });
    expect(windowOf(0, 0, true)).toEqual({ first: 0, last: 0 });
  });
});

describe('flipped', () => {
  it('moves by a page or a spread and stops at both ends', () => {
    expect(flipped(0, 'next', 5, false)).toBe(1);
    expect(flipped(4, 'next', 5, false)).toBe(4);
    expect(flipped(0, 'previous', 5, false)).toBe(0);
    expect(flipped(0, 'next', 5, true)).toBe(2);
    expect(flipped(2, 'next', 5, true)).toBe(4);
    expect(flipped(4, 'next', 5, true)).toBe(4);
    expect(flipped(4, 'previous', 5, true)).toBe(2);
    expect(flipped(3, 'first', 5, true)).toBe(0);
    expect(flipped(0, 'last', 5, true)).toBe(4);
    expect(flipped(0, 'last', 6, true)).toBe(4);
  });
});

describe('keys and clicks', () => {
  it('arrows, Page keys and Space flip; Home/End jump; modified keys are left to the browser', () => {
    expect(flipForKey(key('ArrowRight'))).toBe('next');
    expect(flipForKey(key('PageDown'))).toBe('next');
    expect(flipForKey(key(' '))).toBe('next');
    expect(flipForKey(key(' ', { shiftKey: true }))).toBe('previous');
    expect(flipForKey(key('ArrowUp'))).toBe('previous');
    expect(flipForKey(key('Home'))).toBe('first');
    expect(flipForKey(key('End'))).toBe('last');
    expect(flipForKey(key('a'))).toBeNull();
    expect(flipForKey(key('ArrowRight', { ctrlKey: true }))).toBeNull();
  });

  it('the left half of the window goes back, the right half forward', () => {
    expect(flipForClick(100, 0, 1000)).toBe('previous');
    expect(flipForClick(900, 0, 1000)).toBe('next');
  });
});
