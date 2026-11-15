// "Where did this come from" (P25, R-242; AD-P25-09): the canvas's blocks at the cursor, innermost first (a paragraph in a cell, the
// cell, the row, the table), each as the element the profile's CSS styles. A selected picture or figure comes first. Node views that
// wrap the styled element in an editor box (`div.pmd-table` around `<table>`, `div.pmd-media` around pagemd's `<figure>`) give the
// element inside.
import type { InspectChain } from '@pagemd-editor/files-panel';

/** What is read of the canvas's ProseMirror view (structural, so the app needs no prosemirror types of its own). */
export interface InspectView {
  state: {
    selection: {
      from: number;
      node?: InspectNode;
      $from: { depth: number; node(depth: number): InspectNode; before(depth: number): number };
    };
  };
  nodeDOM(pos: number): Node | null;
}

interface InspectNode {
  type: { name: string };
  attrs: Record<string, unknown>;
}

const NAMES: Record<string, string> = {
  paragraph: 'Paragraph',
  blockquote: 'Quote',
  bullet_list: 'Bulleted list',
  ordered_list: 'Numbered list',
  list_item: 'List item',
  table: 'Table',
  table_row: 'Row',
  table_cell: 'Cell',
  table_header: 'Header cell',
  code_block: 'Code',
  horizontal_rule: 'Line',
  image: 'Picture',
  pmd_embed: 'Picture',
  pmd_figure: 'Figure',
  pmd_annotated_image: 'Picture with shapes',
};

/** "Heading 2", "Cell", "Box" (an unknown node: its name in words). */
export function blockLabel(node: InspectNode): string {
  const name = node.type.name;
  if (name === 'heading') return `Heading ${String(node.attrs['level'] ?? '')}`.trim();
  const known = NAMES[name];
  if (known) return known;
  const words = name.replace(/^pmd_/, '').replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The element the CSS styles for a node's DOM (see the file header); null for a node with no element. */
export function styledElement(dom: Node | null): Element | null {
  if (!dom || dom.nodeType !== 1) return null;
  const el = dom as Element;
  if (el.matches('div.pmd-table, div.pmd-media, span.pmd-media')) return el.querySelector(':scope > table, :scope > figure, :scope > img') ?? el.firstElementChild ?? el;
  return el;
}

/** The blocks at the cursor, innermost first (no duplicates). */
export function blockChain(view: InspectView): InspectChain[] {
  const out: InspectChain[] = [];
  const push = (node: InspectNode, pos: number): void => {
    const element = styledElement(view.nodeDOM(pos));
    if (element && !out.some((entry) => entry.element === element)) out.push({ label: `${blockLabel(node)} (${element.tagName.toLowerCase()})`, element });
  };
  const selection = view.state.selection;
  if (selection.node) push(selection.node, selection.from);
  const $from = selection.$from;
  for (let depth = $from.depth; depth >= 1; depth--) push($from.node(depth), $from.before(depth));
  return out;
}
