// FIX-PGF (item 2d, AD-FIX-PGF-08), moved into the tools by P27 (R-248, amendment 1: no Convert buttons): a picture in the middle of a
// sentence that a tool makes a block of (Add shape → an annotated image; Crop, Rotate, Flip → a FIGURE). Word keeps such a picture in
// line; a pagemd figure is a block, so the picture is put on a paragraph of its own first (Word's "Top and bottom" wrapping: the text
// before and after become their own paragraphs), then made a block, all in ONE transaction (one undo step).
import { EditorState, NodeSelection, type Transaction } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { commonmarkItems } from '@pagemd-editor/preset-commonmark';
import { gfmItems } from '@pagemd-editor/preset-gfm';
import { createTransformer } from '@pagemd-editor/transformer';
import { addShapeTransaction, asBlock, blockReason, canAnnotate, editableTarget, pagemdItems, pictureTarget, toFigure, turnTransaction } from '../src/index.ts';
import { setFigureStyle } from '../src/index.ts';
setFigureStyle('native'); // these tests are about the picture tools, in the native style; the readable default has its own tests (readable-figures.test.ts)

const items = [...commonmarkItems, ...gfmItems, ...pagemdItems({})];
const t = createTransformer(items);

function selectFirst(text: string, name: string): EditorState {
  const doc = t.parse(text);
  let at = -1;
  doc.descendants((node, pos) => {
    if (at < 0 && node.type.name === name) at = pos;
    return at < 0;
  });
  if (at < 0) throw new Error(`no ${name} in ${text}`);
  const state = EditorState.create({ schema: t.schema, doc });
  return state.apply(state.tr.setSelection(NodeSelection.create(doc, at)));
}

/** Applies `tr` and returns what is written; the result reads back as written and the new block is selected. */
function written(state: EditorState, tr: Transaction | null | undefined, block: string): string {
  if (!tr) throw new Error('nothing made');
  const next = state.apply(tr);
  expect(next.selection instanceof NodeSelection && next.selection.node.type.name === block).toBe(true);
  const text = t.serialize(next.doc);
  expect(t.serialize(t.parse(text))).toBe(text);
  return text;
}

/** The first `name` of `text` made a FIGURE (Caption's, Size's and the Edit picture tools' way). */
const figure = (text: string, name: string): string => {
  const state = selectFirst(text, name);
  return written(state, asBlock(state, pictureTarget(state)!, 'pmd_figure', (s, target) => toFigure(s, target))?.tr, 'pmd_figure');
};

describe('a picture in the middle of a sentence is put on its own line first (FIX-PGF, P27 amendment 1)', () => {
  it('splits the paragraph around the picture: text before, the figure, text after (the spaces at the cut go)', () => {
    expect(figure('Before the ![chart](a.png) and after.\n', 'image')).toBe('Before the\n\n<!-- ::FIGURE src="a.png" alt="chart" -->\n\nand after.');
  });

  it('at the start or the end of the paragraph: two blocks, not three', () => {
    expect(figure('![chart](a.png) then text.\n', 'image')).toBe('<!-- ::FIGURE src="a.png" alt="chart" -->\n\nthen text.');
    expect(figure('Text, then ![chart](a.png)\n', 'image')).toBe('Text, then\n\n<!-- ::FIGURE src="a.png" alt="chart" -->');
  });

  it('an embed in a sentence; Rotate right (a FIGURE, turned) and Add marker (an annotated image) do the same', () => {
    expect(figure('See ![[a.png]] here.\n', 'pmd_embed')).toBe('See\n\n<!-- ::FIGURE src="a.png" -->\n\nhere.');
    const turned = selectFirst('Before ![chart](a.png) after.\n', 'image');
    expect(written(turned, turnTransaction(turned, { kind: 'rotate', turn: 'right' })?.tr, 'pmd_figure')).toBe('Before\n\n<!-- ::FIGURE src="a.png" alt="chart" rotate="90" -->\n\nafter.');
    const marked = selectFirst('Before ![chart](a.png) after.\n', 'image');
    expect(written(marked, addShapeTransaction(marked, 'markers'), 'pmd_annotated_image')).toBe(
      'Before\n\n::: annotated-image a.png\noptions:\n  alt: "chart"\nmarkers:\n  - { id: 1, x: 50, y: 50, label: "Marker 1" }\n:::\n\nafter.',
    );
  });

  it("the paragraph's own {…} attributes stay on the text before; its #id only there", () => {
    expect(figure('Before ![c](a.png) after. {.note #p1}\n', 'image')).toBe('Before {.note #p1}\n\n<!-- ::FIGURE src="a.png" alt="c" -->\n\nafter. {.note}');
  });

  it('it is one transaction: one undo step takes the split and the new block back', () => {
    const text = 'Before the ![chart](a.png) and after.\n';
    const state = selectFirst(text, 'image');
    const tr = addShapeTransaction(state, 'markers')!;
    const next = state.apply(tr);
    // inverting the one transaction's steps gives the original document back
    let doc = next.doc;
    for (let i = tr.steps.length - 1; i >= 0; i--) doc = tr.steps[i]!.invert(tr.docs[i]!).apply(doc).doc!;
    expect(t.serialize(doc)).toBe(text.trimEnd());
  });

  it('stays off, with the reason, in a table cell and in a heading', () => {
    for (const [text, why] of [
      ['| a |\n| --- |\n| x ![c](a.png) y |\n', /table cell/],
      ['# Title ![c](a.png) here\n', /heading/],
    ] as const) {
      const state = selectFirst(text, 'image');
      expect(canAnnotate(state), text).toBe(false);
      expect(editableTarget(state), text).toBeNull();
      expect(addShapeTransaction(state, 'markers'), text).toBeNull();
      expect(turnTransaction(state, { kind: 'flip', axis: 'horizontal' }), text).toBeNull();
      expect(blockReason(state), text).toMatch(why);
    }
  });
});
