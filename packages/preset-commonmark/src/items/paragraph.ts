import { blockTypeCommand, type SyntaxItem } from '@pagemd-editor/core';

export const paragraph: SyntaxItem = {
  id: 'paragraph',
  group: 'text',
  schema: {
    nodes: {
      paragraph: { content: 'inline*', group: 'block', parseDOM: [{ tag: 'p' }], toDOM: () => ['p', 0] },
    },
  },
  fromTokens: { paragraph: { block: 'paragraph' } },
  toMarkdown: {
    nodes: {
      paragraph: (state, node) => {
        state.renderInline(node);
        state.closeBlock(node);
      },
    },
  },
  label: 'Text',
  icon: 'symbol-text',
  slash: { keywords: ['text', 'paragraph'] },
  commands: [
    blockTypeCommand({ id: 'paragraph.set', label: 'Text', icon: 'text-size', keybinding: 'Mod-Alt-0', keywords: ['text', 'paragraph', 'plain', 'normal'] }, 'paragraph'),
  ],
};
