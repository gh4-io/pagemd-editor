// The Code view's text bookkeeping (P9): the smallest edit between two texts, and a text from elsewhere merged under
// typing not yet sent. The view itself runs in a browser (test/e2e/code-view.spec.ts).
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { kindClass, lineEndingOf, rebase, textDiff, type CodeKind } from '../src/index.ts';

const apply = (text: string, edit: { from: number; to: number; text: string } | null): string => (edit ? text.slice(0, edit.from) + edit.text + text.slice(edit.to) : text);

describe('textDiff', () => {
  it('is null for the same text, else one replacement that makes the new text', () => {
    expect(textDiff('abc', 'abc')).toBeNull();
    expect(textDiff('# Title\n\nBody.\n', '# Title\n\nBody text.\n')).toEqual({ from: 13, to: 13, text: ' text' });
    expect(textDiff('aaa', 'aa')).toEqual({ from: 2, to: 3, text: '' });
  });

  it('always turns one text into the other', () => {
    fc.assert(fc.property(fc.string(), fc.string(), (a, b) => apply(a, textDiff(a, b)) === b));
  });
});

describe('rebase: a text from elsewhere under typing not yet sent', () => {
  it('keeps the typing and takes the other change', () => {
    const base = '# A\n\nOne.\n\nTwo.\n';
    const typed = '# A\n\nOne more.\n\nTwo.\n';
    const incoming = '# A\n\nOne.\n\nTwo changed.\n';
    expect(rebase(base, typed, incoming)).toBe('# A\n\nOne more.\n\nTwo changed.\n');
  });

  it('is the incoming text when nothing was typed, and the typing when nothing came', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (base, other) => {
        expect(rebase(base, base, other)).toBe(other);
        expect(rebase(base, other, base)).toBe(other);
      }),
    );
  });
});

describe('line endings (fix-sync-bugs, bug 7)', () => {
  it('rebase keeps a CRLF file CRLF (CodeMirror holds \'\\n\' lines; before the fix this threw or turned the file to LF)', () => {
    const base = '# A\r\n\r\nOne.\r\n\r\nTwo.\r\n';
    const typed = '# A\r\n\r\nOne more.\r\n\r\nTwo.\r\n';
    const incoming = '# A\r\n\r\nOne.\r\n\r\nTwo changed.\r\n';
    expect(rebase(base, typed, incoming)).toBe('# A\r\n\r\nOne more.\r\n\r\nTwo changed.\r\n');
    expect(rebase(base, base, incoming)).toBe(incoming);
  });

  it('lineEndingOf: the first line break, \'\\n\' when there is none', () => {
    expect(lineEndingOf('a\r\nb\nc')).toBe('\r\n');
    expect(lineEndingOf('a\nb')).toBe('\n');
    expect(lineEndingOf('')).toBe('\n');
  });
});

describe('colors', () => {
  it('every kind but plain text has a class from the highlight style', () => {
    const kinds: CodeKind[] = ['heading', 'code', 'quote', 'list', 'table', 'html', 'directive', 'meta', 'rule', 'raw'];
    for (const kind of kinds) expect(kindClass(kind), kind).toMatch(/\S/);
    expect(kindClass('text')).toBeNull();
  });
});
