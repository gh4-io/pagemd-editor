// P15 (ADR-0018, R-194): the image tools' document side. The shapes as data (move, resize, add, delete, renumber), the
// remaps after a turn or a flip (P27: keys, never pixels) for every kind of shape, the crop maths checked against pagemd's own
// rendered `object-view-box`, the conversions, and the save: a drag changes ONE entry's line of YAML (one diff hunk,
// lossless elsewhere, the author's YAML style kept). P27's own checks: picture-keys.test.ts.
import { createDialect } from '@pagemd/syntax';
import { EditorState, NodeSelection, TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { applyEdits, diffToEdits } from '@pagemd-editor/lossless';
import { commonmarkItems } from '@pagemd-editor/preset-commonmark';
import { gfmItems } from '@pagemd-editor/preset-gfm';
import { createTransformer } from '@pagemd-editor/transformer';
import {
  addShape,
  boundsOf,
  dragHandle,
  cropKeysFor,
  cropRectOf,
  mapPoint,
  moveEntry,
  nextLegendId,
  refOfField,
  remapAnnotations,
  renumberMarkers,
  round2,
  shapeLabel,
  tabOrder,
  withCrop,
  withEntry,
  withoutEntry,
  type AnnotationData,
  type Geometry,
} from '../src/media/image-tools/geometry.ts';
import { cropTransaction, pictureTarget, toAnnotated, toFigure } from '../src/media/image-tools/target.ts';
import { requestShape, SHAPE_REQUEST, shapeEditingKey, shapeEditingPlugin } from '../src/media/image-tools/plugin.ts';
import type { DecorationSet } from 'prosemirror-view';
import { pagemdItems } from '../src/index.ts';
import { setFigureStyle } from '../src/index.ts';
setFigureStyle('native'); // these tests are about the picture tools, in the native style; the readable default has its own tests (readable-figures.test.ts)
import { annotatedHtmlFor } from '../src/media/media.ts';

const t = createTransformer([...commonmarkItems, ...gfmItems, ...pagemdItems({})]);

/** `text` with the first node named `name` selected. */
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

/** The text after `next` is saved the way the editor saves (only changed blocks rewritten), and the edits made. */
function saved(state: EditorState, next: EditorState, source: string) {
  const edits = diffToEdits(state.doc, next.doc, source);
  return { text: applyEdits(source, edits), edits };
}

describe('shapes as data (D3, D4)', () => {
  it('a move keeps the shape inside the picture as a whole; numbers get two decimals; other keys and their order stay', () => {
    const marker = { id: 1, x: 10, y: 20, label: 'A', note: 'kept' };
    expect(moveEntry(marker, 'point', 5.555, -30)).toEqual({ id: 1, x: 15.56, y: 0, label: 'A', note: 'kept' });
    expect(Object.keys(moveEntry(marker, 'point', 1, 1))).toEqual(['id', 'x', 'y', 'label', 'note']);
    // a box stops at the edge without changing size
    expect(moveEntry({ x: 70, y: 0, width: 20, height: 10 }, 'rect', 50, 0)).toEqual({ x: 80, y: 0, width: 20, height: 10 });
    // an arrow moves both ends by the same amount, stopping when one end reaches the edge
    expect(moveEntry({ x1: 10, y1: 10, x2: 90, y2: 50 }, 'segment', 20, 0)).toEqual({ x1: 20, y1: 10, x2: 100, y2: 50 });
  });
  it('handles: an end point moves alone; a corner moves with the opposite corner fixed, never smaller than 0.5 %', () => {
    expect(dragHandle({ x1: 10, y1: 10, x2: 50, y2: 50 }, 'segment', 'end', 70, 120)).toEqual({ x1: 10, y1: 10, x2: 70, y2: 100 });
    expect(dragHandle({ x: 10, y: 10, width: 20, height: 20 }, 'rect', 'se', 50, 60)).toEqual({ x: 10, y: 10, width: 40, height: 50 });
    // dragged past the fixed corner: the box turns round, still a proper box
    expect(dragHandle({ x: 10, y: 10, width: 20, height: 20 }, 'rect', 'nw', 40, 40)).toEqual({ x: 30, y: 30, width: 10, height: 10 });
    expect(dragHandle({ x: 10, y: 10, width: 20, height: 20 }, 'rect', 'se', 10, 10)).toEqual({ x: 10, y: 10, width: 0.5, height: 0.5 });
  });
  it('add, delete, the next legend number, labels, Tab order, Inspector paths', () => {
    const data: AnnotationData = { markers: [{ id: 1, x: 1, y: 1, label: 'a' }], boxes: [{ id: '7', x: 1, y: 1, width: 1, height: 1, label: 'b' }] };
    expect(nextLegendId(data)).toBe(8);
    const added = addShape(data, 'markers');
    expect(added.ref).toEqual({ list: 'markers', index: 1 });
    expect((added.data['markers'] as unknown[])[1]).toEqual({ id: 8, x: 50, y: 50, label: 'Marker 8' });
    expect(withoutEntry(added.data, { list: 'markers', index: 0 })['markers']).toEqual([{ id: 8, x: 50, y: 50, label: 'Marker 8' }]);
    expect(withoutEntry(data, { list: 'markers', index: 0 })['markers']).toEqual([]);
    expect(shapeLabel({ list: 'boxes', index: 0 }, { id: '7', label: 'b' })).toBe('Box 7 (b)');
    expect(shapeLabel({ list: 'text', index: 2 }, { text: 'Hi' })).toBe('Text note 3 (Hi)');
    expect(tabOrder({ ...data, text: [{ x: 1 }] })).toEqual([{ list: 'markers', index: 0 }, { list: 'boxes', index: 0 }]); // a text note without y can't be placed
    expect(refOfField('arrows.3.x1')).toEqual({ list: 'arrows', index: 3 });
    expect(refOfField('options.caption')).toBeNull();
    expect(withEntry(data, { list: 'boxes', index: 0 }, { x: 2 })['markers']).toBe(data['markers']); // other lists: the same objects
  });
  it('renumbers markers in reading order (bands of 5 % of the height), changing only ids that differ; null when in order', () => {
    const data: AnnotationData = { markers: [{ id: 1, x: 50, y: 30, label: 'b' }, { id: 2, x: 10, y: 31, label: 'a' }, { id: 3, x: 5, y: 80, label: 'c' }, { id: 9, label: 'no position' }] };
    const next = renumberMarkers(data)!;
    expect((next['markers'] as { id: unknown }[]).map((m) => m.id)).toEqual([2, 1, 3, 9]);
    expect((next['markers'] as unknown[])[2]).toBe((data['markers'] as unknown[])[2]); // unchanged entries are the same objects
    expect(renumberMarkers(next)).toBeNull();
  });
});

describe('moving the shapes with the picture: a turn or a flip of the picture as shown (P27, R-249)', () => {
  const rotateRight: Geometry = { kind: 'rotate', turn: 'right' };
  const rotateLeft: Geometry = { kind: 'rotate', turn: 'left' };
  it('a point follows its pixel: a quarter turn clockwise puts the top-left corner top-right; a flip mirrors it', () => {
    expect(mapPoint(rotateRight, 0, 0)).toEqual({ x: 100, y: 0 });
    expect(mapPoint(rotateRight, 10, 20)).toEqual({ x: 80, y: 10 });
    expect(mapPoint(rotateLeft, 10, 20)).toEqual({ x: 20, y: 90 });
    expect(mapPoint({ kind: 'flip', axis: 'horizontal' }, 10, 20)).toEqual({ x: 90, y: 20 });
    expect(mapPoint({ kind: 'flip', axis: 'vertical' }, 10, 20)).toEqual({ x: 10, y: 80 });
  });
  it('every kind of shape after a turn: points, end points and boxes (width and height swap)', () => {
    const data: AnnotationData = {
      markers: [{ id: 1, x: 10, y: 20, label: 'm' }],
      text: [{ x: 5, y: 5, text: 't' }],
      arrows: [{ x1: 10, y1: 10, x2: 30, y2: 50 }],
      lines: [{ x1: 0, y1: 0, x2: 100, y2: 0 }],
      boxes: [{ x: 10, y: 20, width: 30, height: 10, label: 'kept' }],
      ellipses: [{ x: 0, y: 0, width: 50, height: 25 }],
      highlights: [{ x: 50, y: 50, width: 50, height: 50 }],
      redact: [{ x: 0, y: 0, width: 10, height: 20 }],
    };
    const out = remapAnnotations(data, rotateRight);
    expect(out['markers']).toEqual([{ id: 1, x: 80, y: 10, label: 'm' }]);
    expect(out['text']).toEqual([{ x: 95, y: 5, text: 't' }]);
    expect(out['arrows']).toEqual([{ x1: 90, y1: 10, x2: 50, y2: 30 }]);
    expect(out['lines']).toEqual([{ x1: 100, y1: 0, x2: 100, y2: 100 }]);
    expect(out['boxes']).toEqual([{ x: 70, y: 10, width: 10, height: 30, label: 'kept' }]);
    expect(out['ellipses']).toEqual([{ x: 75, y: 0, width: 25, height: 50 }]);
    expect(out['highlights']).toEqual([{ x: 0, y: 50, width: 50, height: 50 }]);
    expect(out['redact']).toEqual([{ x: 80, y: 0, width: 20, height: 10 }]); // redactions move with the picture too (R-251)
    // four quarter turns, or two flips, give the shapes back
    let back = data;
    for (let i = 0; i < 4; i++) back = remapAnnotations(back, rotateLeft);
    expect(back).toEqual(data);
    const flipped = remapAnnotations(remapAnnotations(data, { kind: 'flip', axis: 'horizontal' }), { kind: 'flip', axis: 'horizontal' });
    expect(flipped).toEqual(data);
  });
  it('entries pagemd cannot draw are kept as written; nothing is cut or dropped by a turn', () => {
    const data: AnnotationData = { markers: [{ id: 1, x: 0, y: 100, label: 'edge' }, { id: 3, label: 'not placed' }] };
    expect(remapAnnotations(data, rotateRight)['markers']).toEqual([{ id: 1, x: 0, y: 0, label: 'edge' }, { id: 3, label: 'not placed' }]);
  });
});

/** The rectangle (% of the picture) pagemd's own FIGURE HTML shows, read from its `object-view-box: inset(t r b l)`. */
function shownByPagemd(params: string): { x: number; y: number; width: number; height: number } {
  const html = createDialect({ mode: 'render' }).render(`<!-- ::FIGURE src="a.png" ${params} -->`);
  const inset = /object-view-box: inset\((.*)\)"/.exec(html.replace(/&quot;/g, '"'))?.[1];
  if (!inset) throw new Error(`no inset in ${html}`);
  // Each edge is "N%", "0px" or calc(A op B) of those: add them up, % counted, 0px as 0.
  const edges: number[] = [];
  for (const m of inset.matchAll(/calc\(([^)]*)\)|(-?[\d.]+)(%|px)/g)) {
    if (m[1] !== undefined) {
      const [a, op, b] = m[1].trim().split(/\s+(?=[-+]\s)|(?<=[-+])\s+/);
      const value = (s: string): number => (s.endsWith('%') ? Number.parseFloat(s) : 0);
      edges.push(op === '-' ? value(a!) - value(b!) : value(a!) + value(b!));
    } else edges.push(m[3] === '%' ? Number(m[2]) : 0);
  }
  const [top, right, bottom, left] = edges as [number, number, number, number];
  return { x: round2(left), y: round2(top), width: round2(100 - left - right), height: round2(100 - top - bottom) };
}

describe("the crop keys (A8 / R-109; P27: both forms, in %): the values pagemd needs to show a rectangle", () => {
  const rects = [
    { x: 10, y: 20, width: 50, height: 40 },
    { x: 0, y: 0, width: 33.33, height: 100 },
    { x: 12.5, y: 0, width: 87.5, height: 60 },
    { x: 0, y: 70, width: 100, height: 30 },
  ];
  for (const rect of rects) {
    it(`shows exactly ${JSON.stringify(rect)} in pagemd's own HTML`, () => {
      const params = Object.entries(cropKeysFor(rect))
        .map(([k, v]) => `${k}="${v}"`)
        .join(' ');
      expect(shownByPagemd(params)).toEqual(rect);
      expect(cropRectOf(cropKeysFor(rect))).toEqual(rect);
      expect(cropRectOf(cropKeysFor(rect, 'yaml'))).toEqual(rect); // the YAML's numbers read the same
    });
  }
  it('the signs are checked: a positive pos-x would move the window the other way (the control)', () => {
    expect(shownByPagemd('crop-x="50" pos-x="10%"')).not.toEqual({ x: 10, y: 0, width: 50, height: 100 });
    expect(cropKeysFor({ x: 10, y: 0, width: 50, height: 100 })).toEqual({ 'crop-x': '50', 'pos-x': '-10%' });
    expect(cropKeysFor({ x: 10, y: 0, width: 50, height: 100 }, 'yaml')).toEqual({ 'crop-x': 50, 'pos-x': -10 });
  });
  it('no crop, the whole picture, another unit, and keeping every other parameter', () => {
    expect(cropRectOf({ src: 'a.png' })).toBeNull();
    expect(cropKeysFor({ x: 0, y: 0, width: 100, height: 100 })).toEqual({});
    expect(cropRectOf({ 'crop-x': '50', 'pos-x': '-20px' })).toBe('unknown');
    expect(cropRectOf({ 'crop-x': '300px' })).toBe('unknown');
    expect(withCrop({ src: 'a.png', 'crop-x': '10', caption: 'C' }, null)).toEqual({ src: 'a.png', caption: 'C' });
  });
});

describe('the picture the tools act on, and their edits (one transaction each)', () => {
  it('finds a selected picture of every kind, and a lone image by the cursor; not a picture among words', () => {
    expect(pictureTarget(selected('<!-- ::FIGURE src="a.png" -->\n', 'pmd_figure'))).toMatchObject({ kind: 'figure', src: 'a.png', alone: true });
    expect(pictureTarget(selected('::: annotated-image b.png\n:::\n', 'pmd_annotated_image'))).toMatchObject({ kind: 'annotated', src: 'b.png' });
    expect(pictureTarget(selected('![[c.png|C]]\n', 'pmd_embed'))).toMatchObject({ kind: 'embed', src: 'c.png', alone: true });
    expect(pictureTarget(selected('see ![d](d.png) here\n', 'image'))).toMatchObject({ kind: 'image', alone: false });
    const doc = t.parse('![d](d.png)\n');
    const cursor = EditorState.create({ schema: t.schema, doc, selection: TextSelection.create(doc, 1) });
    expect(pictureTarget(cursor)).toMatchObject({ kind: 'image', src: 'd.png', alone: true });
    const words = t.parse('just words\n');
    expect(pictureTarget(EditorState.create({ schema: t.schema, doc: words }))).toBeNull();
  });
  it('a lone image → FIGURE: alt, title as caption, id and width carried over, the link kept, the rest named in a note', () => {
    const state = selected('[![Shot](a.png "The window"){#fig1 width=50% .wide}](https://x.org)\n', 'image');
    const made = toFigure(state, pictureTarget(state)!)!;
    expect(t.serialize(state.apply(made.tr).doc).trimEnd()).toBe('<!-- ::FIGURE src="a.png" caption="The window" id="fig1" alt="Shot" width="50%" link="https://x.org" -->'); // the write rule's canonical order
    expect(made.notes).toEqual(['Not carried over to the figure: .wide.']);
  });
  it('FIGURE → annotated image: options carried over, height named; a cropped FIGURE keeps its crop (R-248)', () => {
    const state = selected('<!-- ::FIGURE src="a.png" caption="Login" width="half" height="200px" -->\n', 'pmd_figure');
    const made = toAnnotated(state, pictureTarget(state)!)!;
    expect(t.serialize(state.apply(made.tr).doc).trimEnd()).toBe('::: annotated-image a.png\noptions:\n  caption: "Login"\n  width: "half"\n:::');
    expect(made.notes).toEqual(['An annotated image has no place for: height.']);
    const cropped = selected('<!-- ::FIGURE src="a.png" crop-x="50" pos-x="-10%" rotate="90" flip="h" -->\n', 'pmd_figure');
    const kept = toAnnotated(cropped, pictureTarget(cropped)!)!;
    expect(t.serialize(cropped.apply(kept.tr).doc).trimEnd()).toBe('::: annotated-image a.png\noptions:\n  crop-x: 50\n  pos-x: -10\n  rotate: 90\n  flip: "h"\n:::');
  });
  it("FIGURE's own crop changes only that line, in place, keeping the author's parameters and order", () => {
    const source = 'Intro.\n\n<!-- ::FIGURE caption=\'Login\' src="a.png" width=half -->\n\nEnd.\n';
    const state = selected(source, 'pmd_figure');
    const made = cropTransaction(state, pictureTarget(state)!, { x: 10, y: 0, width: 50, height: 100 })!;
    const { text, edits } = saved(state, state.apply(made.tr), source);
    expect(text).toBe('Intro.\n\n<!-- ::FIGURE caption=\'Login\' src="a.png" width=half crop-x="50" pos-x="-10%" -->\n\nEnd.\n');
    expect(edits).toHaveLength(1);
  });
});

describe('a drag or a nudge saves as ONE hunk: only that entry\'s line changes (D11, acceptance criterion 1)', () => {
  const SOURCE = [
    '# Guide',
    '',
    'Some text.',
    '',
    '::: annotated-image shots/app.png',
    '# the author keeps notes here',
    'options: { caption: "The app" }',
    'markers:',
    '  - { id: 1, x: 10, y: 20, label: "Menu" }   # first',
    '  - id: 2',
    '    x: 30',
    '    y: 40',
    '    label: Save',
    'boxes:',
    '  - { x: 5, y: 50, width: 30, height: 20, label: "Tasks", id: 3 }',
    ':::',
    '',
    'More text.',
    '',
  ].join('\n');
  const edit = (change: (data: AnnotationData) => AnnotationData) => {
    const state = selected(SOURCE, 'pmd_annotated_image');
    const node = (state.selection as NodeSelection).node;
    const value = node.attrs['data'] as { data: AnnotationData };
    const tr = state.tr.setNodeMarkup(state.selection.from, undefined, { ...node.attrs, data: { ...value, data: change(value.data) } });
    return saved(state, state.apply(tr), SOURCE);
  };
  const changedLines = (text: string): string[] => {
    const a = SOURCE.split('\n');
    const b = text.split('\n');
    expect(b).toHaveLength(a.length);
    return b.filter((line, i) => line !== a[i]);
  };
  it('a flow-style marker moved: only its line, its comment kept', () => {
    const { text, edits } = edit((d) => withEntry(d, { list: 'markers', index: 0 }, moveEntry((d['markers'] as AnnotationData[])[0]!, 'point', 2.5, 0)));
    expect(changedLines(text)).toEqual(['  - { id: 1, x: 12.5, y: 20, label: "Menu" }   # first']);
    expect(edits).toHaveLength(1);
  });
  it('a block-style marker moved: only its x and y lines', () => {
    const { text } = edit((d) => withEntry(d, { list: 'markers', index: 1 }, moveEntry((d['markers'] as AnnotationData[])[1]!, 'point', 1, 1)));
    expect(changedLines(text)).toEqual(['    x: 31', '    y: 41']);
  });
  it('a box resized by a corner: only its line, key order kept', () => {
    const { text } = edit((d) => withEntry(d, { list: 'boxes', index: 0 }, dragHandle((d['boxes'] as AnnotationData[])[0]!, 'rect', 'se', 50, 80)));
    expect(changedLines(text)).toEqual(['  - { x: 5, y: 50, width: 45, height: 30, label: "Tasks", id: 3 }']);
  });
  it('nothing changed: the text is byte-identical (the control: a changed value is seen)', () => {
    expect(edit((d) => d).text).toBe(SOURCE);
    expect(edit((d) => withEntry(d, { list: 'markers', index: 0 }, { ...(d['markers'] as AnnotationData[])[0]!, x: 11 })).text).not.toBe(SOURCE);
  });
  it('boundsOf reads what pagemd draws (clamped to the picture)', () => {
    expect(boundsOf({ x: 90, y: 0, width: 30, height: 10 }, 'rect')).toEqual({ x: 90, y: 0, width: 10, height: 10 });
  });
});

describe('the shape-editing plugin', () => {
  it('a request (a new shape, an Inspector row) travels as a decoration on the annotated image and follows it when text is typed above', () => {
    const plugin = shapeEditingPlugin();
    const base = selected('Para.\n\n::: annotated-image a.png\nmarkers: [{ id: 1, x: 1, y: 1, label: "a" }]\n:::\n', 'pmd_annotated_image');
    let state = EditorState.create({ schema: t.schema, doc: base.doc, selection: base.selection, plugins: [plugin] });
    const pos = state.selection.from;
    state = state.apply(requestShape(state.tr, pos, { list: 'markers', index: 0 }, true));
    expect(shapeEditingKey.getState(state)).toMatchObject({ pos, request: { ref: { list: 'markers', index: 0 }, focus: true } });
    state = state.apply(state.tr.insertText('abc', 1));
    expect(shapeEditingKey.getState(state)!.pos).toBe(pos + 3);
    const decorations = (plugin.props.decorations as (s: EditorState) => DecorationSet).call(plugin, state);
    const found = decorations.find();
    expect(found).toHaveLength(1);
    expect(found[0]!.from).toBe(pos + 3);
    expect((found[0]!.spec as Record<string, { ref: unknown }>)[SHAPE_REQUEST]!.ref).toEqual({ list: 'markers', index: 0 });
    // the picture deleted: the request goes
    state = state.apply(state.tr.delete(pos + 3, pos + 3 + state.doc.nodeAt(pos + 3)!.nodeSize));
    expect(shapeEditingKey.getState(state)).toBeNull();
  });
});

describe('the CLI shows the edited picture as the canvas does (I3, acceptance criterion 3)', () => {
  /** The annotated image's HTML without what differs on purpose: the figure number (the canvas counts live) and SVG ids. */
  const comparable = (html: string): string =>
    html
      .replace(/<span class="fig-num">[^<]*<\/span>/g, '<span class="fig-num"></span>')
      .replace(/arrowhead-[\w-]+/g, 'arrowhead')
      .replace(/\s+/g, ' ')
      .trim();
  it('after a drag, a rotate remap and an added shape, pagemd renders the saved text exactly as the canvas draws the node', () => {
    const source = '# T\n\n::: annotated-image a.png\noptions: { caption: "Shot" }\nmarkers:\n  - { id: 1, x: 10, y: 20, label: "A" }\narrows:\n  - { id: 2, x1: 10, y1: 10, x2: 40, y2: 40, label: "B" }\n:::\n';
    let state = selected(source, 'pmd_annotated_image');
    const pos = state.selection.from;
    const node = (state.selection as NodeSelection).node;
    const value = node.attrs['data'] as { data: AnnotationData };
    let data = withEntry(value.data, { list: 'markers', index: 0 }, moveEntry((value.data['markers'] as AnnotationData[])[0]!, 'point', 12.5, 3));
    data = remapAnnotations(data, { kind: 'rotate', turn: 'right' });
    data = addShape(data, 'ellipses').data;
    state = state.apply(state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, data: { ...value, data } }));
    const text = applyEdits(source, diffToEdits(selected(source, 'pmd_annotated_image').doc, state.doc, source));
    const cli = createDialect({ mode: 'render' }).render(text);
    const figure = /<figure class="annotated-image-container[\s\S]*?<\/figure>/.exec(cli)![0];
    expect(comparable(annotatedHtmlFor(state.doc.nodeAt(pos)!))).toBe(comparable(figure));
    // the CLI numbers it (one counter with FIGURE, C9); the canvas leaves the number to its CSS counter
    expect(figure).toContain('Figure <span class="fig-num">1</span>: Shot');
    // the control: a different shape position is seen
    expect(comparable(annotatedHtmlFor(selected(source, 'pmd_annotated_image').doc.nodeAt(pos)!))).not.toBe(comparable(figure));
  });
});
