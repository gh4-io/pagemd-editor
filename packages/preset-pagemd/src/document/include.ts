// `!!!include(path)!!!` on its own line: an atom (C2), never read from disk here. The canvas shows the path and
// an "Open" link (Ctrl/Cmd+click, like every link on the canvas: ILinks). Showing the included file's text needs
// a host service to read another file, which ADR-0013 doesn't have yet (amendment 10: later, shown first).
import type { Node } from 'prosemirror-model';
import { insertBlockCommand, type SyntaxItem } from '@pagemd-editor/core';
import { atomWriter } from '../shared/write.ts';

const pathOf = (node: Node): string => {
  const path = (node.attrs['data'] as Record<string, unknown>)['path'];
  return typeof path === 'string' ? path : '';
};

export const include: SyntaxItem = {
  id: 'include',
  group: 'document',
  schema: {
    nodes: {
      pmd_include: {
        group: 'block',
        atom: true,
        selectable: true,
        draggable: true,
        attrs: { data: {} },
        toDOM: (node) => [
          'div',
          { class: 'include-placeholder pmd-directive pmd-include', 'data-path': pathOf(node), contenteditable: 'false' },
          ['span', { class: 'pmd-chip' }, `Include: ${pathOf(node)}`],
          ['a', { href: pathOf(node), class: 'pmd-include-open', title: 'Ctrl+click to open' }, 'Open'],
        ],
      },
    },
  },
  fromTokens: {
    pagemd_include: {
      node: 'pmd_include',
      getAttrs: (tok) => ({ data: { ...((tok.meta as { pmd?: { data: Record<string, unknown> } } | null)?.pmd?.data ?? {}) } }),
    },
  },
  toMarkdown: { nodes: { pmd_include: atomWriter(() => 'include') } },
  label: 'Include file',
  icon: 'file-symlink-file',
  slash: { keywords: ['include', 'insert file'] },
  outline: (node, pos) => ({ kind: 'include', label: pathOf(node), level: 0, pos }),
  commands: [
    insertBlockCommand({ id: 'include.insert', label: 'Include file', icon: 'file-symlink-file', keywords: ['include', 'insert file'] }, 'pmd_include', (schema) =>
      schema.nodes['pmd_include']!.create({ data: { path: 'file.md' } }),
    ),
  ],
};
