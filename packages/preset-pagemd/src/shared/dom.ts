// Canvas helpers (I3: the canvas shows the classes pagemd's renderer writes, so profile CSS applies).
import { DOMSerializer, type Node } from 'prosemirror-model';
import type { NodeViewConstructor } from 'prosemirror-view';

/**
 * A node view that draws the node exactly as its own item's `toDOM` does, plus `extra(node)` attributes on the
 * outer element (classes are added to the existing ones). Used for nodes other presets own that a pagemd item
 * extends (a heading with `{.class}`, a lettered list): the owning item's look is kept, pagemd's classes added.
 */
export function withAttributes(extra: (node: Node) => Record<string, string>): NodeViewConstructor {
  return (node) => {
    const spec = node.type.spec.toDOM?.(node);
    if (!spec) throw new Error(`Node '${node.type.name}' has no toDOM.`);
    const { dom, contentDOM } = DOMSerializer.renderSpec(document, spec);
    const element = dom as HTMLElement;
    applyAttributes(element, extra(node));
    return {
      dom: element,
      ...(contentDOM ? { contentDOM: contentDOM as HTMLElement } : {}),
      // A changed attribute redraws the node (ProseMirror builds a new view when update returns false).
      update: (next) => next.type === node.type && sameAttrs(next, node),
    };
  };
}

function applyAttributes(element: HTMLElement, attrs: Record<string, string>): void {
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') element.classList.add(...value.split(/\s+/).filter(Boolean));
    else element.setAttribute(key, value);
  }
}

function sameAttrs(a: Node, b: Node): boolean {
  return JSON.stringify(a.attrs) === JSON.stringify(b.attrs);
}

/** Joins class names, leaving out empty ones. */
export const classes = (...names: (string | null | undefined | false)[]): string => names.filter(Boolean).join(' ');
