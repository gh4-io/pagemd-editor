// P18 (R-229): a matched SECTION_START … SECTION_END pair (and COVER's) is drawn as pagemd draws it, a box around its blocks, and
// stays invisible to saving: an edit inside a section rewrites only that one block (ADR-0007), a document nobody edited is written
// back byte for byte, and deleting a marker removes its box and only that marker's line. The brochure from the user's examples
// (test/e2e/fixtures/print-fidelity) is the document.
import { readFileSync } from 'node:fs';
import { EditorState, TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { groupsPlugin, isTransparent, topBlocks, type GroupRule } from '@pagemd-editor/core';
import { applyEdits, diffToEdits } from '@pagemd-editor/lossless';
import { sourceOf } from '@pagemd-editor/transformer';
import { pagemdItems, SECTION_BOX } from '../src/index.ts';
import { transformerFor } from './corpus-files.ts';

const BROCHURE = readFileSync(new URL('../../../test/e2e/fixtures/print-fidelity/brochure-uofo/uofo-company-overview-brochure.md', import.meta.url), 'utf8');
const rules: GroupRule[] = pagemdItems().flatMap((item) => item.groups ?? []);
const t = transformerFor(BROCHURE);
const stateOf = (text: string) => EditorState.create({ doc: t.parse(text), plugins: [groupsPlugin(rules)] });
const boxes = (state: EditorState) => {
  const out: string[] = [];
  state.doc.descendants((node) => {
    if (isTransparent(node)) out.push(`${node.attrs['kind']}:${node.attrs['className']}`);
    return true;
  });
  return out;
};

describe('SECTION and COVER boxes', () => {
  it('the brochure reads as three boxes with their classes; the blocks and their ranges are the ones without boxes', () => {
    const doc = t.parse(BROCHURE);
    expect(boxes(stateOf(BROCHURE))).toEqual(['section:panel panel-1', 'section:panel panel-2', 'section:panel panel-3']);
    expect(sourceOf(doc)!.blocks).toHaveLength(topBlocks(doc).length);
    expect(t.serialize(doc)).toBe(BROCHURE.replace(/\n+$/, '')); // a fresh write writes the blocks, not the boxes
  });

  it("is drawn as pagemd's element: <div id class> (a cover: <div class=\"cover\">)", () => {
    const text = '<!-- ::SECTION_START class="panel panel-1" id="p1" -->\n\nText\n\n<!-- ::SECTION_END -->\n\n<!-- ::COVER_START -->\n\nCover\n\n<!-- ::COVER_END -->\n';
    const doc = t.parse(text);
    const box = (i: number) => {
      const spec = t.schema.nodes[SECTION_BOX]!.spec.toDOM!(doc.child(i)) as [string, Record<string, string | null>];
      return [spec[0], spec[1]];
    };
    expect(box(0)).toEqual(['div', { class: 'panel panel-1', id: 'p1', 'data-pmd-box': 'section' }]);
    expect(box(1)).toEqual(['div', { class: 'cover', id: null, 'data-pmd-box': 'cover' }]);
  });

  it('typing inside a section saves only that paragraph', () => {
    let state = stateOf(BROCHURE);
    const para = topBlocks(state.doc).find((b) => b.node.textContent.startsWith('Uncertified Organic Farmers Org grows'))!;
    state = state.apply(state.tr.insertText(' Since 1998.', para.pos + para.node.nodeSize - 1));
    const edits = diffToEdits(t.parse(BROCHURE), state.doc, BROCHURE);
    expect(edits).toHaveLength(1);
    const range = sourceOf(t.parse(BROCHURE))!.blocks[topBlocks(state.doc).findIndex((b) => b.node.textContent.includes('Since 1998'))]!;
    expect(edits[0]!.from).toBeGreaterThanOrEqual(range.from);
    expect(edits[0]!.to).toBeLessThanOrEqual(range.to);
    expect(applyEdits(BROCHURE, edits)).toBe(BROCHURE.replace('than value.', 'than value. Since 1998.'));
  });

  it("deleting a section's start marker takes its box away and changes only that marker's line; the cursor stays in its text", () => {
    const original = t.parse(BROCHURE);
    let state = EditorState.create({ doc: original, plugins: [groupsPlugin(rules)] });
    const what = topBlocks(state.doc).find((b) => b.node.textContent === 'What We Do')!;
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, what.pos + 3)));
    const marker = topBlocks(state.doc).filter((b) => b.node.type.name === 'pmd_section')[2]!; // panel 2's start
    state = state.apply(state.tr.delete(marker.pos, marker.pos + marker.node.nodeSize));
    // panel 2's end now closes panel 1? No: panel 1 was closed by its own end; panel 2's end has nothing open and stays a block.
    expect(boxes(state)).toEqual(['section:panel panel-1', 'section:panel panel-3']);
    expect(state.doc.textBetween(state.selection.head - 2, state.selection.head)).toBe('Wh');
    const saved = applyEdits(BROCHURE, diffToEdits(original, state.doc, BROCHURE));
    expect(saved).toBe(BROCHURE.replace('<!-- ::SECTION_START class="panel panel-2" -->\n\n', ''));
  });

  it('a document nobody edited is saved as it was, also after the boxes were made again', () => {
    const original = t.parse(BROCHURE);
    const state = EditorState.create({ doc: original, plugins: [groupsPlugin(rules)] });
    expect(diffToEdits(original, state.doc, BROCHURE)).toEqual([]);
  });
});
