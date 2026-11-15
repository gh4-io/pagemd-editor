// GFM tables. Reading, writing, display (P3) and Insert Table (P7, R-151); row, column and cell tools come in a later phase (table editing).
// The schema matches prosemirror-tables' node names (table, table_row, table_cell, table_header_cell) so
// that later phase can adopt it without a schema migration.
import type { Node, NodeType } from 'prosemirror-model';
import { insertBlockCommand, type NodeWriter, type SyntaxItem, type TokenSpec } from '@pagemd-editor/core';

export type Align = 'left' | 'right' | 'center' | null;

/** markdown-it puts the column's alignment in a `style="text-align:…"` attribute on each th/td. */
function alignOf(style: string | null): Align {
  const match = /text-align:(left|right|center)/.exec(style ?? '');
  return (match?.[1] as Align) ?? null;
}

const cellAttrs = { align: { default: null as Align } };

/** Escapes `|` (not handled by the shared line-escaper, which is for plain text outside tables) and
 *  collapses any line break a mark (e.g. a hard break) might introduce: a table row is one line. */
function writeCellInline(state: Parameters<NodeWriter>[0], cell: Node): void {
  const internals = state as unknown as { out: string };
  const before = internals.out.length;
  state.renderInline(cell);
  internals.out = internals.out.slice(0, before) + internals.out.slice(before).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

const cellWriter: NodeWriter = (state, node) => writeCellInline(state, node);

function dashesFor(align: Align): string {
  if (align === 'center') return ':---:';
  if (align === 'right') return '---:';
  if (align === 'left') return ':---';
  return '---';
}

const tableRowWriter: NodeWriter = (state, node, _parent, index) => {
  state.write('|');
  node.forEach((cell, _offset, i) => {
    state.write(' ');
    state.render(cell, node, i);
    state.write(' |');
  });
  state.ensureNewLine();
  if (index === 0) {
    state.write('|');
    node.forEach((cell) => state.write(` ${dashesFor(cell.attrs['align'] as Align)} |`));
    state.ensureNewLine();
  }
};

const cellSpec = (nodeName: string): TokenSpec => ({ block: nodeName, getAttrs: (tok) => ({ align: alignOf(tok.attrGet('style')) }) });

export const table: SyntaxItem = {
  id: 'table',
  group: 'tables',
  markdownIt: (md) => md.enable(['table']),
  schema: {
    nodes: {
      table: {
        content: 'table_row+',
        group: 'block',
        isolating: true,
        parseDOM: [{ tag: 'table' }],
        toDOM: () => ['table', 0],
      },
      table_row: {
        content: '(table_cell | table_header_cell)+',
        parseDOM: [{ tag: 'tr' }],
        toDOM: () => ['tr', 0],
      },
      table_header_cell: {
        content: 'inline*',
        attrs: cellAttrs,
        parseDOM: [{ tag: 'th', getAttrs: (dom) => ({ align: alignOf(dom.style.textAlign || null) }) }],
        toDOM: (node) => ['th', node.attrs['align'] ? { style: `text-align:${node.attrs['align'] as string}` } : {}, 0],
      },
      table_cell: {
        content: 'inline*',
        attrs: cellAttrs,
        parseDOM: [{ tag: 'td', getAttrs: (dom) => ({ align: alignOf(dom.style.textAlign || null) }) }],
        toDOM: (node) => ['td', node.attrs['align'] ? { style: `text-align:${node.attrs['align'] as string}` } : {}, 0],
      },
    },
  },
  fromTokens: {
    table: { block: 'table' },
    thead: { ignore: true },
    tbody: { ignore: true },
    tr: { block: 'table_row' },
    th: cellSpec('table_header_cell'),
    td: cellSpec('table_cell'),
  },
  toMarkdown: {
    nodes: {
      table: (state, node) => {
        state.renderContent(node);
        state.closeBlock(node);
      },
      table_row: tableRowWriter,
      table_header_cell: cellWriter,
      table_cell: cellWriter,
    },
  },
  label: 'Table',
  icon: 'table',
  slash: { keywords: ['table', 'grid', 'rows', 'columns'] },
  commands: [
    insertBlockCommand({ id: 'table.insert', label: 'Table', icon: 'table', keywords: ['table', 'grid', 'rows', 'columns'] }, 'table', (schema) => {
      const { table, table_row: row, table_header_cell: header, table_cell: cell } = schema.nodes as Record<string, NodeType>;
      const cells = (type: NodeType): Node[] => [type.create(), type.create(), type.create()];
      return table!.create(null, [row!.create(null, cells(header!)), row!.create(null, cells(cell!)), row!.create(null, cells(cell!))]);
    }),
  ],
};
