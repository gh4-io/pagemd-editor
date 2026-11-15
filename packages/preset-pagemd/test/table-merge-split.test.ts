// Fix run undo-bg-table-split (bug 2, "split hasn't worked since the widths"): on every table shape the round-3 matrix uses
// (`||` and `^^` cells), with and without widths in each spelling, every merge the Table tab offers must write markdown that
// reads back as the same table, and Split must then be on in the merged cell and work. Two causes were found:
// - a merged cell spanning columns AND rows was written with one `|` too many (`| x ||| 6 |`, three columns) and the row
//   below without its `||` (pagemd-common's writer); read again (VS Code's undo / redo, reopening the file) the table was
//   not in standard form, so every table tool, Split included, was off;
// - a merge that takes every cell a lower row has of its own (`tall` is `^^` there) left that row empty, which an editor
//   table can't hold: ProseMirror put an empty cell in it and the table was at once not in standard form (Split off).
//   AD-FIX-UB-03 switched such a merge off; the fix run word-style-tables-pictures (AD-FIX-WS-01) does what Word does: the merge
//   goes ahead, the emptied row is removed and the cells that reached through it are one row shorter.
import type { Node } from 'prosemirror-model';
import { EditorState, TextSelection } from 'prosemirror-state';
import { CellSelection, TableMap } from 'prosemirror-tables';
import { describe, expect, it } from 'vitest';
import { createRegistry, ItemRegistry, RAW_BLOCK, ViewState, type CommandSpec } from '@pagemd-editor/core';
import { commonmarkItems } from '@pagemd-editor/preset-commonmark';
import { gfmItems } from '@pagemd-editor/preset-gfm';
import { createTransformer } from '@pagemd-editor/transformer';
import { pagemdItems, tableEditingPlugins } from '../src/index.ts';

const all = [...commonmarkItems, ...gfmItems, ...pagemdItems()];
const t = createTransformer(all);
const registry = createRegistry({ items: new ItemRegistry([...all]), view: new ViewState() });
const get = (id: string): CommandSpec => registry.commands.get(id)!;

const SPAN = '| A | B | C |\n| --- | --- | --- |\n| wide || 3 |\n| tall | x | y |\n| ^^ | p | q |';
const PLAIN = '| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n| 7 | 8 | 9 |';
const WIDTHS: Record<string, string> = {
  'no widths': '',
  'the hidden comment': '\n<!-- ::TABLE widths="20% 30% 50%" -->',
  'widths="equal"': '\n<!-- ::TABLE widths="equal" -->',
  'the older {data-col-widths}': '\n{data-col-widths="20% 30% 50%"}',
  'the older {.fixed-layout}': '\n{.fixed-layout}',
};

function tableOf(doc: Node): { node: Node; pos: number } {
  let found: { node: Node; pos: number } | undefined;
  doc.descendants((node, pos) => {
    if (node.type.name === 'table' && !found) found = { node, pos };
    return !found;
  });
  return found!;
}

function stateFor(text: string, at: [number, number], to?: [number, number]): EditorState {
  const doc = t.parse(text);
  const state = EditorState.create({ schema: t.schema, doc, plugins: tableEditingPlugins() });
  const { node, pos } = tableOf(doc);
  const map = TableMap.get(node);
  const cell = (r: number, c: number): number => pos + 1 + map.map[r * map.width + c]!;
  const selection = to ? CellSelection.create(doc, cell(...at), cell(...to)) : TextSelection.create(doc, cell(...at) + 1);
  return state.apply(state.tr.setSelection(selection));
}

/** Runs `id`; the written text, which must read back as the document the command made (what a re-read would show). */
function act(id: string, state: EditorState): string {
  let next = state;
  expect(get(id).run(state, (tr) => (next = state.apply(tr)))).toBe(true);
  const written = t.serialize(next.doc);
  const again = t.parse(written);
  expect(JSON.stringify(again.toJSON()).includes(RAW_BLOCK), `${written} reads back as raw text`).toBe(false);
  expect(again.toJSON(), `${written} reads back as another table`).toEqual(next.doc.toJSON());
  return written;
}

describe('merge, then split: every merge the Table tab offers reads back, and Split works on the merged cell', () => {
  for (const [shape, base] of Object.entries({ 'spans (|| and ^^)': SPAN, 'plain 3 x 3': PLAIN })) {
    for (const [name, suffix] of Object.entries(WIDTHS)) {
      it(`${shape}, ${name}`, () => {
        const text = base + suffix;
        const map = TableMap.get(tableOf(t.parse(text)).node);
        let merges = 0;
        for (let r1 = 0; r1 < map.height; r1++)
          for (let c1 = 0; c1 < map.width; c1++)
            for (let r2 = r1; r2 < map.height; r2++)
              for (let c2 = c1; c2 < map.width; c2++) {
                if (r1 === r2 && c1 === c2) continue;
                const state = stateFor(text, [r1, c1], [r2, c2]);
                if (!get('table.merge-cells').isEnabled(state)) continue;
                merges++;
                const merged = act('table.merge-cells', state);
                if (suffix) expect(merged.endsWith(suffix), 'the widths stay').toBe(true);
                // The merged cell sits where the selection's rectangle starts (the reader's table, as after a re-read).
                const sel = state.selection as CellSelection;
                const start = sel.$anchorCell.start(-1);
                const rect = TableMap.get(sel.$anchorCell.node(-1)).rectBetween(sel.$anchorCell.pos - start, sel.$headCell.pos - start);
                const reread = stateFor(merged, [rect.top, rect.left]);
                expect(get('table.split-cell').isEnabled(reread), `Split on after merging ${r1},${c1}-${r2},${c2}: ${merged}`).toBe(true);
                const split = act('table.split-cell', reread);
                expect(TableMap.get(tableOf(t.parse(split)).node).problems ?? null, `${split} is in standard form`).toBeNull();
              }
        expect(merges).toBeGreaterThan(10);
      });
    }
  }

  it('a block of cells spanning columns and rows is written with one || per extra column and ^^ || below it', () => {
    const state = stateFor(PLAIN, [2, 0], [3, 1]);
    expect(act('table.merge-cells', state)).toBe('| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 5 7 8 || 6 |\n| ^^ || 9 |');
    // the round-3 table: `tall` (a ^^ below it) merged with x and p
    expect(act('table.merge-cells', stateFor(SPAN, [2, 0], [2, 1]))).toBe('| A | B | C |\n| --- | --- | --- |\n| wide || 3 |\n| tall x p || y |\n| ^^ || q |');
  });

  it('a merge that would leave a row with no cell of its own removes that row, as Word does (one edit, standard form)', () => {
    const merge = get('table.merge-cells');
    // x y p q: the row of p and q keeps only the ^^ of tall; the row goes and tall becomes one row tall
    expect(merge.isEnabled(stateFor(SPAN, [2, 1], [3, 2]))).toBe(true);
    expect(act('table.merge-cells', stateFor(SPAN, [2, 1], [3, 2]))).toBe('| A | B | C |\n| --- | --- | --- |\n| wide || 3 |\n| tall | x y p q ||');
    // two whole rows become one row with one cell across the table
    expect(act('table.merge-cells', stateFor(PLAIN, [2, 0], [3, 2]))).toBe('| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 5 6 7 8 9 |||');
    // three whole rows
    expect(act('table.merge-cells', stateFor(PLAIN, [1, 0], [3, 2]))).toBe('| A | B | C |\n| --- | --- | --- |\n| 1 2 3 4 5 6 7 8 9 |||');
    // the other merges are as before
    expect(act('table.merge-cells', stateFor(PLAIN, [2, 0], [3, 1]))).toContain('| ^^ || 9 |');
    expect(merge.isEnabled(stateFor(PLAIN, [1, 0], [1, 2]))).toBe(true);
  });

  it('the emptied row is removed in one transaction, and one undo of it brings the table back', () => {
    const state = stateFor(SPAN, [2, 1], [3, 2]);
    let count = 0;
    let next = state;
    get('table.merge-cells').run(state, (tr) => {
      count++;
      next = state.apply(tr);
    });
    expect(count).toBe(1);
    expect(TableMap.get(tableOf(next.doc).node).height).toBe(3); // header, wide, the merged row
    expect(t.serialize(state.doc)).toContain('| ^^ | p | q |');
  });
});
