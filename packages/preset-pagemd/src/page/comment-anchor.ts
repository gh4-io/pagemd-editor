// Review-comment anchors (P12, ADR-0015, R-179): `<!-- ::COMMENT id="c7" -->` on its own line marks the block below it;
// the thread itself lives in `.pagemd/comments/<doc>.json`. pagemd prints an unknown directive as an HTML comment, so
// the PDF is unaffected. The reading and writing are @pagemd/syntax's directive rules (I1); this file only gives the
// anchor its own node, which takes no room on the page (a hidden marker with a small flag in the margin), is written as
// a `tight` block (the lossless layer puts no blank line after it, so a new comment adds exactly one line) and can be
// found, made and removed by the comments plugin without that plugin knowing the dialect.
import type { Node } from 'prosemirror-model';
import type { EditorState, Transaction } from 'prosemirror-state';
import { topBlocks, type SyntaxItem } from '@pagemd-editor/core';
import { atomWriter, UNKNOWN_DIRECTIVE } from '../shared/write.ts';
import { FRONTMATTER_NODE } from '../document/frontmatter.ts';

/** The anchor's node (a block directive on its own line). */
export const COMMENT_NODE = 'pmd_comment';
/** The same directive written inside a line of text (read, listed and tinted; never made by the editor). */
const INLINE_NODE = 'pmd_directive_inline';

interface DirectiveLike {
  name?: unknown;
  attrs?: { id?: unknown };
}

const dataOf = (node: Node): DirectiveLike => (node.attrs['data'] ?? {}) as DirectiveLike;

/** The thread id an anchor names, or null when `node` is not a comment anchor. */
export function commentAnchorId(node: Node): string | null {
  if (node.type.name !== COMMENT_NODE && node.type.name !== INLINE_NODE) return null;
  const data = dataOf(node);
  const id = data.attrs?.id;
  return data.name === 'COMMENT' && typeof id === 'string' && id !== '' ? id : null;
}

/** True when the dialect reader should give `<!-- ::COMMENT id="…" -->` the anchor node (used by dialect.ts). */
export const isCommentDirective = (data: Record<string, unknown>): boolean => data['name'] === 'COMMENT' && typeof (data['attrs'] as { id?: unknown } | undefined)?.id === 'string' && (data['attrs'] as { id: string }).id !== '';

export interface CommentAnchor {
  id: string;
  /** Where the anchor node starts. */
  pos: number;
  /** In a line of text rather than on its own line. */
  inline: boolean;
}

/** Every anchor in the document, in order. */
export function commentAnchors(doc: Node): CommentAnchor[] {
  const found: CommentAnchor[] = [];
  doc.descendants((node, pos) => {
    const id = commentAnchorId(node);
    if (id !== null) found.push({ id, pos, inline: node.isInline });
    return true;
  });
  return found;
}

/** The anchor node for thread `id`, made the way the reader would read `<!-- ::COMMENT id="…" -->`. */
function anchorNode(state: EditorState, id: string): Node {
  return state.schema.nodes[COMMENT_NODE]!.create({ data: { name: 'COMMENT', parenParams: null, params: `id="${id}"`, attrs: { id } } });
}

/**
 * Puts the anchor for `id` directly above the top-level block that holds the selection (a list or table is one block), as
 * one transaction. null when there is nowhere to put it: no anchor node in the schema, or the selection is in the
 * frontmatter card.
 */
export function insertCommentAnchor(state: EditorState, id: string): Transaction | null {
  if (!state.schema.nodes[COMMENT_NODE]) return null;
  const found = blockHolding(state.doc, state.selection.from);
  if (!found || found.node.type.name === FRONTMATTER_NODE) return null;
  return state.tr.insert(found.pos, anchorNode(state, id));
}

/** The top-level block the anchor marks (the first block below it that is not itself an anchor), or null. */
export function commentedBlock(doc: Node, anchor: CommentAnchor): { pos: number; node: Node } | null {
  const blocks = topBlocks(doc);
  if (anchor.inline) return blockHolding(doc, anchor.pos, blocks);
  const at = blocks.findIndex((b) => b.pos === anchor.pos);
  if (at < 0) return null;
  for (let i = at + 1; i < blocks.length; i++) if (commentAnchorId(blocks[i]!.node) === null) return blocks[i]!;
  return null;
}

/** The top-level block (groups looked through, P18) holding position `pos`, or null. */
function blockHolding(doc: Node, pos: number, blocks = topBlocks(doc)): { pos: number; node: Node } | null {
  for (const b of blocks) if (pos >= b.pos && pos < b.pos + b.node.nodeSize) return b;
  return null;
}

/** Removes the (first) anchor for `id`, as one transaction; null when the document has none. */
export function removeCommentAnchor(state: EditorState, id: string): Transaction | null {
  const anchor = commentAnchors(state.doc).find((a) => a.id === id);
  if (!anchor) return null;
  const node = state.doc.nodeAt(anchor.pos)!;
  return state.tr.delete(anchor.pos, anchor.pos + node.nodeSize);
}

/** Removes the anchor node that starts at `pos` (one of `commentAnchors`' positions), as one transaction; null when none is there. */
export function removeCommentAnchorAt(state: EditorState, pos: number): Transaction | null {
  const node = state.doc.nodeAt(pos);
  return node && commentAnchorId(node) !== null ? state.tr.delete(pos, pos + node.nodeSize) : null;
}

const flag = (id: string): ['span', Record<string, string>, string] => ['span', { class: 'pmd-comment-flag', title: `Comment ${id}`, 'data-comment-id': id }, id];

export const commentAnchor: SyntaxItem = {
  id: 'comment-anchor',
  group: 'page',
  schema: {
    nodes: {
      [COMMENT_NODE]: {
        group: 'block',
        atom: true,
        selectable: true,
        draggable: false,
        // A new anchor is saved as one line directly above its block, no blank line after it (R-179, lossless).
        tight: true,
        attrs: { data: {} },
        toDOM: (node) => ['div', { class: 'pmd-comment-anchor', 'data-comment-id': commentAnchorId(node) ?? '', contenteditable: 'false' }, flag(commentAnchorId(node) ?? '')],
      },
    },
  },
  fromTokens: { [COMMENT_NODE]: { node: COMMENT_NODE, getAttrs: (tok) => ({ data: { ...((tok.meta as { pmd?: { data: Record<string, unknown> } } | null)?.pmd?.data ?? {}) } }) } },
  toMarkdown: { nodes: { [COMMENT_NODE]: atomWriter(() => UNKNOWN_DIRECTIVE) } },
  label: 'Comment',
  icon: 'comment',
};
