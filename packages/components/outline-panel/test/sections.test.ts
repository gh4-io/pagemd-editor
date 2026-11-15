// P9 acceptance: "Reordering a section moves exactly those lines" (R-164). Over the golden corpus (plain files, this repo's
// docs) and pagemd's corpus, every section is moved up, down and to the end: the new text is the old text with exactly
// those lines moved (the blank lines between the two runs stay between them), and it reads back as the same blocks in
// the new order, each block's text unchanged.
import { describe, expect, it } from 'vitest';
import { commonmarkItems } from '@pagemd-editor/preset-commonmark';
import { gfmItems } from '@pagemd-editor/preset-gfm';
import { createRegistry, ItemRegistry, rawBlockItem, topBlocks, ViewState, type TextEdit } from '@pagemd-editor/core';
import { sourceOf, createTransformer } from '@pagemd-editor/transformer';
import { pagemdItems } from '@pagemd-editor/preset-pagemd';
import { corpus, transformerFor } from '../../../preset-pagemd/test/corpus-files.ts';
import { docsFiles, plainFiles } from '../../../../test/corpus/sources.ts';
import { dropTargets, moveDown, moveEdit, movedCleanly, moveUp, sectionHeads, sectionOf, swapRuns, type SectionMove } from '../src/sections.ts';

const registry = createRegistry({ items: new ItemRegistry([rawBlockItem, ...commonmarkItems, ...gfmItems, ...pagemdItems()]), view: new ViewState() });
const files = [...plainFiles, ...docsFiles, ...corpus];

const apply = (text: string, edit: TextEdit): string => text.slice(0, edit.from) + edit.text + text.slice(edit.to);
const lines = (text: string): string[] => text.split(/\r\n|\r|\n/);
/** The line a text offset sits on. */
const lineOf = (text: string, offset: number): number => lines(text.slice(0, offset)).length - 1;

/** What the lines must be: the old lines with run b's lines put before run a's, everything else in place. */
function expectedLines(text: string, blocks: readonly { from: number; to: number }[], move: SectionMove): string[] {
  const { a, b } = swapRuns(move)!;
  const all = lines(text);
  const a0 = lineOf(text, blocks[a.first]!.from);
  const a1 = lineOf(text, blocks[a.end - 1]!.to);
  const b0 = lineOf(text, blocks[b.first]!.from);
  const b1 = lineOf(text, blocks[b.end - 1]!.to);
  return [...all.slice(0, a0), ...all.slice(b0, b1 + 1), ...all.slice(a1 + 1, b0), ...all.slice(a0, a1 + 1), ...all.slice(b1 + 1)];
}

/** The moves to try in one file: each section up, down and to the end (spread over the file). */
function movesOf(file: { text: string }): { move: SectionMove; label: string }[] {
  const doc = transformerFor(file.text).parse(file.text);
  const heads = sectionHeads(doc, registry.outline(doc));
  const out: { move: SectionMove; label: string }[] = [];
  const pick = heads.length <= 12 ? heads : heads.filter((_, i) => i % Math.ceil(heads.length / 12) === 0);
  const count = topBlocks(doc).length; // (P18: blocks counted as the ranges count them, a SECTION's box looked through)
  for (const head of pick) {
    const up = moveUp(heads, head, count);
    const down = moveDown(heads, head, count);
    const section = sectionOf(heads, head, count);
    if (up) out.push({ move: up, label: `up ${head.entry.label}` });
    if (down) out.push({ move: down, label: `down ${head.entry.label}` });
    if (dropTargets(heads, section, count).includes(count)) out.push({ move: { section, before: count }, label: `end ${head.entry.label}` });
  }
  return out;
}

describe('moving a section moves exactly those lines', () => {
  const refused: string[] = [];
  const withSections = files.filter((f) => movesOf(f).length > 0);

  it('the corpus has sections to move', () => expect(withSections.length).toBeGreaterThan(60));

  it.each(withSections.map((f) => [f.name, f] as const))('%s', (_name, file) => {
    const t = transformerFor(file.text);
    const doc = t.parse(file.text);
    const source = sourceOf(doc)!;
    const blockTexts = source.blocks.map((r) => file.text.slice(r.from, r.to));
    for (const { move, label } of movesOf(file)) {
      const edit = moveEdit(file.text, source.blocks, move)!;
      expect(edit, label).not.toBeNull();
      const moved = apply(file.text, edit);
      // Exactly those lines moved.
      expect(lines(moved), label).toEqual(expectedLines(file.text, source.blocks, move));
      // It reads back as the same blocks, in the new order, each block's text unchanged; the one known exception is
      // refused by the app's safety check (a section moved below a fence never closed, which would swallow it).
      const { a, b } = swapRuns(move)!;
      const order = [...Array.from({ length: a.first }, (_, i) => i), ...range(b), ...range(a), ...Array.from({ length: blockTexts.length - b.end }, (_, i) => b.end + i)];
      const again = sourceOf(t.parse(moved))!;
      const after = again.blocks.map((r) => moved.slice(r.from, r.to));
      const clean = movedCleanly(blockTexts, after, move);
      if (clean) expect(after, label).toEqual(order.map((i) => blockTexts[i]));
      else refused.push(`${file.name}: ${label}`);
    }
  });

  it('the safety check refuses only moves below a fence the author never closed', () => {
    // That file ends inside a ```` ``` ```` fence it never closes: anything moved to its end would become code.
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.filter((r) => !r.startsWith('pagemd/docs/wiki/reference/Inline-Attributes.md: end '))).toEqual([]);
  });
});

const range = (run: { first: number; end: number }): number[] => Array.from({ length: run.end - run.first }, (_, i) => run.first + i);

describe('sections', () => {
  const text = ['Intro.', '', '# A', '', 'a text', '', '## A1', '', 'a1', '', '# B', 'b tight', '', '## B1', '', '# C', '', 'c', ''].join('\n');
  const t = createTransformer([...commonmarkItems, ...gfmItems, ...pagemdItems()]);
  const doc = t.parse(text);
  const heads = sectionHeads(doc, registry.outline(doc));
  const head = (label: string) => heads.find((h) => h.entry.label === label)!;
  const blocks = sourceOf(doc)!.blocks;

  it('a section is the heading plus everything up to the next heading of the same or a higher level', () => {
    expect(heads.map((h) => [h.entry.label, h.block, h.level])).toEqual([
      ['A', 1, 1],
      ['A1', 3, 2],
      ['B', 5, 1],
      ['B1', 7, 2],
      ['C', 8, 1],
    ]);
    expect(sectionOf(heads, head('A'), doc.childCount)).toEqual({ first: 1, end: 5 });
    expect(sectionOf(heads, head('A1'), doc.childCount)).toEqual({ first: 3, end: 5 });
    expect(sectionOf(heads, head('C'), doc.childCount)).toEqual({ first: 8, end: 10 });
  });

  it('Move up / Move down stay among siblings; the first and last can’t move further', () => {
    expect(moveUp(heads, head('A'), doc.childCount)).toBeNull();
    expect(moveUp(heads, head('A1'), doc.childCount)).toBeNull();
    expect(moveDown(heads, head('A1'), doc.childCount)).toBeNull();
    expect(moveDown(heads, head('C'), doc.childCount)).toBeNull();
    expect(moveUp(heads, head('B'), doc.childCount)).toEqual({ section: { first: 5, end: 8 }, before: 1 });
    expect(moveDown(heads, head('A'), doc.childCount)).toEqual({ section: { first: 1, end: 5 }, before: 8 });
  });

  it('B moved up: its lines (with its sub-section) go before A; the blank line between them stays', () => {
    const edit = moveEdit(text, blocks, moveUp(heads, head('B'), doc.childCount)!)!;
    expect(apply(text, edit)).toBe(['Intro.', '', '# B', 'b tight', '', '## B1', '', '# A', '', 'a text', '', '## A1', '', 'a1', '', '# C', '', 'c', ''].join('\n'));
  });

  it('drop places: other sections’ headings and the end, never inside itself or right after it', () => {
    expect(dropTargets(heads, sectionOf(heads, head('A'), doc.childCount), doc.childCount)).toEqual([7, 8, 10]);
    expect(dropTargets(heads, sectionOf(heads, head('C'), doc.childCount), doc.childCount)).toEqual([1, 3, 5, 7]);
    expect(moveEdit(text, blocks, { section: { first: 1, end: 5 }, before: 3 })).toBeNull();
    expect(moveEdit(text, blocks, { section: { first: 1, end: 5 }, before: 5 })).toBeNull();
  });

  it('content before the first heading, and headings inside a box, start no section', () => {
    const boxed = t.parse(':::note Box\n# Inside\n:::\n\n# Out\n');
    expect(sectionHeads(boxed, registry.outline(boxed)).map((h) => h.entry.label)).toEqual(['Out']);
  });
});
