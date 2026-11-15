// pagemd tables (markdown-it-multimd-table + markdown-it-table-captions, read by @pagemd/syntax). Replaces
// preset-gfm's table item (amendment 7) and keeps prosemirror-tables' node names and cell attributes (colspan,
// rowspan, colwidth) so table editing (P7) needs no migration. A changed table is written back from C2's table
// model by @pagemd/syntax's writeTable(): column alignment, colspan `||`, rowspan `^^`, body groups, headerless
// tables, both kinds of caption; the `{…}` line under it by writeAttributes(). A multi-line row is held when each of
// its cells is one paragraph (P16); a table with any other multi-line cell, a table inside a cell (no model) or a row
// the reader misreads stays a raw_block (dialect.ts).
import { DOMSerializer, type DOMOutputSpec, type Fragment, type Node, type NodeSpec, type NodeType } from 'prosemirror-model';
import type { Selection } from 'prosemirror-state';
import type { NodeView, ViewMutationRecord } from 'prosemirror-view';
import type { MarkdownSerializerState } from 'prosemirror-markdown';
import { TableMap, type CellSelection } from 'prosemirror-tables';
import { writeAttributes, writeTable, writeTableCaption, writeTableDirective } from '@pagemd/syntax';
import { tableCommands } from './commands.ts';
import { insertBlockCommand, type NodeWriter, type SyntaxItem, type TokenSpec } from '@pagemd-editor/core';
import { writtenAttributes } from '../dialect.ts';
import { inlineMarkdown, writeLines } from '../shared/write.ts';
import { classes } from '../shared/dom.ts';
import { COLUMN_WIDTHS_ATTR, layoutDom } from './widths.ts';

type Align = '' | 'left' | 'right' | 'center';

interface Column {
  align: Align;
  wrap: boolean;
}

interface TableModel {
  columns: Column[];
  header: unknown[];
  bodies: unknown[][];
  caption: { text: string; position: string; label: string | null } | null;
  tableCaption: { text: string; form: string; position: string } | null;
}

const cellAttrs = { colspan: { default: 1 }, rowspan: { default: 1 }, colwidth: { default: null }, align: { default: null } };

function alignOf(style: string | null): Align | null {
  const match = /text-align:\s*(left|right|center)/.exec(style ?? '');
  return (match?.[1] as Align | undefined) ?? null;
}

const cellDom = (tag: 'td' | 'th') => (node: Node): [string, Record<string, string>, 0] => {
  const attrs: Record<string, string> = {};
  if ((node.attrs['colspan'] as number) > 1) attrs['colspan'] = String(node.attrs['colspan']);
  if ((node.attrs['rowspan'] as number) > 1) attrs['rowspan'] = String(node.attrs['rowspan']);
  if (node.attrs['align']) attrs['style'] = `text-align:${node.attrs['align'] as string}`;
  return [tag, attrs, 0];
};

const cellSpec = (node: string): TokenSpec => ({
  block: node,
  getAttrs: (tok) => ({
    colspan: Number(tok.attrGet('colspan')) || 1,
    rowspan: Number(tok.attrGet('rowspan')) || 1,
    align: alignOf(tok.attrGet('style')),
  }),
});

const cellNode = (tag: 'td' | 'th'): NodeSpec => ({
  content: 'inline*',
  attrs: cellAttrs,
  tableRole: tag === 'th' ? 'header_cell' : 'cell',
  isolating: true,
  toDOM: cellDom(tag),
});

/** The model C2 reads, rebuilt from the table node: rows grouped as header / body n, cells as inline markdown. */
function modelOf(state: MarkdownSerializerState, table: Node): Record<string, unknown> {
  const model = table.attrs['model'] as TableModel;
  const header: unknown[] = [];
  const groups = new Map<number, unknown[]>();
  table.forEach((row) => {
    const cells: unknown[] = [];
    // A multi-line row keeps its cells' line breaks (they are continuation lines); a one-line row has none to keep.
    const multiline = row.attrs['multiline'] === true;
    row.forEach((cell) => cells.push({ text: inlineMarkdown(state, cell, multiline || hasLineBreak(cell)), colspan: cell.attrs['colspan'], rowspan: cell.attrs['rowspan'] }));
    const group = row.attrs['group'] as number;
    const line = { cells, multiline };
    if (group < 0) header.push(line);
    else (groups.get(group) ?? groups.set(group, []).get(group)!).push(line);
  });
  const bodies = [...groups.keys()].sort((a, b) => a - b).map((k) => groups.get(k)!);
  return { ...model, columns: columnsFor(table, model.columns), header, bodies };
}

/** A cell with a line break in it (a kept soft break or a hard break): its row is written multi-line, so no text is bent into one line. */
function hasLineBreak(cell: Node): boolean {
  let found = cell.textContent.includes('\n');
  cell.descendants((n) => {
    if (n.type.name === 'hard_break') found = true;
    return !found;
  });
  return found;
}

/** The columns as long as a rectangular table is wide (an added column's separator cell is never missing). */
function columnsFor(table: Node, columns: Column[]): Column[] {
  const map = TableMap.get(table);
  if (map.problems || columns.length === map.width) return columns;
  return Array.from({ length: map.width }, (_, k) => columns[k] ?? { align: '', wrap: false });
}

/**
 * The table that copied cells are written as (plugin-clipboard, amendment 9): the copied columns' settings only, no
 * caption or `{…}` (they belong to the whole table), and a header row (the copy's first row when it has none, so the
 * text is an ordinary markdown table anywhere it is pasted).
 */
function copiedRows(table: Node, rows: Fragment, selection: Selection): Node {
  const sel = selection as CellSelection;
  const start = sel.$anchorCell.start(-1);
  const rect = TableMap.get(table).rectBetween(sel.$anchorCell.pos - start, sel.$headCell.pos - start);
  const model = table.attrs['model'] as TableModel;
  let header = false;
  rows.forEach((row) => (header ||= (row.attrs['group'] as number) < 0));
  const out = header ? rows : rows.replaceChild(0, rows.firstChild!.type.create({ ...rows.firstChild!.attrs, group: -1 }, rows.firstChild!.content));
  return table.type.create({ model: { ...model, columns: model.columns.slice(rect.left, rect.right), caption: null, tableCaption: null }, pmdAttrs: null, tableDirective: null }, out);
}

/** The class of a header row on the canvas: style-pagemd's HEAD_ROW_CLASS (a test checks both say the same). */
export const HEAD_ROW_CLASS = 'pmd-head-row';

/** A width as pagemd writes it in a `<col>` (at most two decimals). */
const percent = (w: number): string => `${Number(w.toFixed(2))}%`;

/**
 * The table as the canvas draws it (P19: the same layout as pagemd's HTML: `table-layout:fixed` for `.fixed-layout` or
 * set widths, and a `<colgroup>` with the widths). The caption shows above the table (the renderer's <caption>).
 */
function tableDom(node: Node): DOMOutputSpec {
  const dom: Record<string, string> = {};
  for (const [key, value] of (node.attrs['pmdAttrs'] as [string, string][] | null) ?? []) if (key === 'class' || key === 'id' || key === COLUMN_WIDTHS_ATTR) dom[key] = value;
  const layout = layoutDom(node);
  if (layout.fixed) dom['style'] = 'table-layout:fixed';
  const model = node.attrs['model'] as TableModel;
  const caption = model.caption?.text ?? model.tableCaption?.text;
  const colgroup: DOMOutputSpec[] = layout.cols ? [['colgroup', ...layout.cols.map((w): DOMOutputSpec => ['col', w === null ? {} : { style: `width:${percent(w)}` }])]] : [];
  return ['div', { class: classes('pmd-table', caption && 'pmd-table-captioned'), 'data-caption': caption ?? '' }, ['table', dom, ...colgroup, ['tbody', 0]]];
}

/**
 * The table's node view (P19): drawn by `tableDom`, and it lets the column-width drag (resize.ts) change the `<col>`
 * widths and the table's layout while the pointer moves, without ProseMirror reading the table back from the page
 * (a change outside the rows is ignored). A changed layout, or any other attribute, draws the table again.
 */
class TableView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  #node: Node;
  #layout: string;

  constructor(node: Node) {
    this.#node = node;
    this.#layout = JSON.stringify(layoutDom(node));
    const { dom, contentDOM } = DOMSerializer.renderSpec(document, tableDom(node));
    this.dom = dom as HTMLElement;
    this.contentDOM = contentDOM as HTMLElement;
  }

  update(node: Node): boolean {
    if (!node.sameMarkup(this.#node) || JSON.stringify(layoutDom(node)) !== this.#layout) return false;
    this.#node = node;
    return true;
  }

  ignoreMutation(mutation: ViewMutationRecord): boolean {
    return mutation.type !== 'selection' && !this.contentDOM.contains(mutation.target);
  }
}

const writeTableNode: NodeWriter = (state, node) => {
  const model = modelOf(state, node);
  const tableCaption = (model['tableCaption'] as TableModel['tableCaption']) ?? null;
  const pairs = node.attrs['pmdAttrs'] as [string, string][] | null;
  let text = writeTable({ ...model, tableCaption: null });
  // The `{…}` line right under the table's own lines (markdown-it-attrs reads it there), before a
  // "Table:" caption paragraph.
  if (pairs) text += `\n${writeAttributes(pairs)}`;
  // P19 round 3: the hidden comment with the column widths, right under the table (and its `{…}` line).
  const hidden = writeTableDirective((node.attrs['tableDirective'] as Record<string, unknown> | null) ?? {});
  if (hidden) text += `\n${hidden}`;
  if (tableCaption) text = tableCaption.position === 'top' ? `${writeTableCaption(tableCaption)}\n\n${text}` : `${text}\n\n${writeTableCaption(tableCaption)}`;
  writeLines(state, text);
  state.closeBlock(node);
};

/** Writers for the parts: never used alone (a changed table is always written whole). */
const partWriter: NodeWriter = () => {
  throw new Error('A table row or cell is written by its table.');
};

export const table: SyntaxItem = {
  id: 'multimd-table',
  overrides: 'table',
  group: 'tables',
  schema: {
    nodes: {
      table: {
        content: 'table_row+',
        group: 'block',
        isolating: true,
        tableRole: 'table',
        attrs: { model: {}, pmdAttrs: { default: null }, tableDirective: { default: null } },
        clipboardRows: copiedRows,
        toDOM: tableDom,
      },
      table_row: {
        content: '(table_cell | table_header_cell)+',
        tableRole: 'row',
        attrs: { group: { default: 0 }, multiline: { default: false } },
        // Header rows carry a class (OQ-49): every row sits in one <tbody> on the canvas, and style-pagemd turns the
        // profile's `thead` rules into rules for this class, so a header row looks as in pagemd's PDF.
        toDOM: (node) => ((node.attrs['group'] as number) < 0 ? ['tr', { class: HEAD_ROW_CLASS }, 0] : ['tr', 0]),
      },
      table_header_cell: cellNode('th'),
      table_cell: cellNode('td'),
    },
  },
  fromTokens: {
    table: {
      block: 'table',
      getAttrs: (tok) => {
        const { columns, caption, tableCaption } = (tok.meta as { table: TableModel }).table;
        const meta = tok.meta as { tableDirective?: unknown } | null;
        return { model: { columns, caption, tableCaption }, pmdAttrs: writtenAttributes(tok as never), tableDirective: meta?.tableDirective ?? null };
      },
    },
    thead: { ignore: true },
    tbody: { ignore: true },
    tr: {
      block: 'table_row',
      getAttrs: (tok) => {
        const meta = tok.meta as { pmdGroup?: number; multiline?: boolean; mbounds?: unknown } | null;
        return { group: meta?.pmdGroup ?? 0, multiline: !!(meta?.multiline && meta.mbounds) };
      },
    },
    th: cellSpec('table_header_cell'),
    td: cellSpec('table_cell'),
  },
  toMarkdown: { nodes: { table: writeTableNode, table_row: partWriter, table_header_cell: partWriter, table_cell: partWriter } },
  nodeViews: { table: (node) => new TableView(node) },
  label: 'Table',
  icon: 'table',
  slash: { keywords: ['table', 'grid', 'rows', 'columns'] },
  outline: (node, pos) => {
    // The item owns the rows and cells too; only the table itself is an entry (P9: a row has no model).
    if (node.type.name !== 'table') return null;
    const model = node.attrs['model'] as TableModel;
    return { kind: 'table', label: model.caption?.text ?? model.tableCaption?.text ?? 'Table', level: 0, pos };
  },
  commands: [
    insertBlockCommand({ id: 'table.insert', label: 'Table', icon: 'table', keywords: ['table', 'grid', 'rows', 'columns'] }, 'table', (schema) => {
      const { table, table_row: row, table_header_cell: header, table_cell: cell } = schema.nodes as Record<string, NodeType>;
      const cells = (type: NodeType): Node[] => [type.create(), type.create(), type.create()];
      const model: TableModel = { columns: [0, 1, 2].map(() => ({ align: '', wrap: false })), header: [], bodies: [], caption: null, tableCaption: null };
      return table!.create({ model, pmdAttrs: null }, [row!.create({ group: -1 }, cells(header!)), row!.create({ group: 0 }, cells(cell!)), row!.create({ group: 0 }, cells(cell!))]);
    }),
    ...tableCommands(),
  ],
};
