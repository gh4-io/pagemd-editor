// @pagemd-editor/plugin-source-map: canvas positions ⇄ places in the markdown text (P9, layered-architecture.md §3).
// Split view keeps its two cursors together with it, and the Outline and the Code view link entries to their lines.
// Every answer stays inside one top-level block (the acceptance criterion: "cursor sync stays within the same block"):
// the block comes from the transformer's block ranges (`sourceOf(doc).blocks`, ADR-0007), and inside a block the
// block's text on the canvas is matched character by character against its source text, skipping the markup the
// canvas doesn't show (`**`, `[`, `](…)`, directive comments). Nothing here reads markdown: no second parser (I1).
import type { Node } from 'prosemirror-model';
import type { BlockRange } from '@pagemd-editor/transformer';
import { topBlocks } from '@pagemd-editor/core';

/** What the source side needs: the text and one range per top-level block (the transformer's `SourceInfo`). */
export interface SourceBlocks {
  readonly text: string;
  readonly blocks: readonly BlockRange[];
}

/**
 * The top-level block holding `pos` (the last one for the document's end) and where that block starts. Blocks are counted as the
 * block ranges count them: groups (P18, a SECTION's box) are looked through, so a position on a group's own edge belongs to the
 * block after it.
 */
export function blockAtPos(doc: Node, pos: number): { index: number; start: number } {
  const blocks = topBlocks(doc);
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    if (pos < b.pos + b.node.nodeSize || i === blocks.length - 1) return { index: i, start: b.pos };
  }
  return { index: 0, start: 0 };
}

/** Where top-level block `index` starts on the canvas (the document's end for an index past the last block). */
export function blockStart(doc: Node, index: number): number {
  const blocks = topBlocks(doc);
  return index < blocks.length ? (blocks[Math.max(0, index)]?.pos ?? 0) : doc.content.size;
}

/**
 * The block an offset in the text belongs to: the last block starting at or before it (an offset in the blank lines
 * between two blocks belongs to the block above), the first block for an offset before every block.
 */
export function blockAtOffset(source: SourceBlocks, offset: number): number {
  const { blocks } = source;
  let found = 0;
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i]!.from <= offset) found = i;
    else break;
  }
  return found;
}

/** The text characters of a block on the canvas, each with its position. */
function canvasChars(block: Node, start: number): { pos: number; ch: string }[] {
  const out: { pos: number; ch: string }[] = [];
  block.descendants((node, pos) => {
    if (!node.isText) return true;
    const text = node.text ?? '';
    for (let i = 0; i < text.length; i++) out.push({ pos: start + 1 + pos + i, ch: text[i]! });
    return false;
  });
  return out;
}

/** How far ahead in the source a canvas character is looked for before it counts as not found (markup is short). */
const LOOKAHEAD = 400;

/**
 * Pairs each canvas character of a block with the source offset it was read from, in order: a greedy match that skips
 * source characters the canvas doesn't show. A character not found nearby is paired with the place the match stopped.
 */
function align(block: Node, start: number, source: string, range: BlockRange): { pos: number; offset: number }[] {
  // The same block against the same source text gives the same pairs: kept while both live (moving the cursor
  // around one block asks again and again).
  const cached = alignments.get(block);
  if (cached && cached.source === source && cached.from === range.from && cached.to === range.to && cached.start === start) return cached.pairs;
  const pairs = alignBlock(block, start, source, range);
  alignments.set(block, { source, from: range.from, to: range.to, start, pairs });
  return pairs;
}

const alignments = new WeakMap<Node, { source: string; from: number; to: number; start: number; pairs: { pos: number; offset: number }[] }>();

function alignBlock(block: Node, start: number, source: string, range: BlockRange): { pos: number; offset: number }[] {
  const chars = canvasChars(block, start);
  const pairs: { pos: number; offset: number }[] = [];
  let j = range.from;
  for (const { pos, ch } of chars) {
    let k = j;
    const limit = Math.min(range.to, j + LOOKAHEAD);
    while (k < limit && source[k] !== ch) k++;
    if (k < limit) {
      pairs.push({ pos, offset: k });
      j = k + 1;
    } else {
      pairs.push({ pos, offset: Math.min(j, range.to) });
    }
  }
  return pairs;
}

/** The range for block `index`, or the last one when the canvas has more blocks than the source (unsent edits). */
function rangeFor(source: SourceBlocks, index: number): BlockRange | undefined {
  return source.blocks[Math.min(index, source.blocks.length - 1)];
}

/**
 * The offset in the text for canvas position `pos`: inside the same top-level block's source range, at the character
 * the cursor sits before (or the end of the block's text when it sits after the last one).
 */
export function posToOffset(doc: Node, source: SourceBlocks, pos: number): number {
  const blocks = topBlocks(doc);
  if (blocks.length === 0 || source.blocks.length === 0) return 0;
  const { index, start } = blockAtPos(doc, pos);
  const range = rangeFor(source, index)!;
  const pairs = align(blocks[index]!.node, start, source.text, range);
  const next = pairs.find((p) => p.pos >= pos);
  if (next) return next.offset;
  const last = pairs[pairs.length - 1];
  return last ? Math.min(range.to, last.offset + 1 + Math.max(0, pos - last.pos - 1)) : range.from;
}

/**
 * The canvas position for offset `offset` in the text: inside the same top-level block, at the character read from
 * that offset (or the next one shown); the block's first text position when the offset is in markup before any text.
 */
export function offsetToPos(doc: Node, source: SourceBlocks, offset: number): number {
  const blocks = topBlocks(doc);
  if (blocks.length === 0 || source.blocks.length === 0) return 0;
  const index = Math.min(blockAtOffset(source, offset), blocks.length - 1);
  const start = blocks[index]!.pos;
  const block = blocks[index]!.node;
  const range = rangeFor(source, index)!;
  const pairs = align(block, start, source.text, range);
  const next = pairs.find((p) => p.offset >= offset);
  if (next) return next.pos;
  const last = pairs[pairs.length - 1];
  // After the last text character: just after it; a block without text: its start (an atom is selected from there).
  return last ? last.pos + 1 : block.isLeaf || block.isAtom ? start : Math.min(start + 1, start + block.nodeSize - 1);
}
