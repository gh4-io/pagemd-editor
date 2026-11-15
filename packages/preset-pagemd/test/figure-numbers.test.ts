// P9 (D9, R-164): the outline's figure numbers are @pagemd/syntax's, never recounted. Over pagemd's whole corpus the
// numbers on the outline entries equal the numbers @pagemd/syntax's reader puts on the figure tokens when it reads the
// whole file (the numbering the output prints); and after an edit (a figure inserted, a caption removed) they follow.
import { createDialect } from '@pagemd/syntax';
import { describe, expect, it } from 'vitest';
import { commonmarkItems } from '@pagemd-editor/preset-commonmark';
import { gfmItems } from '@pagemd-editor/preset-gfm';
import { createRegistry, ItemRegistry, rawBlockItem, ViewState } from '@pagemd-editor/core';
import { createTransformer } from '@pagemd-editor/transformer';
import { figureNumbers, numberedOutline, pagemdItems } from '../src/index.ts';
import { corpus, transformerFor } from './corpus-files.ts';

const registry = createRegistry({ items: new ItemRegistry([rawBlockItem, ...commonmarkItems, ...gfmItems, ...pagemdItems()]), view: new ViewState() });

/** What pagemd's reader numbers when it reads the whole file: the figure tokens' numbers, in document order. */
function syntaxNumbers(text: string): (number | undefined)[] {
  return createDialect({ mode: 'editor' })
    .parse(text, {})
    .filter((t) => t.type === 'figure_open' || t.type === 'annotated_image')
    .map((t) => (t.meta as { figureNumber?: number } | null)?.figureNumber);
}

describe('figure numbers come from @pagemd/syntax (D9)', () => {
  const withFigures = corpus.filter((f) => /::FIGURE|annotated-image/.test(f.text));

  it('the corpus has figures to check', () => {
    expect(withFigures.length).toBeGreaterThan(3);
  });

  it.each(withFigures.map((f) => [f.name, f] as const))('%s: the outline numbers are the reader’s numbers', (_name, file) => {
    const doc = transformerFor(file.text).parse(file.text);
    const expected = syntaxNumbers(file.text);
    const positions: number[] = [];
    doc.descendants((node, pos) => {
      if (node.type.name === 'pmd_figure' || node.type.name === 'pmd_annotated_image') positions.push(pos);
      return true;
    });
    // Figures the editor keeps as raw text (none expected) would make the two lists differ in length.
    expect(positions.length).toBe(expected.length);
    const numbers = figureNumbers(doc);
    expect(positions.map((p) => numbers.get(p))).toEqual(expected);
    // Numbered outline entries carry the same numbers.
    for (const entry of numberedOutline(registry, doc).filter((e) => e.kind === 'figure')) expect(entry.number).toBe(numbers.get(entry.pos));
  });

  it('numbers follow edits: a captioned figure inserted first takes 1, the others move up; no caption, no number', () => {
    const text = [
      '<!-- ::FIGURE src="a.png" caption="A" -->',
      '',
      '<!-- ::FIGURE src="b.png" -->',
      '',
      '::: annotated-image c.png',
      'options:',
      '  caption: "C"',
      'markers:',
      '  - { id: 1, x: 10, y: 20, label: "A" }',
      ':::',
      '',
    ].join('\n');
    const t = createTransformer([...commonmarkItems, ...gfmItems, ...pagemdItems()]);
    const doc = t.parse(text);
    const numbered = (d: typeof doc) => numberedOutline(registry, d).map((e) => [e.label, e.number]);
    expect(numbered(doc)).toEqual([
      ['A', 1],
      ['b.png', undefined],
      ['C', 2],
    ]);
    const first = doc.child(0);
    const inserted = doc.copy(doc.content.addToStart(first));
    expect(numbered(inserted)).toEqual([
      ['A', 1],
      ['A', 2],
      ['b.png', undefined],
      ['C', 3],
    ]);
  });
});
