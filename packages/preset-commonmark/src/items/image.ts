// ![alt](src "title").
import { insertInlineCommand, type SyntaxItem } from '@pagemd-editor/core';
import { escapeLine } from '@pagemd-editor/transformer';
import { destination } from './link.ts';

interface InlineToken {
  type: string;
  content: string;
  children: InlineToken[] | null;
}

/** The alt text as plain text: what markdown-it's renderer writes into `alt`. */
function plainText(tokens: readonly InlineToken[] | null): string {
  return (tokens ?? [])
    .map((t) => (t.type === 'text' || t.type === 'code_inline' ? t.content : t.type === 'softbreak' || t.type === 'hardbreak' ? '\n' : t.type === 'image' ? plainText(t.children) : ''))
    .join('');
}

export const image: SyntaxItem = {
  id: 'image',
  group: 'media',
  schema: {
    nodes: {
      image: {
        inline: true,
        group: 'inline',
        draggable: true,
        attrs: { src: {}, alt: { default: null }, title: { default: null } },
        parseDOM: [{ tag: 'img[src]', // `data-pmd-full-src`: the canvas shows a very large picture from a smaller copy (P13b); the file's own path is what the document means
        getAttrs: (dom) => ({ src: dom.getAttribute('data-pmd-full-src') ?? dom.getAttribute('src'), alt: dom.getAttribute('alt'), title: dom.getAttribute('title') }) }],
        toDOM: (node) => ['img', node.attrs],
      },
    },
  },
  fromTokens: {
    image: {
      node: 'image',
      getAttrs: (tok) => ({ src: tok.attrGet('src'), title: tok.attrGet('title') || null, alt: plainText(tok.children as InlineToken[] | null) || null }),
    },
  },
  toMarkdown: {
    nodes: {
      image: (state, node) => {
        const alt = escapeLine(state, (node.attrs['alt'] as string | null) ?? '', false);
        const src = destination(node.attrs['src'] as string);
        const title = node.attrs['title'] ? ` "${(node.attrs['title'] as string).replace(/["\\]/g, '\\$&')}"` : '';
        state.write(`![${alt}](${src}${title})`);
      },
    },
  },
  label: 'Image',
  icon: 'file-media',
  slash: { keywords: ['image', 'picture'] },
  commands: [
    insertInlineCommand({ id: 'image.insert', label: 'Image', icon: 'file-media', keywords: ['image', 'picture', 'photo'] }, 'image', (schema, text) =>
      schema.nodes['image']!.create({ src: 'image.png', alt: text || 'Image' }),
    ),
  ],
};
