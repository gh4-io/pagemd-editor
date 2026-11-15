// P18 (R-229): groups, boxes around the blocks between two markers, transparent for the block ranges. A small schema of its own:
// `open`/`close` blocks are the markers; pagemd's SECTION/COVER use the same code (packages/preset-pagemd/test/sections.test.ts).
import { Schema, type Node } from 'prosemirror-model';
import { EditorState, NodeSelection, TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { flattenGroups, groupBlocks, groupsPlugin, isTransparent, regroup, topBlocks, type GroupRule } from '../src/index.ts';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'text*' },
    open: { group: 'block', atom: true, attrs: { name: { default: '' } } },
    close: { group: 'block', atom: true },
    box: { group: 'block', content: 'block+', transparent: true, attrs: { name: { default: '' } } },
    text: {},
  },
});
const p = (text: string) => schema.node('paragraph', null, text ? schema.text(text) : undefined);
const open = (name: string) => schema.node('open', { name });
const close = () => schema.node('close');
const rules: GroupRule[] = [{ node: 'box', opens: (b) => (b.type.name === 'open' ? { name: b.attrs['name'] } : null), closes: (b) => b.type.name === 'close' }];

/** A readable shape: `[name: …]` for a box, the text or the type for a block. */
const shape = (nodes: readonly Node[]): string =>
  nodes.map((n) => (isTransparent(n) ? `[${n.attrs['name']}: ${shape(children(n))}]` : n.type.name === 'paragraph' ? n.textContent : n.type.name)).join(' ');
const children = (n: Node): Node[] => {
  const out: Node[] = [];
  n.forEach((c) => out.push(c));
  return out;
};

describe('groupBlocks', () => {
  it('puts a box around a matched pair, the markers inside it', () => {
    expect(shape(groupBlocks([p('a'), open('x'), p('b'), close(), p('c')], rules, schema))).toBe('a [x: open b close] c');
  });
  it('nests; an end closes the innermost box', () => {
    expect(shape(groupBlocks([open('x'), open('y'), p('b'), close(), p('c'), close()], rules, schema))).toBe('[x: open [y: open b close] c close]');
  });
  it('a start nobody closes runs to the end; an end with nothing open is an ordinary block', () => {
    expect(shape(groupBlocks([close(), p('a'), open('x'), p('b')], rules, schema))).toBe('close a [x: open b]');
  });
  it('no rules: the blocks as they are', () => {
    expect(shape(groupBlocks([open('x'), p('b'), close()], [], schema))).toBe('open b close');
  });
});

describe('topBlocks and regroup', () => {
  const doc = schema.node('doc', null, groupBlocks([p('a'), open('x'), p('b'), open('y'), p('c'), close(), close(), p('d')], rules, schema));

  it('topBlocks opens every box: the blocks in order, each with its position', () => {
    const blocks = topBlocks(doc);
    expect(blocks.map((b) => (b.node.type.name === 'paragraph' ? b.node.textContent : b.node.type.name))).toEqual(['a', 'open', 'b', 'open', 'c', 'close', 'close', 'd']);
    for (const b of blocks) expect(doc.nodeAt(b.pos)).toBe(b.node);
    expect(flattenGroups(children(doc))).toEqual(blocks.map((b) => b.node));
  });

  it('regroup gives the same document when the boxes match the markers, and the same blocks when they do not', () => {
    expect(regroup(doc, rules)).toBe(doc);
    const flat = schema.node('doc', null, flattenGroups(children(doc)));
    const again = regroup(flat, rules);
    expect(again.eq(doc)).toBe(true);
    expect(topBlocks(again).map((b) => b.node)).toEqual(topBlocks(flat).map((b) => b.node)); // the very same block objects
  });
});

describe('groupsPlugin', () => {
  const start = () => {
    const doc = schema.node('doc', null, groupBlocks([p('a'), open('x'), p('b'), close(), p('c')], rules, schema));
    return EditorState.create({ doc, plugins: [groupsPlugin(rules)] });
  };

  it('a deleted start marker takes its box away, in the same change; the cursor stays on the same text', () => {
    let state = start();
    const b = topBlocks(state.doc).find((x) => x.node.textContent === 'b')!;
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, b.pos + 2)));
    const marker = topBlocks(state.doc).find((x) => x.node.type.name === 'open')!;
    const result = state.applyTransaction(state.tr.delete(marker.pos, marker.pos + marker.node.nodeSize));
    expect(result.transactions).toHaveLength(2); // the edit and the plugin's own
    const next = result.state;
    expect(shape(children(next.doc))).toBe('a b close c');
    const nowB = topBlocks(next.doc).find((x) => x.node.textContent === 'b')!;
    expect(next.selection.head).toBe(nowB.pos + 2);
  });

  it('a new pair gets its box; a selected marker stays selected', () => {
    let state = start();
    const c = topBlocks(state.doc).find((x) => x.node.textContent === 'c')!;
    state = state.apply(state.tr.insert(c.pos + c.node.nodeSize, [close()]).insert(c.pos, [open('z')]));
    expect(shape(children(state.doc))).toBe('a [x: open b close] [z: open c close]');
    const z = topBlocks(state.doc).filter((x) => x.node.type.name === 'open')[1]!;
    state = state.apply(state.tr.setSelection(NodeSelection.create(state.doc, z.pos)));
    expect((state.selection as NodeSelection).node.attrs['name']).toBe('z');
  });

  it('typing inside a paragraph is never looked at again (no second transaction)', () => {
    const state = start();
    const b = topBlocks(state.doc).find((x) => x.node.textContent === 'b')!;
    const result = state.applyTransaction(state.tr.insertText('!', b.pos + 2));
    expect(result.transactions).toHaveLength(1);
    expect(shape(children(result.state.doc))).toBe('a [x: open b! close] c');
  });
});
