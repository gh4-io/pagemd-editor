// GFM strikethrough: ~~text~~. Built into markdown-it's core rules, disabled by the 'commonmark' preset.
import { markCommand, type SyntaxItem } from '@pagemd-editor/core';

export const strikethrough: SyntaxItem = {
  id: 'strikethrough',
  group: 'text',
  markdownIt: (md) => md.enable(['strikethrough']),
  schema: {
    marks: {
      strikethrough: {
        parseDOM: [{ tag: 's' }, { tag: 'del' }, { tag: 'strike' }, { style: 'text-decoration=line-through' }],
        toDOM: () => ['s', 0],
      },
    },
  },
  fromTokens: { s: { mark: 'strikethrough' } },
  toMarkdown: {
    marks: {
      strikethrough: { open: '~~', close: '~~', mixable: true, expelEnclosingWhitespace: true },
    },
  },
  label: 'Strikethrough',
  icon: 'strikethrough',
  commands: [
    markCommand({ id: 'strikethrough.toggle', label: 'Strikethrough', icon: 'strikethrough', keybinding: 'Mod-Shift-x', toolbar: true }, 'strikethrough'),
  ],
};
