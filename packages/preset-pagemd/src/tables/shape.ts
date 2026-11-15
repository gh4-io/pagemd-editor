// Tables not in standard form (P19 round 3). A pagemd table whose rows don't all reach the table's width can't use the
// table tools (prosemirror-tables needs a rectangle; P16 never "fixes" a table by itself, AD-P16-03/04). The shapes the
// reader gives us that way, checked by running it (P19.md, round 3):
// - a body row with fewer cells than the header (a column added to the header and separator lines only);
// - a row with more cells than the header, or a separator line with more cells than the header (the header is short);
// - `||` at the end of the header with body rows of the old width (a span: the rows below are short);
// - a `^^` row with an extra cell.
// prosemirror-tables reports all of these as "missing" cells and nothing else. That is the one shape called FIXABLE here:
// filling the short rows with empty cells at their end changes no text and no span. FIX-FT (AD-FIX-FT-04/05, Word's way):
// such a table is drawn as pagemd draws it and keeps its bytes until it is edited; its first edit (typing, a table tool, the
// Inspector, a border drag) also fills its short rows, in the same undo step, so it is written in standard form. Any other
// problem (cells that overlap, a span reaching past the table) is NOT fixed: its tools stay off and say why. Shapes the
// reader accepts as they are (no outer pipes, a separator line with fewer cells) are ordinary tables: their tools work and a
// save writes them in pagemd's usual form.
import type { Node } from 'prosemirror-model';
import type { EditorState, Transaction } from 'prosemirror-state';
import { TableMap, tableNodeTypes } from 'prosemirror-tables';
import { groupOf } from './context.ts';

export type TableShape =
  | { kind: 'standard' }
  | { kind: 'fixable'; reason: string; spanAtEnd: boolean }
  | { kind: 'broken'; reason: string };

type Missing = { type: 'missing'; row: number; n: number };

/** Whether the table's rows all reach its width; when not, whether filling short rows fixes it, and why, in plain words. */
export function tableShape(table: Node): TableShape {
  const map = TableMap.get(table);
  const problems = map.problems;
  if (!problems || problems.length === 0) return { kind: 'standard' };
  if (problems.some((p) => p.type !== 'missing')) {
    return { kind: 'broken', reason: 'some cells overlap (a ^^ or || reaches into another cell), so the table tools can\'t work on it. Its text can still be edited' };
  }
  const missing = problems as Missing[];
  const first = missing.slice().sort((a, b) => a.row - b.row)[0]!;
  const header = groupOf(table, first.row) < 0;
  const which = header ? `the header row (row ${first.row + 1})` : `row ${first.row + 1}`;
  const more = missing.length > 1 ? ` (and ${missing.length - 1} more row${missing.length > 2 ? 's' : ''})` : '';
  return {
    kind: 'fixable',
    reason: `${which} has ${map.width - first.n} of the table's ${map.width} cells${more}`,
    spanAtEnd: spanAtEndRow(table, map) >= 0,
  };
}

/** A row whose last cell spans columns up to the table's right edge (`| … | Revised Day ||`), or -1. */
function spanAtEndRow(table: Node, map: TableMap): number {
  for (let row = 0; row < table.childCount; row++) {
    const last = table.child(row).lastChild;
    if (!last || (last.attrs['colspan'] as number) < 2) continue;
    // The last cell's offset in the table's content: the rows before, the row's opening, the cells before it.
    let offset = 0;
    for (let r = 0; r < row; r++) offset += table.child(r).nodeSize;
    offset += table.child(row).nodeSize - 1 - last.nodeSize;
    try {
      if (map.findCell(offset).right === map.width) return row;
    } catch {
      /* a cell the map doesn't hold */
    }
  }
  return -1;
}

/**
 * The fix, as one transaction for the table at `pos`: empty cells at the end of every short row (header cells in a header
 * row). With `splitSpan`, a row ending in a cell that spans to the right edge first gets that span turned into separate
 * empty cells (`|| ` meant as an empty column; only when the author picks it). Null when the table isn't fixable.
 */
export function fixTableTransaction(state: EditorState, pos: number, splitSpan = false): Transaction | null {
  const tr = state.tr;
  return fillShortRows(tr, pos, splitSpan) ? tr : null;
}

/**
 * The fix added to `tr` for the table at `pos` in `tr.doc` (FIX-FT, AD-FIX-FT-04: the tidy step runs it on the first edit in
 * such a table, and the table tools run it before their own change, in the same undo step). False, and `tr` untouched, when
 * the table isn't fixable.
 */
export function fillShortRows(tr: Transaction, pos: number, splitSpan = false): boolean {
  const table = tr.doc.nodeAt(pos);
  if (!table || table.type.spec.tableRole !== 'table') return false;
  const shape = tableShape(table);
  if (shape.kind !== 'fixable') return false;
  const types = tableNodeTypes(tr.doc.type.schema);
  const map = TableMap.get(table);
  const ends: number[] = [];
  let at = pos + 1;
  table.forEach((row) => ends.push((at += row.nodeSize) - 1));
  const cellType = (row: number) => (groupOf(table, row) < 0 ? types.header_cell : types.cell);
  const added = new Map<number, number>();
  const mapping = tr.mapping.maps.length;
  if (splitSpan) {
    const row = spanAtEndRow(table, map);
    if (row >= 0) {
      const last = table.child(row).lastChild!;
      const span = last.attrs['colspan'] as number;
      const cellPos = ends[row]! - last.nodeSize;
      tr.setNodeMarkup(cellPos, undefined, { ...last.attrs, colspan: 1, colwidth: null });
      added.set(row, span - 1);
    }
  }
  for (const { row, n } of map.problems as Missing[]) added.set(row, (added.get(row) ?? 0) + n);
  // Last row first: the positions before it don't move.
  for (const row of [...added.keys()].sort((a, b) => b - a)) {
    const end = tr.mapping.slice(mapping).map(ends[row]!);
    tr.insert(end, Array.from({ length: added.get(row)! }, () => cellType(row).createAndFill()!));
  }
  return true;
}
