// Fenced (``` / ~~~) and indented code blocks. The fence (or `null` for indented) and info string are kept.
import type { Node } from 'prosemirror-model';
import { textblockTypeInputRule } from 'prosemirror-inputrules';
import { blockTypeCommand, type SyntaxItem } from '@pagemd-editor/core';

/** A fence longer than any run of its character inside the code. */
function fenceFor(node: Node): string {
  const wanted = (node.attrs['fence'] as string | null) ?? '```';
  const params = node.attrs['params'] as string;
  const char = wanted[0] === '~' || params.includes('`') ? '~' : '`';
  let longest = 0;
  for (const run of node.textContent.match(char === '`' ? /`+/g : /~+/g) ?? []) longest = Math.max(longest, run.length);
  return char.repeat(Math.max(3, wanted[0] === char ? wanted.length : 3, longest + 1));
}

export const codeBlock: SyntaxItem = {
  id: 'code_block',
  group: 'blocks',
  schema: {
    nodes: {
      code_block: {
        content: 'text*',
        marks: '',
        group: 'block',
        code: true,
        defining: true,
        attrs: { params: { default: '' }, fence: { default: '```' } },
        parseDOM: [{ tag: 'pre', preserveWhitespace: 'full' }],
        toDOM: () => ['pre', ['code', 0]],
      },
    },
  },
  fromTokens: {
    fence: { block: 'code_block', getAttrs: (tok) => ({ params: tok.info, fence: tok.markup }), noCloseToken: true },
    code_block: { block: 'code_block', attrs: { params: '', fence: null }, noCloseToken: true },
  },
  toMarkdown: {
    nodes: {
      code_block: (state, node, parent, index) => {
        const text = node.textContent;
        // Indented code can't start or end with a blank line, or be empty; right after a list it would
        // continue the list, right after indented code it would join it, and as the first block of a
        // list item its indent depends on the marker width. Those are written fenced.
        const prev = index > 0 ? parent.child(index - 1) : null;
        const afterList =
          (prev !== null && (/list$/.test(prev.type.name) || (prev.type.name === 'code_block' && prev.attrs['fence'] === null))) ||
          (prev === null && parent.type.name === 'list_item');
        const indented = node.attrs['fence'] === null && !afterList && text.trim() !== '' && !/^\s*\n|\n\s*$/.test(text) && !/^\s*$/.test(text.split('\n')[0]!);
        if (indented) {
          text.split('\n').forEach((line, i) => {
            if (i > 0) state.write('\n');
            state.write(line === '' ? '' : '    ' + line);
          });
        } else {
          const fence = fenceFor(node);
          state.write(fence + (node.attrs['params'] as string) + '\n');
          state.text(text, false);
          state.write('\n');
          state.write(fence);
        }
        state.closeBlock(node);
      },
    },
  },
  label: 'Code block',
  icon: 'file-code',
  slash: { keywords: ['code', 'fence', 'snippet'] },
  // ``` at a block's start turns it into a fenced code block (OQ-24, P3).
  inputRules: (schema) => [textblockTypeInputRule(/^```$/, schema.nodes['code_block']!, () => ({ params: '', fence: '```' }))],
  commands: [
    blockTypeCommand({ id: 'code_block.toggle', label: 'Code block', icon: 'file-code', keybinding: 'Mod-Alt-c', keywords: ['code', 'fence', 'snippet'] }, 'code_block', { params: '', fence: '```' }, { anyAttrs: true }),
  ],
};
