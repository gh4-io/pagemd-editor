import { describe, expect, it } from 'vitest';
import { mapOffset, rebase, textDiff } from '../src/index';

describe('code-view-monaco helpers', () => {
  it('maps an offset past an insertion at the same point only when it is a start', () => {
    const insert = { from: 3, to: 3, text: 'xx' };
    expect(mapOffset(3, insert, 1)).toBe(5);
    expect(mapOffset(3, insert, -1)).toBe(3);
  });
  it('puts an incoming change on top of typing not yet sent', () => {
    expect(rebase('one\ntwo\n', 'ONE\ntwo\n', 'one\ntwo\nthree\n')).toBe('ONE\ntwo\nthree\n');
  });
  it('keeps the incoming line ending', () => {
    expect(rebase('a\r\nb', 'a\r\nbc', 'A\r\nb')).toBe('A\r\nbc');
    expect(textDiff('ab', 'ab')).toBeNull();
  });
});
