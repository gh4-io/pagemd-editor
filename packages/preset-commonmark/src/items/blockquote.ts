import { wrappingInputRule } from 'prosemirror-inputrules';
import { wrapCommand, type SyntaxItem } from '@pagemd-editor/core';

export const blockquote: SyntaxItem = {
  id: 'blockquote',
  group: 'blocks',
  schema: {
    nodes: {
      blockquote: { content: 'block+', group: 'block', defining: true, parseDOM: [{ tag: 'blockquote' }], toDOM: () => ['blockquote', 0] },
    },
  },
  fromTokens: { blockquote: { block: 'blockquote' } },
  toMarkdown: {
    nodes: {
      blockquote: (state, node) => state.wrapBlock('> ', null, node, () => state.renderContent(node)),
    },
  },
  label: 'Quote',
  icon: 'quote',
  slash: { keywords: ['quote', 'blockquote'] },
  // `> ` at a block's start wraps it in a quote (OQ-24, P3).
  inputRules: (schema) => [wrappingInputRule(/^\s*>\s$/, schema.nodes['blockquote']!)],
  commands: [
    wrapCommand({ id: 'blockquote.toggle', label: 'Quote', icon: 'quote', keybinding: 'Mod-Shift-.', toolbar: true, keywords: ['quote', 'blockquote'] }, 'blockquote'),
  ],
};
