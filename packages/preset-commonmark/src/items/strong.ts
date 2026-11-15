// **strong** / __strong__; the marker is kept in `markup`.
import { markCommand, type SyntaxItem } from '@pagemd-editor/core';

export const strong: SyntaxItem = {
  id: 'strong',
  group: 'text',
  schema: {
    marks: {
      strong: {
        attrs: { markup: { default: '**' } },
        parseDOM: [{ tag: 'strong' }, { tag: 'b' }, { style: 'font-weight=bold' }],
        toDOM: () => ['strong', 0],
      },
    },
  },
  fromTokens: { strong: { mark: 'strong', getAttrs: (tok) => ({ markup: tok.markup }) } },
  toMarkdown: {
    marks: {
      strong: {
        open: (_state, mark) => mark.attrs['markup'] as string,
        close: (_state, mark) => mark.attrs['markup'] as string,
        mixable: true,
        expelEnclosingWhitespace: true,
      },
    },
  },
  label: 'Bold',
  icon: 'bold',
  commands: [
    markCommand({ id: 'strong.toggle', label: 'Bold', icon: 'bold', keybinding: 'Mod-b', toolbar: true }, 'strong'),
  ],
};
