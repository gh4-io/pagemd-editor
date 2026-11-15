// P16: the table commands on real tables (spans, two header rows, two bodies, headerless, caption, `{…}`, multi-line).
// Each runs on a document, is written by the items' own writers, read back by the same reader, and must read back as
// the document the command made (no raw block, nothing lost). Also the tidy step on planted bad states, and the
// table-only keys.
import type { Node } from 'prosemirror-model';
import { EditorState, TextSelection } from 'prosemirror-state';
import { CellSelection, TableMap } from 'prosemirror-tables';
import { describe, expect, it } from 'vitest';
import { createRegistry, ItemRegistry, RAW_BLOCK, ViewState, type CommandSpec } from '@pagemd-editor/core';
import { commonmarkItems } from '@pagemd-editor/preset-commonmark';
import { gfmItems } from '@pagemd-editor/preset-gfm';
import { createTransformer } from '@pagemd-editor/transformer';
import { pagemdItems, tableEditingPlugins, tidyTable } from '../src/index.ts';

const all = [...commonmarkItems, ...gfmItems, ...pagemdItems()];
const t = createTransformer(all);
const registry = createRegistry({ items: new ItemRegistry([...all]), view: new ViewState() });
const get = (id: string): CommandSpec => {
  const found = registry.commands.get(id);
  if (!found) throw new Error(`no command ${id}`);
  return found;
};

export const BASIC = '| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |';
const ALIGNED = '| A | B | C |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |';
const TWO_BODIES = '| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n\n| 5 | 6 |\n| 7 | 8 |';
const TWO_HEADERS = '| A | B |\n| X | Y |\n| --- | --- |\n| 1 | 2 |';
const HEADERLESS = '| --- | --- |\n| 1 | 2 |\n| 3 | 4 |';
const SPANS = '| A | B | C |\n| --- | --- | --- |\n| tall | 2 | 3 |\n| ^^ | 5 | 6 |\n| wide || 9 |';
const CAPTIONED = 'Table: Numbers\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n{.striped #t1}';
const MULTILINE = '| A | B |\n| --- | --- |\n| one | x | \\\n| two | y |\n| 3 | 4 |';

/** The state with the plugins the app adds; the cursor in the cell at (row, col) of the first table. */
function stateFor(text: string, at: [number, number] = [0, 0], to?: [number, number]): EditorState {
  const doc = t.parse(text);
  const state = EditorState.create({ schema: t.schema, doc, plugins: tableEditingPlugins() });
  const found = tableOf(doc);
  const map = TableMap.get(found.node);
  const cell = (r: number, c: number): number => found.pos + 1 + map.map[r * map.width + c]!;
  const selection = to ? CellSelection.create(doc, cell(...at), cell(...to)) : TextSelection.create(doc, cell(...at) + 1);
  return state.apply(state.tr.setSelection(selection));
}

function tableOf(doc: Node): { node: Node; pos: number } {
  let found: { node: Node; pos: number } | undefined;
  doc.descendants((node, pos) => {
    if (node.type.name === 'table' && !found) found = { node, pos };
    return !found;
  });
  if (!found) throw new Error('no table');
  return found;
}

/** Without what is only display (a cell's alignment mirror) the JSON of a document. */
const json = (doc: Node): unknown => JSON.parse(JSON.stringify(doc.toJSON()));

function run(id: string, state: EditorState): EditorState {
  const command = get(id);
  expect(command.isEnabled(state), `${id} should be enabled`).toBe(true);
  let next = state;
  expect(command.run(state, (tr) => (next = state.apply(tr)))).toBe(true);
  return next;
}

/** Runs the command; the written text, with the check that it reads back as the document the command made. */
function act(id: string, text: string, at?: [number, number], to?: [number, number]): string {
  const next = run(id, stateFor(text, at, to));
  const written = t.serialize(next.doc);
  const again = t.parse(written);
  expect(JSON.stringify(again.toJSON()).includes(RAW_BLOCK), 'the written table must stay a table').toBe(false);
  expect(json(again)).toEqual(json(next.doc));
  expect(t.serialize(again)).toBe(written);
  return written;
}

const enabled = (id: string, text: string, at?: [number, number], to?: [number, number]): boolean => get(id).isEnabled(stateFor(text, at, to));

describe('rows', () => {
  it('add-row-above / below put a body row next to the cursor row', () => {
    expect(act('table.add-row-above', BASIC, [1, 1])).toBe('| A | B | C |\n| --- | --- | --- |\n|  |  |  |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |');
    expect(act('table.add-row-below', BASIC, [2, 0])).toBe('| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n|  |  |  |');
  });

  it('below the (last) header row is a body row, above the header row is a header row', () => {
    expect(act('table.add-row-below', BASIC, [0, 0])).toBe('| A | B | C |\n| --- | --- | --- |\n|  |  |  |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |');
    expect(act('table.add-row-above', BASIC, [0, 1])).toBe('|  |  |  |\n| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |');
  });

  it('a row added in the second body stays in the second body (its group, not the first)', () => {
    expect(act('table.add-row-above', TWO_BODIES, [3, 0])).toBe('| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n\n|  |  |\n| 5 | 6 |\n| 7 | 8 |');
    expect(act('table.add-row-below', TWO_BODIES, [4, 1])).toBe('| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n\n| 5 | 6 |\n| 7 | 8 |\n|  |  |');
    expect(act('table.add-row-below', TWO_BODIES, [2, 1])).toBe('| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n|  |  |\n\n| 5 | 6 |\n| 7 | 8 |');
  });

  it('a second header row, in a headerless table, with spans, with a caption and `{…}`', () => {
    expect(act('table.add-row-below', TWO_HEADERS, [1, 0])).toBe('| A | B |\n| X | Y |\n| --- | --- |\n|  |  |\n| 1 | 2 |');
    expect(act('table.add-row-above', TWO_HEADERS, [1, 0])).toBe('| A | B |\n|  |  |\n| X | Y |\n| --- | --- |\n| 1 | 2 |');
    expect(act('table.add-row-below', HEADERLESS, [0, 0])).toBe('| --- | --- |\n| 1 | 2 |\n|  |  |\n| 3 | 4 |');
    expect(act('table.add-row-above', CAPTIONED, [1, 0])).toBe('Table: Numbers\n\n| A | B |\n| --- | --- |\n|  |  |\n| 1 | 2 |\n{.striped #t1}');
  });

  it('a row added inside a rowspan makes it taller, a row at its edge does not', () => {
    expect(act('table.add-row-below', SPANS, [1, 1])).toBe('| A | B | C |\n| --- | --- | --- |\n| tall | 2 | 3 |\n| ^^ |  |  |\n| ^^ | 5 | 6 |\n| wide || 9 |');
    expect(act('table.add-row-below', SPANS, [2, 1])).toBe('| A | B | C |\n| --- | --- | --- |\n| tall | 2 | 3 |\n| ^^ | 5 | 6 |\n|  |  |  |\n| wide || 9 |');
  });

  it('delete-row removes the cursor row (and every selected row)', () => {
    expect(act('table.delete-row', BASIC, [1, 1])).toBe('| A | B | C |\n| --- | --- | --- |\n| 4 | 5 | 6 |');
    expect(act('table.delete-row', BASIC, [1, 0], [2, 2])).toBe('| A | B | C |\n| --- | --- | --- |');
    expect(act('table.delete-row', BASIC, [0, 0])).toBe('| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |');
    expect(enabled('table.delete-row', BASIC, [0, 0], [2, 2])).toBe(true); // every row: Word deletes the table (AD-FIX-WS-02)
    expect(act('table.delete-row', BASIC, [0, 0], [2, 2])).not.toContain('| A |');
  });

  it('move-row-up / down swap the row with its neighbour; not into or out of the header; not a lone-row edge', () => {
    expect(act('table.move-row-up', BASIC, [2, 1])).toBe('| A | B | C |\n| --- | --- | --- |\n| 4 | 5 | 6 |\n| 1 | 2 | 3 |');
    expect(act('table.move-row-down', BASIC, [1, 1])).toBe('| A | B | C |\n| --- | --- | --- |\n| 4 | 5 | 6 |\n| 1 | 2 | 3 |');
    expect(enabled('table.move-row-up', BASIC, [1, 1])).toBe(false); // would go into the header
    expect(enabled('table.move-row-down', BASIC, [0, 1])).toBe(false);
    expect(enabled('table.move-row-down', BASIC, [2, 1])).toBe(false);
    // FIX-PGF (AD-FIX-PGF-06, Word's way): a row next to a cell two rows tall moves past both of its rows, and the two rows tied by
    // the tall cell move as one block (before, both were off).
    expect(act('table.move-row-up', SPANS, [3, 1])).toBe('| A | B | C |\n| --- | --- | --- |\n| wide || 9 |\n| tall | 2 | 3 |\n| ^^ | 5 | 6 |');
    expect(act('table.move-row-down', SPANS, [1, 0])).toBe('| A | B | C |\n| --- | --- | --- |\n| wide || 9 |\n| tall | 2 | 3 |\n| ^^ | 5 | 6 |');
    expect(act('table.move-row-down', SPANS, [2, 2])).toBe('| A | B | C |\n| --- | --- | --- |\n| wide || 9 |\n| tall | 2 | 3 |\n| ^^ | 5 | 6 |'); // from the covered row too
    expect(enabled('table.move-row-up', SPANS, [2, 1])).toBe(false); // the block would go into the header
  });

  it('FIX-PGF: a block of three rows tied by a tall cell moves down past the next row as a whole (prosemirror-tables would misplace it)', () => {
    const TALL3 = '| A | B |\n| --- | --- |\n| tall | 1 |\n| ^^ | 2 |\n| ^^ | 3 |\n| x | y |\n| z | w |';
    expect(act('table.move-row-down', TALL3, [2, 1])).toBe('| A | B |\n| --- | --- |\n| x | y |\n| tall | 1 |\n| ^^ | 2 |\n| ^^ | 3 |\n| z | w |');
    // and the row below it moves up past the whole block
    expect(act('table.move-row-up', TALL3, [4, 1])).toBe('| A | B |\n| --- | --- |\n| x | y |\n| tall | 1 |\n| ^^ | 2 |\n| ^^ | 3 |\n| z | w |');
  });

  it('a row moved across two bodies lands in the other body (the groups stay where the rows are)', () => {
    expect(act('table.move-row-down', TWO_BODIES, [2, 0])).toBe('| A | B |\n| --- | --- |\n| 1 | 2 |\n| 5 | 6 |\n\n| 3 | 4 |\n| 7 | 8 |');
  });
});

describe('columns', () => {
  it('add-column-left / right add a cell to every row and a separator cell, with no alignment', () => {
    expect(act('table.add-column-right', BASIC, [1, 1])).toBe('| A | B |  | C |\n| --- | --- | --- | --- |\n| 1 | 2 |  | 3 |\n| 4 | 5 |  | 6 |');
    expect(act('table.add-column-left', BASIC, [1, 0])).toBe('|  | A | B | C |\n| --- | --- | --- | --- |\n|  | 1 | 2 | 3 |\n|  | 4 | 5 | 6 |');
  });

  it('alignment stays with its column when columns are added, deleted and moved', () => {
    expect(act('table.add-column-left', ALIGNED, [1, 1])).toBe('| A |  | B | C |\n| :--- | --- | :---: | ---: |\n| 1 |  | 2 | 3 |\n| 4 |  | 5 | 6 |');
    expect(act('table.delete-column', ALIGNED, [1, 0])).toBe('| B | C |\n| :---: | ---: |\n| 2 | 3 |\n| 5 | 6 |');
    expect(act('table.move-column-right', ALIGNED, [1, 0])).toBe('| B | A | C |\n| :---: | :--- | ---: |\n| 2 | 1 | 3 |\n| 5 | 4 | 6 |');
    expect(act('table.move-column-left', ALIGNED, [2, 2])).toBe('| A | C | B |\n| :--- | ---: | :---: |\n| 1 | 3 | 2 |\n| 4 | 6 | 5 |');
  });

  it('delete-column deletes every selected column, never all of them; a cell that spans keeps its place', () => {
    expect(act('table.delete-column', BASIC, [1, 0], [2, 1])).toBe('| C |\n| --- |\n| 3 |\n| 6 |');
    expect(enabled('table.delete-column', BASIC, [0, 0], [2, 2])).toBe(true); // every column: Word deletes the table (AD-FIX-WS-02)
    expect(act('table.delete-column', BASIC, [0, 0], [2, 2])).not.toContain('| A |');
    expect(act('table.delete-column', SPANS, [1, 2])).toBe('| A | B |\n| --- | --- |\n| tall | 2 |\n| ^^ | 5 |\n| wide ||');
    expect(act('table.delete-column', SPANS, [1, 1])).toBe('| A | C |\n| --- | --- |\n| tall | 3 |\n| ^^ | 6 |\n| wide | 9 |');
  });

  it('move-column is off at the edges; columns tied by a wide cell move as one block (FIX-PGF, AD-FIX-PGF-06)', () => {
    expect(enabled('table.move-column-left', BASIC, [1, 0])).toBe(false);
    expect(enabled('table.move-column-right', BASIC, [1, 2])).toBe(false);
    // `wide ||` ties columns A and B: they move past C together (before: off)
    expect(act('table.move-column-right', SPANS, [1, 0])).toBe('| C | A | B |\n| --- | --- | --- |\n| 3 | tall | 2 |\n| 6 | ^^ | 5 |\n| 9 | wide ||');
    expect(act('table.move-column-left', SPANS, [1, 2])).toBe('| C | A | B |\n| --- | --- | --- |\n| 3 | tall | 2 |\n| 6 | ^^ | 5 |\n| 9 | wide ||');
    expect(enabled('table.move-column-left', SPANS, [3, 0])).toBe(false); // the block is already at the left edge
  });
});

describe('cells', () => {
  it('merge-cells joins the selected cells with a space and keeps every word; split-cell undoes the shape', () => {
    const merged = act('table.merge-cells', '| A | B | C | D |\n| --- | --- | --- | --- |\n| a | b | c | d |', [1, 1], [1, 2]);
    expect(merged).toBe('| A | B | C | D |\n| --- | --- | --- | --- |\n| a | b c || d |');
    const state = stateFor(merged, [1, 1]);
    expect(act('table.split-cell', merged, [1, 1])).toBe('| A | B | C | D |\n| --- | --- | --- | --- |\n| a | b c |  | d |');
    expect(get('table.split-cell').isEnabled(state)).toBe(true);
  });

  it('merge down makes a rowspan; the merged text is in one cell', () => {
    expect(act('table.merge-cells', BASIC, [1, 0], [2, 0])).toBe('| A | B | C |\n| --- | --- | --- |\n| 1 4 | 2 | 3 |\n| ^^ | 5 | 6 |');
  });

  it('merge is off for one cell, across the header and the body; Split is on for a plain cell (P24) and off for several cells', () => {
    expect(enabled('table.merge-cells', BASIC, [1, 1])).toBe(false);
    expect(enabled('table.merge-cells', BASIC, [0, 0], [1, 1])).toBe(false);
    expect(enabled('table.split-cell', BASIC, [1, 1])).toBe(true);
    expect(enabled('table.split-cell', BASIC, [1, 0], [1, 1])).toBe(false);
  });

  it('header-row turns the first row into a header and back, in a one-row table too', () => {
    expect(act('table.header-row', HEADERLESS, [0, 0])).toBe('| 1 | 2 |\n| --- | --- |\n| 3 | 4 |');
    expect(act('table.header-row', BASIC, [1, 0])).toBe('| --- | --- | --- |\n| A | B | C |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |');
    expect(act('table.header-row', TWO_HEADERS, [0, 0])).toBe('| --- | --- |\n| A | B |\n| X | Y |\n| 1 | 2 |');
    // FIX-PGF (AD-FIX-PGF-05, Word's way): a one-row table's header row turns off and on again (before: off). Both read back.
    expect(act('table.header-row', '| A |\n| --- |', [0, 0])).toBe('| --- |\n| A |');
    expect(act('table.header-row', '| --- |\n| A |', [0, 0])).toBe('| A |\n| --- |');
    expect(get('table.header-row').isActive!(stateFor(BASIC))).toBe(true);
    expect(get('table.header-row').isActive!(stateFor(HEADERLESS))).toBe(false);
  });
});

describe('alignment', () => {
  it('sets the cursor column, or every selected column', () => {
    expect(act('table.align-center', BASIC, [1, 1])).toBe('| A | B | C |\n| --- | :---: | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |');
    expect(act('table.align-right', BASIC, [1, 0], [2, 1])).toBe('| A | B | C |\n| ---: | ---: | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |');
    expect(act('table.align-left', BASIC, [0, 2])).toBe('| A | B | C |\n| --- | --- | :--- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |');
    expect(act('table.align-none', ALIGNED, [1, 2])).toBe('| A | B | C |\n| :--- | :---: | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |');
  });

  it('a column keeps a wrap mark (`+`) when its alignment changes, and shows what the column has', () => {
    const wrap = '| A | B |\n| ---+ | --- |\n| 1 | 2 |';
    expect(act('table.align-center', wrap, [1, 0])).toBe('| A | B |\n| :---:+ | --- |\n| 1 | 2 |');
    expect(get('table.align-left').isActive!(stateFor(ALIGNED, [1, 0]))).toBe(true);
    expect(get('table.align-left').isActive!(stateFor(ALIGNED, [1, 1]))).toBe(false);
    expect(get('table.align-none').isActive!(stateFor(BASIC, [1, 1]))).toBe(true);
  });
});

describe('delete table', () => {
  it('removes the table and nothing else', () => {
    const next = run('table.delete', stateFor(`${BASIC}\n\nafter`, [1, 1]));
    expect(t.serialize(next.doc)).toBe('after');
  });
});

describe('where the commands apply', () => {
  const ids = registry.commands.list().map((c) => c.id).filter((id) => id.startsWith('table.') && id !== 'table.insert');

  it('there are the 25 commands (P19 added seven: four width commands, Fit column, Even out rows and its span-to-cells form), none on the slash menu', () => {
    expect(ids).toHaveLength(25);
    expect(registry.actions({ surface: 'slash' }).map((a) => a.id).filter((id) => ids.includes(id))).toEqual([]);
  });

  it('none is enabled outside a table', () => {
    const outside = EditorState.create({ schema: t.schema, doc: t.parse('words\n'), plugins: tableEditingPlugins() });
    expect(ids.filter((id) => get(id).isEnabled(outside))).toEqual([]);
  });

  it('FIX-FT: in a table with short rows the tools are on as in a plain one (they even it out first, AD-FIX-FT-05), Even out rows too', () => {
    const ragged = '| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 | 4 |\n| 5 | 6 |';
    const state = stateFor(ragged, [1, 0]);
    expect(ids.filter((id) => !get(id).isEnabled(state)).sort()).toEqual(['table.fill-rows-split', 'table.fit-column', 'table.merge-cells', 'table.move-column-left', 'table.move-row-up', 'table.reset-widths'].sort());
  });

  it('every command is enabled in a plain table but merge (cells), Automatic widths (needs widths), Fit (needs the page) and Even out rows (needs short rows)', () => {
    const state = stateFor(BASIC, [1, 1]);
    expect(ids.filter((id) => !get(id).isEnabled(state)).sort()).toEqual(['table.fill-rows', 'table.fill-rows-split', 'table.fit-column', 'table.merge-cells', 'table.move-row-up', 'table.reset-widths'].sort());
  });
});

describe('multi-line rows (amendment 7)', () => {
  it('open as a table; a cell keeps its line breaks, and the row stays multi-line when a row is added elsewhere', () => {
    const doc = t.parse(MULTILINE);
    expect(doc.child(0).type.name).toBe('table');
    expect(doc.child(0).child(1).attrs['multiline']).toBe(true);
    expect(doc.child(0).child(1).child(0).textContent).toBe('one\ntwo');
    expect(t.serialize(doc)).toBe(MULTILINE);
    expect(act('table.add-row-below', MULTILINE, [2, 0])).toBe(`${MULTILINE}\n|  |  |`);
  });

  it('typing in a multi-line cell keeps the continuation lines', () => {
    const state = stateFor(MULTILINE, [1, 0]);
    const cell = tableOf(state.doc).node.child(1).child(0);
    const end = state.selection.from + cell.content.size; // the end of "one\ntwo"
    const next = state.apply(state.tr.insertText('!', end, end));
    expect(t.serialize(next.doc)).toBe(MULTILINE.replace('| two |', '| two! |'));
  });

  it('a cell with a list, or two paragraphs, keeps the table raw', () => {
    expect(t.parse('| A | B |\n| --- | --- |\n| - a \\\n| - b | x |').child(0).type.name).toBe(RAW_BLOCK);
  });

  it('a row moved with its line breaks keeps them', () => {
    expect(act('table.move-row-down', MULTILINE, [1, 0])).toBe('| A | B |\n| --- | --- |\n| 3 | 4 |\n| one | x | \\\n| two | y |');
  });
});

describe('the tidy step', () => {
  /** A table whose rows carry these groups and cell types, planted as a bad state. */
  function planted(groups: number[], source = TWO_BODIES): EditorState {
    const state = stateFor(source);
    const { node, pos } = tableOf(state.doc);
    const tr = state.tr;
    let at = pos + 1;
    node.forEach((row, _o, i) => {
      tr.setNodeMarkup(at, undefined, { ...row.attrs, group: groups[i] });
      at += row.nodeSize;
    });
    return state.apply(tr);
  }

  it('is quiet on a table that is in order (so a second pass changes nothing)', () => {
    for (const source of [BASIC, TWO_BODIES, TWO_HEADERS, HEADERLESS, SPANS, CAPTIONED, MULTILINE, ALIGNED]) {
      const state = stateFor(source);
      const tr = state.tr;
      expect(tidyTable(tr, tableOf(state.doc).pos), source).toBe(false);
    }
  });

  it('a row with group 0 in the second body goes back to the second body (same transaction)', () => {
    const state = planted([-1, 0, 0, 1, 0]);
    const groups: number[] = [];
    tableOf(state.doc).node.forEach((row) => groups.push(row.attrs['group'] as number));
    expect(groups).toEqual([-1, 0, 0, 1, 1]);
  });

  it('a header row after the body becomes a body row; header rows are header cells, body rows body cells', () => {
    const state = planted([-1, 0, -1, 1, 1]);
    const types: string[][] = [];
    const groups: number[] = [];
    tableOf(state.doc).node.forEach((row) => {
      groups.push(row.attrs['group'] as number);
      const names: string[] = [];
      row.forEach((cell) => names.push(cell.type.name));
      types.push(names);
    });
    expect(groups).toEqual([-1, 0, 0, 1, 1]);
    expect(types.map((r) => r[0])).toEqual(['table_header_cell', 'table_cell', 'table_cell', 'table_cell', 'table_cell']);
  });

  it('a rowspan that reaches into another group is cut, and the row it no longer reaches gets an empty cell', () => {
    const state = planted([-1, 0, 1], '| A | B |\n| --- | --- |\n| 1 | 2 |\n| ^^ | 3 |');
    expect(t.serialize(state.doc)).toBe('| A | B |\n| --- | --- |\n| 1 | 2 |\n\n|  | 3 |');
    expect(tableOf(state.doc).node.child(1).child(0).attrs['rowspan']).toBe(1);
  });

  it('the cells show their column\'s alignment after the columns change (display only)', () => {
    const next = run('table.align-right', stateFor(BASIC, [1, 1]));
    const aligns: unknown[] = [];
    tableOf(next.doc).node.forEach((row) => aligns.push(row.child(1).attrs['align']));
    expect(aligns).toEqual(['right', 'right', 'right']);
  });

  it('FIX-FT: typing in a table with short rows evens it out in the same step (AD-FIX-FT-04; it was left ragged before)', () => {
    const state = stateFor('| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 | 4 |\n| 5 | 6 |', [1, 0]);
    const typed = state.apply(state.tr.insertText('x', state.selection.from));
    expect(t.serialize(typed.doc)).toBe('| A | B | C |  |\n| --- | --- | --- | --- |\n| x1 | 2 | 3 | 4 |\n| 5 | 6 |  |  |');
    expect(tableOf(typed.doc).node.child(0).childCount).toBe(4);
    expect(tableOf(typed.doc).node.child(2).childCount).toBe(4);
  });

  it('typing in a table leaves the cell selection mapping and the groups alone', () => {
    const state = stateFor(TWO_BODIES, [2, 1]);
    const typed = state.apply(state.tr.insertText('x', state.selection.from));
    expect(t.serialize(typed.doc)).toBe('| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | x4 |\n\n| 5 | 6 |\n| 7 | 8 |');
  });
});
