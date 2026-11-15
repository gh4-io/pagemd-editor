// P27 (R-248 to R-252, ADR-0019): the Image tab's document side. Add shape converts any picture in ONE transaction and keeps a
// figure's crop; Crop, Rotate, Flip and Reset picture write keys (never pixels), with shapes and redactions moved in the same
// transaction; Reset picture puts everything back exactly from all 8 orientations; redactions (R-251) are drawn as opaque boxes on
// the canvas (editor mode) and never as the uncovered picture; shapes hidden by a crop are flagged. Each check names its control.
import { createDialect, displayedRectToNatural } from '@pagemd/syntax';
import { EditorState, NodeSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { applyEdits, diffToEdits } from '@pagemd-editor/lossless';
import { commonmarkItems } from '@pagemd-editor/preset-commonmark';
import { gfmItems } from '@pagemd-editor/preset-gfm';
import { createTransformer } from '@pagemd-editor/transformer';
import { mapPoint, readFlip, readRotate, turnedKeys, undoSteps, type Flip, type Geometry, type Turn } from '../src/media/image-tools/geometry.ts';
import { addShapeTransaction, canRedact, cropTransaction, hasPictureEdits, pictureTarget, redactReason, resetTransaction, turnTransaction } from '../src/media/image-tools/target.ts';
import { hiddenShapes } from '../src/media/image-tools/annotation-view.ts';
import { annotatedHtml, annotatedHtmlFor, redactedPictures } from '../src/media/media.ts';
import { pagemdItems } from '../src/index.ts';
import { setFigureStyle } from '../src/index.ts';
setFigureStyle('native'); // these tests are about the picture tools, in the native style; the readable default has its own tests (readable-figures.test.ts)
import { paramFields } from '../src/fields.ts';

const t = createTransformer([...commonmarkItems, ...gfmItems, ...pagemdItems({})]);

function selected(text: string, name: string): EditorState {
  const doc = t.parse(text);
  let at = -1;
  doc.descendants((node, pos) => {
    if (at < 0 && node.type.name === name) at = pos;
    return at < 0;
  });
  if (at < 0) throw new Error(`no ${name}`);
  const state = EditorState.create({ schema: t.schema, doc });
  return state.apply(state.tr.setSelection(NodeSelection.create(doc, at)));
}

/** The text after one transaction, saved the editor's way (only changed blocks rewritten), and the number of transactions. */
const saved = (source: string, state: EditorState, next: EditorState): string => applyEdits(source, diffToEdits(state.doc, next.doc, source));

const RIGHT: Geometry = { kind: 'rotate', turn: 'right' };
const LEFT: Geometry = { kind: 'rotate', turn: 'left' };
const FLIP_H: Geometry = { kind: 'flip', axis: 'horizontal' };
const FLIP_V: Geometry = { kind: 'flip', axis: 'vertical' };

describe('Add shape converts automatically, in ONE transaction (R-248, amendment 1)', () => {
  const cases: [string, string, string, RegExp][] = [
    ['a plain picture on its own line', '![Shot](a.png)\n', 'image', /^::: annotated-image a\.png\noptions:\n {2}alt: "Shot"\nmarkers:\n/],
    ['a picture in a sentence (put on its own line first)', 'See ![Shot](a.png) here.\n', 'image', /^See\n\n::: annotated-image a\.png\n[\s\S]*:::\n\nhere\.$/],
    ['a FIGURE', '<!-- ::FIGURE src="a.png" caption="C" -->\n', 'pmd_figure', /^::: annotated-image a\.png\noptions:\n {2}caption: "C"\nmarkers:\n/],
    ['a cropped FIGURE (the crop kept)', '<!-- ::FIGURE src="a.png" crop-x="50" crop-y="40.5" pos-x="-25%" pos-y="10px" crop-fit="cover" -->\n', 'pmd_figure', /^::: annotated-image a\.png\noptions:\n {2}crop-x: 50\n {2}crop-y: 40\.5\n {2}pos-x: -25\n {2}pos-y: "10px"\n {2}crop-fit: "cover"\nmarkers:\n/],
  ];
  for (const [name, text, node, written] of cases) {
    it(name, () => {
      const state = selected(text, node);
      const tr = addShapeTransaction(state, 'markers')!;
      expect(tr).not.toBeNull();
      const next = state.apply(tr);
      const out = t.serialize(next.doc);
      expect(out).toMatch(written);
      expect(out).toContain('  - { id: 1, x: 50, y: 50, label: "Marker 1" }');
      // ONE transaction: inverting its steps gives the document back (one undo step)
      let doc = next.doc;
      for (let i = tr.steps.length - 1; i >= 0; i--) doc = tr.steps[i]!.invert(tr.docs[i]!).apply(doc).doc!;
      expect(t.serialize(doc)).toBe(text.trimEnd());
    });
  }
  it('the crop carried over draws the same window in pagemd (the figure and the annotated image show the same part)', () => {
    const state = selected('<!-- ::FIGURE src="a.png" crop-x="50" pos-x="-25%" -->\n', 'pmd_figure');
    const out = t.serialize(state.apply(addShapeTransaction(state, 'markers')!).doc);
    const html = createDialect({ mode: 'render' }).render(out);
    expect(html).toContain('calc-size(fit-content, size * 0.5)');
    expect(html).toContain('translate(-25%, 0px)');
  });
});

/** Where the displayed point (x, y) % is on the picture file (pagemd's own map, C13: the independent oracle). */
const natural = (x: number, y: number, rotate: Turn, flip: Flip): { x: number; y: number } => {
  const r = displayedRectToNatural({ x, y, width: 0, height: 0 }, rotate, flip);
  return { x: Math.round(r.x * 100) / 100, y: Math.round(r.y * 100) / 100 };
};

describe('Rotate and Flip: the keys turn the picture the way the button says; shapes stay on their picture point (R-249)', () => {
  const ORIENTATIONS: [Turn, Flip][] = [0, 90, 180, 270].flatMap((r) => (['', 'h', 'v', 'hv'] as Flip[]).map((f): [Turn, Flip] => [r as Turn, f]));
  const POINTS = [
    [10, 20],
    [75, 5],
    [33.33, 66.67],
  ] as const;
  it('for all 16 key combinations and the four buttons: the shown picture turns as asked (pagemd\'s map is the judge)', () => {
    for (const [rotate, flip] of ORIENTATIONS) {
      for (const g of [RIGHT, LEFT, FLIP_H, FLIP_V]) {
        const after = turnedKeys(rotate, flip, g);
        for (const [x, y] of POINTS) {
          // the picture point shown at (x, y) is shown at g(x, y) afterwards
          const moved = mapPoint(g, x, y);
          expect(natural(moved.x, moved.y, after.rotate, after.flip), `${rotate}/${flip} ${JSON.stringify(g)} (${x}, ${y})`).toEqual(natural(x, y, rotate, flip));
        }
      }
    }
  });
  it('the control: the turn the other way is caught', () => {
    const wrong = (r: Turn, f: Flip, g: Geometry) => (g.kind === 'rotate' ? turnedKeys(r, f, { kind: 'rotate', turn: g.turn === 'right' ? 'left' : 'right' }) : turnedKeys(r, f, g));
    const after = wrong(0, 'h', RIGHT);
    const moved = mapPoint(RIGHT, 10, 20);
    expect(natural(moved.x, moved.y, after.rotate, after.flip)).not.toEqual(natural(10, 20, 0, 'h'));
  });

  const SOURCE = [
    'Intro.',
    '',
    '::: annotated-image a.png',
    '# notes stay',
    'options: { caption: "Shot", crop-x: 50, pos-x: -10 }',
    'markers:',
    '  - { id: 1, x: 10, y: 20, label: "A" }',
    'boxes:',
    '  - { x: 60, y: 20, width: 20, height: 40 }',
    'redact:',
    '  - { x: 0, y: 0, width: 10, height: 20 }',
    ':::',
    '',
    'End.',
    '',
  ].join('\n');

  it('Rotate right on an annotated image: rotate, the crop, every shape and the redaction in ONE transaction', () => {
    const state = selected(SOURCE, 'pmd_annotated_image');
    const change = turnTransaction(state, RIGHT)!;
    expect(change.tr.steps).toHaveLength(1);
    const text = saved(SOURCE, state, state.apply(change.tr));
    // (new keys go where pagemd-common's YAML updater puts them, C3: after the last key it keeps; AD-P27-05)
    expect(text).toContain('options: { caption: "Shot", pos-y: -10, crop-y: 50, rotate: 90 }');
    expect(text).toContain('  - { id: 1, x: 80, y: 10, label: "A" }');
    expect(text).toContain('  - { x: 40, y: 60, width: 40, height: 20 }');
    expect(text).toContain('  - { x: 80, y: 0, width: 20, height: 10 }');
    expect(text).toContain('# notes stay');
  });

  it('a plain picture becomes a FIGURE with rotate; a FIGURE keeps its line and gets flip; a px crop stays, with a note', () => {
    const image = selected('![x](a.png)\n', 'image');
    expect(t.serialize(image.apply(turnTransaction(image, LEFT)!.tr).doc)).toBe('<!-- ::FIGURE src="a.png" alt="x" rotate="270" -->');
    const fig = selected('<!-- ::FIGURE src="a.png" caption="C" crop-x="300px" -->\n', 'pmd_figure');
    const flipped = turnTransaction(fig, FLIP_H)!;
    expect(t.serialize(fig.apply(flipped.tr).doc)).toBe('<!-- ::FIGURE src="a.png" caption="C" crop-x="300px" flip="h" -->');
    expect(flipped.notes.join(' ')).toMatch(/CSS length/);
  });
});

describe('Reset picture: one transaction; shapes back exactly from all 8 orientations (R-249)', () => {
  const START = '::: annotated-image a.png\noptions: { caption: "C" }\nmarkers:\n  - { id: 1, x: 12.34, y: 56.78, label: "A" }\narrows:\n  - { x1: 1, y1: 2, x2: 33.33, y2: 99.99 }\nboxes:\n  - { x: 5.5, y: 6.25, width: 30, height: 12.5 }\n:::\n';
  // every orientation of the dihedral group, reached by the buttons
  const ROUTES: Geometry[][] = [[], [RIGHT], [RIGHT, RIGHT], [LEFT], [FLIP_H], [FLIP_V], [RIGHT, FLIP_H], [FLIP_H, RIGHT], [LEFT, FLIP_V, RIGHT, RIGHT, FLIP_H]];
  it('every route, then a crop and a redaction, then Reset: the YAML is back as it was, byte for byte', () => {
    const seen = new Set<string>();
    for (const route of ROUTES) {
      let state = selected(START, 'pmd_annotated_image');
      let text = START;
      const step = (next: EditorState): void => {
        text = saved(text, state, next);
        state = next;
      };
      for (const g of route) step(state.apply(turnTransaction(state, g)!.tr));
      step(state.apply(cropTransaction(state, pictureTarget(state)!, { x: 10, y: 5, width: 50, height: 60 })!.tr));
      step(state.apply(addShapeTransaction(state, 'redact')!));
      const options = ((state.selection as NodeSelection).node.attrs['data'] as { data: { options: Record<string, unknown> } }).data.options;
      seen.add(`${readRotate(options['rotate'])}/${readFlip(options['flip'])}`);
      expect(hasPictureEdits(state)).toBe(true);
      const reset = resetTransaction(state)!;
      expect(reset.tr.steps).toHaveLength(1);
      step(state.apply(reset.tr));
      expect(text, route.map((g) => JSON.stringify(g)).join(' ')).toBe(START);
      expect(hasPictureEdits(state)).toBe(false);
    }
    // the routes reach the 8 distinct orientations (a flip both ways is a half turn; pagemd keeps the keys as written)
    const distinct = new Set([...seen].map((key) => {
      const [r, f] = key.split('/') as [string, Flip];
      return JSON.stringify([natural(0, 0, Number(r) as Turn, f), natural(100, 0, Number(r) as Turn, f)]);
    }));
    expect(distinct.size).toBe(8);
  });
  it('the control: undoing the turn the wrong way would not put the shapes back', () => {
    expect(undoSteps(90, '')).toEqual([LEFT]);
    expect(undoSteps(90, 'h')).toEqual([FLIP_H, LEFT]);
    expect(undoSteps(180, 'hv')).toEqual([FLIP_H, FLIP_V, LEFT, LEFT]);
  });
  it('a FIGURE: crop, shift, turn and flip removed, the rest kept; nothing to reset: off', () => {
    const fig = selected('<!-- ::FIGURE src="a.png" caption="C" crop-x="50" pos-x="-10%" crop-fit="cover" rotate="90" flip="v" width="half" -->\n', 'pmd_figure');
    expect(t.serialize(fig.apply(resetTransaction(fig)!.tr).doc)).toBe('<!-- ::FIGURE src="a.png" caption="C" width="half" -->');
    const plain = selected('<!-- ::FIGURE src="a.png" caption="C" -->\n', 'pmd_figure');
    expect(hasPictureEdits(plain)).toBe(false);
    expect(resetTransaction(plain)).toBeNull();
  });
  it('FIX-CF (AD-FIX-CF-06): height is the crop\'s box and goes with the crop; a plain figure height stays', () => {
    const boxed = selected('<!-- ::FIGURE src="a.png" crop-x="50" height="100px" crop-fit="contain" width="half" -->\n', 'pmd_figure');
    expect(t.serialize(boxed.apply(resetTransaction(boxed)!.tr).doc)).toBe('<!-- ::FIGURE src="a.png" width="half" -->');
    const turnedOnly = selected('<!-- ::FIGURE src="a.png" rotate="90" height="100px" -->\n', 'pmd_figure');
    expect(t.serialize(turnedOnly.apply(resetTransaction(turnedOnly)!.tr).doc)).toBe('<!-- ::FIGURE src="a.png" height="100px" -->');
  });
});

describe('Crop writes % keys on both forms (R-249: never pixels)', () => {
  it('an annotated image: numbers in the YAML; the whole picture removes the crop', () => {
    const source = '::: annotated-image a.png\noptions: { caption: "C" }\n:::\n';
    const state = selected(source, 'pmd_annotated_image');
    const next = state.apply(cropTransaction(state, pictureTarget(state)!, { x: 12.5, y: 0, width: 50, height: 75.25 })!.tr);
    expect(saved(source, state, next)).toBe('::: annotated-image a.png\noptions: { caption: "C", pos-x: -12.5, crop-y: 75.25, crop-x: 50 }\n:::\n');
    // the whole picture (or none) removes the crop: back to the text as it was
    const whole = next.apply(cropTransaction(next, pictureTarget(next)!, { x: 0, y: 0, width: 100, height: 100 })!.tr);
    expect(applyEdits(saved(source, state, next), diffToEdits(next.doc, whole.doc, saved(source, state, next)))).toBe(source);
    expect(t.serialize(next.apply(cropTransaction(next, pictureTarget(next)!, null)!.tr).doc)).toBe('::: annotated-image a.png\noptions: { caption: "C" }\n:::');
  });
  it('a plain picture becomes a FIGURE with the crop; a picture in a sentence is put on its own line first', () => {
    const state = selected('See ![x](a.png) here.\n', 'image');
    const change = cropTransaction(state, pictureTarget(state)!, { x: 10, y: 0, width: 50, height: 100 })!;
    expect(t.serialize(state.apply(change.tr).doc)).toBe('See\n\n<!-- ::FIGURE src="a.png" alt="x" crop-x="50" pos-x="-10%" -->\n\nhere.');
  });
});

describe('Redact (R-251, provisional): a rectangle in `redact:`, opaque on the canvas, never the picture uncovered', () => {
  it('on a FIGURE: an annotated image with one redaction, selected for editing, in one transaction; on a web address: off, with the reason', () => {
    const state = selected('<!-- ::FIGURE src="a.png" caption="C" -->\n', 'pmd_figure');
    expect(canRedact(state)).toBe(true);
    const out = t.serialize(state.apply(addShapeTransaction(state, 'redact')!).doc);
    expect(out).toBe('::: annotated-image a.png\noptions:\n  caption: "C"\nredact:\n  - { x: 35, y: 45, width: 30, height: 10 }\n:::');
    const web = selected('<!-- ::FIGURE src="https://x.org/a.png" -->\n', 'pmd_figure');
    expect(canRedact(web)).toBe(false);
    expect(redactReason(web)).toMatch(/web or data: address/);
  });
  it('the canvas draws the redaction as an opaque black box over the picture (editor mode); pagemd without its bake draws the placeholder', () => {
    const value = { imagePath: 'a.png', content: '', data: { options: {}, redact: [{ x: 10, y: 20, width: 30, height: 40 }] } };
    const canvas = annotatedHtml(value, null);
    expect(canvas).toContain('<rect class="annotation-redact" x="10" y="20" width="30" height="40" fill="#000000"');
    expect(canvas).toContain('<img src="a.png"');
    expect(canvas).not.toContain('Redacted picture not prepared');
    // the control: drawn in render mode (as before P27) the canvas would show the grey placeholder box, not the covered picture
    const rendered = createDialect({ mode: 'render' }).render('::: annotated-image a.png\nredact:\n  - { x: 10, y: 20, width: 30, height: 40 }\n:::\n');
    expect(rendered).toContain('Redacted picture not prepared');
    expect(rendered).not.toContain('src="a.png"');
  });
  it('redactedPictures finds every redacted picture, also one whose redact list is not rectangles (fail closed)', () => {
    const doc = t.parse('::: annotated-image a.png\nredact:\n  - { x: 1, y: 1, width: 1, height: 1 }\n:::\n\n::: annotated-image b.png\nredact: oops\n:::\n\n::: annotated-image c.png\nmarkers: []\n:::\n\n<!-- ::FIGURE src="d.png" -->\n');
    expect(redactedPictures(doc)).toEqual(['a.png', 'b.png']);
    expect(redactedPictures(t.parse('::: annotated-image c.png\nredact: []\n:::\n'))).toEqual([]);
  });
});

describe('shapes hidden by a crop are flagged (amendment 4)', () => {
  const source = '::: annotated-image a.png\noptions: { crop-x: 50 }\nmarkers:\n  - { id: 1, x: 10, y: 10, label: "in" }\n  - { id: 2, x: 80, y: 10, label: "out" }\nboxes:\n  - { x: 70, y: 70, width: 10, height: 10 }\n:::\n';
  it('the canvas counts them and the Inspector rows say so', () => {
    const state = selected(source, 'pmd_annotated_image');
    const node = (state.selection as NodeSelection).node;
    const data = (node.attrs['data'] as { data: Record<string, unknown> }).data;
    expect(hiddenShapes(data)).toEqual([{ list: 'markers', index: 1 }, { list: 'boxes', index: 0 }]);
    // the control: no crop, nothing hidden
    expect(hiddenShapes({ ...data, options: {} })).toEqual([]);
    expect(paramFields('annotated-image').length).toBeGreaterThan(0);
  });
});

describe('the canvas draws the picture keys as pagemd does (I3)', () => {
  const comparable = (html: string): string =>
    html
      .replace(/<span class="fig-num">[^<]*<\/span>/g, '<span class="fig-num"></span>')
      .replace(/arrowhead-[\w-]+/g, 'arrowhead')
      .replace(/\s+/g, ' ')
      .trim();
  it('a cropped, turned, flipped annotated image with sized and labelled markers: the same HTML as pagemd, given the picture size', () => {
    const source = '::: annotated-image a.png\noptions: { caption: "S", crop-x: 60, pos-x: -20, rotate: 90, flip: "h", showLabels: true }\nmarkers:\n  - { id: 1, x: 30, y: 40, label: "A", size: 2 }\n  - { id: 2, x: 50, y: 50, label: "B", showLabel: false }\n:::\n';
    const size = { width: 400, height: 200 };
    const env = { pictureSize: () => size };
    const state = selected(source, 'pmd_annotated_image');
    const cli = createDialect({ mode: 'render' }).render(source, env);
    const canvas = annotatedHtmlFor((state.selection as NodeSelection).node, env);
    expect(comparable(canvas)).toBe(comparable(/<figure class="annotated-image-container[\s\S]*?<\/figure>/.exec(cli)![0]));
    expect(canvas).toContain('class="image-turn" style="position: relative; width: 200px;');
    expect(canvas).toContain('--marker-scale: 2');
    expect(canvas).toContain('<span class="marker-label"');
    // the control: without the size the picture is turned in its unturned box (no turn box)
    expect(annotatedHtmlFor((state.selection as NodeSelection).node)).not.toContain('image-turn');
  });
});
