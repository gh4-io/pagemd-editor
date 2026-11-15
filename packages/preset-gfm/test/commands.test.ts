// P7: GFM's own commands when pagemd isn't there (strikethrough, Insert Table, the five alerts), written and read back.
import { EditorState, TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { createRegistry, ItemRegistry, ViewState } from '@pagemd-editor/core';
import { commonmarkItems } from '@pagemd-editor/preset-commonmark';
import { createTransformer } from '@pagemd-editor/transformer';
import { gfmItems } from '../src/index.ts';

const items = [...commonmarkItems, ...gfmItems];
const t = createTransformer(items);
const registry = createRegistry({ items: new ItemRegistry([...items]), view: new ViewState() });

function run(id: string, text: string, select?: [number, number]): string {
  const doc = t.parse(text);
  let state = EditorState.create({ schema: t.schema, doc });
  state = state.apply(state.tr.setSelection(TextSelection.create(doc, 1 + (select?.[0] ?? 0), 1 + (select?.[1] ?? 0))));
  const command = registry.commands.get(id)!;
  expect(command.isEnabled(state)).toBe(true);
  let next = state;
  expect(command.run(state, (tr) => (next = state.apply(tr)))).toBe(true);
  const written = t.serialize(next.doc);
  expect(t.serialize(t.parse(written))).toBe(written); // reads back as the same text
  return written;
}

describe('GFM commands without pagemd', () => {
  it('lists exactly its own commands', () => {
    const own = registry.commands.list().map((c) => c.id);
    expect(own).toEqual(expect.arrayContaining(['strikethrough.toggle', 'table.insert', 'alert.note', 'alert.tip', 'alert.important', 'alert.warning', 'alert.caution']));
    expect(own.some((id) => id.startsWith('containers.') || id.startsWith('fancy-lists.'))).toBe(false);
  });
  it('strikethrough, Insert Table and the alerts', () => {
    expect(run('strikethrough.toggle', 'hello world\n', [0, 5])).toBe('~~hello~~ world');
    expect(run('table.insert', 'above\n')).toMatch(/above\n\n\|\s+\|\s+\|\s+\|\n\| --- \| --- \| --- \|\n/);
    expect(run('alert.warning', 'careful\n')).toBe('> [!WARNING]\n> careful');
  });
});
