// P19 round 3: the hidden <!-- ::TABLE widths="…" --> comment (written, read back, older spellings migrated), tables with
// spanning cells (|| and ^^) with widths through every tool (ask 2), tables not in standard form (the shapes, the fix, the
// prompt's on/off and Dismiss, the reason on the tools), and the header-row class (OQ-49). The page itself: e2e.
import type { DOMOutputSpec, Node } from 'prosemirror-model';
import { EditorState, TextSelection } from 'prosemirror-state';
import { CellSelection, TableMap } from 'prosemirror-tables';
import { describe, expect, it } from 'vitest';
import { createDialect } from '@pagemd/syntax';
import { createRegistry, ItemRegistry, RAW_BLOCK, ViewState, type CommandSpec } from '@pagemd-editor/core';
import { commonmarkItems } from '@pagemd-editor/preset-commonmark';
import { gfmItems } from '@pagemd-editor/preset-gfm';
import { createTransformer } from '@pagemd-editor/transformer';
import { HEAD_ROW_CLASS, layoutOf, pagemdItems, tableEditingPlugins, tableShape } from '../src/index.ts';

const all = [...commonmarkItems, ...gfmItems, ...pagemdItems()];
const t = createTransformer(all);
const registry = createRegistry({ items: new ItemRegistry([...all]), view: new ViewState() });
const get = (id: string): CommandSpec => registry.commands.get(id)!;
const H = (w: string): string => `<!-- ::TABLE widths="${w}" -->`;

function tableOf(doc: Node): { node: Node; pos: number } {
  let found: { node: Node; pos: number } | undefined;
  doc.descendants((node, pos) => {
    if (node.type.name === 'table' && !found) found = { node, pos };
    return !found;
  });
  return found!;
}

function stateFor(text: string, at: [number, number] = [0, 0], to?: [number, number]): EditorState {
  const doc = t.parse(text);
  const state = EditorState.create({ schema: t.schema, doc, plugins: tableEditingPlugins() });
  const { node, pos } = tableOf(doc);
  const map = TableMap.get(node);
  const cell = (r: number, c: number): number => pos + 1 + map.map[r * map.width + c]!;
  const selection = to ? CellSelection.create(doc, cell(...at), cell(...to)) : TextSelection.create(doc, cell(...at) + 1);
  return state.apply(state.tr.setSelection(selection));
}

/** Runs the command; the written text, which must read back as the document the command made. */
function act(id: string, text: string, at?: [number, number], to?: [number, number]): string {
  const state = stateFor(text, at, to);
  expect(get(id).isEnabled(state), `${id} enabled`).toBe(true);
  let next = state;
  expect(get(id).run(state, (tr) => (next = state.apply(tr)))).toBe(true);
  const written = t.serialize(next.doc);
  const again = t.parse(written);
  expect(JSON.stringify(again.toJSON()).includes(RAW_BLOCK)).toBe(false);
  expect(again.toJSON()).toEqual(next.doc.toJSON());
  return written;
}

/** The <col> widths pagemd writes for `text`. */
const pagemdCols = (text: string): string[] => [...createDialect().render(text).matchAll(/<col(?: style="width:([^"]*)")?>/g)].map((m) => m[1] ?? '');

describe('the hidden comment: read, written, read back; the older spellings keep working and are migrated', () => {
  const T = '| A | B |\n| --- | --- |\n| 1 | 2 |';
  it('a document with the comment opens and saves byte for byte (unchanged blocks keep their bytes)', () => {
    const text = `Before.\n\n${T}\n{.striped}\n${H('30% 70%')}\n\nAfter.\n`;
    expect(t.serialize(t.parse(text))).toBe(text.replace(/\n$/, ''));
    const table = tableOf(t.parse(text)).node;
    expect(layoutOf(table).widths).toEqual([30, 70]);
    expect(table.attrs['pmdAttrs']).toEqual([['class', 'striped']]);
  });

  it('an older {data-col-widths} document reads the same widths and opens unchanged', () => {
    const text = `${T}\n{data-col-widths="30% 70%"}\n`;
    expect(layoutOf(tableOf(t.parse(text)).node).widths).toEqual([30, 70]);
    expect(t.serialize(t.parse(text))).toBe(text.replace(/\n$/, ''));
  });

  it('a change migrates: the comment is written, data-col-widths and .fixed-layout go, other classes and attributes stay', () => {
    expect(act('table.column-wider', `${T}\n{#t1 .striped .fixed-layout data-col-widths="30% 70%" data-x="1"}\n`, [0, 0])).toBe(`${T}\n{#t1 .striped data-x="1"}\n${H('35% 65%')}`);
    expect(act('table.reset-widths', `${T}\n${H('30% 70%')}\n`, [0, 0])).toBe(T);
  });

  it('other parameters the author wrote in the comment are kept', () => {
    expect(act('table.column-wider', `${T}\n<!-- ::TABLE note="kept" widths="30% 70%" -->\n`, [0, 0])).toBe(`${T}\n<!-- ::TABLE note="kept" widths="35% 65%" -->`);
  });
});

// Ask 2: tables with spanning cells. Each has a `||` colspan and a `^^` rowspan.
const SPAN = '| A | B | C |\n| --- | --- | --- |\n| wide || 3 |\n| tall | x | y |\n| ^^ | p | q |';
const SPAN_W = `${SPAN}\n${H('20% 30% 50%')}`;

describe('spanning cells with widths (|| and ^^): every tool, the output, the round trip', () => {
  it('reads: widths count real columns; the canvas draws the same <col>s as pagemd', () => {
    const table = tableOf(t.parse(SPAN_W)).node;
    expect(layoutOf(table).widths).toEqual([20, 30, 50]);
    const spec = table.type.spec.toDOM!(table) as unknown as unknown[];
    const group = ((spec[2] as unknown[]).slice(2) as DOMOutputSpec[]).find((c) => Array.isArray(c) && c[0] === 'colgroup') as unknown as unknown[];
    const cols = (group.slice(1) as [string, Record<string, string>][]).map((col) => (col[1]['style'] ?? '').replace('width:', ''));
    expect(cols).toEqual(pagemdCols(`${SPAN_W}\n`));
    expect(createDialect().render(`${SPAN_W}\n`)).toContain('<td colspan="2" style="width:50%">wide</td>');
  });

  it('opens and saves byte for byte; every block written fresh reads back the same', () => {
    expect(t.serialize(t.parse(`${SPAN_W}\n`))).toBe(SPAN_W);
  });

  it('Wider / Narrower / Equal / Automatic work across spans', () => {
    expect(act('table.column-wider', SPAN_W, [2, 1])).toBe(`${SPAN}\n${H('20% 35% 45%')}`);
    expect(act('table.column-narrower', SPAN_W, [2, 0])).toBe(`${SPAN}\n${H('15% 35% 50%')}`);
    expect(act('table.equal-widths', SPAN_W, [1, 2])).toBe(`${SPAN}\n${H('equal')}`);
    expect(act('table.reset-widths', SPAN_W, [1, 2])).toBe(SPAN);
    // FIX-PGF (AD-FIX-PGF-07): in the spanning cell (two columns) Wider widens its first column, taken from the column outside the
    // cell, so the merged cell itself gets wider (before: off)
    expect(act('table.column-wider', SPAN_W, [1, 0])).toBe(`${SPAN}\n${H('25% 30% 45%')}`);
    expect(act('table.column-narrower', SPAN_W, [1, 0])).toBe(`${SPAN}\n${H('15% 30% 55%')}`);
    // a selection of the last two columns: the first of them, taken from the column before the selection
    expect(act('table.column-wider', SPAN_W, [2, 1], [2, 2])).toBe(`${SPAN}\n${H('15% 35% 50%')}`);
    // a one-column table, and every column selected: off, with the reason
    const one = stateFor('| A |\n| --- |\n| 1 |', [1, 0]);
    for (const id of ['table.column-wider', 'table.column-narrower', 'table.fit-column']) {
      expect(get(id).isEnabled(one), id).toBe(false);
      expect(get(id).reason!(one), id).toMatch(/^A table with one column always fills the text width in pagemd/);
    }
    expect(get('table.column-wider').reason!(stateFor(SPAN_W, [2, 0], [2, 2]))).toMatch(/^The selection covers every column/);
  });

  it('add a column next to a span; delete and move columns where no span is in the way; widths follow', () => {
    expect(act('table.add-column-right', SPAN_W, [2, 2])).toBe(`| A | B | C |  |\n| --- | --- | --- | --- |\n| wide || 3 |  |\n| tall | x | y |  |\n| ^^ | p | q |  |\n${H('20% 30% 25% 25%')}`);
    expect(act('table.delete-column', SPAN_W, [2, 2])).toBe(`| A | B |\n| --- | --- |\n| wide || \n| tall | x |\n| ^^ | p |\n${H('20% 80%')}`.replace('| wide || \n', '| wide ||\n'));
    // FIX-PGF (AD-FIX-PGF-06, Word's way): columns tied by the || span move as one block, with their widths (before: off, AD-P16-11)
    expect(act('table.move-column-right', SPAN_W, [0, 0])).toBe(`| C | A | B |\n| --- | --- | --- |\n| 3 | wide ||\n| y | tall | x |\n| q | ^^ | p |\n${H('50% 20% 30%')}`);
    expect(act('table.move-column-left', SPAN_W, [0, 2])).toBe(`| C | A | B |\n| --- | --- | --- |\n| 3 | wide ||\n| y | tall | x |\n| q | ^^ | p |\n${H('50% 20% 30%')}`);
    // a table whose span doesn't reach the moved columns: the width goes with the column
    expect(act('table.move-column-right', `| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| ^^ | x | y |\n${H('20% 30% 50%')}`, [0, 1])).toBe(`| A | C | B |\n| --- | --- | --- |\n| 1 | 3 | 2 |\n| ^^ | y | x |\n${H('20% 50% 30%')}`);
  });

  it('merge and split cells keep the widths', () => {
    const merged = act('table.merge-cells', SPAN_W, [2, 1], [2, 2]);
    expect(merged).toBe(`| A | B | C |\n| --- | --- | --- |\n| wide || 3 |\n| tall | x y ||\n| ^^ | p | q |\n${H('20% 30% 50%')}`);
    expect(act('table.split-cell', merged, [2, 1])).toBe(`| A | B | C |\n| --- | --- | --- |\n| wide || 3 |\n| tall | x y |  |\n| ^^ | p | q |\n${H('20% 30% 50%')}`);
    expect(act('table.split-cell', SPAN_W, [2, 0])).toContain(H('20% 30% 50%')); // the ^^ rowspan split
  });

  it("pagemd's HTML for every table above has the widths on the spanning cells", () => {
    const html = createDialect().render(`${SPAN_W}\n`);
    expect(html).toContain('<td rowspan="2" style="width:20%">tall</td>');
    expect(html).toContain('<col style="width:20%">\n<col style="width:30%">\n<col style="width:50%">');
  });
});

describe('tables not in standard form (ask 3)', () => {
  const SHORT = '| A | B | C |\n| --- | --- | --- |\n| 1 | 2 |\n';
  const LONG = '| A | B |\n| --- | --- |\n| 1 | 2 | 3 |\n';
  const SEP_MORE = '| A | B |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n';
  const SPAN_END = '| A | B ||\n| --- | --- | --- |\n| 1 | 2 |\n';
  const OVERLAP = '| A | B |\n| --- | --- |\n| 1 | 2 |\n| ^^ | x |\n| ^^ | y | z |\n';
  const NO_PIPES = 'A | B\n---|---\n1 | 2\n';
  const SEP_FEWER = '| A | B | C |\n| --- | --- |\n| 1 | 2 | 3 |\n';

  it('the shapes: short rows (however they came about) are fixable; tables the reader takes as they are are standard', () => {
    expect(tableShape(tableOf(t.parse(SHORT)).node)).toEqual({ kind: 'fixable', reason: "row 2 has 2 of the table's 3 cells", spanAtEnd: false });
    expect(tableShape(tableOf(t.parse(LONG)).node)).toEqual({ kind: 'fixable', reason: "the header row (row 1) has 2 of the table's 3 cells", spanAtEnd: false });
    expect(tableShape(tableOf(t.parse(SEP_MORE)).node).kind).toBe('fixable');
    expect(tableShape(tableOf(t.parse(SPAN_END)).node)).toMatchObject({ kind: 'fixable', spanAtEnd: true });
    expect(tableShape(tableOf(t.parse(OVERLAP)).node).kind).toBe('fixable'); // the extra cell in the ^^ row: the others are short
    expect(tableShape(tableOf(t.parse(NO_PIPES)).node).kind).toBe('standard');
    expect(tableShape(tableOf(t.parse(SEP_FEWER)).node).kind).toBe('standard');
  });

  it('the fix: empty cells at the ends of the short rows, one transaction, only that table; or the span made into cells', () => {
    expect(act('table.fill-rows', `Before.\n\n${SHORT}\nAfter.\n`, [1, 0])).toBe(`Before.\n\n| A | B | C |\n| --- | --- | --- |\n| 1 | 2 |  |\n\nAfter.`);
    expect(act('table.fill-rows', LONG, [1, 0])).toBe('| A | B |  |\n| --- | --- | --- |\n| 1 | 2 | 3 |');
    expect(act('table.fill-rows', SPAN_END, [1, 0])).toBe('| A | B ||\n| --- | --- | --- |\n| 1 | 2 |  |');
    expect(act('table.fill-rows-split', SPAN_END, [1, 0])).toBe('| A | B |  |\n| --- | --- | --- |\n| 1 | 2 |  |');
    expect(get('table.fill-rows-split').isEnabled(stateFor(SHORT, [1, 0]))).toBe(false);
  });

  it('FIX-FT: a table filling fixes has its tools on; each tool evens the rows out first, in the one transaction it makes', () => {
    const state = stateFor(SHORT, [1, 0]);
    const action = registry.actions({ surface: 'ribbon', context: { state, editable: true } }).find((a) => a.id === 'table.add-row-below')!;
    expect(action.enabled).toBe(true);
    expect(action.reason).toBeUndefined();
    expect(act('table.add-row-below', SHORT, [1, 0])).toBe('| A | B | C |\n| --- | --- | --- |\n| 1 | 2 |  |\n|  |  |  |');
    expect(act('table.add-column-right', SHORT, [1, 1])).toBe('| A | B |  | C |\n| --- | --- | --- | --- |\n| 1 | 2 |  |  |');
    expect(act('table.align-center', LONG, [1, 2])).toBe('| A | B |  |\n| --- | --- | :---: |\n| 1 | 2 | 3 |');
    expect(act('table.column-wider', SHORT, [0, 0])).toContain('| 1 | 2 |  |\n<!-- ::TABLE widths=');
    // one transaction: the filling and the tool's change undo together
    let next = state;
    get('table.add-row-below').run(state, (tr) => (next = state.apply(tr)));
    expect(TableMap.get(tableOf(next.doc).node).problems).toBeFalsy();
    expect(next.doc.textContent).toBe(state.doc.textContent);
    // Even out rows still works as it is (and is then off: nothing left to even out)
    expect(get('table.fill-rows').isEnabled(state)).toBe(true);
    expect(get('table.fill-rows').isEnabled(stateFor(T3, [1, 0]))).toBe(false);
  });

  it('a table filling cannot fix (cells that overlap) keeps its tools off, and they say why', () => {
    // The reader gives no such table (checked: `^^` and `||` mixes all read as rectangles or short rows), so it is made here: a row span reaching past the table.
    const plain = stateFor(T3, [1, 0]);
    const { node, pos } = tableOf(plain.doc);
    const cellPos = pos + 1 + TableMap.get(node).map[3]!;
    const state = plain.apply(plain.tr.setNodeMarkup(cellPos, undefined, { ...plain.doc.nodeAt(cellPos)!.attrs, rowspan: 2 }));
    expect(tableShape(tableOf(state.doc).node).kind).toBe('broken');
    const action = registry.actions({ surface: 'ribbon', context: { state, editable: true } }).find((a) => a.id === 'table.add-row-below')!;
    expect(action.enabled).toBe(false);
    expect(action.reason).toContain("this table isn't in standard form: some cells overlap");
    const fine = registry.actions({ surface: 'ribbon', context: { state: stateFor(T3, [1, 0]), editable: true } }).find((a) => a.id === 'table.add-row-below')!;
    expect(fine.enabled).toBe(true);
    expect(fine.reason).toBeUndefined();
    // P24: Split says when it is off in a table that is in standard form (several cells selected)
    const split = registry.actions({ surface: 'ribbon', context: { state: stateFor(T3, [1, 0], [1, 1]), editable: true } }).find((a) => a.id === 'table.split-cell')!;
    expect(split.enabled).toBe(false);
    expect(split.reason).toContain('Split works on one cell');
  });

  it('FIX-FT: typing in such a table evens it out in the same step; an edit elsewhere leaves it byte for byte; no bar', () => {
    const text = `Para.\n\n${SHORT}\nAfter.\n`;
    const state = stateFor(text, [1, 0]);
    // typing in a cell: one transaction from the author, the tidy step's filling appended (prosemirror-history keeps them as one step)
    const typed = state.applyTransaction(state.tr.insertText('x'));
    expect(typed.transactions).toHaveLength(2);
    expect(t.serialize(typed.state.doc)).toBe('Para.\n\n| A | B | C |\n| --- | --- | --- |\n| x1 | 2 |  |\n\nAfter.');
    // typing in the paragraph above: the table keeps its bytes
    const elsewhere = state.applyTransaction(state.tr.insertText('More ', 1));
    expect(elsewhere.transactions).toHaveLength(1);
    expect(t.serialize(elsewhere.state.doc)).toBe(`More ${text.replace(/\n$/, '')}`);
    // the bar is gone: the plugins draw nothing above the table
    expect(state.plugins.some((p) => (p as unknown as { key: string }).key.startsWith('pmd-table-prompt'))).toBe(false);
  });
});

const T3 = '| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n';

describe('header rows carry the class the profile CSS reaches (OQ-49)', () => {
  it('a header row has it, a body row does not', () => {
    const table = tableOf(t.parse(T3)).node;
    const dom = (row: Node) => JSON.stringify(row.type.spec.toDOM!(row));
    expect(dom(table.child(0))).toContain(HEAD_ROW_CLASS);
    expect(dom(table.child(1))).not.toContain(HEAD_ROW_CLASS);
  });
});
