// Where a table command works (P16): the table around the selection, its map and the selected rectangle. A table
// the commands handle is a pagemd table (it has the `model` attribute; GFM's table has none, AD-P16-01) whose rows
// are all as long as the table is wide (AD-P16-04: a ragged table's text is editable, its tools are off).
import type { Node } from 'prosemirror-model';
import type { EditorState } from 'prosemirror-state';
import { CellSelection, TableMap, cellAround, type Rect } from 'prosemirror-tables';

export interface Column {
  align: '' | 'left' | 'right' | 'center';
  wrap: boolean;
}

export interface TableModelAttr {
  columns: Column[];
  caption: unknown;
  tableCaption: unknown;
}

export interface TableContext {
  table: Node;
  /** Position just before the table. */
  pos: number;
  /** Position at the start of the table's content (what prosemirror-tables calls `tableStart`). */
  tableStart: number;
  map: TableMap;
  /** The selected cells' rectangle (the cursor's cell when the selection is not a cell selection). */
  rect: Rect;
  /** More than one cell is selected. */
  cells: boolean;
  /** Every row has as many columns as the table is wide: the tools work. */
  rectangular: boolean;
}

export const isPagemdTable = (node: Node): boolean => node.type.spec.tableRole === 'table' && !!node.attrs['model'];

/** The pagemd table the selection is in (or selects cells of), or null. */
export function tableAt(state: EditorState): TableContext | null {
  const sel = state.selection;
  const $cell = sel instanceof CellSelection ? sel.$anchorCell : cellAround(sel.$head);
  if (!$cell) return null;
  const table = $cell.node(-1);
  if (!isPagemdTable(table)) return null;
  const tableStart = $cell.start(-1);
  const map = TableMap.get(table);
  const rect = sel instanceof CellSelection ? map.rectBetween(sel.$anchorCell.pos - tableStart, sel.$headCell.pos - tableStart) : map.findCell($cell.pos - tableStart);
  return { table, pos: tableStart - 1, tableStart, map, rect, cells: sel instanceof CellSelection && sel.$anchorCell.pos !== sel.$headCell.pos, rectangular: !map.problems };
}

/** The group of row `index`: header -1, body n. */
export const groupOf = (table: Node, index: number): number => table.child(index).attrs['group'] as number;

export const columnsOf = (table: Node): Column[] => ((table.attrs['model'] as TableModelAttr).columns ?? []).map((c) => ({ ...c }));
