// The tidy step (P16, amendment 6, AD-P16-03): what prosemirror-tables' commands and paste don't know about a pagemd
// table, put right in the same transaction (so it is one undo step). A table is written whole from its rows' groups
// (header -1, body n), so after any change:
// - a row's group is where it belongs: header rows at the top, body groups never going back;
// - header rows are made of header cells and body rows of body cells;
// - a rowspan stays inside its row's group (the rows it can no longer reach get an empty cell);
// - `model.columns` is as long as the table is wide, and every cell's `align` shows its column's alignment (display only).
// A table whose rows are not all as long as the table is wide (a "ragged" table) keeps its bytes until it is edited. FIX-FT
// (AD-FIX-FT-04, Word's way: the author sees one table and every tool works): with `fill`, the first edit in a ragged table
// that filling fixes (shape.ts) also adds the empty cells at the ends of its short rows, so the table is written in standard
// form, in the same undo step. A table filling can't fix (cells that overlap) is still left as the author wrote it.
import type { Node } from 'prosemirror-model';
import type { Transaction } from 'prosemirror-state';
import { TableMap, tableNodeTypes } from 'prosemirror-tables';
import { columnsOf, isPagemdTable, type Column, type TableModelAttr } from './context.ts';
import { fillShortRows } from './shape.ts';

interface Cell {
  /** Offset of the cell from the start of the table's content. */
  offset: number;
  node: Node;
  row: number;
  col: number;
}

/** The groups the rows should have: header rows first, body groups in order. */
export function tidyGroups(table: Node): number[] {
  const groups: number[] = [];
  let seenBody = false;
  let lastBody = 0;
  table.forEach((row) => {
    let group = row.attrs['group'] as number;
    if (group < 0) {
      if (seenBody) group = lastBody;
    } else {
      if (group < lastBody) group = lastBody;
      seenBody = true;
      lastBody = group;
    }
    groups.push(group);
  });
  return groups;
}

/** The cells of a rectangular table, each once, in reading order. */
function cellsOf(table: Node, map: TableMap): Cell[] {
  const cells: Cell[] = [];
  for (let row = 0; row < map.height; row++) {
    for (let col = 0; col < map.width; col++) {
      const offset = map.map[row * map.width + col]!;
      if ((row > 0 && map.map[(row - 1) * map.width + col] === offset) || (col > 0 && map.map[row * map.width + col - 1] === offset)) continue;
      cells.push({ offset, node: table.nodeAt(offset)!, row, col });
    }
  }
  return cells;
}

/** Puts the table at `pos` in order inside `tr` (with `fill`, a ragged table is evened out first). Returns whether it changed anything. */
export function tidyTable(tr: Transaction, pos: number, fill = false): boolean {
  let table = tr.doc.nodeAt(pos);
  if (!table || !isPagemdTable(table)) return false;
  let map = TableMap.get(table);
  const filled = !!map.problems && fill && fillShortRows(tr, pos);
  if (filled) {
    table = tr.doc.nodeAt(pos)!;
    map = TableMap.get(table);
  }
  if (map.problems) return filled;
  const start = pos + 1;
  const types = tableNodeTypes(tr.doc.type.schema);
  const groups = tidyGroups(table);
  const model = table.attrs['model'] as TableModelAttr;
  const wanted: Column[] = Array.from({ length: map.width }, (_, k) => columnsOf(table)[k] ?? { align: '', wrap: false });
  const before = tr.steps.length;

  // Rows' offsets from the start of the table's content.
  const rowAt: number[] = [];
  let offset = 0;
  table.forEach((row) => {
    rowAt.push(offset);
    offset += row.nodeSize;
  });

  const fillers: { row: number; col: number; colspan: number }[] = [];
  const cells = cellsOf(table, map);
  for (const cell of cells) {
    const group = groups[cell.row]!;
    let reach = 1;
    while (cell.row + reach < map.height && groups[cell.row + reach] === group) reach++;
    const rowspan = Math.min(cell.node.attrs['rowspan'] as number, reach);
    for (let r = cell.row + rowspan; r < cell.row + (cell.node.attrs['rowspan'] as number); r++) fillers.push({ row: r, col: cell.col, colspan: cell.node.attrs['colspan'] as number });
    const type = group < 0 ? types['header_cell']! : types['cell']!;
    const align = wanted[cell.col]?.align || null;
    if (type === cell.node.type && rowspan === cell.node.attrs['rowspan'] && align === (cell.node.attrs['align'] ?? null)) continue;
    tr.setNodeMarkup(start + cell.offset, type, { ...cell.node.attrs, rowspan, align });
  }
  table.forEach((row, _o, index) => {
    if (groups[index] !== row.attrs['group']) tr.setNodeMarkup(start + rowAt[index]!, undefined, { ...row.attrs, group: groups[index] });
  });
  if (JSON.stringify(wanted) !== JSON.stringify(model.columns)) tr.setNodeMarkup(pos, undefined, { ...table.attrs, model: { ...model, columns: wanted } });

  // Empty cells where a rowspan was cut short: last position first, so none moves another.
  const insertAt = (filler: (typeof fillers)[number]): number => {
    let at = start + rowAt[filler.row]! + 1;
    for (const cell of cells) if (cell.row === filler.row && cell.col < filler.col) at += cell.node.nodeSize;
    return at;
  };
  fillers
    .map((filler) => ({ filler, at: insertAt(filler) }))
    .sort((a, b) => b.at - a.at || b.filler.col - a.filler.col)
    .forEach(({ filler, at }) => {
      const type = groups[filler.row]! < 0 ? types['header_cell']! : types['cell']!;
      tr.insert(at, type.createAndFill({ colspan: filler.colspan })!);
    });
  return filled || tr.steps.length > before;
}
