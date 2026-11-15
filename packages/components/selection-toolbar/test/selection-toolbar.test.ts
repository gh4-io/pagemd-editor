// When the floating toolbar shows, and its compact labels (P7). The bar itself is in test/e2e/ribbon.spec.ts.
import { Schema } from 'prosemirror-model';
import { EditorState, NodeSelection, TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import type { Action } from '@pagemd-editor/core';
import { shortLabel, toolbarVisible } from '../src/index.ts';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block', toDOM: () => ['p', 0] },
    code_block: { content: 'text*', group: 'block', code: true, toDOM: () => ['pre', 0] },
    atom: { inline: true, group: 'inline', atom: true, selectable: true, toDOM: () => ['span'] },
    text: { group: 'inline' },
  },
});
const doc = schema.node('doc', null, [
  schema.node('paragraph', null, [schema.text('hello world'), schema.node('atom')]),
  schema.node('code_block', null, [schema.text('x = 1')]),
]);
const state = EditorState.create({ schema, doc });
const select = (from: number, to: number) => state.apply(state.tr.setSelection(TextSelection.create(doc, from, to)));

describe('toolbarVisible', () => {
  it('shows for selected text in an editable canvas', () => {
    expect(toolbarVisible(select(1, 6), true)).toBe(true);
  });
  it('hides for an empty selection, a read-only canvas, code, and a selected node', () => {
    expect(toolbarVisible(select(3, 3), true)).toBe(false);
    expect(toolbarVisible(select(1, 6), false)).toBe(false);
    expect(toolbarVisible(select(16, 19), true)).toBe(false);
    expect(toolbarVisible(state.apply(state.tr.setSelection(NodeSelection.create(doc, 12))), true)).toBe(false);
  });
});

describe('shortLabel', () => {
  const action = (label: string): Action => ({ id: label, kind: 'edit', label, keywords: [], toggle: false, enabled: true, active: false });
  it('shortens heading labels and keeps the others', () => {
    expect(shortLabel(action('Heading 2'))).toBe('H2');
    expect(shortLabel(action('Bold'))).toBe('Bold');
    expect(shortLabel(action('Heading'))).toBe('Heading');
  });
});
