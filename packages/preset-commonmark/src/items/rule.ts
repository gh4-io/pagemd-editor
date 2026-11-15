// Thematic break (`---`, `***`, `___`); the author's marker is kept.
import { insertBlockCommand, type SyntaxItem } from '@pagemd-editor/core';

export const rule: SyntaxItem = {
  id: 'horizontal_rule',
  group: 'blocks',
  schema: {
    nodes: {
      horizontal_rule: { group: 'block', attrs: { markup: { default: '---' } }, parseDOM: [{ tag: 'hr' }], toDOM: () => ['hr'] },
    },
  },
  fromTokens: { hr: { node: 'horizontal_rule', getAttrs: (tok) => ({ markup: tok.markup }) } },
  toMarkdown: {
    nodes: {
      horizontal_rule: (state, node) => {
        state.write(node.attrs['markup'] as string);
        state.closeBlock(node);
      },
    },
  },
  label: 'Line',
  icon: 'horizontal-rule',
  slash: { keywords: ['line', 'rule', 'divider'] },
  commands: [
    insertBlockCommand({ id: 'rule.insert', label: 'Horizontal line', icon: 'horizontal-rule', keywords: ['line', 'rule', 'divider', 'hr'] }, 'horizontal_rule', (schema) => schema.nodes['horizontal_rule']!.create()),
  ],
};
