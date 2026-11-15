// Sections (P9, R-164): a section is a heading plus every block after it up to the next heading of the same or a higher
// level, so its sub-sections travel with it. Only headings that are top-level blocks start a movable section (a heading
// inside a box or a list moves with its box); content before the first heading and `:::SECTION` boxes are not
// movable in P9. A move is a TEXT edit: two neighbouring runs of whole blocks swap places, byte for byte, and the blank
// lines between them stay where they were, so the new text is the old text with exactly those lines moved.
import type { Node } from 'prosemirror-model';
import { topBlocks, type OutlineEntry, type TextEdit } from '@pagemd-editor/core';

/** A heading that starts a section: its top-level block and level. */
export interface SectionHead {
  block: number;
  level: number;
  /** The outline entry it came from. */
  entry: OutlineEntry;
}

/** A run of whole top-level blocks: [first, end). */
export interface BlockRun {
  first: number;
  end: number;
}

/** Move the section `section` so it starts before top-level block `before` (the block count: to the end). */
export interface SectionMove {
  section: BlockRun;
  before: number;
}

/** Where a block's text sits: [from, to), the last line's ending excluded (the transformer's `BlockRange`). */
export interface TextRange {
  from: number;
  to: number;
}

/** The headings that start a section: heading entries that are a top-level block of their own, in order. */
export function sectionHeads(doc: Node, entries: readonly OutlineEntry[]): SectionHead[] {
  const starts = new Map<number, number>();
  topBlocks(doc).forEach((block, i) => starts.set(block.pos, i)); // (P18: a SECTION's box is looked through)
  const heads: SectionHead[] = [];
  for (const entry of entries) {
    if (entry.kind !== 'heading') continue;
    const block = starts.get(entry.pos);
    if (block !== undefined) heads.push({ block, level: entry.level, entry });
  }
  return heads;
}

/** The section head `head` starts: up to the next head of the same or a higher level (a lower number), or the end. */
export function sectionOf(heads: readonly SectionHead[], head: SectionHead, blockCount: number): BlockRun {
  const i = heads.indexOf(head);
  const next = heads.slice(i + 1).find((h) => h.level <= head.level);
  return { first: head.block, end: next ? next.block : blockCount };
}

/** The places a section may be dropped: before any other section's heading (not inside itself), or at the end. */
export function dropTargets(heads: readonly SectionHead[], section: BlockRun, blockCount: number): number[] {
  const targets = heads.map((h) => h.block).filter((b) => b < section.first || b > section.end);
  // Right after the section is where it already is; the end is a target unless the section already ends there.
  if (section.end < blockCount) targets.push(blockCount);
  return targets.filter((b) => b !== section.end);
}

/** Move up: before the previous section at the same level under the same parent; null when it is the first. */
export function moveUp(heads: readonly SectionHead[], head: SectionHead, blockCount: number): SectionMove | null {
  const i = heads.indexOf(head);
  for (let k = i - 1; k >= 0; k--) {
    const h = heads[k]!;
    if (h.level < head.level) return null; // the parent: no earlier sibling
    if (h.level === head.level) return { section: sectionOf(heads, head, blockCount), before: h.block };
  }
  return null;
}

/** Move down: after the next section at the same level under the same parent; null when it is the last. */
export function moveDown(heads: readonly SectionHead[], head: SectionHead, blockCount: number): SectionMove | null {
  const section = sectionOf(heads, head, blockCount);
  const next = heads.find((h) => h.block === section.end);
  if (!next || next.level !== head.level) return null;
  return { section, before: sectionOf(heads, next, blockCount).end };
}

/**
 * The two neighbouring runs a move swaps: the section and the blocks between it and the drop place. Null for a move that
 * changes nothing (a drop inside the section or right after it).
 */
export function swapRuns(move: SectionMove): { a: BlockRun; b: BlockRun } | null {
  const { section, before } = move;
  if (before < section.first) return { a: { first: before, end: section.first }, b: section };
  if (before > section.end) return { a: section, b: { first: section.end, end: before } };
  return null;
}

/**
 * The text edit for a move: runs `a` and `b` (a right before b) swap places. Each run keeps its own text, byte for byte
 * (blank lines inside it travel with it); the gap between them stays between them, and what follows `b` follows the
 * new last run. One edit, so VS Code records one undo step.
 */
export function moveEdit(text: string, blocks: readonly TextRange[], move: SectionMove): TextEdit | null {
  const runs = swapRuns(move);
  if (!runs) return null;
  const { a, b } = runs;
  if (a.end !== b.first || a.first >= a.end || b.first >= b.end || b.end > blocks.length) return null;
  const aFrom = blocks[a.first]!.from;
  const aTo = blocks[a.end - 1]!.to;
  const bFrom = blocks[b.first]!.from;
  const bTo = blocks[b.end - 1]!.to;
  return { from: aFrom, to: bTo, text: text.slice(bFrom, bTo) + text.slice(aTo, bFrom) + text.slice(aFrom, aTo) };
}

/**
 * The safety check after a move, given each top-level block's text before (`before`) and after reading the new text
 * again (`after`): true when the new text reads as the same blocks in the new order, each block's text unchanged. False
 * when the move would change how the text around it reads (e.g. a section moved below a code fence the author never
 * closed, which would swallow it); the move is then not made.
 */
export function movedCleanly(before: readonly string[], after: readonly string[], move: SectionMove): boolean {
  const runs = swapRuns(move);
  if (!runs || before.length !== after.length) return false;
  const { a, b } = runs;
  const order = [...indices(0, a.first), ...indices(b.first, b.end), ...indices(a.first, a.end), ...indices(b.end, before.length)];
  return order.every((i, k) => before[i] === after[k]);
}

const indices = (from: number, to: number): number[] => Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i);
