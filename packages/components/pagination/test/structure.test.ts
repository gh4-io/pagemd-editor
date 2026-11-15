// P13b: typing must not walk the whole document. The pagination plugin keeps "structure" decorations (marker chips take no room, named
// pages change the width of the blocks after them). They depend on the blocks between paragraphs, not on the text in them, so a
// transaction that stays inside paragraphs only moves them (`staysInsideTextblocks`); anything structural works them out again.
// This test proves the two give the same decorations for edits of every kind on a document with markers and a named page.
import { Schema, type Node } from 'prosemirror-model';
import { EditorState, TextSelection, type Transaction } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import type { PageGeometry } from '@pagemd-editor/core';
import type { MarkerOf } from '../src/measure.ts';
import { staysInsideTextblocks, structureDecorations } from '../src/paginator.ts';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] },
    pagebreak: { group: 'block', atom: true, toDOM: () => ['hr'] },
    layout: { group: 'block', atom: true, attrs: { name: { default: 'wide' } }, toDOM: () => ['hr'] },
    text: { group: 'inline' },
  },
  marks: { strong: { toDOM: () => ['strong', 0] } },
});

const markerOf: MarkerOf = (node) => (node.type.name === 'pagebreak' ? { kind: 'pagebreak' } : node.type.name === 'layout' ? { kind: 'layout', name: node.attrs['name'] as string } : null);
const geometry = (width: number): PageGeometry => ({ width, height: 297, margins: { top: 25, right: 25, bottom: 25, left: 25 } });
const setup = { page: geometry(210), namedPages: { wide: geometry(297) } };

const p = (text: string) => schema.node('paragraph', null, text ? [schema.text(text)] : []);
const make = (): Node => schema.node('doc', null, [p('alpha beta'), schema.node('pagebreak'), p('gamma'), schema.node('layout'), p('delta'), p('epsilon zeta')]);
const at = (doc: Node, index: number) => {
  let pos = 0;
  for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize;
  return pos;
};
const found = (doc: Node, decorations: ReturnType<typeof structureDecorations>) => decorations.find().map((d) => [d.from, d.to, JSON.stringify((d as unknown as { type: { attrs: unknown } }).type.attrs)]).sort((a, b) => Number(a[0]) - Number(b[0]) || Number(a[1]) - Number(b[1]));

describe('staysInsideTextblocks', () => {
  const doc = make();
  const state = EditorState.create({ doc, schema });
  const cases: [string, (tr: Transaction) => Transaction, boolean][] = [
    ['typing in a paragraph', (tr) => tr.insertText('x', at(doc, 0) + 3), true],
    ['deleting inside a paragraph', (tr) => tr.delete(at(doc, 4) + 2, at(doc, 4) + 4), true],
    ['replacing a selected word', (tr) => tr.insertText('Q', at(doc, 5) + 1, at(doc, 5) + 8), true],
    ['adding a mark', (tr) => tr.addMark(at(doc, 2) + 1, at(doc, 2) + 4, schema.marks['strong']!.create()), true],
    ['typing in an empty paragraph', (tr) => tr.insertText('hi', at(doc, 0) + 1), true],
    ['Enter: splitting a paragraph', (tr) => tr.split(at(doc, 0) + 3), false],
    ['joining two paragraphs', (tr) => tr.join(at(doc, 5)), false],
    ['deleting a marker', (tr) => tr.delete(at(doc, 1), at(doc, 2)), false],
    ['inserting a marker', (tr) => tr.insert(at(doc, 2), schema.node('pagebreak')), false],
    ['changing a marker\'s attribute', (tr) => tr.setNodeMarkup(at(doc, 3), undefined, { name: 'other' }), false],
    ['deleting across blocks', (tr) => tr.delete(at(doc, 0) + 3, at(doc, 2) + 3), false],
  ];
  for (const [name, edit, inside] of cases) {
    it(`${name}: ${inside ? 'moved' : 'worked out again'}, and the decorations are the same either way`, () => {
      const tr = edit(state.tr);
      expect(tr.docChanged).toBe(true);
      expect(staysInsideTextblocks(tr, markerOf)).toBe(inside);
      const before = structureDecorations(doc, setup, markerOf);
      const moved = before.map(tr.mapping, tr.doc);
      const again = found(tr.doc, structureDecorations(tr.doc, setup, markerOf));
      if (inside) {
        expect(found(tr.doc, moved)).toEqual(again);
        expect(moved.find().length).toBeGreaterThan(0);
      } else if (/inserting a marker|attribute/.test(name)) {
        // the guard is needed: moving the old decorations would be wrong when a marker is added or changed
        expect(found(tr.doc, moved)).not.toEqual(again);
      }
    });
  }

  it('is false for a transaction with no step, and for a textblock that is itself a marker', () => {
    expect(staysInsideTextblocks(state.tr.setSelection(TextSelection.create(doc, 3)), markerOf)).toBe(false);
    const paragraphIsMarker: MarkerOf = (node) => (node.type.name === 'paragraph' && node.textContent === 'gamma' ? { kind: 'pagebreak' } : null);
    expect(staysInsideTextblocks(state.tr.insertText('x', at(doc, 2) + 2), paragraphIsMarker)).toBe(false);
  });
});
