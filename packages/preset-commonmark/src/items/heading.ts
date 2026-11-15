// ATX (`# Title`) and setext (`Title` + `===`) headings; the author's form is kept in `setext`.
import type { Node } from 'prosemirror-model';
import { textblockTypeInputRule } from 'prosemirror-inputrules';
import { blockTypeCommand, type SyntaxItem } from '@pagemd-editor/core';

/** A copy of an inline node whose line breaks became spaces (ATX headings are one line). */
function oneLine(node: Node): Node {
  const content: Node[] = [];
  node.forEach((child) => content.push(child.isText ? child.type.schema.text(child.text!.replace(/\n/g, ' '), child.marks) : child));
  return node.type.create(node.attrs, content, node.marks);
}

export const heading: SyntaxItem = {
  id: 'heading',
  group: 'text',
  schema: {
    nodes: {
      heading: {
        attrs: { level: { default: 1 }, setext: { default: false } },
        content: 'inline*',
        group: 'block',
        defining: true,
        parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({ tag: `h${level}`, attrs: { level } })),
        toDOM: (node) => [`h${node.attrs['level']}`, 0],
      },
    },
  },
  fromTokens: {
    heading: { block: 'heading', getAttrs: (tok) => ({ level: Number(tok.tag.slice(1)), setext: tok.markup === '=' || tok.markup === '-' }) },
  },
  toMarkdown: {
    nodes: {
      heading: (state, node) => {
        const level = node.attrs['level'] as number;
        const multiLine = node.textContent.includes('\n');
        // A setext heading needs some content: text that isn't only spaces, or an inline node (an image).
        let hasContent = node.textContent.trim() !== '';
        node.forEach((child) => {
          if (!child.isText) hasContent = true;
        });
        if (level <= 2 && (node.attrs['setext'] || multiLine) && hasContent) {
          state.renderInline(node);
          state.ensureNewLine();
          state.write(level === 1 ? '===' : '---');
        } else {
          state.write('#'.repeat(level) + ' ');
          state.renderInline(multiLine ? oneLine(node) : node, false);
          // A closing run of `#` after a space would be read as the optional closing sequence.
          const s = state as unknown as { out: string };
          s.out = s.out.replace(/([ \t])(#+)$/, '$1\\$2');
        }
        state.closeBlock(node);
      },
    },
  },
  label: 'Heading',
  icon: 'text-size',
  slash: { keywords: ['heading', 'title', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'] },
  outline: (node, pos) => ({ kind: 'heading', label: node.textContent, level: node.attrs['level'] as number, pos }),
  // `## ` … `###### ` at a block's start turns it into an ATX heading of that level (OQ-24, P3).
  inputRules: (schema) => [textblockTypeInputRule(/^(#{1,6})\s$/, schema.nodes['heading']!, (match) => ({ level: match[1]!.length, setext: false }))],
  commands: [
    ...[1, 2, 3, 4, 5, 6].map((level) =>
      blockTypeCommand(
        { id: `heading.h${level}`, label: `Heading ${level}`, icon: 'text-size', keybinding: `Mod-Alt-${level}`, toolbar: level <= 3, keywords: ['heading', 'title', `h${level}`, `heading ${level}`] },
        'heading',
        { level },
        { anyAttrs: false },
      ),
    ),
  ],
};
