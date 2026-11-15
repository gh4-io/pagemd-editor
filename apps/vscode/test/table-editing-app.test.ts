// P16 at the app level: copying a cell selection puts a markdown table on the clipboard (amendment 9), pasting a
// markdown table into a cell selection fills the cells, and the layout file's Table tab places the table commands.
import type { Node, Slice } from 'prosemirror-model';
import { EditorState, type Plugin } from 'prosemirror-state';
import { CellSelection, TableMap } from 'prosemirror-tables';
import { describe, expect, it } from 'vitest';
import { createEditor, parseRibbonLayout } from '@pagemd-editor/core';
import { clipboardPlugin } from '@pagemd-editor/plugin-clipboard';
import { commonmarkPreset } from '@pagemd-editor/preset-commonmark';
import { gfmPreset } from '@pagemd-editor/preset-gfm';
import { pagemdPreset, tableEditingPlugins } from '@pagemd-editor/preset-pagemd';
import { createTransformer } from '@pagemd-editor/transformer';
import ribbonLayoutFile from '../webview/ribbon.layout.json';

type ClipboardProps = Plugin & { props: { clipboardTextSerializer?: (slice: Slice, view: unknown) => string; clipboardTextParser?: (text: string) => Slice } };

const TEXT = '| A | B | C |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n\nafter\n';

async function setup(): Promise<{ doc: Node; state: EditorState; serialize: (slice: Slice, state: EditorState) => string; transformer: ReturnType<typeof createTransformer> }> {
  const editor = await createEditor({ presets: [commonmarkPreset, gfmPreset, pagemdPreset()], plugins: [clipboardPlugin()], ribbonLayout: parseRibbonLayout(ribbonLayoutFile) });
  const transformer = createTransformer(editor.registry.items(), { schema: editor.schema });
  const doc = transformer.parse(TEXT);
  const plugin = editor.pmPlugins[0] as ClipboardProps;
  return { doc, state: EditorState.create({ schema: editor.schema, doc, plugins: tableEditingPlugins() }), serialize: (slice, state) => plugin.props.clipboardTextSerializer!(slice, { state }), transformer };
}

function cellSelection(state: EditorState, from: [number, number], to: [number, number]): EditorState {
  let table: { node: Node; pos: number } | undefined;
  state.doc.descendants((node, pos) => {
    if (node.type.name === 'table' && !table) table = { node, pos };
    return !table;
  });
  const map = TableMap.get(table!.node);
  const at = (r: number, c: number): number => table!.pos + 1 + map.map[r * map.width + c]!;
  return state.apply(state.tr.setSelection(CellSelection.create(state.doc, at(...from), at(...to))));
}

describe('P16: copying cells', () => {
  it('a cell selection is copied as a markdown table of just those cells (the header row with them)', async () => {
    const { state, serialize } = await setup();
    const picked = cellSelection(state, [0, 1], [2, 2]);
    expect(serialize(picked.selection.content(), picked)).toBe('| B | C |\n| :---: | ---: |\n| 2 | 3 |\n| 5 | 6 |');
  });

  it('only body cells: the first copied row becomes the header, so it is an ordinary markdown table', async () => {
    const { state, serialize, transformer } = await setup();
    const picked = cellSelection(state, [1, 0], [2, 1]);
    const text = serialize(picked.selection.content(), picked);
    expect(text).toBe('| 1 | 2 |\n| :--- | :---: |\n| 4 | 5 |');
    expect(transformer.parse(text).child(0).type.name).toBe('table');
  });

  it('a whole-table selection and ordinary text copy as before', async () => {
    const { state, serialize } = await setup();
    const all = cellSelection(state, [0, 0], [2, 2]);
    expect(serialize(all.selection.content(), all)).toBe('| A | B | C |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |');
    expect(serialize(state.doc.slice(0, state.doc.content.size), state)).toBe(TEXT.trimEnd());
  });
});

describe('P16: the Table tab', () => {
  it('is the tab after Insert, always placed, and holds every table command', async () => {
    const layout = parseRibbonLayout(ribbonLayoutFile);
    expect(layout.tabs.map((t) => t.id)).toEqual(['home', 'insert', 'table', 'image', 'layout', 'document', 'review', 'view']); // P20: Image after Table
    const tab = layout.tabs.find((t) => t.id === 'table')!;
    expect(tab.groups.map((g) => g.label)).toEqual(['Rows', 'Columns', 'Cells', 'Align', 'Width', 'Table']);
    expect(tab.groups.flatMap((g) => g.commands)).toHaveLength(25);
    expect(tab.groups.some((g) => g.reserved)).toBe(false);
  });
});
