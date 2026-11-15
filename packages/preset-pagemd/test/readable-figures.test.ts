// "Readable figures" (R-253 to R-257): new pictures are written as `![alt](src "caption")` plus, only when plain markdown
// can't hold a setting, one comment line under it. The `figureStyle` setting picks readable (default), native or legacy; figures
// already in the document keep the form they were read in. Each test names its control.
import { EditorState, NodeSelection, TextSelection } from 'prosemirror-state';
import type { Node } from 'prosemirror-model';
import { afterEach, describe, expect, it } from 'vitest';
import { commonmarkItems } from '@pagemd-editor/preset-commonmark';
import { gfmItems } from '@pagemd-editor/preset-gfm';
import { createTransformer } from '@pagemd-editor/transformer';
import { captionFigure, insertFigures, makeFiguresReadable, pagemdItems, pictureTarget, setFigureStyle } from '../src/index.ts';

const t = createTransformer([...commonmarkItems, ...gfmItems, ...pagemdItems({ fields: { fancy_lists: true } })]);
const stateFor = (text: string): EditorState => EditorState.create({ doc: t.parse(text), schema: t.schema });
const at = (state: EditorState, pos: number): EditorState => state.apply(state.tr.setSelection(TextSelection.near(state.doc.resolve(pos))));
const out = (state: EditorState): string => t.serialize(state.doc);
const figures = (doc: Node): Node[] => {
  const found: Node[] = [];
  doc.descendants((n) => void (n.type.name === 'pmd_figure' && found.push(n)));
  return found;
};
/** The Inspector's edit: new attrs on the figure's data (its form, raw text and picture line stay). */
function edit(state: EditorState, attrs: Record<string, unknown>): EditorState {
  let pos = -1;
  let node!: Node;
  state.doc.descendants((n, p) => {
    if (n.type.name === 'pmd_figure' && pos < 0) [pos, node] = [p, n];
  });
  const data = node.attrs['data'] as { attrs: Record<string, unknown> };
  return state.apply(state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, data: { ...data, attrs: { ...data.attrs, ...attrs } } }));
}

afterEach(() => setFigureStyle('readable'));

describe('new pictures (paste and drop) in the three styles', () => {
  it('readable is the default: a plain picture line with the file name as alt, and no comment line', () => {
    const state = at(stateFor('Text.\n'), 3);
    expect(out(state.apply(insertFigures(state, ['.pagemd/assets/img/a.png', 'b c.png'])!))).toBe('Text.\n\n![a](.pagemd/assets/img/a.png)\n\n![b c](<b c.png>)');
  });
  it('a caption typed later goes in the title; the bare marker makes it a numbered figure (control: no marker → a plain picture in pagemd)', () => {
    const state = at(stateFor('Text.\n'), 3);
    const next = edit(state.apply(insertFigures(state, ['a.png'])!), { caption: 'The login page' });
    expect(out(next)).toBe('Text.\n\n![a](a.png "The login page")\n<!-- ::FIGURE -->');
  });
  it('a width added in the Inspector goes in the comment', () => {
    const state = at(stateFor('Text.\n'), 3);
    const next = edit(edit(state.apply(insertFigures(state, ['a.png'])!), { caption: 'Cap' }), { width: 'half' });
    expect(out(next)).toBe('Text.\n\n![a](a.png "Cap")\n<!-- ::FIGURE width="half" -->');
  });
  it('native: the one-line comment, as before', () => {
    setFigureStyle('native');
    const state = at(stateFor('Text.\n'), 3);
    expect(out(state.apply(insertFigures(state, ['a.png'])!))).toBe('Text.\n\n<!-- ::FIGURE src="a.png" -->');
  });
  it('legacy: the comment, then the picture line (with nothing for the comment, just the picture line)', () => {
    setFigureStyle('legacy');
    const state = at(stateFor('Text.\n'), 3);
    const next = state.apply(insertFigures(state, ['a.png'])!);
    expect(out(next)).toBe('Text.\n\n![a](a.png)');
    expect(out(edit(next, { caption: 'Cap' }))).toBe('Text.\n\n<!-- ::FIGURE caption="Cap" -->\n![a](a.png)');
  });
  it('an unknown setting value is readable', () => {
    setFigureStyle('fancy');
    const state = at(stateFor('Text.\n'), 3);
    expect(out(state.apply(insertFigures(state, ['a.png'])!))).toContain('![a](a.png)');
  });
});

describe('Caption on a plain picture: its title becomes the caption', () => {
  it('![alt](src "title") → the same line (the title is the caption) and the bare marker', () => {
    const base = stateFor('![Login](a.png "The login page")\n');
    const state = base.apply(base.tr.setSelection(NodeSelection.create(base.doc, 1)));
    expect(pictureTarget(state)?.kind).toBe('image');
    const change = captionFigure(state)!;
    expect(out(state.apply(change.tr))).toBe('![Login](a.png "The login page")\n<!-- ::FIGURE -->');
  });
});

describe('figures already in the document keep their form (ADR-0007)', () => {
  it('a native figure edited stays native (control: readable writer used → src and caption would leave the comment)', () => {
    const next = edit(stateFor('<!-- ::FIGURE src="a.png" caption="C" -->\n'), { width: 'half' });
    expect(out(next)).toBe('<!-- ::FIGURE src="a.png" caption="C" width="half" -->');
  });
  it('a legacy figure edited stays legacy', () => {
    const next = edit(stateFor('<!-- ::FIGURE caption="C" -->\n![A](a.png)\n'), { width: 'half' });
    expect(out(next)).toBe('<!-- ::FIGURE caption="C" width="half" -->\n![A](a.png)');
  });
  it('a readable figure edited stays readable, and an untouched one keeps its bytes', () => {
    const text = '![ A ](a.png   "C")\n<!-- ::FIGURE id="x" width="half" -->\n\nMore.\n';
    expect(out(stateFor(text))).toBe(text.trimEnd());
    const next = edit(stateFor(text), { width: 'full' });
    expect(out(next)).toBe('![ A ](a.png   "C")\n<!-- ::FIGURE id="x" width="full" -->\n\nMore.');
  });
  it('the setting changes nothing already written', () => {
    setFigureStyle('legacy');
    const text = '![A](a.png "C")\n<!-- ::FIGURE id="x" -->\n\n<!-- ::FIGURE src="b.png" -->\n';
    expect(out(stateFor(text))).toBe(text.trimEnd());
  });
});

describe('Make figures readable', () => {
  const text = '<!-- ::FIGURE src="a.png" caption="One" id="f1" width="half" -->\n\n<!-- ::FIGURE caption="Two" -->\n![B](b.png)\n\n![C](c.png "Plain")\n\n![[d.png]]\n\n![E](e.png)\n<!-- ::FIGURE id="e" -->\n';
  it('rewrites native and legacy figures in one transaction; the rest is left alone', () => {
    const state = stateFor(text);
    const tr = makeFiguresReadable(state)!;
    expect(tr.steps.length).toBe(2); // one step per figure, one transaction = one undo step
    const next = state.apply(tr);
    expect(out(next)).toBe('![](a.png "One")\n<!-- ::FIGURE id="f1" width="half" -->\n\n![B](b.png "Two")\n<!-- ::FIGURE -->\n\n![C](c.png "Plain")\n\n![[d.png]]\n\n![E](e.png)\n<!-- ::FIGURE id="e" -->');
    // control: read back, each is a figure again (not a raw block), with the same settings
    expect(figures(t.parse(`${out(next)}\n`))).toHaveLength(3);
  });
  it('nothing to change is null', () => {
    expect(makeFiguresReadable(stateFor('![E](e.png)\n<!-- ::FIGURE id="e" -->\n'))).toBeNull();
    expect(makeFiguresReadable(stateFor('Text only.\n'))).toBeNull();
  });
});
