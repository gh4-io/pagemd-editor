// P9 (R-164): VS Code's own Outline. The host's symbol provider lists pagemd's items from the same outline the Outline
// panel shows: the frontmatter title first, figures with @pagemd/syntax's numbers, tables, boxes, the TOC, includes. The
// headings are left to VS Code's Markdown extension (AD-P9-03: test:vscode showed them twice otherwise).
import { describe, expect, it } from 'vitest';
import * as mock from '../../../__mocks__/vscode.ts';
import { outlineSymbols, PagemdSymbolProvider } from '../host/symbols.ts';

const DOC = [
  '---',
  'title: The guide',
  '---',
  '',
  '# Start',
  '',
  '<!-- ::TOC -->',
  '',
  '<!-- ::FIGURE src="a.png" caption="Login" -->',
  '',
  '## Tables',
  '',
  '| A | B |',
  '|---|---|',
  '| 1 | 2 |',
  '',
  ':::note Remember',
  'Inside.',
  ':::',
  '',
  '<!-- ::FIGURE src="b.png" -->',
  '',
  '<!-- ::FIGURE src="c.png" caption="Logout" -->',
  '',
].join('\n');

describe('the native Outline (symbol provider)', () => {
  it('lists the title first, then pagemd’s items in order, figures numbered; no headings', () => {
    expect(outlineSymbols(DOC).map((s) => [s.kind, s.name])).toEqual([
      ['title', 'The guide'],
      ['toc', 'Table of contents'],
      ['figure', 'Figure 1: Login'],
      ['table', 'Table'],
      ['box', 'Remember'],
      ['figure', 'b.png'],
      ['figure', 'Figure 2: Logout'],
    ]);
  });

  it('can list the headings too (off: VS Code’s Markdown extension lists them)', () => {
    expect(outlineSymbols(DOC, { headings: true }).filter((s) => s.kind === 'heading').map((s) => s.name)).toEqual(['Start', 'Tables']);
  });

  it('each symbol covers its block’s text', () => {
    for (const symbol of outlineSymbols(DOC)) {
      const text = DOC.slice(symbol.from, symbol.to);
      if (symbol.kind === 'figure') expect(text).toMatch(/^<!-- ::FIGURE/);
      if (symbol.kind === 'title') expect(text).toMatch(/^---\ntitle: The guide\n---$/);
      if (symbol.kind === 'table') expect(text).toMatch(/^\| A \| B \|/);
    }
  });

  it('gives VS Code DocumentSymbols with line ranges', () => {
    const doc = new mock.MockTextDocument(mock.Uri.file('/w/a.md'), DOC);
    const symbols = new PagemdSymbolProvider().provideDocumentSymbols(doc as never) as unknown as mock.DocumentSymbol[];
    expect(symbols[0]).toMatchObject({ name: 'The guide', kind: mock.SymbolKind.File, range: { start: { line: 0, character: 0 }, end: { line: 2, character: 3 } } });
    expect(symbols.find((s) => s.name === 'Figure 1: Login')).toMatchObject({ kind: mock.SymbolKind.Object, range: { start: { line: 8 } } });
  });

  it('a plain markdown file has nothing to add to the Markdown extension’s headings', () => {
    expect(outlineSymbols('# A\n\nText.\n')).toEqual([]);
  });
});
