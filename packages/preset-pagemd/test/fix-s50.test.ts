// Fix run, session 50: Caption on a picture in the middle of a sentence (put on its own line, then a figure, one transaction); the first
// heading can be hidden (`hide_first_h1`); a drag draws a shape (the entry it makes).
import { EditorState, NodeSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { commonmarkItems } from '@pagemd-editor/preset-commonmark';
import { gfmItems } from '@pagemd-editor/preset-gfm';
import { createTransformer } from '@pagemd-editor/transformer';
import { firstHeadingKey } from '../src/document/first-heading.ts';
import { captionFigure, drawnEntry, firstHeadingPlugin, hideFirstH1, pagemdItems, pictureField } from '../src/index.ts';
import { setFigureStyle } from '../src/index.ts';
setFigureStyle('native'); // these tests are about the picture tools, in the native style; the readable default has its own tests (readable-figures.test.ts)

const t = createTransformer([...commonmarkItems, ...gfmItems, ...pagemdItems({})]);

function selected(text: string, name: string): EditorState {
  const doc = t.parse(text);
  let at = -1;
  doc.descendants((node, pos) => {
    if (at < 0 && node.type.name === name) at = pos;
    return at < 0;
  });
  const state = EditorState.create({ schema: t.schema, doc });
  return state.apply(state.tr.setSelection(NodeSelection.create(doc, at)));
}

describe('Caption on a picture in a sentence (issue 2)', () => {
  it('is on, and makes a figure on its own line in ONE transaction', () => {
    const state = selected('See ![Shot](a.png) here.\n', 'image');
    expect(pictureField(state, 'caption')).toBe('caption');
    const made = captionFigure(state)!;
    expect(made).not.toBeNull();
    const out = t.serialize(state.apply(made.tr).doc);
    expect(out).toMatch(/^See\n\n<!-- ::FIGURE src="a\.png"[^>]*-->\n\nhere\.$/);
  });
});

describe('the first heading (OQ-68)', () => {
  it('hide_first_h1 follows the properties (every spelling) over the profile default', () => {
    expect(hideFirstH1('# T\n')).toBe(false);
    for (const key of ['hide_first_h1', 'hide-first-h1', 'hideFirstH1']) expect(hideFirstH1(`---\n${key}: true\n---\n# T\n`), key).toBe(true);
    expect(hideFirstH1('# T\n', { hide_first_h1: true })).toBe(true);
    expect(hideFirstH1('---\nhide_first_h1: false\n---\n# T\n', { hide_first_h1: true })).toBe(false);
  });

  it('only the first level-1 heading is marked', () => {
    const plugin = firstHeadingPlugin();
    const doc = t.parse('Intro\n\n## Two\n\n# One\n\n# Another\n');
    const state = EditorState.create({ schema: t.schema, doc, plugins: [plugin] });
    const marked: string[] = [];
    firstHeadingKey.getState(state)!.find().forEach((d) => marked.push(doc.nodeAt(d.from)!.textContent));
    expect(marked).toEqual(['One']);
  });
});

describe('draw mode makes the entry from a drag (OQ-63)', () => {
  const arrow = { x1: 35, y1: 35, x2: 50, y2: 50 };
  const box = { x: 40, y: 40, width: 20, height: 20 };
  it('an arrow runs from where the drag started to where it ended', () => {
    expect(drawnEntry('arrows', arrow, { x: 10, y: 20 }, { x: 60, y: 80 })).toEqual({ x1: 10, y1: 20, x2: 60, y2: 80 });
  });
  it('a box is the rectangle between the two corners, whichever way it was dragged', () => {
    expect(drawnEntry('boxes', box, { x: 60, y: 70 }, { x: 20, y: 30 })).toEqual({ x: 20, y: 30, width: 40, height: 40 });
  });
  it('a click places the usual shape around the point', () => {
    expect(drawnEntry('boxes', box, { x: 30, y: 30 }, null)).toEqual({ x: 20, y: 20, width: 20, height: 20 });
  });
});
