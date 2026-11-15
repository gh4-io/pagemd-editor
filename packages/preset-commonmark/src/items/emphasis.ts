// *emphasis* / _emphasis_; the marker is kept in `markup`.
import { markCommand, type SyntaxItem } from '@pagemd-editor/core';

export const emphasis: SyntaxItem = {
  id: 'emphasis',
  group: 'text',
  schema: {
    marks: {
      em: {
        attrs: { markup: { default: '*' } },
        parseDOM: [{ tag: 'em' }, { tag: 'i' }, { style: 'font-style=italic' }],
        toDOM: () => ['em', 0],
      },
    },
  },
  fromTokens: { em: { mark: 'em', getAttrs: (tok) => ({ markup: tok.markup }) } },
  toMarkdown: {
    marks: {
      em: {
        open: (_state, mark) => mark.attrs['markup'] as string,
        close: (_state, mark) => mark.attrs['markup'] as string,
        mixable: true,
        expelEnclosingWhitespace: true,
      },
    },
  },
  label: 'Italic',
  icon: 'italic',
  commands: [
    markCommand({ id: 'emphasis.toggle', label: 'Italic', icon: 'italic', keybinding: 'Mod-i', toolbar: true }, 'em'),
  ],
};
