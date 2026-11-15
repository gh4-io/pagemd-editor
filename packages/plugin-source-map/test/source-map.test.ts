// P9 acceptance: "Split cursor sync stays within the same block". Over the golden corpus (plain files, this repo's docs)
// and pagemd's corpus: every canvas position maps to an offset inside its own block's source range, every offset in a
// block's range maps to a position inside that same block on the canvas, and a cursor before a text character comes back
// to the same place.
import type { Node } from 'prosemirror-model';
import { topBlocks } from '@pagemd-editor/core';
import { describe, expect, it } from 'vitest';
import { sourceOf } from '@pagemd-editor/transformer';
import { corpus, transformerFor } from '../../preset-pagemd/test/corpus-files.ts';
import { docsFiles, hasDocs, plainFiles } from '../../../test/corpus/sources.ts';
import { blockAtOffset, blockAtPos, blockStart, offsetToPos, posToOffset } from '../src/index.ts';

const files = [...plainFiles, ...docsFiles, ...corpus];

/** Up to `max` values from `all`, spread out. */
function spread<T>(all: T[], max: number): T[] {
  if (all.length <= max) return all;
  return Array.from({ length: max }, (_, i) => all[Math.floor((i * all.length) / max)]!);
}

/** Positions before a text character, per top-level block. */
function textPositions(doc: Node): number[] {
  const out: number[] = [];
  doc.descendants((node, pos) => {
    if (node.isText) for (let i = 0; i < (node.text ?? '').length; i++) out.push(pos + i);
    return true;
  });
  return out;
}

describe('the source map stays within the same block', () => {
  // The private docs/ add about 200 files; a public copy has none (AD-SAN0-13), and its plain files plus pagemd's corpus are 97 (AD-SAN3-04).
  it('has a corpus', () => expect(files.length).toBeGreaterThan(hasDocs ? 100 : 90));

  it.each(files.map((f) => [f.name, f] as const))('%s', (_name, file) => {
    const doc = transformerFor(file.text).parse(file.text);
    const source = sourceOf(doc)!;
    if (doc.childCount === 0) return;
    // Canvas → text: every sampled position (all kinds: block starts, inside, ends) lands in its own block's range.
    const positions = spread(Array.from({ length: doc.content.size + 1 }, (_, i) => i), 400);
    for (const pos of positions) {
      const { index } = blockAtPos(doc, pos);
      const offset = posToOffset(doc, source, pos);
      const range = source.blocks[index]!;
      expect(offset, `pos ${pos} in block ${index}`).toBeGreaterThanOrEqual(range.from);
      expect(offset, `pos ${pos} in block ${index}`).toBeLessThanOrEqual(range.to);
      expect(blockAtOffset(source, offset)).toBe(index);
    }
    // Text → canvas: every sampled offset inside a block's range lands inside that block.
    for (const [index, range] of source.blocks.entries()) {
      const start = blockStart(doc, index);
      const end = start + topBlocks(doc)[index]!.node.nodeSize; // (P18: a SECTION's box is looked through, as the ranges are)
      for (const offset of spread(Array.from({ length: range.to - range.from + 1 }, (_, i) => range.from + i), 12)) {
        const pos = offsetToPos(doc, source, offset);
        expect(pos, `offset ${offset} in block ${index}`).toBeGreaterThanOrEqual(start);
        expect(pos, `offset ${offset} in block ${index}`).toBeLessThanOrEqual(end);
      }
    }
    // A cursor before a text character found in the source (not one the reader made up, like a typographic quote)
    // comes back to the same place.
    for (const pos of spread(textPositions(doc), 200)) {
      const offset = posToOffset(doc, source, pos);
      if (offset >= source.blocks[blockAtPos(doc, pos).index]!.to || source.text[offset] !== doc.textBetween(pos, pos + 1)) continue;
      expect(offsetToPos(doc, source, offset)).toBe(pos);
    }
  });

  it('points at the character itself, past the markup', () => {
    const text = '# Title\n\nSome **bold** and [a link](https://x.org) here.\n';
    const doc = transformerFor(text).parse(text);
    const source = sourceOf(doc)!;
    const at = (word: string): number => {
      let found = -1;
      doc.descendants((node, pos) => {
        if (found < 0 && node.isText && node.text!.includes(word)) found = pos + node.text!.indexOf(word);
        return found < 0;
      });
      return found;
    };
    expect(posToOffset(doc, source, at('bold'))).toBe(text.indexOf('bold'));
    expect(posToOffset(doc, source, at('a link'))).toBe(text.indexOf('a link'));
    expect(posToOffset(doc, source, at('here'))).toBe(text.indexOf('here'));
    expect(offsetToPos(doc, source, text.indexOf('here'))).toBe(at('here'));
    // An offset in the `](https://…)` markup goes to the next shown character.
    expect(offsetToPos(doc, source, text.indexOf('https'))).toBe(at(' here'));
    // The blank line between the blocks belongs to the block above.
    expect(blockAtOffset(source, text.indexOf('\n\n') + 1)).toBe(0);
  });
});
