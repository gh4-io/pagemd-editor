import type { SyntaxItem } from '@pagemd-editor/core';

export const hardBreak: SyntaxItem = {
  id: 'hard_break',
  group: 'text',
  schema: {
    nodes: {
      hard_break: { inline: true, group: 'inline', selectable: false, parseDOM: [{ tag: 'br' }], toDOM: () => ['br'] },
    },
  },
  fromTokens: { hardbreak: { node: 'hard_break' } },
  toMarkdown: {
    nodes: {
      // A break at the very end of a block means nothing in markdown, so it isn't written.
      hard_break: (state, node, parent, index) => {
        for (let i = index + 1; i < parent.childCount; i++) {
          if (parent.child(i).type !== node.type) {
            state.write('\\\n');
            return;
          }
        }
      },
    },
  },
  label: 'Line break',
  icon: 'newline',
};
