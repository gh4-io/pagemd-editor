// The comment anchors on the canvas (P12): where they are, which block each one marks, the tint on that block, and "which
// comment is the cursor in". The plugin knows no dialect: the app passes `anchorOf` (preset-pagemd's `commentAnchorId`).
// A block anchor on its own line marks the next block that is not itself an anchor; an anchor written in a line of text
// marks the block it sits in.
import type { Node } from 'prosemirror-model';
import { Plugin, PluginKey, type EditorState } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import { topBlocks } from '@pagemd-editor/core';
import { shorten } from './model.ts';

export interface AnchorInfo {
  id: string;
  /** Where the anchor node starts. */
  pos: number;
  inline: boolean;
  /** The block it marks (top-level): where it starts and ends, or null when nothing follows the anchor. */
  block: { from: number; to: number } | null;
}

export interface CommentsPluginState {
  anchors: AnchorInfo[];
  /** The thread the panel has selected. */
  active: string | null;
  decorations: DecorationSet;
}

export type ThreadStatus = 'open' | 'resolved';

export interface CommentsPluginOptions {
  /** The thread id an anchor node names; null for any other node. */
  anchorOf(node: Node): string | null;
  /** 'open' or 'resolved' for a thread with this id, or undefined when no thread has it (a bare anchor is tinted as open). */
  statusOf(id: string): ThreadStatus | undefined;
  /** A comment's flag on the page was clicked. */
  onActivate(id: string, view: EditorView): void;
  /** The cursor moved into (or out of) a commented block; `id` is the first thread there, or null. */
  onCursor?(id: string | null): void;
  /** The document or the selection changed (after `onCursor`); the panel redraws its quote and lists. */
  onUpdate?(): void;
}

export const commentsKey = new PluginKey<CommentsPluginState>('pmd-comments');

type Meta = { refresh: true } | { active: string | null };

/** The anchors of `doc` with the block each marks. */
export function findAnchors(doc: Node, anchorOf: (node: Node) => string | null): AnchorInfo[] {
  const found: AnchorInfo[] = [];
  // Blocks as the block ranges count them (P18: a SECTION's box is looked through, its blocks are top-level blocks).
  const blocks = topBlocks(doc);
  blocks.forEach(({ node: child, pos: start }, index) => {
    const pos = start + child.nodeSize;
    const id = anchorOf(child);
    if (id !== null) {
      // The next top-level block that is not an anchor.
      let block: AnchorInfo['block'] = null;
      for (let i = index + 1; i < blocks.length; i++) {
        const next = blocks[i]!;
        if (anchorOf(next.node) === null) {
          block = { from: next.pos, to: next.pos + next.node.nodeSize };
          break;
        }
      }
      found.push({ id, pos: start, inline: false, block });
    } else if (child.inlineContent || child.childCount > 0) {
      // An anchor written inside a block (a line of text, a list item) marks that whole top-level block.
      child.descendants((node, offset) => {
        const inner = anchorOf(node);
        if (inner !== null) found.push({ id: inner, pos: start + 1 + offset, inline: node.isInline, block: { from: start, to: pos } });
        return true;
      });
    }
  });
  return found;
}

export const anchorsOf = (state: EditorState): AnchorInfo[] => commentsKey.getState(state)?.anchors ?? [];

/** The first thread whose block holds `pos`. */
export function threadAt(anchors: readonly AnchorInfo[], pos: number): string | null {
  return anchors.find((a) => a.block && pos >= a.block.from && pos <= a.block.to)?.id ?? null;
}

/** What a new comment is about: the selected text, else the text of the block the cursor is in. */
export function quoteFor(state: EditorState, max = 200): string {
  const { from, to, $from } = state.selection;
  if (from !== to) return shorten(state.doc.textBetween(from, to, ' ', ' '), max);
  const block = $from.depth >= 1 ? $from.node(1) : state.doc.maybeChild($from.index(0));
  return block ? shorten(block.textBetween(0, block.content.size, ' ', ' '), max) : '';
}

export function commentsPlugin(options: CommentsPluginOptions): Plugin<CommentsPluginState> {
  const compute = (doc: Node, active: string | null): CommentsPluginState => {
    const anchors = findAnchors(doc, options.anchorOf);
    const decorations: Decoration[] = [];
    for (const anchor of anchors) {
      if (!anchor.block) continue;
      const status = options.statusOf(anchor.id) ?? 'open';
      const classes = ['pmd-commented'];
      if (status === 'resolved') classes.push('pmd-commented-resolved');
      if (anchor.id === active) classes.push('pmd-commented-active');
      decorations.push(Decoration.node(anchor.block.from, anchor.block.to, { class: classes.join(' ') }));
    }
    return { anchors, active, decorations: DecorationSet.create(doc, decorations) };
  };
  return new Plugin<CommentsPluginState>({
    key: commentsKey,
    state: {
      init: (_config, state) => compute(state.doc, null),
      apply(tr, prev, _old, state) {
        const meta = tr.getMeta(commentsKey) as Meta | undefined;
        if (meta && 'active' in meta) return compute(state.doc, meta.active);
        if (meta || tr.docChanged) return compute(state.doc, prev.active);
        return prev;
      },
    },
    props: {
      decorations: (state) => commentsKey.getState(state)?.decorations ?? null,
      handleDOMEvents: {
        click: (view, event) => {
          const flag = (event.target as HTMLElement | null)?.closest?.('.pmd-comment-flag');
          const id = flag?.getAttribute('data-comment-id');
          if (!id) return false;
          options.onActivate(id, view);
          return false;
        },
      },
    },
    view: () => {
      let last: string | null | undefined;
      return {
        update(view, previous) {
          if (last !== undefined && previous.doc.eq(view.state.doc) && previous.selection.eq(view.state.selection)) return;
          const id = threadAt(anchorsOf(view.state), view.state.selection.head);
          if (id !== last) {
            last = id;
            options.onCursor?.(id);
          }
          options.onUpdate?.();
        },
      };
    },
  });
}

/** Redraws the tints (a thread was resolved, added or removed). */
export function refreshComments(view: EditorView): void {
  view.dispatch(view.state.tr.setMeta(commentsKey, { refresh: true } satisfies Meta).setMeta('addToHistory', false));
}

/** Marks a thread as the selected one (its block is tinted stronger); null for none. */
export function setActiveComment(view: EditorView, id: string | null): void {
  view.dispatch(view.state.tr.setMeta(commentsKey, { active: id } satisfies Meta).setMeta('addToHistory', false));
}
