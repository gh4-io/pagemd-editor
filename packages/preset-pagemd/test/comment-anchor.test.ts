// P12 (R-179): the review-comment anchor. It reads as its own node (not a generic directive), writes back byte for byte,
// a new one adds exactly one line (no blank line after it) and removing it takes exactly that line away.
import { EditorState, NodeSelection, TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { RAW_BLOCK } from '@pagemd-editor/core';
import { applyEdits, diffToEdits } from '@pagemd-editor/lossless';
import { commonmarkItems } from '@pagemd-editor/preset-commonmark';
import { gfmItems } from '@pagemd-editor/preset-gfm';
import { createTransformer } from '@pagemd-editor/transformer';
import { COMMENT_NODE, commentAnchors, commentedBlock, insertCommentAnchor, removeCommentAnchor, pagemdItems } from '../src/index.ts';

const t = createTransformer([...commonmarkItems, ...gfmItems, ...pagemdItems({})]);
const stateFor = (text: string, pos: number): EditorState => {
  const doc = t.parse(text);
  return EditorState.create({ doc, schema: t.schema, selection: TextSelection.near(doc.resolve(pos)) });
};
/** Saves `next` against the state's document the way the editor does. */
const save = (state: EditorState, source: string, tr: ReturnType<typeof insertCommentAnchor>) => {
  const next = state.apply(tr!);
  const text = applyEdits(source, diffToEdits(state.doc, next.doc, source));
  return { next, text };
};

const SOURCE = '# Title\n\nFirst paragraph.\n\n- one\n- two\n\nLast.\n';

describe('comment anchors', () => {
  it('read as their own node, not a raw block or a generic directive, and write back unchanged', () => {
    const text = '# T\n\n<!-- ::COMMENT id="c7" -->\nCommented.\n\nAfter a blank line:\n\n<!-- ::COMMENT id="c8" -->\n\nNext.\n';
    const doc = t.parse(text);
    const names: string[] = [];
    doc.forEach((n) => names.push(n.type.name));
    expect(names).toEqual(['heading', COMMENT_NODE, 'paragraph', 'paragraph', COMMENT_NODE, 'paragraph']);
    expect(names).not.toContain(RAW_BLOCK);
    expect(commentAnchors(doc).map((a) => [a.id, a.inline])).toEqual([['c7', false], ['c8', false]]);
    expect(applyEdits(text, diffToEdits(doc, doc, text))).toBe(text);
  });
  it('an anchor inside a line of text is found too (inline), and an id-less COMMENT is no anchor', () => {
    const doc = t.parse('Some <!-- ::COMMENT id="c1" --> text.\n\n<!-- ::COMMENT -->\n');
    expect(commentAnchors(doc).map((a) => [a.id, a.inline])).toEqual([['c1', true]]);
  });
  it('a new anchor adds exactly one line, directly above the block that holds the cursor', () => {
    const state = stateFor(SOURCE, 12); // in "First paragraph."
    const { text } = save(state, SOURCE, insertCommentAnchor(state, 'c1'));
    expect(text).toBe('# Title\n\n<!-- ::COMMENT id="c1" -->\nFirst paragraph.\n\n- one\n- two\n\nLast.\n');
    expect(text.split('\n').length - SOURCE.split('\n').length).toBe(1);
  });
  it('anchors a list as one block, the first block of the document, and stacks above an existing anchor', () => {
    let state = stateFor(SOURCE, state0(SOURCE, 'two'));
    let source = SOURCE;
    ({ next: state, text: source } = save(state, source, insertCommentAnchor(state, 'c1')));
    expect(source).toBe('# Title\n\nFirst paragraph.\n\n<!-- ::COMMENT id="c1" -->\n- one\n- two\n\nLast.\n');
    // a second comment on the same list goes between the first anchor and the list
    const again = t.parse(source);
    let s2 = EditorState.create({ doc: again, schema: t.schema, selection: TextSelection.near(again.resolve(state0(source, 'one'))) });
    ({ text: source } = save(s2, source, insertCommentAnchor(s2, 'c2')));
    expect(source).toBe('# Title\n\nFirst paragraph.\n\n<!-- ::COMMENT id="c1" -->\n<!-- ::COMMENT id="c2" -->\n- one\n- two\n\nLast.\n');
    const first = stateFor('Only block.\n', 2);
    expect(save(first, 'Only block.\n', insertCommentAnchor(first, 'c1')).text).toBe('<!-- ::COMMENT id="c1" -->\nOnly block.\n');
    s2 = first;
  });
  it('keeps the file\'s CRLF line endings', () => {
    const source = '# T\r\n\r\nPara.\r\n';
    const state = stateFor(source, 7);
    expect(save(state, source, insertCommentAnchor(state, 'c3')).text).toBe('# T\r\n\r\n<!-- ::COMMENT id="c3" -->\r\nPara.\r\n');
  });
  it('the saved text reads back as the same anchor above the same block', () => {
    const state = stateFor(SOURCE, 12);
    const { text } = save(state, SOURCE, insertCommentAnchor(state, 'c1'));
    const doc = t.parse(text);
    const [anchor] = commentAnchors(doc);
    expect(anchor!.id).toBe('c1');
    expect(commentedBlock(doc, anchor!)!.node.textContent).toBe('First paragraph.');
  });
  it('removing an anchor takes exactly its line away', () => {
    const source = '# T\n\n<!-- ::COMMENT id="c1" -->\nPara.\n\nEnd.\n';
    const state = stateFor(source, state0(source, 'Para'));
    const tr = removeCommentAnchor(state, 'c1')!;
    const next = state.apply(tr);
    expect(applyEdits(source, diffToEdits(state.doc, next.doc, source))).toBe('# T\n\nPara.\n\nEnd.\n');
    expect(removeCommentAnchor(next, 'c1')).toBeNull();
  });
  it('nothing is made in the frontmatter card', () => {
    const source = '---\ntitle: X\n---\n\nBody.\n';
    const doc = t.parse(source);
    const state = EditorState.create({ doc, schema: t.schema, selection: NodeSelection.create(doc, 0) });
    expect(state.doc.firstChild!.type.name).toBe('pmd_frontmatter');
    expect(insertCommentAnchor(state, 'c1')).toBeNull();
  });
});

/** The document position inside the text `word` of the state's source (a position in the first text node that has it). */
function state0(source: string, word: string): number {
  const doc = t.parse(source);
  let found = -1;
  doc.descendants((node, pos) => {
    if (found < 0 && node.isText && node.text!.includes(word)) found = pos + node.text!.indexOf(word) + 1;
    return found < 0;
  });
  return found;
}
