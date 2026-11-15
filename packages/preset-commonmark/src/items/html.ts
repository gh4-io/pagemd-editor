// Raw HTML, block and inline: kept exactly as written (the canvas shows it as a raw chip). Since P18 a raw HTML block also carries
// a preview of what it draws, shown instead of its source in the views styled by the profile (pagemd's page draws the HTML; Draft
// keeps the source): made safe like a template (core's safe-html.ts), not editable; the source shows again while the cursor is in
// the block (the canvas marks that block, components/canvas's `pmd-cursor-in`), so it is edited as before.
import type { Node } from 'prosemirror-model';
import type { NodeView, NodeViewConstructor } from 'prosemirror-view';
import { safeFragment, type SyntaxItem } from '@pagemd-editor/core';

/** The class on a raw HTML block's preview (P18). */
export const HTML_PREVIEW_CLASS = 'pmd-html-preview';

class HtmlBlockView implements NodeView {
  readonly dom: HTMLElement;
  readonly contentDOM: HTMLElement;
  readonly #preview: HTMLElement;
  #node: Node;
  #shown = '';

  constructor(node: Node, doc: Document) {
    this.#node = node;
    this.dom = doc.createElement('div');
    this.dom.className = 'pmd-html-view';
    this.#preview = doc.createElement('div');
    this.#preview.className = HTML_PREVIEW_CLASS;
    this.#preview.contentEditable = 'false';
    const pre = doc.createElement('pre');
    pre.className = 'pmd-html-block';
    this.contentDOM = doc.createElement('code');
    pre.append(this.contentDOM);
    this.dom.append(this.#preview, pre);
    this.#draw();
  }

  #draw(): void {
    const html = this.#node.textContent;
    if (html === this.#shown) return;
    this.#shown = html;
    this.#preview.replaceChildren(safeFragment(this.dom.ownerDocument, html));
  }

  update(node: Node): boolean {
    if (node.type !== this.#node.type) return false;
    this.#node = node;
    this.#draw();
    return true;
  }

  /** The preview is drawn here, not by ProseMirror. */
  ignoreMutation(mutation: MutationRecord | { type: 'selection'; target: globalThis.Node }): boolean {
    return this.#preview.contains(mutation.target as globalThis.Node);
  }
}

const htmlBlockView: NodeViewConstructor = (node, view) => new HtmlBlockView(node, view.dom.ownerDocument);

export const html: SyntaxItem = {
  id: 'html',
  group: 'blocks',
  schema: {
    nodes: {
      html_block: {
        content: 'text*',
        marks: '',
        group: 'block',
        code: true,
        defining: true,
        parseDOM: [{ tag: 'pre.pmd-html-block', preserveWhitespace: 'full' }],
        toDOM: () => ['pre', { class: 'pmd-html-block' }, ['code', 0]],
      },
      html_inline: {
        inline: true,
        group: 'inline',
        atom: true,
        attrs: { html: {} },
        parseDOM: [{ tag: 'code.pmd-html-inline', getAttrs: (dom) => ({ html: dom.textContent }) }],
        toDOM: (node) => ['code', { class: 'pmd-html-inline' }, node.attrs['html'] as string],
      },
    },
  },
  fromTokens: {
    html_block: { block: 'html_block', noCloseToken: true },
    html_inline: { node: 'html_inline', getAttrs: (tok) => ({ html: tok.content }) },
  },
  toMarkdown: {
    nodes: {
      html_block: (state, node) => {
        state.text(node.textContent, false);
        state.closeBlock(node);
      },
      html_inline: (state, node) => state.text(node.attrs['html'] as string, false),
    },
  },
  nodeViews: { html_block: htmlBlockView },
  label: 'HTML',
  icon: 'code',
};
