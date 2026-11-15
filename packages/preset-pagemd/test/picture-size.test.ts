// P20 (the Image tab): the rule that shows the tab (a picture selected as an object, AD-P20-04) and the new Size and Caption
// commands (AD-P20-05): pagemd's own `width` on a FIGURE or an annotated image, one transaction each, written by
// @pagemd/syntax's write rules (only spellings that exist: `width="half"`, `width: "half"`); off, with a reason, for a plain
// image or an embed (AD-P20-08: pagemd sizes and captions figures only). One test per command; the coverage check at the end
// fails for a `picture.*` command with none.
import { EditorState, NodeSelection, TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { createRegistry, ItemRegistry, ViewState, type CommandSpec } from '@pagemd-editor/core';
import { commonmarkItems } from '@pagemd-editor/preset-commonmark';
import { gfmItems } from '@pagemd-editor/preset-gfm';
import { createTransformer } from '@pagemd-editor/transformer';
import { captionFigure, FIGURE_ONLY_REASON, pagemdItems, pictureField, pictureSelected, pictureTarget } from '../src/index.ts';
import { setFigureStyle } from '../src/index.ts';
setFigureStyle('native'); // these tests are about the picture tools, in the native style; the readable default has its own tests (readable-figures.test.ts)

const items = [...commonmarkItems, ...gfmItems, ...pagemdItems({})];
const t = createTransformer(items);
const registry = createRegistry({ items: new ItemRegistry([...items]), view: new ViewState() });
const tested = new Set<string>();

/** `text` with its first node named `name` selected as an object. */
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

/** `text` with a text cursor at `offset` inside its first textblock. */
function cursorIn(text: string, offset = 0): EditorState {
  const doc = t.parse(text);
  let pos = -1;
  doc.descendants((node, p) => {
    if (pos < 0 && node.isTextblock) pos = p + 1;
    return pos < 0;
  });
  const state = EditorState.create({ schema: t.schema, doc });
  return state.apply(state.tr.setSelection(TextSelection.create(doc, pos + offset)));
}

const get = (id: string): CommandSpec => registry.commands.get(id) ?? (() => { throw new Error(`no command ${id}`); })();

/** Runs `id` and counts the transactions it dispatched (one edit = one undo step). */
function run(id: string, state: EditorState): { next: EditorState; text: string; steps: number } {
  tested.add(id);
  const command = get(id);
  expect(command.isEnabled(state)).toBe(true);
  let next = state;
  let steps = 0;
  expect(command.run(state, (tr) => ((next = next.apply(tr)), steps++))).toBe(true);
  return { next, text: `${t.serialize(next.doc).trimEnd()}\n`, steps };
}

const FIGURE = 'Intro.\n\n<!-- ::FIGURE src="shot.png" caption="Login" id="fig-login" -->\n\nAfter.\n';
const ANNOTATED = 'Intro.\n\n::: annotated-image shot.png\n# the author\'s comment\noptions: { caption: "Login" }\nmarkers:\n  - { id: 1, x: 80, y: 10, label: "Save" }\n:::\n\nAfter.\n';

describe('pictureSelected (the Image tab rule, AD-P20-04)', () => {
  it('is true for each of the four picture kinds selected as an object', () => {
    expect(pictureSelected(selectFirst('![Shot](a.png)\n', 'image'))).toBe(true);
    expect(pictureSelected(selectFirst('![[a.png|Shot]]\n', 'pmd_embed'))).toBe(true);
    expect(pictureSelected(selectFirst(FIGURE, 'pmd_figure'))).toBe(true);
    expect(pictureSelected(selectFirst(ANNOTATED, 'pmd_annotated_image'))).toBe(true);
  });

  it('is false for a text cursor, for a cursor in a paragraph holding only a picture, and for a range over a picture and words', () => {
    expect(pictureSelected(cursorIn('words\n', 2))).toBe(false);
    const lone = cursorIn('![Shot](a.png)\n', 0);
    expect(pictureSelected(lone)).toBe(false);
    // The control: the commands' own target DOES take the cursor next to a lone picture, so a copy of it would pass here.
    expect(pictureTarget(lone)).not.toBeNull();
    const doc = t.parse('see ![a](a.png) here\n');
    const state = EditorState.create({ schema: t.schema, doc });
    const range = state.apply(state.tr.setSelection(TextSelection.create(doc, 1, doc.content.size - 1)));
    expect(pictureSelected(range)).toBe(false);
    // A selected block that is not a picture.
    expect(pictureSelected(selectFirst('<!-- ::PAGEBREAK -->\n', 'pmd_pagebreak'))).toBe(false);
  });
});

describe('Image tab > Size: pagemd\'s own width (one edit, one undo step)', () => {
  for (const width of ['full', 'half', 'third', 'quarter'] as const) {
    it(`picture.width-${width}: FIGURE gets width="${width}" on its own line, the rest kept; the annotated image's options too`, () => {
      const figure = run(`picture.width-${width}`, selectFirst(FIGURE, 'pmd_figure'));
      expect(figure.steps).toBe(1);
      expect(figure.text).toBe(`Intro.\n\n<!-- ::FIGURE src="shot.png" caption="Login" id="fig-login" width="${width}" -->\n\nAfter.\n`);
      expect(figure.next.selection).toBeInstanceOf(NodeSelection); // the picture stays selected (the tab stays)
      expect(get(`picture.width-${width}`).isActive!(figure.next)).toBe(true);
      const annotated = run(`picture.width-${width}`, selectFirst(ANNOTATED, 'pmd_annotated_image'));
      expect(annotated.steps).toBe(1);
      expect(annotated.text).toContain(`width: "${width}"`);
      expect(annotated.text).toContain('caption: "Login"');
      expect(annotated.text).toContain('markers:\n  - { id: 1, x: 80, y: 10, label: "Save" }');
      // It reads back as the same picture with that width.
      expect(`${t.serialize(t.parse(annotated.text)).trimEnd()}\n`).toBe(annotated.text);
    });
  }

  it('a second width replaces the first; the same width again is not an edit', () => {
    const half = run('picture.width-half', selectFirst(FIGURE, 'pmd_figure')).next;
    const quarter = run('picture.width-quarter', half);
    expect(quarter.text).toContain('width="quarter"');
    expect(quarter.text).not.toContain('half');
    expect(get('picture.width-quarter').run(quarter.next, () => undefined)).toBe(false);
  });

  it('picture.width-original removes the key (FIGURE and annotated image); off when there is no width', () => {
    const figure = selectFirst('<!-- ::FIGURE src="shot.png" width="half" caption="Login" -->\n', 'pmd_figure');
    const back = run('picture.width-original', figure);
    expect(back.steps).toBe(1);
    expect(back.text).toBe('<!-- ::FIGURE src="shot.png" caption="Login" -->\n');
    expect(get('picture.width-original').isEnabled(back.next)).toBe(false);
    const annotated = run('picture.width-original', run('picture.width-third', selectFirst(ANNOTATED, 'pmd_annotated_image')).next);
    expect(annotated.text).not.toContain('width');
    expect(annotated.text).toContain('caption: "Login"');
  });

  it('Word-style (AD-FIX-WS-03): a plain image takes pagemd\'s class .width-*; a second size replaces the first; Original removes it and nothing else', () => {
    const image = selectFirst('Text.\n\n![Shot](a.png){#pic .wide}\n', 'image');
    const half = run('picture.width-half', image);
    expect(half.steps).toBe(1);
    expect(half.text).toBe('Text.\n\n![Shot](a.png){#pic .wide .width-half}\n');
    expect(get('picture.width-half').isActive!(half.next)).toBe(true);
    const third = run('picture.width-third', half.next);
    expect(third.text).toBe('Text.\n\n![Shot](a.png){#pic .wide .width-third}\n');
    expect(get('picture.width-third').run(third.next, () => undefined)).toBe(false); // the same size again is not an edit
    for (const width of ['full', 'quarter']) expect(run(`picture.width-${width}`, image).text).toContain(`.width-${width}`);
    const back = run('picture.width-original', third.next);
    expect(back.text).toBe('Text.\n\n![Shot](a.png){#pic .wide}\n');
    expect(get('picture.width-original').isEnabled(back.next)).toBe(false);
    // An older pixel size is replaced, not kept beside the class.
    expect(run('picture.width-half', selectFirst('![a](a.png){width=300}\n', 'image')).text).toBe('![a](a.png){.width-half}\n');
    expect(run('picture.width-original', selectFirst('![a](a.png){width=300}\n', 'image')).text).toBe('![a](a.png)\n');
  });

  it('Word-style: an embed on its own line becomes a figure with the size, in one step', () => {
    const half = run('picture.width-half', selectFirst('![[a.png|Shot]]\n', 'pmd_embed'));
    expect(half.steps).toBe(1);
    expect(half.text).toBe('<!-- ::FIGURE src="a.png" alt="Shot" width="half" -->\n');
  });

  it('an embed inside a sentence has no size (nowhere to write it) and says why; nothing selected is off with no reason', () => {
    const inline = selectFirst('see ![[a.png]] here\n', 'pmd_embed');
    expect(get('picture.width-half').isEnabled(inline)).toBe(false);
    expect(get('picture.width-half').reason!(inline)).toBe(FIGURE_ONLY_REASON);
    expect(get('picture.width-half').isEnabled(cursorIn('words\n'))).toBe(false);
    expect(get('picture.width-half').reason!(cursorIn('words\n'))).toBeNull();
    // A text cursor near a FIGURE is not a selected picture (the tab is not shown there either).
    expect(get('picture.width-half').isEnabled(cursorIn('Text.\n\n<!-- ::FIGURE src="a.png" -->\n', 2))).toBe(false);
  });

  it('an inline image in a sentence is sized too (the class sits on that image)', () => {
    expect(run('picture.width-quarter', selectFirst('see ![a](a.png) here\n', 'image')).text).toBe('see ![a](a.png){.width-quarter} here\n');
  });

  it('control: the width goes on the selected picture only, never on another one', () => {
    const two = '<!-- ::FIGURE src="one.png" -->\n\n<!-- ::FIGURE src="two.png" -->\n';
    const doc = t.parse(two);
    const positions: number[] = [];
    doc.descendants((node, pos) => (node.type.name === 'pmd_figure' ? (positions.push(pos), false) : true));
    const state = EditorState.create({ schema: t.schema, doc });
    const second = state.apply(state.tr.setSelection(NodeSelection.create(doc, positions[1]!)));
    expect(run('picture.width-half', second).text).toBe('<!-- ::FIGURE src="one.png" -->\n\n<!-- ::FIGURE src="two.png" width="half" -->\n');
  });
});

describe('Image tab > Caption and Details', () => {
  it('picture.caption-remove takes the caption off a FIGURE and an annotated image, in one step; off without a caption', () => {
    const figure = run('picture.caption-remove', selectFirst(FIGURE, 'pmd_figure'));
    expect(figure.steps).toBe(1);
    expect(figure.text).toBe('Intro.\n\n<!-- ::FIGURE src="shot.png" id="fig-login" -->\n\nAfter.\n');
    expect(get('picture.caption-remove').isEnabled(figure.next)).toBe(false);
    const annotated = run('picture.caption-remove', selectFirst(ANNOTATED, 'pmd_annotated_image'));
    expect(annotated.text).not.toContain('Login');
    expect(annotated.text).toContain('markers:');
  });

  it('pictureField names the Inspector box for caption, alt text and path, per kind (the app\'s Caption, Alt text and Change picture)', () => {
    const figure = selectFirst(FIGURE, 'pmd_figure');
    expect([pictureField(figure, 'caption'), pictureField(figure, 'alt'), pictureField(figure, 'path')]).toEqual(['caption', 'alt', 'src']);
    const annotated = selectFirst(ANNOTATED, 'pmd_annotated_image');
    expect([pictureField(annotated, 'caption'), pictureField(annotated, 'alt'), pictureField(annotated, 'path')]).toEqual(['options.caption', 'options.alt', 'src']);
    const image = selectFirst('![Shot](a.png)\n', 'image');
    expect([pictureField(image, 'caption'), pictureField(image, 'alt'), pictureField(image, 'path')]).toEqual(['caption', 'alt', 'src']); // Caption on a plain image makes it a figure first (captionFigure)
    const embed = selectFirst('![[a.png]]\n', 'pmd_embed');
    expect([pictureField(embed, 'caption'), pictureField(embed, 'alt'), pictureField(embed, 'path')]).toEqual(['caption', 'alt', 'path']);
    expect(pictureField(selectFirst('see ![[a.png]] here\n', 'pmd_embed'), 'caption')).toBe('caption'); // FIX-S50: inside a sentence it is put on its own line first, as Word's Insert Caption does
    expect(pictureField(cursorIn('words\n'), 'alt')).toBeNull();
    expect(pictureField(selectFirst('::: annotated-image a.png\nmarkers: [\n:::\n', 'pmd_annotated_image'), 'alt')).toBeNull(); // a YAML error: no form
  });
});

describe('Word-style Caption on a plain picture (AD-FIX-WS-04)', () => {
  it('a plain image becomes a figure in one step, keeping its title as the caption and its size class as the width', () => {
    const state = selectFirst('Text.\n\n![Shot](a.png "Login"){.width-third}\n', 'image');
    const next = state.apply(captionFigure(state)!.tr);
    expect(`${t.serialize(next.doc).trimEnd()}\n`).toBe('Text.\n\n<!-- ::FIGURE src="a.png" caption="Login" alt="Shot" width="third" -->\n');
    expect(next.selection instanceof NodeSelection).toBe(true);
  });

  it('an embed becomes a figure too; a FIGURE and a picture in a table cell are left alone; one in a sentence is put on its own line', () => {
    expect(captionFigure(selectFirst('![[a.png]]\n', 'pmd_embed'))).not.toBeNull();
    expect(captionFigure(selectFirst(FIGURE, 'pmd_figure'))).toBeNull();
    expect(captionFigure(selectFirst('| A |\n| --- |\n| ![x](a.png) |\n', 'image'))).toBeNull();
    expect(captionFigure(selectFirst('see ![x](a.png) here\n', 'image'))).not.toBeNull(); // FIX-S50: put on a line of its own first
  });
});

describe('coverage', () => {
  it('every picture.* command of the preset has a test above', () => {
    const ids = registry.commands.list().map((c) => c.id).filter((id) => id.startsWith('picture.'));
    expect(ids.length).toBe(6);
    expect(ids.filter((id) => !tested.has(id))).toEqual([]);
  });
});
