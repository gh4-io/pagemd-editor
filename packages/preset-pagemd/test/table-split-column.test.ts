// P24: Split on a cell that is not merged adds a column, as Word's Split Cells does (R-236): the cell keeps its text, a new empty
// cell sits on its right, every other row's cell over that column spans one more column, the column's width is halved (when the
// table has widths), one undo step, both new cells selected. A merged cell is still taken apart as before.
import type { Node } from 'prosemirror-model';
import { EditorState, TextSelection } from 'prosemirror-state';
import { CellSelection, TableMap } from 'prosemirror-tables';
import { describe, expect, it } from 'vitest';
import { createRegistry, ItemRegistry, RAW_BLOCK, ViewState, type CommandSpec } from '@pagemd-editor/core';
import { commonmarkItems } from '@pagemd-editor/preset-commonmark';
import { gfmItems } from '@pagemd-editor/preset-gfm';
import { createTransformer } from '@pagemd-editor/transformer';
import { pagemdItems, tableEditingPlugins } from '../src/index.ts';
import { splitColumnWidth } from '../src/tables/widths.ts';

import { tableAt } from '../src/tables/context.ts';

import { plainCell, splitTransaction } from '../src/tables/commands.ts';
const all = [...commonmarkItems, ...gfmItems, ...pagemdItems()];
const t = createTransformer(all);
const registry = createRegistry({ items: new ItemRegistry([...all]), view: new ViewState() });
const get = (id: string): CommandSpec => registry.commands.get(id)!;

const SPAN = '| A | B | C |\n| --- | --- | --- |\n| wide || 3 |\n| tall | x | y |\n| ^^ | p | q |';
const PLAIN = '| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n| 7 | 8 | 9 |';
const TWO_HEADERS = '| A | B |\n| X | Y |\n| --- | --- |\n| 1 | 2 |';
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

/** Runs `id` in one dispatch (counted); the written text must read back as the document the command made. */
function run(id: string, state: EditorState): { text: string; next: EditorState; dispatches: number } {
  let next = state;
  let dispatches = 0;
  expect(get(id).run(state, (tr) => ((next = state.apply(tr)), dispatches++))).toBe(true);
  const text = t.serialize(next.doc);
  const again = t.parse(text);
  expect(JSON.stringify(again.toJSON()).includes(RAW_BLOCK), `${text} reads back as raw text`).toBe(false);
  expect(again.toJSON(), `${text} reads back as another table`).toEqual(next.doc.toJSON());
  return { text, next, dispatches };
}

const widthsOf = (text: string): number[] | null => {
  const m = /widths="([^"]*)"/.exec(text);
  return m && m[1] !== 'equal' ? m[1]!.split(/\s+/).map((w) => parseInt(w, 10)) : null;
};

describe('Split on a cell that is not merged adds a column', () => {
  it('a plain cell: the cell keeps its text, an empty cell follows, the other rows span the new column', () => {
    expect(run('table.split-cell', stateFor(PLAIN, [2, 1])).text).toBe('| A | B || C |\n| --- | --- | --- | --- |\n| 1 | 2 || 3 |\n| 4 | 5 |  | 6 |\n| 7 | 8 || 9 |');
  });

  it('in the header row the new cell is a header cell; in the first column', () => {
    expect(run('table.split-cell', stateFor(PLAIN, [0, 0])).text).toBe('| A |  | B | C |\n| --- | --- | --- | --- |\n| 1 || 2 | 3 |\n| 4 || 5 | 6 |\n| 7 || 8 | 9 |');
  });

  it('a table with || and ^^ cells: wide cells grow by one, a tall cell once', () => {
    expect(run('table.split-cell', stateFor(SPAN, [3, 1])).text).toBe('| A | B || C |\n| --- | --- | --- | --- |\n| wide ||| 3 |\n| tall | x || y |\n| ^^ | p |  | q |');
    // the tall cell (rowspan 2) is a merged cell, so Split takes it apart as before (no column is added)
    expect(run('table.split-cell', stateFor(SPAN, [2, 0])).text).toContain('| tall | x | y |');
  });

  it('a tall cell over the split column is widened once, not once per row it crosses', () => {
    const text = '| A | B | C |\n| --- | --- | --- |\n| 1 | tall | 3 |\n| 4 | ^^ | 6 |\n| 7 | 8 | 9 |';
    expect(run('table.split-cell', stateFor(text, [3, 1])).text).toBe('| A | B || C |\n| --- | --- | --- | --- |\n| 1 | tall || 3 |\n| 4 | ^^ || 6 |\n| 7 | 8 |  | 9 |');
  });

  it('two header rows: the other header row spans too', () => {
    const { text } = run('table.split-cell', stateFor(TWO_HEADERS, [0, 0]));
    expect(text.split('\n').slice(0, 2)).toEqual(['| A |  | B |', '| X || Y |']);
  });

  it('AD-P24-01: Split is off where the reader would read the result differently; the reason says so', () => {
    const state = stateFor(PLAIN, [2, 2]); // the last column of a table with a header
    expect(get('table.split-cell').isEnabled(state)).toBe(false);
    expect(get('table.split-cell').reason?.(state)).toContain("reader would read the spans");
    expect(get('table.split-cell').isEnabled(stateFor(PLAIN, [2, 1]))).toBe(true);
    // the header row alone is the split row, so no header span: on, even in the last column
    expect(get('table.split-cell').isEnabled(stateFor('| 1 | 2 |\n| --- | --- |\n| 3 | 4 |', [0, 1]))).toBe(true);
    // a headerless table has no header span either
    expect(get('table.split-cell').isEnabled(stateFor('| --- | --- |\n| 3 | 4 |\n| 5 | 6 |', [0, 1]))).toBe(true);
  });

  it('the guard agrees with the real round trip: Split is on exactly where the written result reads back as the same table', () => {
    let on = 0;
    let off = 0;
    for (const base of [SPAN, PLAIN, TWO_HEADERS, '| A | B | C | D |\n| --- | --- | --- | --- |\n| 1 | 2 | 3 | 4 |']) {
      const first = tableOf(t.parse(base));
      const map = TableMap.get(first.node);
      for (let r = 0; r < map.height; r++)
        for (let c = 0; c < map.width; c++) {
          const state = stateFor(base, [r, c]);
          const ctx = tableAt(state);
          const cell = ctx && plainCell(ctx);
          if (!ctx || !cell) continue;
          const tr = splitTransaction(state, ctx, cell);
          const written = t.serialize(state.apply(tr).doc);
          const same = JSON.stringify(t.parse(written).toJSON()) === JSON.stringify(state.apply(tr).doc.toJSON());
          expect(get('table.split-cell').isEnabled(state), `${r},${c} of ${base}: ${written}`).toBe(same);
          same ? on++ : off++;
        }
    }
    expect(on).toBeGreaterThan(8);
    expect(off).toBeGreaterThan(2);
  });

  it('a second Split of the same column is read back wrongly with a header (colspan 3), so it is off; the first is on', () => {
    const first = run('table.split-cell', stateFor(PLAIN, [2, 1])).text;
    expect(get('table.split-cell').isEnabled(stateFor(first, [2, 2]))).toBe(false);
  });

  it('every plain cell of every shape, in every widths spelling, reads back in standard form with the right number of cells', () => {
    let splits = 0;
    let guarded = 0;
    for (const base of [SPAN, PLAIN, TWO_HEADERS]) {
      for (const suffix of Object.values(WIDTHS)) {
        const text = base + suffix;
        const map = TableMap.get(tableOf(t.parse(text)).node);
        for (let r = 0; r < map.height; r++)
          for (let c = 0; c < map.width; c++) {
            const at = map.map[r * map.width + c]!;
            const cell = tableOf(t.parse(text)).node.nodeAt(at)!;
            if (cell.attrs['colspan'] !== 1 || cell.attrs['rowspan'] !== 1) continue;
            const state = stateFor(text, [r, c]);
            if (!get('table.split-cell').isEnabled(state)) {
              guarded++; // AD-P24-01: only where the reader would misread the result (checked in the test above)
              continue;
            }
            const { text: written } = run('table.split-cell', state);
            const after = TableMap.get(tableOf(t.parse(written)).node);
            expect(after.problems ?? null, `${written} is in standard form`).toBeNull();
            expect(after.width).toBe(map.width + 1);
            splits++;
          }
      }
    }
    expect(splits).toBeGreaterThan(30);
    expect(guarded).toBeLessThan(splits);
  });

  it('LF and CRLF files', () => {
    const lf = run('table.split-cell', stateFor(PLAIN, [2, 1])).text;
    const crlf = run('table.split-cell', stateFor(PLAIN.replace(/\n/g, '\r\n'), [2, 1])).text;
    expect(crlf.replace(/\r\n/g, '\n')).toBe(lf);
  });
});

describe('Split: the widths', () => {
  it('a hidden-comment table halves the split column; the total and the other columns stay', () => {
    const { text } = run('table.split-cell', stateFor(SPAN + WIDTHS['the hidden comment'], [3, 1]));
    expect(widthsOf(text)).toEqual([20, 15, 15, 50]);
  });
  it('the older spellings are replaced by the hidden comment', () => {
    const text = run('table.split-cell', stateFor(PLAIN + WIDTHS['the older {data-col-widths}'], [2, 1])).text;
    expect(widthsOf(text)).toEqual([20, 15, 15, 50]);
    expect(text).not.toContain('data-col-widths');
  });
  it('an equal table gets explicit equal widths first, then the halving', () => {
    for (const key of ['widths="equal"', 'the older {.fixed-layout}']) {
      const text = run('table.split-cell', stateFor(PLAIN + WIDTHS[key], [2, 0])).text;
      expect(widthsOf(text), key).toEqual([17, 17, 33, 33]);
      expect(text).not.toContain('.fixed-layout');
    }
  });
  it('a table with no widths gets none written', () => {
    expect(run('table.split-cell', stateFor(PLAIN, [2, 0])).text).not.toContain('::TABLE');
  });
  it('splitColumnWidth: whole numbers, the total unchanged, at least 1 each', () => {
    expect(splitColumnWidth([20, 30, 50], 1)).toEqual([20, 15, 15, 50]);
    expect(splitColumnWidth([20, 31, 49], 1)).toEqual([20, 16, 15, 49]);
    expect(splitColumnWidth([1, 99], 0)).toEqual([1, 1, 98]);
    expect(splitColumnWidth([2, 98], 0)).toEqual([1, 1, 98]);
    expect(splitColumnWidth([100], 0).reduce((a, b) => a + b, 0)).toBe(100);
  });
});

describe('Split: one undo step, selection, Merge and Delete column afterwards', () => {
  it('one transaction; both new cells are selected and Merge is on', () => {
    const { next, dispatches } = run('table.split-cell', stateFor(PLAIN + WIDTHS['the hidden comment'], [2, 1]));
    expect(dispatches).toBe(1);
    expect(next.selection).toBeInstanceOf(CellSelection);
    const sel = next.selection as CellSelection;
    const start = sel.$anchorCell.start(-1);
    const rect = TableMap.get(sel.$anchorCell.node(-1)).rectBetween(sel.$anchorCell.pos - start, sel.$headCell.pos - start);
    expect(rect).toMatchObject({ top: 2, bottom: 3, left: 1, right: 3 });
    expect(get('table.merge-cells').isEnabled(next)).toBe(true);
  });

  it('Split then Merge: one cell of the old width again; the other rows keep their spans (documented)', () => {
    const split = run('table.split-cell', stateFor(PLAIN, [2, 1])).next;
    const merged = run('table.merge-cells', split).text;
    expect(merged).toBe('| A | B || C |\n| --- | --- | --- | --- |\n| 1 | 2 || 3 |\n| 4 | 5 || 6 |\n| 7 | 8 || 9 |');
  });

  it('Delete column on the added column shortens the other rows back', () => {
    const split = run('table.split-cell', stateFor(PLAIN, [2, 1])).text;
    expect(run('table.delete-column', stateFor(split, [2, 2])).text).toBe(PLAIN);
  });

  it('a second Split in a table without a header widens the spans again', () => {
    const first = run('table.split-cell', stateFor('| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |', [0, 1])).text;
    expect(run('table.split-cell', stateFor(first, [0, 2])).text).toContain('| 4 | 5 ||| 6 |');
  });
});

describe('Split: what stays as it was', () => {
  it('a merged cell is taken apart; a cell selection of several cells is off; Split is off outside a table', () => {
    // the merged cell `wide ||` is taken apart (as before: no column is added), a ^^ tall cell too
    expect(run('table.split-cell', stateFor(SPAN, [1, 0])).text).toBe('| A | B | C |\n| --- | --- | --- |\n| wide |  | 3 |\n| tall | x | y |\n| ^^ | p | q |');
    expect(run('table.split-cell', stateFor(SPAN, [2, 0])).text).toContain('| tall | x | y |');
    expect(get('table.split-cell').isEnabled(stateFor(PLAIN, [1, 0], [2, 1]))).toBe(false);
    expect(get('table.split-cell').reason?.(stateFor(PLAIN, [1, 0], [2, 1]))).toContain('Split works on one cell');
  });
  it('FIX-FT: on in a table with short rows: the table is evened out first, in the same change (AD-FIX-FT-05)', () => {
    const state = stateFor('| A | B |\n| --- | --- |\n| 1 |', [1, 0]);
    expect(get('table.split-cell').isEnabled(state)).toBe(true);
    expect(run('table.split-cell', state)).toMatchObject({ dispatches: 1, text: '| A || B |\n| --- | --- | --- |\n| 1 |  |  |' });
  });
});

describe('Split: a 100-row table', () => {
  it('one transaction touches every row and reads back', () => {
    const rows = Array.from({ length: 100 }, (_, i) => `| r${i} | s${i} | u${i} |`).join('\n');
    const { text, dispatches } = run('table.split-cell', stateFor(`| A | B | C |\n| --- | --- | --- |\n${rows}`, [50, 1]));
    expect(dispatches).toBe(1);
    expect(text.split('\n').filter((l) => l.includes('||')).length).toBe(100);
  });
});
