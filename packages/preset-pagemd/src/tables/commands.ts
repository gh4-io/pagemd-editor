// The table commands (P16, R-151, `table.<verb>`): rows, columns, cells, alignment, the header row, delete. Each is a
// registry command of the pagemd table item, enabled only where it applies (in a pagemd table whose rows are all as
// long as the table is wide). prosemirror-tables does the span maths (add, remove, move, split); this file adds
// pagemd's facts: a new row takes a group (header / body n), `model.columns` follows the columns, a merge keeps every
// word. The tidy step (tidy.ts) runs on the transaction afterwards, in the same undo step.
// P19: the column widths (widths.ts): Wider / Narrower / Equal widths / Reset widths, and the widths kept in step when
// columns are added, deleted or moved.
import { Fragment, type Node } from 'prosemirror-model';
import { TextSelection, type EditorState, type Transaction } from 'prosemirror-state';
import { CellSelection, TableMap, addColSpan, addColumn, addRow, deleteRow, deleteTable, removeColumn, splitCell } from 'prosemirror-tables';
import type { CommandSpec, Dispatch } from '@pagemd-editor/core';
import { columnsOf, groupOf, tableAt, type Column, type TableContext, type TableModelAttr } from './context.ts';
import { fitColumnWidths, hasCanvas, measureColumns } from './resize.ts';
import { readsAsHeld } from './readback.ts';
import { fillShortRows, fixTableTransaction, tableShape } from './shape.ts';
import { completeWidths, deleteColumnWidths, insertColumnWidth, layoutOf, splitColumnWidth, setLayout, STEP, tradeWidth } from './widths.ts';

type Align = Column['align'];

const BLANK: Column = { align: '', wrap: false };

/** `tr` with the table's columns replaced (the table is at `pos` in `tr.doc`). */
function setColumns(tr: Transaction, pos: number, columns: Column[]): void {
  const table = tr.doc.nodeAt(pos)!;
  tr.setNodeMarkup(pos, undefined, { ...table.attrs, model: { ...(table.attrs['model'] as TableModelAttr), columns } });
}

/** The table's set widths changed by `change` (complete widths in, complete widths out); nothing when it has none (P19). */
function keepWidths(tr: Transaction, ctx: TableContext, change: (widths: number[]) => number[]): void {
  const layout = layoutOf(ctx.table);
  if (layout.hasWidths) setLayout(tr, ctx.pos, { widths: change(completeWidths(layout)) });
}

/** Where the group of a new row comes from: `row` is the row it is added next to, `below` which side. */
function newRowGroup(table: Node, row: number, below: boolean): number {
  const group = groupOf(table, row);
  // Below the last header row is the first body row (a new body row), not one more header row.
  if (below && group < 0 && (row + 1 >= table.childCount || groupOf(table, row + 1) >= 0)) return row + 1 < table.childCount ? groupOf(table, row + 1) : 0;
  return group;
}

/** A row added at `index` (before the row now there), in the group of the row next to it. */
export function insertRow(state: EditorState, ctx: TableContext, index: number, group: number): Transaction {
  const tr = state.tr;
  addRow(tr, { ...ctx.rect, tableStart: ctx.tableStart, map: ctx.map, table: ctx.table }, index);
  let at = ctx.tableStart;
  const table = tr.doc.nodeAt(ctx.pos)!;
  for (let i = 0; i < index; i++) at += table.child(i).nodeSize;
  tr.setNodeMarkup(at, undefined, { ...table.child(index).attrs, group, multiline: false });
  return tr;
}

/** The new row below the selection (Tab in the last cell uses this too); the cursor goes to its first cell. */
export function addRowBelow(state: EditorState, dispatch?: Dispatch, moveCursor = false): boolean {
  const ctx = tableAt(state);
  if (!ctx?.rectangular) return false;
  if (dispatch) {
    const last = ctx.rect.bottom - 1;
    const tr = insertRow(state, ctx, ctx.rect.bottom, newRowGroup(ctx.table, last, true));
    if (moveCursor) {
      const table = tr.doc.nodeAt(ctx.pos)!;
      let at = ctx.tableStart;
      for (let i = 0; i < ctx.rect.bottom; i++) at += table.child(i).nodeSize;
      tr.setSelection(TextSelection.create(tr.doc, at + 2));
    }
    dispatch(tr.scrollIntoView());
  }
  return true;
}

function addColumnAt(state: EditorState, dispatch: Dispatch | undefined, right: boolean): boolean {
  const ctx = tableAt(state);
  if (!ctx?.rectangular) return false;
  if (dispatch) {
    const col = right ? ctx.rect.right : ctx.rect.left;
    const tr = state.tr;
    addColumn(tr, { ...ctx.rect, tableStart: ctx.tableStart, map: ctx.map, table: ctx.table }, col);
    const columns = columnsOf(ctx.table);
    columns.splice(col, 0, { ...BLANK });
    setColumns(tr, ctx.pos, columns);
    // The new column takes half the width of the column it is added beside (P19).
    keepWidths(tr, ctx, (widths) => insertColumnWidth(widths, col, right ? ctx.rect.right - 1 : ctx.rect.left));
    dispatch(tr.scrollIntoView());
  }
  return true;
}

function deleteColumns(state: EditorState, dispatch: Dispatch | undefined): boolean {
  const ctx = tableAt(state);
  if (!ctx?.rectangular) return false;
  // Every column selected: Word deletes the table (fix run word-style-tables-pictures, AD-FIX-WS-02).
  if (ctx.rect.left === 0 && ctx.rect.right === ctx.map.width) return removeTable(state, dispatch);
  if (dispatch) {
    const tr = state.tr;
    let rect = { ...ctx.rect, tableStart: ctx.tableStart, map: ctx.map, table: ctx.table };
    for (let col = ctx.rect.right - 1; ; col--) {
      removeColumn(tr, rect, col);
      if (col === ctx.rect.left) break;
      const table = tr.doc.nodeAt(ctx.pos)!;
      rect = { ...rect, table, map: TableMap.get(table) };
    }
    const columns = columnsOf(ctx.table);
    columns.splice(ctx.rect.left, ctx.rect.right - ctx.rect.left);
    setColumns(tr, ctx.pos, columns);
    // The deleted columns' width goes to the column on their left (P19).
    keepWidths(tr, ctx, (widths) => deleteColumnWidths(widths, ctx.rect.left, ctx.rect.right));
    dispatch(tr.scrollIntoView());
  }
  return true;
}

/** Rows and columns move one at a time (a selection of several cells is not moved; one merged cell is). */
const single = (ctx: TableContext, axis: 'row' | 'col'): boolean => !ctx.cells || (axis === 'row' ? ctx.rect.bottom - ctx.rect.top === 1 : ctx.rect.right - ctx.rect.left === 1);

/**
 * The rows (or columns) `[from, to)` grown until no cell reaches out of them: a band that moves as one block (FIX-PGF, AD-FIX-PGF-06).
 * A cell two rows tall ties its two rows together, as in Word, where a row with a merged cell moves with the rows the cell covers.
 */
export function bandOf(map: TableMap, axis: 'row' | 'col', from: number, to: number): { from: number; to: number } {
  let lo = from;
  let hi = to;
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = lo; i < hi; i++) {
      const across = axis === 'row' ? map.width : map.height;
      for (let j = 0; j < across; j++) {
        const rect = map.findCell(map.map[axis === 'row' ? i * map.width + j : j * map.width + i]!);
        const [a, b] = axis === 'row' ? [rect.top, rect.bottom] : [rect.left, rect.right];
        if (a < lo || b > hi) {
          lo = Math.min(lo, a);
          hi = Math.max(hi, b);
          changed = true;
        }
      }
    }
  }
  return { from: lo, to: hi };
}

/** The two neighbouring bands a move by `by` swaps (the one with the selection, and the next one that way), or null at the edge. */
function bandsFor(ctx: TableContext, axis: 'row' | 'col', by: -1 | 1): { first: { from: number; to: number }; second: { from: number; to: number }; moving: 'first' | 'second' } | null {
  const size = axis === 'row' ? ctx.map.height : ctx.map.width;
  const own = bandOf(ctx.map, axis, axis === 'row' ? ctx.rect.top : ctx.rect.left, axis === 'row' ? ctx.rect.bottom : ctx.rect.right);
  if (by < 0 ? own.from === 0 : own.to === size) return null;
  const other = by < 0 ? bandOf(ctx.map, axis, own.from - 1, own.from) : bandOf(ctx.map, axis, own.to, own.to + 1);
  return by < 0 ? { first: other, second: own, moving: 'second' } : { first: own, second: other, moving: 'first' };
}

/** `[0, n)` with the adjacent ranges `first` and `second` swapped. */
function swappedOrder(n: number, first: { from: number; to: number }, second: { from: number; to: number }): number[] {
  const range = (a: number, b: number): number[] => Array.from({ length: b - a }, (_, k) => a + k);
  return [...range(0, first.from), ...range(second.from, second.to), ...range(first.from, first.to), ...range(second.to, n)];
}

/** The selection in `tr.doc` after the table at `pos` was replaced by one made of the same cell nodes (found again by identity). */
function keepSelection(state: EditorState, tr: Transaction, ctx: TableContext): void {
  const old = state.selection;
  const fresh = tr.doc.nodeAt(ctx.pos)!;
  const where = new Map<Node, number>();
  fresh.descendants((node, offset) => {
    if (node.type.spec.tableRole === 'cell' || node.type.spec.tableRole === 'header_cell') {
      where.set(node, ctx.tableStart + offset);
      return false;
    }
    return true;
  });
  const map = (p: number): number => {
    const $p = state.doc.resolve(p);
    for (let d = $p.depth; d > 0; d--) {
      const cell = $p.node(d);
      const at = where.get(cell);
      if (at !== undefined) return at + (p - $p.before(d));
    }
    return p;
  };
  const mapCell = (p: number): number => where.get(state.doc.nodeAt(p)!) ?? p; // (a cell selection names the positions before its cells)
  if (old instanceof CellSelection) tr.setSelection(CellSelection.create(tr.doc, mapCell(old.$anchorCell.pos), mapCell(old.$headCell.pos)));
  else tr.setSelection(TextSelection.create(tr.doc, map(old.anchor), map(old.head)));
}

/**
 * Move row up / down (FIX-PGF, AD-FIX-PGF-06, Word's way): the row moves past the next row, and rows tied together by a cell that
 * spans them move as one block (so every span stays whole). Rows keep their places' groups (header, body n) and take their own
 * line-break flag with them. Not into or out of the header.
 */
function moveRow(state: EditorState, dispatch: Dispatch | undefined, by: -1 | 1): boolean {
  const ctx = tableAt(state);
  if (!ctx?.rectangular || !single(ctx, 'row')) return false;
  const bands = bandsFor(ctx, 'row', by);
  if (!bands) return false;
  const kind = groupOf(ctx.table, bands.first.from) < 0;
  for (let i = bands.first.from; i < bands.second.to; i++) if (groupOf(ctx.table, i) < 0 !== kind) return false;
  if (!dispatch) return true;
  const order = swappedOrder(ctx.table.childCount, bands.first, bands.second);
  const rows = order.map((from, i) => ctx.table.child(from).type.create({ ...ctx.table.child(from).attrs, group: groupOf(ctx.table, i) }, ctx.table.child(from).content));
  const tr = state.tr.replaceWith(ctx.pos, ctx.pos + ctx.table.nodeSize, ctx.table.type.create(ctx.table.attrs, rows, ctx.table.marks));
  keepSelection(state, tr, ctx);
  dispatch(tr.scrollIntoView());
  return true;
}

/**
 * Move column left / right (FIX-PGF, AD-FIX-PGF-06): the column moves past the next one, and columns tied together by a cell that
 * spans them move as one block. Each column's alignment and width go with it.
 */
function moveColumn(state: EditorState, dispatch: Dispatch | undefined, by: -1 | 1): boolean {
  const ctx = tableAt(state);
  if (!ctx?.rectangular || !single(ctx, 'col')) return false;
  const bands = bandsFor(ctx, 'col', by);
  if (!bands) return false;
  if (!dispatch) return true;
  const { map, table } = ctx;
  const order = swappedOrder(map.width, bands.first, bands.second);
  const rank = new Map(order.map((col, i) => [col, i]));
  const rows: Node[] = [];
  table.forEach((row, offset) => {
    // The cells that start in this row, by the column they start in; then in the new order of those columns.
    const cells: { cell: Node; left: number }[] = [];
    row.forEach((cell, cellOffset) => cells.push({ cell, left: map.findCell(offset + 1 + cellOffset).left }));
    cells.sort((a, b) => rank.get(a.left)! - rank.get(b.left)!);
    rows.push(row.type.create(row.attrs, Fragment.from(cells.map((c) => c.cell)), row.marks));
  });
  const tr = state.tr.replaceWith(ctx.pos, ctx.pos + table.nodeSize, table.type.create(table.attrs, rows, table.marks));
  const columns = columnsOf(table);
  setColumns(tr, ctx.pos, order.map((col) => columns[col] ?? { ...BLANK }));
  // The moved columns take their widths with them (P19).
  const layout = layoutOf(table);
  if (layout.hasWidths) setLayout(tr, ctx.pos, { widths: order.map((col) => layout.widths[col] ?? null) });
  keepSelection(state, tr, ctx);
  dispatch(tr.scrollIntoView());
  return true;
}

/** Every selected cell is in one row group (a merged cell can't reach from the header into the body). */
function oneGroup(ctx: TableContext): boolean {
  const group = groupOf(ctx.table, ctx.rect.top);
  for (let row = ctx.rect.top; row < ctx.rect.bottom; row++) if (groupOf(ctx.table, row) !== group) return false;
  return true;
}

/**
 * The rows below the selection's first row that a merge leaves with no cell of its own (all of their cells inside the
 * selection, the rest covered by a `^^` from above). An editor table can't hold a row without cells, so Word's way is taken
 * (user, 2026-10-23, R-236; fix run word-style-tables-pictures, AD-FIX-WS-01): the merge goes ahead, those rows are removed and
 * every cell that reached down through them is made one row shorter for each. (AD-FIX-UB-03 had switched such a merge off.)
 */
function emptiedRows(ctx: TableContext): number[] {
  const { map, rect } = ctx;
  const rows: number[] = [];
  for (let row = rect.top + 1; row < rect.bottom; row++) {
    let own = false;
    for (let col = 0; col < map.width && !own; col++) {
      const cell = map.findCell(map.map[row * map.width + col]!);
      const inside = cell.left >= rect.left && cell.right <= rect.right && cell.top >= rect.top && cell.bottom <= rect.bottom;
      own = cell.top === row && !inside;
    }
    if (!own) rows.push(row);
  }
  return rows;
}

/** Merge the selected cells into one: their text goes together with a space between, so no word is lost. */
function mergeSelected(state: EditorState, dispatch: Dispatch | undefined): boolean {
  const ctx = tableAt(state);
  const sel = state.selection;
  if (!ctx?.rectangular || !ctx.cells || !(sel instanceof CellSelection) || !oneGroup(ctx)) return false;
  const { map, rect, table, tableStart } = ctx;
  // The rectangle must not cut through a spanning cell.
  const cells: { pos: number; node: Node }[] = [];
  const seen = new Set<number>();
  for (let row = rect.top; row < rect.bottom; row++) {
    for (let col = rect.left; col < rect.right; col++) {
      const pos = map.map[row * map.width + col]!;
      if (seen.has(pos)) continue;
      seen.add(pos);
      const cellRect = map.findCell(pos);
      if (cellRect.left < rect.left || cellRect.right > rect.right || cellRect.top < rect.top || cellRect.bottom > rect.bottom) return false;
      cells.push({ pos, node: table.nodeAt(pos)! });
    }
  }
  if (cells.length < 2) return false;
  const emptied = emptiedRows(ctx);
  if (!dispatch) return true;
  const tr = state.tr;
  const first = cells[0]!;
  let content: Fragment = first.node.content;
  for (const { node } of cells.slice(1)) {
    if (node.content.size === 0) continue;
    if (content.size > 0) content = content.append(Fragment.from(state.schema.text(' ')));
    content = content.append(node.content);
  }
  // Cells outside the selection that reach down through a removed row become shorter by the rows they cross.
  const rowsCrossed = (top: number, bottom: number): number => emptied.filter((r) => r > top && r < bottom).length;
  const outside = new Set<number>();
  for (let row = 0; row < map.height; row++) {
    for (let col = 0; col < map.width; col++) {
      const pos = map.map[row * map.width + col]!;
      if (seen.has(pos) || outside.has(pos)) continue;
      outside.add(pos);
      const c = map.findCell(pos);
      const n = rowsCrossed(c.top, c.bottom);
      if (n > 0) tr.setNodeMarkup(pos + tableStart, null, { ...table.nodeAt(pos)!.attrs, rowspan: c.bottom - c.top - n });
    }
  }
  const rowStart = (index: number): number => {
    let at = tableStart;
    for (let i = 0; i < index; i++) at += table.child(i).nodeSize;
    return at;
  };
  for (const row of emptied) {
    const from = tr.mapping.map(rowStart(row));
    tr.delete(from, from + table.child(row).nodeSize);
  }
  for (const { pos, node } of cells.slice(1)) {
    const cell = map.findCell(pos);
    if (emptied.includes(cell.top)) continue; // its whole row is gone
    const from = tr.mapping.map(pos + tableStart);
    tr.delete(from, from + node.nodeSize);
  }
  tr.setNodeMarkup(first.pos + tableStart, null, { ...addColSpan(first.node.attrs as Parameters<typeof addColSpan>[0], first.node.attrs['colspan'] as number, rect.right - rect.left - (first.node.attrs['colspan'] as number)), rowspan: rect.bottom - rect.top - emptied.length });
  const inner = first.pos + tableStart + 1;
  if (content !== first.node.content) tr.replaceWith(inner, inner + first.node.content.size, content);
  tr.setSelection(new CellSelection(tr.doc.resolve(first.pos + tableStart)));
  dispatch(tr.scrollIntoView());
  return true;
}

/** The one plain cell (one column, one row) the selection is in, or null: what Split cuts in two (P24, R-236). */
export function plainCell(ctx: TableContext): { pos: number; node: Node } | null {
  const { rect, map, table } = ctx;
  if (rect.right - rect.left !== 1 || rect.bottom - rect.top !== 1) return null;
  const pos = map.map[rect.top * map.width + rect.left]!;
  const node = table.nodeAt(pos);
  if (!node || node.attrs['colspan'] !== 1 || node.attrs['rowspan'] !== 1) return null;
  return { pos, node };
}

/**
 * Split on a cell that is not merged (P24, as Word's Split Cells with 2 columns and 1 row): the cell keeps its text and a new
 * empty cell (a header cell in a header row) is added to its right; in every other row the one cell over this column gets one
 * more column span (`||`), so the other rows look as before; `model.columns` gets a copy of the column; the column's width, when
 * the table has widths, is halved (an equal table gets explicit equal widths first); a table with no widths gets none. One
 * transaction; both cells are selected afterwards.
 */
export function splitTransaction(state: EditorState, ctx: TableContext, cell: { pos: number; node: Node }): Transaction {
  const { map, table, tableStart, rect } = ctx;
  const col = rect.left;
  const tr = state.tr;
  const seen = new Set<number>([cell.pos]);
  for (let row = 0; row < map.height; row++) {
    const pos = map.map[row * map.width + col]!;
    if (seen.has(pos)) continue; // a cell reaching down through several rows is widened once
    seen.add(pos);
    const node = table.nodeAt(pos)!;
    tr.setNodeMarkup(pos + tableStart, null, { ...node.attrs, colspan: (node.attrs['colspan'] as number) + 1 });
  }
  const at = tableStart + cell.pos + cell.node.nodeSize;
  tr.insert(at, cell.node.type.createAndFill({ ...cell.node.attrs, colspan: 1, rowspan: 1, colwidth: null })!);
  const columns = columnsOf(table);
  columns.splice(col, 0, { ...(columns[col] ?? BLANK) });
  setColumns(tr, ctx.pos, columns);
  const layout = layoutOf(table);
  if (layout.hasWidths || layout.fixed) setLayout(tr, ctx.pos, { widths: splitColumnWidth(completeWidths(layout), col) });
  tr.setSelection(CellSelection.create(tr.doc, tableStart + cell.pos, at));
  return tr;
}

/**
 * AD-P24-01: whether pagemd's reader reads the table the split makes the way the editor holds it (readback.ts). It does not
 * for a header that has spans and a body cell whose span would be clamped (the last column, or a column split twice); Split is
 * off there, with a reason, until the reader (pagemd-common) is fixed. Cached per table, so the ribbon asking is cheap.
 */
const splitReads = new WeakMap<Node, Map<number, boolean>>();
function splitReadsBack(state: EditorState, ctx: TableContext, cell: { pos: number; node: Node }): boolean {
  let byCell = splitReads.get(ctx.table);
  if (!byCell) splitReads.set(ctx.table, (byCell = new Map()));
  let ok = byCell.get(cell.pos);
  if (ok === undefined) byCell.set(cell.pos, (ok = readsAsHeld(splitTransaction(state, ctx, cell).doc.nodeAt(ctx.pos)!)));
  return ok;
}

function split(state: EditorState, dispatch: Dispatch | undefined): boolean {
  const ctx = tableAt(state);
  if (!ctx?.rectangular) return false;
  const plain = plainCell(ctx);
  if (plain) {
    if (!splitReadsBack(state, ctx, plain)) return false;
    if (dispatch) dispatch(splitTransaction(state, ctx, plain).scrollIntoView());
    return true;
  }
  return splitCell(state, dispatch ? (tr) => dispatch(tr.scrollIntoView()) : undefined);
}

/** Why Split is off (the tooltip): it needs one cell, or a merged cell, selected; more than one cell is Merge's job. */
function splitReason(state: EditorState): string | null {
  const standard = tableReason(state);
  if (standard) return standard;
  const ctx = tableAt(state);
  if (!ctx || split(state, undefined)) return null;
  const plain = plainCell(ctx);
  if (plain && !splitReadsBack(state, ctx, plain)) return "Split is off here: pagemd's reader would read the spans in this table's header and rows differently from how they are written (a known limit with spans in the header, mostly the last column or a column split twice). Add a column with Add column right or left instead";
  return 'Split works on one cell (it adds a column) or on a merged cell (it takes it apart): click in a single cell first';
}

/** The header row on or off: the first row becomes a header row; off, every header row becomes a body row. */
function headerRow(state: EditorState, dispatch: Dispatch | undefined): boolean {
  const ctx = tableAt(state);
  if (!ctx?.rectangular) return false;
  const on = groupOf(ctx.table, 0) < 0;
  // FIX-PGF (AD-FIX-PGF-05, Word's way): a table of one row can have its header row turned off too. pagemd reads both spellings:
  // `| A |` over `| --- |` (a header and no body) and `| --- |` over `| A |` (headerless: a body and no header).
  if (dispatch) {
    const tr = state.tr;
    let firstBody = 0;
    while (firstBody < ctx.table.childCount && groupOf(ctx.table, firstBody) < 0) firstBody++;
    const body = firstBody < ctx.table.childCount ? groupOf(ctx.table, firstBody) : 0;
    let at = ctx.tableStart;
    ctx.table.forEach((row, _o, index) => {
      if (on && (row.attrs['group'] as number) < 0) tr.setNodeMarkup(at, undefined, { ...row.attrs, group: body });
      if (!on && index === 0) tr.setNodeMarkup(at, undefined, { ...row.attrs, group: -1 });
      at += row.nodeSize;
    });
    dispatch(tr.scrollIntoView());
  }
  return true;
}

function align(state: EditorState, dispatch: Dispatch | undefined, value: Align): boolean {
  const ctx = tableAt(state);
  if (!ctx?.rectangular) return false;
  if (dispatch) {
    const columns = columnsOf(ctx.table);
    for (let col = ctx.rect.left; col < ctx.rect.right; col++) columns[col] = { ...(columns[col] ?? BLANK), align: value };
    const tr = state.tr;
    setColumns(tr, ctx.pos, columns);
    dispatch(tr);
  }
  return true;
}

const alignedAs = (state: EditorState, value: Align): boolean => {
  const ctx = tableAt(state);
  if (!ctx) return false;
  const columns = columnsOf(ctx.table);
  for (let col = ctx.rect.left; col < ctx.rect.right; col++) if ((columns[col]?.align ?? '') !== value) return false;
  return true;
};

function removeRows(state: EditorState, dispatch: Dispatch | undefined): boolean {
  const ctx = tableAt(state);
  if (!ctx?.rectangular) return false;
  // Every row selected: Word deletes the table (AD-FIX-WS-02; prosemirror-tables itself refuses that case).
  if (ctx.rect.top === 0 && ctx.rect.bottom === ctx.map.height) return removeTable(state, dispatch);
  return deleteRow(state, dispatch ? (tr) => dispatch(tr.scrollIntoView()) : undefined);
}

function removeTable(state: EditorState, dispatch: Dispatch | undefined): boolean {
  if (!tableAt(state)) return false;
  return deleteTable(state, dispatch);
}

/**
 * The column Wider / Narrower / Fit change, and the column it trades width with (FIX-PGF, AD-FIX-PGF-07): the first column the
 * selection covers (a merged cell's first column too), traded with the column just after the selection, or just before it when the
 * selection reaches the right edge. So a merged cell gets wider as a whole, as in Word; one column works as before (P19, AD-P19-05).
 * Null in a one-column table, or when the selection covers every column (there is no column to take the width from).
 */
function widthTarget(ctx: TableContext): { col: number; other: number } | null {
  if (ctx.map.width < 2) return null;
  const other = ctx.rect.right < ctx.map.width ? ctx.rect.right : ctx.rect.left - 1;
  return other < 0 ? null : { col: ctx.rect.left, other };
}

/** Why Wider / Narrower / Fit is off here (a one-column table, or every column selected); null when it isn't for that. */
export function widthReason(state: EditorState): string | null {
  const standard = tableReason(state);
  if (standard) return standard;
  const ctx = tableAt(state);
  if (!ctx || widthTarget(ctx)) return null;
  if (ctx.map.width < 2) return "A table with one column always fills the text width in pagemd: there is no other column to take the width from (pagemd has no width setting for the table itself)";
  return 'The selection covers every column: there is no column outside it to take the width from. Click in one cell first';
}

/**
 * The column under the cursor wider by `by` points (narrower when negative), traded with its neighbour (P19, AD-P19-05). A table
 * without the fixed layout starts from the widths the canvas shows (AD-P19-06). A merged cell or a selection of several columns:
 * its first column, traded with the column outside it (AD-FIX-PGF-07).
 */
function widen(state: EditorState, dispatch: Dispatch | undefined, by: number): boolean {
  const ctx = tableAt(state);
  if (!ctx?.rectangular) return false;
  const target = widthTarget(ctx);
  if (!target) return false;
  const layout = layoutOf(ctx.table);
  const changes = (widths: readonly number[]): boolean => tradeWidth(widths, target.col, target.other, by)[target.col] !== widths[target.col];
  if (layout.fixed && !changes(completeWidths(layout))) return false;
  if (!dispatch) return true;
  const start = completeWidths(layout, measureColumns(state, ctx.pos));
  if (!changes(start)) return false;
  const tr = state.tr;
  if (!setLayout(tr, ctx.pos, { widths: tradeWidth(start, target.col, target.other, by) })) return false;
  dispatch(tr);
  return true;
}

/**
 * The cursor's column fitted to its content (P19 follow-up, the keyboard way to a double-click on its right border): the
 * column gets the width its widest cell needs on one line, traded with its neighbour as Wider does. Needs the canvas (it
 * measures the text), so it is off without one. A merged cell or several columns: their first column (AD-FIX-PGF-07).
 */
function fitColumn(state: EditorState, dispatch: Dispatch | undefined): boolean {
  const ctx = tableAt(state);
  const target = ctx?.rectangular ? widthTarget(ctx) : null;
  if (!ctx || !target || !hasCanvas(state)) return false;
  if (!dispatch) return true;
  const widths = fitColumnWidths(state, ctx.pos, target.col, target.other);
  if (!widths) return false;
  const tr = state.tr;
  if (setLayout(tr, ctx.pos, { widths })) dispatch(tr);
  return true;
}

/**
 * "Even out rows" (P19 follow-up; round 3: shape.ts): a table whose rows are shorter than the table is wide has every other
 * table tool off. This adds empty cells to the short rows, in one undo step, so the tools work again. `splitSpan`: a row
 * ending in a cell that spans to the right edge (`| … | Revised Day ||`) has that span turned into empty cells first: the
 * second choice the prompt offers (never assumed).
 */
function fillRows(state: EditorState, dispatch: Dispatch | undefined, splitSpan = false): boolean {
  const ctx = tableAt(state);
  if (!ctx) return false;
  const shape = tableShape(ctx.table);
  if (shape.kind !== 'fixable' || (splitSpan && !shape.spanAtEnd)) return false;
  if (dispatch) {
    const tr = fixTableTransaction(state, ctx.pos, splitSpan);
    if (!tr) return false;
    dispatch(tr.scrollIntoView());
  }
  return true;
}

/**
 * Why a table tool is off in this table (round 3): the table isn't in standard form and filling can't fix it (cells that
 * overlap). A table filling fixes has its tools on (FIX-FT, AD-FIX-FT-05), so it gives no reason.
 */
export function tableReason(state: EditorState): string | null {
  const ctx = tableAt(state);
  if (!ctx || ctx.rectangular) return null;
  const shape = tableShape(ctx.table);
  if (shape.kind === 'broken') return `this table isn't in standard form: ${shape.reason}`;
  return null;
}

/**
 * A table tool in a table whose short rows filling fixes (FIX-FT, AD-FIX-FT-05, Word's way): the tool works on the table as
 * it would be with empty cells at the ends of its short rows, and the one transaction it dispatches holds both, the filling
 * and the tool's own change (one undo step). Elsewhere the tool runs as it is.
 */
export function throughFill(run: Run): Run {
  return (state, dispatch) => {
    const ctx = tableAt(state);
    if (!ctx || ctx.rectangular) return run(state, dispatch);
    const fill = state.tr;
    if (!fillShortRows(fill, ctx.pos)) return run(state, dispatch);
    const filled = state.apply(fill);
    if (!dispatch) return run(filled, undefined);
    let inner: Transaction | undefined;
    if (!run(filled, (tr) => (inner = tr))) return false;
    if (!inner) return true;
    const done = inner as Transaction;
    for (const step of done.steps) fill.step(step);
    // The tool's selection is in a document equal to `fill.doc`: resolved there again, unmoved.
    fill.setSelection(done.selection.map(fill.doc, fill.mapping.slice(fill.mapping.maps.length)));
    if (done.scrolledIntoView) fill.scrollIntoView();
    dispatch(fill);
    return true;
  };
}

/** Every column the same width: `.fixed-layout` and no widths (P19, AD-P19-07). */
function equalWidths(state: EditorState, dispatch: Dispatch | undefined): boolean {
  const ctx = tableAt(state);
  if (!ctx?.rectangular) return false;
  if (dispatch) {
    const tr = state.tr;
    if (setLayout(tr, ctx.pos, { widths: null, fixedClass: true })) dispatch(tr);
  }
  return true;
}

const isEqual = (state: EditorState): boolean => {
  const ctx = tableAt(state);
  if (!ctx) return false;
  const layout = layoutOf(ctx.table);
  return layout.fixed && !layout.hasWidths; // equal columns, however written (widths="equal" or .fixed-layout)
};

/** Automatic widths again: the widths and `.fixed-layout` both go (P19). */
function resetWidths(state: EditorState, dispatch: Dispatch | undefined): boolean {
  const ctx = tableAt(state);
  if (!ctx?.rectangular) return false;
  const tr = state.tr;
  if (!setLayout(tr, ctx.pos, { widths: null, fixedClass: false })) return false;
  if (dispatch) dispatch(tr);
  return true;
}

type Run = (state: EditorState, dispatch: Dispatch | undefined) => boolean;

/** `icon`: a codicon (P17: every ribbon button has one; '' would mean none). */
const command = (id: string, label: string, icon: string, tool: Run, isActive?: (state: EditorState) => boolean, reason: (state: EditorState) => string | null = tableReason): CommandSpec => {
  // Even out rows works on the table as it is; every other tool through the filling (AD-FIX-FT-05).
  const run = id.startsWith('table.fill-rows') ? tool : throughFill(tool);
  return {
    id,
    label,
    ...(icon ? { icon } : {}),
    slash: false, // table tools are not inserted blocks: the Table tab and the keyboard have them
    isEnabled: (state) => run(state, undefined),
    ...(isActive ? { isActive } : {}),
    reason, // round 3: off in a table not in standard form that filling can't fix, the tooltip says why
    run: (state, dispatch) => run(state, dispatch),
  };
};

/** The 25 table commands, in the order the Table tab shows them. */
export function tableCommands(): CommandSpec[] {
  return [
    command('table.add-row-above', 'Add row above', 'arrow-up', (state, dispatch) => {
      const ctx = tableAt(state);
      if (!ctx?.rectangular) return false;
      if (dispatch) dispatch(insertRow(state, ctx, ctx.rect.top, newRowGroup(ctx.table, ctx.rect.top, false)).scrollIntoView());
      return true;
    }),
    command('table.add-row-below', 'Add row below', 'arrow-down', (state, dispatch) => addRowBelow(state, dispatch)),
    command('table.delete-row', 'Delete row', 'trash', removeRows),
    command('table.move-row-up', 'Move row up', 'chevron-up', (state, dispatch) => moveRow(state, dispatch, -1)),
    command('table.move-row-down', 'Move row down', 'chevron-down', (state, dispatch) => moveRow(state, dispatch, 1)),
    command('table.add-column-left', 'Add column left', 'arrow-left', (state, dispatch) => addColumnAt(state, dispatch, false)),
    command('table.add-column-right', 'Add column right', 'arrow-right', (state, dispatch) => addColumnAt(state, dispatch, true)),
    command('table.delete-column', 'Delete column', 'trash', deleteColumns),
    command('table.move-column-left', 'Move column left', 'chevron-left', (state, dispatch) => moveColumn(state, dispatch, -1)),
    command('table.move-column-right', 'Move column right', 'chevron-right', (state, dispatch) => moveColumn(state, dispatch, 1)),
    command('table.merge-cells', 'Merge cells', 'combine', mergeSelected),
    command('table.split-cell', 'Split cell', 'split-horizontal', split, undefined, splitReason),
    command('table.header-row', 'Header row', 'layout-panel-justify', headerRow, (state) => {
      const ctx = tableAt(state);
      return !!ctx && groupOf(ctx.table, 0) < 0;
    }),
    command('table.align-left', 'Align left', 'layout-panel-left', (state, dispatch) => align(state, dispatch, 'left'), (state) => alignedAs(state, 'left')),
    command('table.align-center', 'Align center', 'layout-panel-center', (state, dispatch) => align(state, dispatch, 'center'), (state) => alignedAs(state, 'center')),
    command('table.align-right', 'Align right', 'layout-panel-right', (state, dispatch) => align(state, dispatch, 'right'), (state) => alignedAs(state, 'right')),
    command('table.align-none', 'No alignment', 'circle-slash', (state, dispatch) => align(state, dispatch, ''), (state) => alignedAs(state, '')),
    command('table.column-wider', 'Wider column', 'arrow-both', (state, dispatch) => widen(state, dispatch, STEP), undefined, widthReason),
    command('table.column-narrower', 'Narrower column', 'screen-normal', (state, dispatch) => widen(state, dispatch, -STEP), undefined, widthReason),
    command('table.equal-widths', 'Equal column widths', 'symbol-ruler', equalWidths, isEqual),
    command('table.reset-widths', 'Automatic column widths', 'discard', resetWidths),
    command('table.fit-column', 'Fit column to content', 'whole-word', fitColumn, undefined, widthReason),
    command('table.fill-rows', 'Even out rows: add empty cells to the short rows, so the table tools work', 'list-flat', (state, dispatch) => fillRows(state, dispatch)),
    command('table.fill-rows-split', 'Even out rows, with the span at the end of a row made into empty cells (|| meant as an empty column)', 'split-horizontal', (state, dispatch) => fillRows(state, dispatch, true)),
    command('table.delete', 'Delete table', 'trash', removeTable),
  ];
}
