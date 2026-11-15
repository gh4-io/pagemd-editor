// `inline code`.
import type { Node } from 'prosemirror-model';
import { markCommand, type SyntaxItem } from '@pagemd-editor/core';

/** Enough backticks for the text, plus a space where CommonMark would otherwise strip or merge one. */
function delimiter(node: Node | undefined, side: 'open' | 'close'): string {
  const text = node?.isText ? node.text! : '';
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  // CommonMark removes one space from each end when both ends have one (and the text isn't all spaces).
  const pad = /^[ `]/.test(text) || /[ `]$/.test(text) ? (/^ +$/.test(text) ? '' : ' ') : '';
  let ticks = '`';
  while (ticks.length <= longest && text.includes(ticks)) ticks += '`';
  if (ticks.length <= longest) ticks = '`'.repeat(longest + 1);
  return side === 'open' ? ticks + pad : pad + ticks;
}

export const code: SyntaxItem = {
  id: 'code',
  group: 'text',
  schema: {
    marks: {
      code: { code: true, parseDOM: [{ tag: 'code' }], toDOM: () => ['code', 0] },
    },
  },
  fromTokens: { code_inline: { mark: 'code', noCloseToken: true } },
  toMarkdown: {
    marks: {
      code: {
        open: (_state, _mark, parent, index) => delimiter(parent.maybeChild(index) ?? undefined, 'open'),
        close: (_state, _mark, parent, index) => delimiter(parent.maybeChild(index - 1) ?? undefined, 'close'),
        escape: false,
      },
    },
  },
  label: 'Code',
  icon: 'code',
  commands: [
    markCommand({ id: 'code.toggle', label: 'Code', icon: 'code', keybinding: 'Mod-e', toolbar: true }, 'code'),
  ],
};
