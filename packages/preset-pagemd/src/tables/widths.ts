// Table column widths (P19): read the way pagemd reads them (@pagemd/syntax's tableLayoutOf: one implementation,
// ADR-0011), from three places: the hidden comment under the table, `<!-- ::TABLE widths="30% 20% 50%" -->` (round 3:
// other markdown viewers show nothing; `widths="equal"`: equal columns), which wins; and the older visible spellings on
// the `{…}` line, `data-col-widths="…"` and `.fixed-layout`, which keep working. Every change the editor makes writes
// the comment and takes the older spellings off that table (AD-P19-22). This file is pure (no DOM): the arithmetic for
// the commands, the drag (resize.ts) and the Inspector, and the attribute change itself.
import type { Node } from 'prosemirror-model';
import type { Transaction } from 'prosemirror-state';
import { TableMap } from 'prosemirror-tables';
import { COLUMN_WIDTHS_ATTR, EQUAL_WIDTHS, FIXED_LAYOUT_CLASS, TABLE_DIRECTIVE, tableLayoutOf, writeColumnWidths, writeTableDirective } from '@pagemd/syntax';

export { COLUMN_WIDTHS_ATTR, FIXED_LAYOUT_CLASS };

type Pairs = [string, string][];

/** The hidden comment under a table, as the reader folds it into the table (`table_open.meta.tableDirective`). */
export interface TableDirective {
  name: string;
  parenParams: string | null;
  params: string;
  attrs: Record<string, string | true>;
}

const directiveOf = (table: Node): TableDirective | null => (table.attrs['tableDirective'] as TableDirective | null) ?? null;

/** The narrowest a column gets from a drag or a command, in percent. */
export const MIN_WIDTH = 5;
/** What Wider / Narrower change, in percentage points. */
export const STEP = 5;

export interface TableLayout {
  /** pagemd draws the table with the fixed layout (`.fixed-layout`, or a set width). */
  fixed: boolean;
  /** The class `fixed-layout` is written. */
  classFixed: boolean;
  /** At least one column's width is set: pagemd writes a `<colgroup>` (and the canvas draws one). */
  hasWidths: boolean;
  /** One entry per column: a percentage, or null when not set. */
  widths: (number | null)[];
}

const pairsOf = (table: Node): Pairs => (table.attrs['pmdAttrs'] as Pairs | null) ?? [];
const classList = (pairs: Pairs): string[] => pairs.filter(([k]) => k === 'class').flatMap(([, v]) => v.split(/\s+/)).filter(Boolean);

/** The table's layout as pagemd reads it, with one width entry per column of the table. */
export function layoutOf(table: Node): TableLayout {
  const pairs = pairsOf(table);
  const classes = classList(pairs);
  const raw = pairs.find(([k]) => k === COLUMN_WIDTHS_ATTR)?.[1] ?? null;
  const hidden = directiveOf(table)?.attrs['widths'];
  const { fixed, widths } = tableLayoutOf(classes.join(' '), raw, typeof hidden === 'string' ? hidden : null);
  const columns = TableMap.get(table).width;
  return { fixed, classFixed: classes.includes(FIXED_LAYOUT_CLASS), hasWidths: widths.length > 0, widths: Array.from({ length: columns }, (_, k) => widths[k] ?? null) };
}

/** Whole percentages adding up to 100, as close to `values` as can be (largest remainder). */
export function roundTo100(values: readonly number[]): number[] {
  if (values.length === 0) return [];
  const total = values.reduce((a, b) => a + Math.max(0, b), 0);
  const scaled = values.map((v) => (total > 0 ? (Math.max(0, v) * 100) / total : 100 / values.length));
  const out = scaled.map(Math.floor);
  let left = 100 - out.reduce((a, b) => a + b, 0);
  const order = scaled.map((v, k) => [v - Math.floor(v), k] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let i = 0; left > 0; i = (i + 1) % order.length, left--) out[order[i]![1]]! += 1;
  return out;
}

/**
 * Every column's width as drawn, in whole percentages adding up to 100: the set widths, the unset columns sharing what
 * they leave (pagemd's fixed layout); a table without the fixed layout uses `measured` (the canvas's columns) when given,
 * else equal shares.
 */
export function completeWidths(layout: TableLayout, measured?: readonly number[] | null): number[] {
  const n = layout.widths.length;
  if (n === 0) return [];
  if (!layout.fixed && measured && measured.length === n) return roundTo100(measured);
  const set = layout.widths.reduce<number>((a, w) => a + (w ?? 0), 0);
  const unset = layout.widths.filter((w) => w === null).length;
  const share = unset > 0 ? Math.max(0, 100 - set) / unset : 0;
  return roundTo100(layout.widths.map((w) => w ?? share));
}

/** `widths` with the border after column `k` moved by `delta` points: columns k and k+1 change, each at least MIN_WIDTH. */
export function moveBorder(widths: readonly number[], k: number, delta: number): number[] {
  const out = [...widths];
  if (k < 0 || k + 1 >= out.length) return out;
  const pair = out[k]! + out[k + 1]!;
  const left = Math.min(Math.max(out[k]! + delta, MIN_WIDTH), pair - MIN_WIDTH);
  out[k] = left;
  out[k + 1] = pair - left;
  return out;
}

/** The column that column `col` trades width with: the one on its right; the last column's is on its left. */
export const neighbourOf = (col: number, count: number): number => (col + 1 < count ? col + 1 : col - 1);

/** `widths` with column `col` wider by `by` points (narrower when negative), taken from or given to its neighbour. */
export function widenColumn(widths: readonly number[], col: number, by: number): number[] {
  const other = neighbourOf(col, widths.length);
  if (other < 0) return [...widths];
  return other > col ? moveBorder(widths, col, by) : moveBorder(widths, other, -by);
}

/**
 * `widths` with column `col` wider by `by` points, taken from column `other` (each at least MIN_WIDTH); unchanged when it can't. Not
 * necessarily neighbours (FIX-PGF, AD-FIX-PGF-07: a merged cell's first column trades with the column just outside the cell).
 */
export function tradeWidth(widths: readonly number[], col: number, other: number, by: number): number[] {
  const out = [...widths];
  if (col === other || out[col] === undefined || out[other] === undefined) return out;
  const pair = out[col] + out[other];
  const next = Math.min(Math.max(out[col] + by, MIN_WIDTH), pair - MIN_WIDTH);
  out[col] = next;
  out[other] = pair - next;
  return out;
}

/** Whether column `col` can get wider (`by` > 0) or narrower by one step. */
export function canWiden(widths: readonly number[], col: number, by: number): boolean {
  if (widths.length < 2) return false;
  const next = widenColumn(widths, col, by);
  return next[col] !== widths[col];
}

/** A new column at `at`, beside column `beside` (in the old numbering): it takes half of that column's width. */
export function insertColumnWidth(widths: readonly number[], at: number, beside: number): number[] {
  const out = [...widths];
  const whole = out[beside] ?? 0;
  const half = Math.floor(whole / 2);
  out[beside] = whole - half;
  out.splice(at, 0, half);
  return out;
}

/**
 * Column `col` cut in two side by side (P24, Word's Split Cells): the first half stays on `col`, the rest is the new column
 * after it, so the total is unchanged and no other column moves. Each half is at least 1 (Word has no minimum; a column of
 * width 1 takes 1 from the widest other column).
 */
export function splitColumnWidth(widths: readonly number[], col: number): number[] {
  const out = [...widths];
  const whole = out[col] ?? 0;
  const half = Math.max(1, Math.floor(whole / 2));
  out[col] = Math.max(1, whole - half);
  const owed = out[col]! + half - whole; // above 0 only when the column was narrower than 2
  if (owed > 0) {
    let widest = -1;
    out.forEach((w, k) => {
      if (k !== col && w > 1 && (widest < 0 || w > out[widest]!)) widest = k;
    });
    if (widest >= 0) out[widest] = out[widest]! - owed;
  }
  out.splice(col + 1, 0, half);
  return out;
}

/** Columns `from`…`to - 1` deleted: their width goes to the column on their left (or the first one left when none). */
export function deleteColumnWidths(widths: readonly number[], from: number, to: number): number[] {
  const out = [...widths];
  const gone = out.splice(from, to - from).reduce((a, b) => a + b, 0);
  if (out.length === 0) return out;
  const to_ = from > 0 ? from - 1 : 0;
  out[to_] = out[to_]! + gone;
  return out;
}

/** Columns `a` and `b` swapped. */
export function swapWidths(widths: readonly (number | null)[], a: number, b: number): (number | null)[] {
  const out = [...widths];
  [out[a], out[b]] = [out[b] ?? null, out[a] ?? null];
  return out;
}

export interface LayoutChange {
  /** New widths (null or all unset: the attribute goes); undefined: as they are. */
  widths?: readonly (number | null)[] | null;
  /** The class `fixed-layout` on or off; undefined: as it is. */
  fixedClass?: boolean;
}

/** The `{…}` pairs with the widths and the class changed; the other pairs stay where the author wrote them. */
export function withLayout(pairs: Pairs | null, change: LayoutChange): Pairs | null {
  const out: Pairs = [];
  const value = change.widths === undefined ? undefined : change.widths === null ? '' : writeColumnWidths(change.widths);
  let widthsDone = false;
  let fixedSeen = false;
  for (const [key, v] of pairs ?? []) {
    if (key === COLUMN_WIDTHS_ATTR) {
      if (value === undefined) out.push([key, v]);
      else if (value && !widthsDone) out.push([key, value]);
      widthsDone = true;
    } else if (key === 'class' && change.fixedClass !== undefined) {
      // One class pair is how pagemd reads `{.a .b}` back: the class joins the first class pair.
      const classes = v.split(/\s+/).filter(Boolean).filter((c) => c !== FIXED_LAYOUT_CLASS);
      if (change.fixedClass && !fixedSeen) classes.push(FIXED_LAYOUT_CLASS);
      fixedSeen = true;
      if (classes.length > 0) out.push([key, classes.join(' ')]);
    } else {
      out.push([key, v]);
    }
  }
  if (value && !widthsDone) out.push([COLUMN_WIDTHS_ATTR, value]);
  if (change.fixedClass === true && !fixedSeen) out.push(['class', FIXED_LAYOUT_CLASS]);
  return out.length > 0 ? out : null;
}

/** The comment with `widths` set (a value) or taken out (null); null when nothing is left in it. */
export function withDirectiveWidths(directive: TableDirective | null, widths: string | null): TableDirective | null {
  const attrs: Record<string, string | true> = { ...(directive?.attrs ?? {}) };
  if (widths) attrs['widths'] = widths;
  else delete attrs['widths'];
  if (Object.keys(attrs).length === 0) return null;
  // `params` is the text as it will be written (C3's writer keeps the author's unchanged parameters), so the table
  // reads back exactly as the editor holds it.
  const written = writeTableDirective({ params: directive?.params ?? '', attrs });
  const params = /^<!--\s*::TABLE\s*(.*?)\s*-->$/.exec(written)?.[1] ?? '';
  return { name: TABLE_DIRECTIVE, parenParams: null, params, attrs };
}

/**
 * The attributes a table gets for a layout change (round 3, AD-P19-22): the widths (or `equal`) go into the hidden
 * comment; the older spellings on the `{…}` line (`data-col-widths`, `.fixed-layout`) are taken off, so one place says
 * it. Reset (`widths: null, fixedClass: false`) takes all of them away. A "Table:" caption below moves above: pagemd
 * reads it below neither the `{…}` line nor the comment (AD-P16-10).
 */
export function layoutAttrs(attrs: Record<string, unknown>, change: LayoutChange): Record<string, unknown> {
  if (change.widths === undefined && change.fixedClass === undefined) return attrs;
  const set = change.widths ? writeColumnWidths(change.widths) : '';
  const hidden = set || (change.fixedClass ? EQUAL_WIDTHS : null);
  const pmdAttrs = withLayout(attrs['pmdAttrs'] as Pairs | null, { widths: null, fixedClass: false });
  const tableDirective = withDirectiveWidths((attrs['tableDirective'] as TableDirective | null) ?? null, hidden);
  const model = attrs['model'] as { tableCaption?: { position?: string } | null } & Record<string, unknown>;
  const moveCaption = (pmdAttrs || tableDirective) && model?.tableCaption?.position === 'bottom';
  return { ...attrs, pmdAttrs, tableDirective, ...(moveCaption ? { model: { ...model, tableCaption: { ...model.tableCaption, position: 'top' } } } : {}) };
}

/** Sets the table's layout in `tr` (the table at `pos` in `tr.doc`): `layoutAttrs`. Returns false when nothing changes. */
export function setLayout(tr: Transaction, pos: number, change: LayoutChange): boolean {
  const table = tr.doc.nodeAt(pos);
  if (!table) return false;
  const next = layoutAttrs(table.attrs, change);
  if (JSON.stringify(next) === JSON.stringify(table.attrs)) return false;
  tr.setNodeMarkup(pos, undefined, next);
  return true;
}

/** What the canvas draws for the table's layout (the same as pagemd's HTML): the fixed layout, and the `<col>` widths. */
export function layoutDom(table: Node): { fixed: boolean; cols: (number | null)[] | null } {
  const layout = layoutOf(table);
  return { fixed: layout.fixed, cols: layout.hasWidths ? layout.widths : null };
}
