// P16 review fixes: a multi-line row in a header or headerless table never fails the document; a hard break in a cell
// round-trips; switching the caption kind never loses a caption.
import { EditorState } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { RAW_BLOCK } from '@pagemd-editor/core';
import { applyEdits, diffToEdits } from '@pagemd-editor/lossless';
import { pagemdPreset, tableEditingPlugins } from '../src/index.ts';
import { transformerFor } from './corpus-files.ts';


function typeInFirstCell(src: string): { out: string; again: ReturnType<ReturnType<typeof transformerFor>['parse']> } {
  const t = transformerFor(src);
  const doc = t.parse(src);
  let pos = -1;
  doc.descendants((n, p) => {
    if (pos < 0 && /^table_(header_)?cell$/.test(n.type.name)) pos = p;
    return pos < 0;
  });
  expect(pos, 'a table').toBeGreaterThanOrEqual(0);
  let state = EditorState.create({ schema: t.schema, doc, plugins: tableEditingPlugins() });
  state = state.apply(state.tr.insertText('Z', pos + 1));
  const out = t.serialize(state.doc);
  return { out, again: t.parse(out) };
}

describe('review fix 1: no throw for a multi-line row without a header, or in the header', () => {
  for (const src of ['para\n\n| a | b | \\\n| c | d |\n|---|---|\n| 1 | 2 |\n', '|---|---|\n| one | x | \\\n| two | y |\n']) {
    it(JSON.stringify(src), () => {
      const t = transformerFor(src);
      expect(() => t.parse(src)).not.toThrow();
      const doc = t.parse(src);
      expect(applyEdits(src, diffToEdits(doc, doc, src))).toBe(src);
      const { out, again } = typeInFirstCell(src);
      expect(out).toContain('Z');
      const letters = (text: string): string => [...text.replace(/\s/g, '')].sort().join('');
      expect(letters(again.textContent)).toBe(letters(`Z${doc.textContent}`));
    });
  }
});

describe('review fix 2: a hard break in a cell is a line break, not a backslash', () => {
  it('in a multi-line row', () => {
    const { out, again } = typeInFirstCell('| a | b |\n|---|---|\n| one\\ | x | \\\n| two | y |\n');
    expect(out).toBe('| Za | b |\n| --- | --- |\n| one\\ | x | \\\n| two | y |');
    expect(JSON.stringify(again.toJSON())).not.toContain(RAW_BLOCK);
  });
  it('a hard break typed in a one-line row makes the row multi-line, no text bent', () => {
    const t = transformerFor('| a | b |\n|---|---|\n| 1 | 2 |\n');
    const doc = t.parse('| a | b |\n|---|---|\n| 1 | 2 |\n');
    let at = -1;
    doc.descendants((n, p) => {
      if (at < 0 && n.type.name === 'table_cell') at = p;
      return at < 0;
    });
    let state = EditorState.create({ schema: t.schema, doc, plugins: tableEditingPlugins() });
    state = state.apply(state.tr.insert(at + 2, t.schema.nodes['hard_break']!.create()));
    const out = t.serialize(state.doc);
    expect(out).not.toContain('\\ ');
    expect(t.parse(out).child(0).type.name).toBe('table');
    expect(t.parse(out).textContent.replace(/\s/g, '')).toBe('ab12');
  });
});

describe('review fix 3: the caption kind is not switched when both kinds exist', () => {
  it('no caption text is lost', () => {
    const src = 'Table: Para cap\n\n[Bracket cap]\n| a | b |\n|---|---|\n| 1 | 2 |\n';
    const t = transformerFor(src);
    const doc = t.parse(src);
    const bindings = pagemdPreset().items.find((i) => i.id === 'multimd-table')!.fields!['table']!;
    const table = doc.child(0);
    const values = { ...bindings.values(table), captionKind: 'Table: paragraph' };
    const attrs = { ...table.attrs, ...bindings.apply(table, values) };
    const model = attrs['model'] as { caption: { text: string } | null; tableCaption: { text: string } | null };
    expect([model.caption?.text, model.tableCaption?.text]).toEqual(['Bracket cap', 'Para cap']);
  });
});
