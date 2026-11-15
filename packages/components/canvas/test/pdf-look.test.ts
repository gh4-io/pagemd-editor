// P18: the views styled by the profile draw the text as pagemd's PDF does: a soft line break (kept in the text, R-85 B) as a space,
// a tight list's items without paragraph gaps. The plugin marks them; kept up to date per change (only touched blocks are read again).
import { Schema } from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';
import type { DecorationSet } from 'prosemirror-view';
import { describe, expect, it } from 'vitest';
import { pdfLook, SOFT_BREAK_CLASS, TIGHT_ATTRIBUTE } from '../src/index.ts';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    code_block: { group: 'block', content: 'text*', code: true },
    bullet_list: { group: 'block', content: 'list_item+', attrs: { tight: { default: true } } },
    list_item: { content: 'block+' },
    text: { group: 'inline' },
  },
});
const p = (text: string) => schema.node('paragraph', null, text ? schema.text(text) : undefined);
const doc = schema.node('doc', null, [
  p('one\ntwo\nthree'),
  schema.node('code_block', null, schema.text('a\nb')),
  schema.node('bullet_list', { tight: true }, [schema.node('list_item', null, p('x'))]),
  schema.node('bullet_list', { tight: false }, [schema.node('list_item', null, p('y'))]),
]);

const decorationsOf = (state: EditorState) => {
  const plugin = state.plugins[0]!;
  const set = plugin.getState(state) as DecorationSet;
  return set.find().map((d) => {
    const spec = (d as unknown as { type: { attrs: Record<string, string> } }).type.attrs;
    return spec['class'] === SOFT_BREAK_CLASS ? `break ${state.doc.textBetween(d.from, d.to) === '\n' ? 'ok' : 'wrong'} @${d.from}` : `tight @${d.from}-${d.to}`;
  });
};

describe('pdfLook', () => {
  it('marks every soft break outside code, and every tight list', () => {
    const state = EditorState.create({ doc, plugins: [pdfLook()] });
    const found = decorationsOf(state);
    expect(found.filter((d) => d.startsWith('break'))).toEqual(['break ok @4', 'break ok @8']);
    expect(found.filter((d) => d.startsWith('tight'))).toHaveLength(1);
    expect(TIGHT_ATTRIBUTE).toBe('data-tight');
  });

  it('follows edits: a typed line break is marked, a removed one is gone, the rest move with the text', () => {
    let state = EditorState.create({ doc, plugins: [pdfLook()] });
    state = state.apply(state.tr.insertText('\nnew', 1)); // "\nnewone\ntwo\nthree"
    expect(decorationsOf(state).filter((d) => d.startsWith('break'))).toEqual(['break ok @1', 'break ok @8', 'break ok @12']);
    state = state.apply(state.tr.delete(1, 2));
    expect(decorationsOf(state).filter((d) => d.startsWith('break'))).toEqual(['break ok @7', 'break ok @11']);
  });
});
