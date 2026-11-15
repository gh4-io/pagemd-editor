import { EditorState, TextSelection } from 'prosemirror-state';
import { Schema, type Node } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import { anchorsOf, commentsKey, commentsPlugin, findAnchors, quoteFor, threadAt } from '../src/index.ts';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] },
    anchor: { group: 'block', atom: true, attrs: { id: { default: '' } }, toDOM: () => ['div'] },
    note: { group: 'inline', inline: true, atom: true, attrs: { id: { default: '' } }, toDOM: () => ['span'] },
    text: { group: 'inline' },
  },
});
const anchorOf = (node: Node): string | null => (node.type.name === 'anchor' || node.type.name === 'note' ? (node.attrs['id'] as string) : null);
const p = (text: string, ...inline: Node[]): Node => schema.nodes['paragraph']!.create(null, [...(text ? [schema.text(text)] : []), ...inline]);
const anchor = (id: string): Node => schema.nodes['anchor']!.create({ id });
const doc = (...blocks: Node[]): Node => schema.nodes['doc']!.create(null, blocks);

describe('findAnchors', () => {
  it('a block anchor marks the next block that is not an anchor', () => {
    const d = doc(p('Intro'), anchor('c1'), anchor('c2'), p('Marked'), p('Other'));
    const anchors = findAnchors(d, anchorOf);
    expect(anchors.map((a) => [a.id, a.inline, d.textBetween(a.block!.from, a.block!.to)])).toEqual([['c1', false, 'Marked'], ['c2', false, 'Marked']]);
  });
  it('an anchor in a line of text marks that block', () => {
    const d = doc(p('Before'), p('Some ', schema.nodes['note']!.create({ id: 'c5' })));
    const [a] = findAnchors(d, anchorOf);
    expect(a).toMatchObject({ id: 'c5', inline: true });
    expect(d.textBetween(a!.block!.from, a!.block!.to)).toBe('Some ');
    expect(d.nodeAt(a!.pos)!.type.name).toBe('note');
  });
  it('an anchor with nothing below it marks nothing', () => {
    const [a] = findAnchors(doc(p('Only'), anchor('c1')), anchorOf);
    expect(a!.block).toBeNull();
  });
});

describe('commentsPlugin', () => {
  const plugin = (status: (id: string) => 'open' | 'resolved' | undefined = () => 'open') => commentsPlugin({ anchorOf, statusOf: status, onActivate: () => undefined });
  const state = (d: Node, p_ = plugin()) => EditorState.create({ doc: d, plugins: [p_] });

  it('tints the marked block, resolved ones differently, and the selected thread stronger', () => {
    const d = doc(anchor('c1'), p('One'), anchor('c2'), p('Two'));
    const s = state(d, plugin((id) => (id === 'c2' ? 'resolved' : 'open')));
    const classes = (st: EditorState) => commentsKey.getState(st)!.decorations.find().map((x) => (x as unknown as { type: { attrs: { class: string } } }).type.attrs.class);
    expect(classes(s)).toEqual(['pmd-commented', 'pmd-commented pmd-commented-resolved']);
    const active = s.apply(s.tr.setMeta(commentsKey, { active: 'c1' }));
    expect(classes(active)[0]).toBe('pmd-commented pmd-commented-active');
  });
  it('follows edits to the document', () => {
    const s = state(doc(p('One')));
    expect(anchorsOf(s)).toEqual([]);
    const next = s.apply(s.tr.insert(0, anchor('c1')));
    expect(anchorsOf(next).map((a) => a.id)).toEqual(['c1']);
  });
  it('threadAt: the thread whose block holds the position', () => {
    const d = doc(anchor('c1'), p('One'), p('Two'));
    const anchors = findAnchors(d, anchorOf);
    expect(threadAt(anchors, 3)).toBe('c1');
    expect(threadAt(anchors, d.content.size - 2)).toBeNull();
  });
});

describe('quoteFor', () => {
  it('the selected text, else the text of the block the cursor is in', () => {
    const d = doc(p('First block text'), p('Second block'));
    const base = EditorState.create({ doc: d });
    expect(quoteFor(base.apply(base.tr.setSelection(TextSelection.create(d, 3))))).toBe('First block text');
    expect(quoteFor(base.apply(base.tr.setSelection(TextSelection.create(d, 2, 7))))).toBe('irst');
  });
});
