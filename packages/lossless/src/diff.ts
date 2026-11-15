// diffToEdits: save only what changed (ADR-0007, R-75, R-85).
// A top-level block that is the same object as when it was read writes back its original text; so does
// one whose content is equal (e.g. after undo). Every run of changed blocks becomes ONE text edit, and
// rewritten blocks use the file's line ending. Afterwards the new document remembers where its blocks
// sit in the saved text, so the next save reuses text again without re-reading the file.
// P26: a block changed in place may instead be written by editing its old text (SourceInfo.patchBlock: a ticked task box changes
// one character), when the edited text reads back as the changed block.
// A block inserted on its own whose node type is `tight` (spec flag, P12 / R-179: a comment anchor) is followed by a
// single line ending instead of a blank line, so adding it changes the file by exactly that one line.
import type { Node } from 'prosemirror-model';
import { topBlocks, type TextEdit } from '@pagemd-editor/core';
import { recordSource, sourceOf, type BlockRange } from '@pagemd-editor/transformer';

/** Where a new block's text will sit: an old range (reused) or a place inside one edit's text. */
type Placement = { kind: 'old'; range: BlockRange } | { kind: 'edit'; edit: TextEdit; offset: number; length: number };

export function diffToEdits(oldDoc: Node, newDoc: Node, source: string): TextEdit[] {
  const info = sourceOf(oldDoc);
  if (!info) throw new Error('diffToEdits: the old document was not read by the transformer (no source recorded).');
  if (info.text !== source) throw new Error('diffToEdits: `source` is not the text the old document was read from.');

  const le = info.lineEnding;
  const blankLine = le + le;
  const oldNodes = children(oldDoc);
  const newNodes = children(newDoc);
  const ranges = info.blocks;
  const write = (node: Node): string => info.writeBlock(node).replace(/\n/g, le);
  const tight = (node: Node | undefined): boolean => node?.type.spec['tight'] === true;

  const anchors = expandByEquality(identityAnchors(oldNodes, newNodes), oldNodes, newNodes);
  const edits: TextEdit[] = [];
  const placements: Placement[] = new Array(newNodes.length);
  for (const [i, j] of anchors) if (i >= 0 && i < oldNodes.length) placements[j] = { kind: 'old', range: ranges[i]! };

  for (let k = 0; k + 1 < anchors.length; k++) {
    const [i0, j0] = anchors[k]!;
    const [i1, j1] = anchors[k + 1]!;
    const oldFirst = i0 + 1;
    const oldLast = i1 - 1;
    const added = newNodes.slice(j0 + 1, j1);
    const before = i0 >= 0 ? ranges[i0] : undefined;
    const after = i1 < oldNodes.length ? ranges[i1] : undefined;
    if (oldFirst > oldLast && added.length === 0) continue;

    // The separators between the new blocks: the original gaps where old blocks stood, else a blank line.
    const gap = (n: number): string =>
      oldFirst + n + 1 <= oldLast ? source.slice(ranges[oldFirst + n]!.to, ranges[oldFirst + n + 1]!.from) : tight(added[n]) ? le : blankLine;
    // P26: one block changed in place by something an item can edit in the old text (a ticked task box): that one edit, the rest as written
    const patched = oldFirst === oldLast && added.length === 1 ? (info.patchBlock?.(oldNodes[oldFirst]!, added[0]!, source.slice(ranges[oldFirst]!.from, ranges[oldFirst]!.to)) ?? null) : null;
    const texts = patched !== null ? [patched] : added.map(write);
    let from: number;
    let to: number;
    let prefix = '';
    let suffix = '';

    if (oldFirst <= oldLast && added.length > 0) {
      // Replace the old blocks (not the gaps around them) with the new ones.
      from = ranges[oldFirst]!.from;
      to = ranges[oldLast]!.to;
    } else if (oldFirst <= oldLast) {
      // Delete blocks together with one neighbouring gap.
      if (after) [from, to] = [ranges[oldFirst]!.from, after.from];
      else if (before) [from, to] = [before.to, ranges[oldLast]!.to];
      else [from, to] = [ranges[oldFirst]!.from, ranges[oldLast]!.to];
    } else if (after && tight(added[added.length - 1])) {
      // A tight block goes directly above the block after it, one line ending between them (R-179).
      from = to = after.from;
      suffix = le;
    } else if (before) {
      // Insert after the previous block.
      from = to = before.to;
      prefix = blankLine;
    } else if (after) {
      // Insert before the first block.
      from = to = after.from;
      suffix = blankLine;
    } else {
      // Unreachable: a parsed document always has at least one block with a range.
      throw new Error('diffToEdits: nowhere to insert.');
    }

    let text = prefix;
    const edit: TextEdit = { from, to, text: '' };
    texts.forEach((t, n) => {
      if (n > 0) text += gap(n - 1);
      placements[j0 + 1 + n] = { kind: 'edit', edit, offset: text.length, length: t.length };
      text += t;
    });
    edit.text = text + suffix;
    edits.push(edit);
  }

  edits.sort((a, b) => a.from - b.from || a.to - b.to);
  remember(newDoc, edits, placements, source, info);
  return edits;
}

/** The document's blocks, groups looked through (P18, R-229: a SECTION box is not a block of its own; its blocks are). */
function children(doc: Node): Node[] {
  return topBlocks(doc).map((block) => block.node);
}

/**
 * Pairs [oldIndex, newIndex] of blocks that are the same object, in order in both documents (the
 * longest increasing run), framed by the virtual start (-1, -1) and end (oldLength, newLength).
 */
function identityAnchors(oldNodes: readonly Node[], newNodes: readonly Node[]): [number, number][] {
  const oldIndex = new Map<Node, number>();
  oldNodes.forEach((node, i) => {
    if (!oldIndex.has(node)) oldIndex.set(node, i);
  });
  const pairs: [number, number][] = [];
  newNodes.forEach((node, j) => {
    const i = oldIndex.get(node);
    if (i !== undefined) pairs.push([i, j]);
  });
  // Longest strictly increasing subsequence of old indices (patience sorting, O(n log n)).
  const tails: number[] = [];
  const prev: number[] = new Array(pairs.length).fill(-1);
  pairs.forEach(([i], p) => {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tails[mid]!]![0] < i) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[p] = tails[lo - 1]!;
    tails[lo] = p;
  });
  const chain: [number, number][] = [];
  for (let p = tails.length > 0 ? tails[tails.length - 1]! : -1; p >= 0; p = prev[p]!) chain.push(pairs[p]!);
  chain.reverse();
  return [[-1, -1], ...chain, [oldNodes.length, newNodes.length]];
}

/** Inside each changed stretch, blocks at its start or end whose content is equal count as unchanged (R-85 A). */
function expandByEquality(anchors: [number, number][], oldNodes: readonly Node[], newNodes: readonly Node[]): [number, number][] {
  const out: [number, number][] = [anchors[0]!];
  for (let k = 0; k + 1 < anchors.length; k++) {
    let [i0, j0] = anchors[k]!;
    let [i1, j1] = anchors[k + 1]!;
    const tail: [number, number][] = [];
    while (i0 + 1 < i1 && j0 + 1 < j1 && oldNodes[i0 + 1]!.eq(newNodes[j0 + 1]!)) out.push([++i0, ++j0]);
    while (i1 - 1 > i0 && j1 - 1 > j0 && oldNodes[i1 - 1]!.eq(newNodes[j1 - 1]!)) tail.unshift([--i1, --j1]);
    out.push(...tail, anchors[k + 1]!);
  }
  return out;
}

/** Records the new document's source after the edits (R-85 C). */
function remember(newDoc: Node, edits: readonly TextEdit[], placements: readonly Placement[], source: string, info: NonNullable<ReturnType<typeof sourceOf>>): void {
  let text = '';
  let cursor = 0;
  const editStart = new Map<TextEdit, number>();
  for (const edit of edits) {
    text += source.slice(cursor, edit.from);
    editStart.set(edit, text.length);
    text += edit.text;
    cursor = edit.to;
  }
  text += source.slice(cursor);

  // Old positions move by the size change of every edit that ends at or before them.
  const shift = (pos: number): number => {
    let delta = 0;
    for (const edit of edits) if (edit.to <= pos) delta += edit.text.length - (edit.to - edit.from);
    return pos + delta;
  };
  const blocks = placements.map((placement): BlockRange => {
    if (placement.kind === 'old') return { from: shift(placement.range.from), to: shift(placement.range.from) + (placement.range.to - placement.range.from) };
    const start = editStart.get(placement.edit)! + placement.offset;
    return { from: start, to: start + placement.length };
  });
  recordSource(newDoc, { ...info, text, blocks });
}
