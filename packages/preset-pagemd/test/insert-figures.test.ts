// P11: `insertFigures`, what image paste and drop insert: a figure for each file, as one edit, the first one selected so
// the Inspector shows its caption (R-174).
import { EditorState, NodeSelection, TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { RAW_BLOCK } from '@pagemd-editor/core';
import { commonmarkItems } from '@pagemd-editor/preset-commonmark';
import { gfmItems } from '@pagemd-editor/preset-gfm';
import { createTransformer } from '@pagemd-editor/transformer';
import { insertFigures, pagemdItems } from '../src/index.ts';
import { setFigureStyle } from '../src/index.ts';
setFigureStyle('native'); // these tests are about the picture tools, in the native style; the readable default has its own tests (readable-figures.test.ts)

const t = createTransformer([...commonmarkItems, ...gfmItems, ...pagemdItems({ fields: { fancy_lists: true } })]);
const stateFor = (text: string, pos?: number): EditorState => {
  const doc = t.parse(text);
  const state = EditorState.create({ doc, schema: t.schema });
  return pos === undefined ? state : state.apply(state.tr.setSelection(TextSelection.near(doc.resolve(pos))));
};

describe('insertFigures', () => {
  it('puts one figure per file below the cursor, with no caption yet, and writes the author-visible directive', () => {
    const state = stateFor('First paragraph.\n\nSecond.\n', 3);
    const tr = insertFigures(state, ['.pagemd/assets/img/a.png', '.pagemd/assets/img/b.png'])!;
    const next = state.apply(tr);
    const text = t.serialize(next.doc);
    expect(text).toBe('First paragraph.\n\n<!-- ::FIGURE src=".pagemd/assets/img/a.png" -->\n\n<!-- ::FIGURE src=".pagemd/assets/img/b.png" -->\n\nSecond.');
    // it reads back as figures, not raw blocks
    const again = t.parse(`${text}\n`);
    const names: string[] = [];
    again.descendants((n) => void names.push(n.type.name));
    expect(names.filter((n) => n === 'pmd_figure')).toHaveLength(2);
    expect(names).not.toContain(RAW_BLOCK);
  });
  it('is one transaction, and selects the first figure (what the Inspector shows)', () => {
    const state = stateFor('Only paragraph.\n', 3);
    const tr = insertFigures(state, ['a.png', 'b.png', 'c.png'])!;
    expect(tr.docChanged).toBe(true);
    const next = state.apply(tr);
    expect(next.selection).toBeInstanceOf(NodeSelection);
    expect((next.selection as NodeSelection).node.type.name).toBe('pmd_figure');
    expect((next.selection as NodeSelection).node.attrs['data'].attrs.src).toBe('a.png');
    expect(next.doc.lastChild!.type.name).toBe('paragraph'); // room to keep typing after the figures
  });
  it('replaces an empty paragraph rather than leaving it above the figure', () => {
    const next = stateFor('\n').apply(insertFigures(stateFor('\n'), ['a.png'])!);
    expect(next.doc.firstChild!.type.name).toBe('pmd_figure');
  });
  it('nothing to insert is null', () => {
    expect(insertFigures(stateFor('Text.\n', 3), [])).toBeNull();
  });
  it('a caption typed later is the figure\'s own field: the file name is never used as one', () => {
    const next = stateFor('Text.\n', 3).apply(insertFigures(stateFor('Text.\n', 3), ['Login screen.png'])!);
    expect(t.serialize(next.doc)).not.toMatch(/caption/);
  });
});
