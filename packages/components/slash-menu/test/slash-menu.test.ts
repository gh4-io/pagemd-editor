// When the slash menu opens, and how the highlight moves (P7). The popup itself is in test/e2e/ribbon.spec.ts.
import { Schema } from 'prosemirror-model';
import { EditorState, TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { gateHint, moveHighlight, slashQuery, slashQueryAt } from '../src/index.ts';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block', toDOM: () => ['p', 0] },
    code_block: { content: 'text*', group: 'block', code: true, toDOM: () => ['pre', 0] },
    atom: { inline: true, group: 'inline', atom: true, toDOM: () => ['span'] },
    text: { group: 'inline' },
  },
});
const paragraph = (...content: (string | null)[]) => schema.node('paragraph', null, content.map((c) => (c === null ? schema.node('atom') : schema.text(c))));
/** The state with the cursor at the end of the first block's text. */
function at(doc: ReturnType<typeof schema.node>, end = true): EditorState {
  const state = EditorState.create({ schema, doc });
  const pos = end ? 1 + doc.firstChild!.content.size : 1;
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
}
const doc = (...blocks: ReturnType<typeof schema.node>[]) => schema.node('doc', null, blocks);

describe('slashQuery', () => {
  it('opens for "/" at the start of a block, with the typed query', () => {
    expect(slashQuery(at(doc(paragraph('/'))))).toEqual({ from: 1, to: 2, query: '' });
    expect(slashQuery(at(doc(paragraph('/tab'))))).toEqual({ from: 1, to: 5, query: 'tab' });
  });
  it('opens after a space, but not in the middle of a word or a path', () => {
    expect(slashQuery(at(doc(paragraph('see /ta'))))).toEqual({ from: 5, to: 8, query: 'ta' });
    expect(slashQuery(at(doc(paragraph('a/b'))))).toBeNull();
    expect(slashQuery(at(doc(paragraph('and/or'))))).toBeNull();
    expect(slashQuery(at(doc(paragraph('https://x'))))).toBeNull();
  });
  it('closes when the query has a space or is very long, and when the cursor is not at its end', () => {
    expect(slashQuery(at(doc(paragraph('/ta ble'))))).toBeNull();
    expect(slashQuery(at(doc(paragraph(`/${'x'.repeat(31)}`))))).toBeNull();
    expect(slashQuery(at(doc(paragraph('/tab')), false))).toBeNull();
  });
  it('is not offered in code, for a selection, or right after an inline node', () => {
    expect(slashQuery(at(doc(schema.node('code_block', null, [schema.text('/x')]))))).toBeNull();
    const state = at(doc(paragraph('/tab')));
    expect(slashQuery(state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, 3))))).toBeNull();
    expect(slashQuery(at(doc(paragraph(null, '/x'))))).toBeNull();
  });
});

describe('slashQueryAt (the "/query" found again later, R-157 review)', () => {
  it('finds it from a transaction\'s selection, at its NEW position, and finds nothing once it is gone', () => {
    const state = at(doc(paragraph('/tab')));
    // Text typed before it by someone else (an outside change) moves it: the query is found where it now is.
    const moved = state.tr.insertText('ab ', 1);
    expect(slashQueryAt(moved.selection)).toEqual({ from: 4, to: 8, query: 'tab' });
    // The "/" deleted: nothing to remove.
    const gone = state.tr.delete(1, 2);
    expect(slashQueryAt(gone.selection)).toBeNull();
  });
});

describe('moveHighlight', () => {
  it('wraps around both ways and copes with an empty list', () => {
    expect(moveHighlight(0, 1, 3)).toBe(1);
    expect(moveHighlight(2, 1, 3)).toBe(0);
    expect(moveHighlight(0, -1, 3)).toBe(2);
    expect(moveHighlight(0, 1, 0)).toBe(0);
  });
});

describe('gateHint', () => {
  it('names the property a gated entry needs, only while its gate is off', () => {
    const base = { id: 'x', kind: 'edit', label: 'X', keywords: [], toggle: false, enabled: true, active: false } as const;
    expect(gateHint({ ...base, gate: { field: 'fancy_lists', value: true, satisfied: false } })).toBe('needs fancy_lists');
    expect(gateHint({ ...base, gate: { field: 'fancy_lists', value: true, satisfied: true } })).toBeUndefined();
    expect(gateHint(base)).toBeUndefined();
  });
});
