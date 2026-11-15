// [text](href "title") and <autolinks>.
import type { Mark, Node } from 'prosemirror-model';
import { linkCommand, type SyntaxItem } from '@pagemd-editor/core';

/** A link or image target: in `<…>` when it has spaces or angle brackets (or is empty), else escaped. */
export function destination(url: string): string {
  if (url === '' || /[\s<>]/.test(url)) return `<${url.replace(/[<>\\]/g, '\\$&')}>`;
  return url.replace(/[()\\]/g, '\\$&');
}

/** Written as `<href>` when the text is exactly the URL (prosemirror-markdown's rule). */
function isPlainUrl(link: Mark, parent: Node, index: number): boolean {
  if (link.attrs['title'] || !/^\w+:/.test(link.attrs['href'] as string)) return false;
  const content = parent.child(index);
  if (!content.isText || content.text !== link.attrs['href'] || content.marks[content.marks.length - 1] !== link) return false;
  return index === parent.childCount - 1 || !link.isInSet(parent.child(index + 1).marks);
}

interface AutolinkState {
  inAutolink?: boolean;
}

export const link: SyntaxItem = {
  id: 'link',
  group: 'text',
  schema: {
    marks: {
      link: {
        attrs: { href: {}, title: { default: null } },
        inclusive: false,
        parseDOM: [{ tag: 'a[href]', getAttrs: (dom) => ({ href: dom.getAttribute('href'), title: dom.getAttribute('title') }) }],
        toDOM: (mark) => ['a', { href: mark.attrs['href'], title: mark.attrs['title'] }, 0],
      },
    },
  },
  fromTokens: {
    link: { mark: 'link', getAttrs: (tok) => ({ href: tok.attrGet('href'), title: tok.attrGet('title') || null }) },
  },
  toMarkdown: {
    marks: {
      link: {
        open(state, mark, parent, index) {
          const plain = isPlainUrl(mark, parent, index);
          (state as unknown as AutolinkState).inAutolink = plain;
          return plain ? '<' : '[';
        },
        close(state, mark) {
          const s = state as unknown as AutolinkState;
          const plain = s.inAutolink;
          s.inAutolink = undefined;
          if (plain) return '>';
          const href = destination(mark.attrs['href'] as string);
          const title = mark.attrs['title'] ? ` "${(mark.attrs['title'] as string).replace(/["\\]/g, '\\$&')}"` : '';
          return `](${href}${title})`;
        },
        mixable: true,
      },
    },
  },
  label: 'Link',
  icon: 'link',
  slash: { keywords: ['link', 'url'] },
  commands: [
    linkCommand({ id: 'link.insert', label: 'Link', icon: 'link', keybinding: 'Mod-k', toolbar: true, keywords: ['link', 'url', 'hyperlink'] }, 'link', 'https://', 'link'),
  ],
};
