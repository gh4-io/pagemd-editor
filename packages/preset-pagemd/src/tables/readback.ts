// Does pagemd's own reader read a table's shape the way the editor holds it? (P24, AD-P24-01.) The reader (markdown-it-attrs'
// "tables tbody calculate" pass in pagemd-common) clamps a body cell's `||` span to the header's cell count minus the cell's
// index, so a header that itself has spans (which Split on a plain cell always makes) can make a body span read narrower than
// it was written. The editor does not copy that rule: it writes the table's shape as plain pipes, asks the real reader
// (@pagemd/syntax) and compares each row's cell spans. Used only to decide whether a command that adds spans may go ahead;
// the text is made of `x` cells, so the answer is about the shape alone.
import type { Node } from 'prosemirror-model';
import { TableMap } from 'prosemirror-tables';
import { createDialect } from '@pagemd/syntax';
import { groupOf } from './context.ts';

type Dialect = ReturnType<typeof createDialect>;
let dialect: Dialect | null = null;
const memo = new WeakMap<Node, boolean>();

/** The pipes the writer would write for the grid of `table`, every cell holding `x`. */
function shapeText(table: Node): string {
  const map = TableMap.get(table);
  const lines: string[] = [];
  let lastGroup: number | null = null;
  let delimiterDone = false;
  const delimiter = `|${' --- |'.repeat(map.width)}`;
  for (let r = 0; r < map.height; r++) {
    const group = groupOf(table, r);
    if (group >= 0 && !delimiterDone) {
      lines.push(delimiter);
      delimiterDone = true;
    }
    if (group >= 0 && lastGroup !== null && lastGroup >= 0 && group !== lastGroup) lines.push('');
    lastGroup = group;
    let line = '|';
    for (let c = 0; c < map.width; c++) {
      const rect = map.findCell(map.map[r * map.width + c]!);
      if (rect.left !== c) continue; // inside a cell that started further left
      const span = rect.right - rect.left;
      if (rect.top === r) line += ` x ${'|'.repeat(span)}`;
      else if (rect.top < r) line += ` ^^ ${'|'.repeat(span)}`;
    }
    lines.push(line);
  }
  if (!delimiterDone) lines.unshift(delimiter);
  return lines.join('\n');
}

/** Per row, per cell: `colspan x rowspan` as the reader's HTML has it. */
function readSpans(html: string): string[][] {
  const rows: string[][] = [];
  for (const row of html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const cells: string[] = [];
    for (const cell of row[1]!.matchAll(/<t[dh]([^>]*)>/g)) {
      const attrs = cell[1]!;
      cells.push(`${/colspan="(\d+)"/.exec(attrs)?.[1] ?? '1'}x${/rowspan="(\d+)"/.exec(attrs)?.[1] ?? '1'}`);
    }
    rows.push(cells);
  }
  return rows;
}

/** True when pagemd's reader sees every cell of `table` with the column and row span the editor holds (or the reader can't be asked). */
export function readsAsHeld(table: Node): boolean {
  const known = memo.get(table);
  if (known !== undefined) return known;
  let ok = true;
  try {
    dialect ??= createDialect();
    const seen = readSpans(dialect.render(`${shapeText(table)}\n`));
    const held: string[][] = [];
    table.forEach((row) => {
      const cells: string[] = [];
      row.forEach((cell) => cells.push(`${cell.attrs['colspan']}x${cell.attrs['rowspan']}`));
      held.push(cells);
    });
    ok = JSON.stringify(seen) === JSON.stringify(held);
  } catch {
    ok = true;
  }
  memo.set(table, ok);
  return ok;
}
