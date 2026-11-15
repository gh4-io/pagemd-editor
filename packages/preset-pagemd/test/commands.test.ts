// P7: every command the three presets declare (commonmark, gfm, pagemd), run on a real document: the result is written
// by the items' own writers and read back by the same reader, and it must read back as the same blocks (no raw
// blocks, nothing lost). One test per command; a command with no test fails the coverage check at the end.
import type { Node } from 'prosemirror-model';
import { EditorState, NodeSelection, TextSelection, type Transaction } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { createRegistry, ItemRegistry, RAW_BLOCK, ViewState, type CommandSpec } from '@pagemd-editor/core';
import { commonmarkItems } from '@pagemd-editor/preset-commonmark';
import { gfmItems } from '@pagemd-editor/preset-gfm';
import { createTransformer, type Transformer } from '@pagemd-editor/transformer';
import { addShapeTransaction, drawModeKey, pagemdItems } from '../src/index.ts';
import { setFigureStyle } from '../src/index.ts';
setFigureStyle('native'); // these tests are about the picture tools, in the native style; the readable default has its own tests (readable-figures.test.ts)
import type { ShapeList } from '../src/media/image-tools/geometry.ts';

const items = (fields = { fancy_lists: true }) => [...commonmarkItems, ...gfmItems, ...pagemdItems({ fields })];
const t: Transformer = createTransformer(items());
const registry = createRegistry({ items: new ItemRegistry([...items()]), view: new ViewState() });
const specs = registry.commands.list();

/** The document `text`, with the cursor (or the words `from`..`to`) in the first paragraph. */
function stateFor(text: string, select?: [number, number]): EditorState {
  const doc = t.parse(text);
  const state = EditorState.create({ schema: t.schema, doc });
  let pos = 1;
  doc.descendants((node, p) => {
    if (node.isTextblock && pos === 1) pos = p + 1;
    return pos === 1;
  });
  const [from, to] = select ?? [0, 0];
  return state.apply(state.tr.setSelection(TextSelection.create(doc, pos + from, pos + to)));
}

function run(command: CommandSpec, state: EditorState): EditorState {
  expect(command.isEnabled(state)).toBe(true);
  let next = state;
  expect(command.run(state, (tr) => (next = state.apply(tr)))).toBe(true);
  return next;
}

const names = (doc: Node): string[] => {
  const out: string[] = [];
  doc.descendants((n) => {
    out.push(n.type.name);
    return true;
  });
  return out;
};

/** Writes the whole document, reads it back, and writes it again: the same text, and no raw block appeared. */
function roundTrip(doc: Node): { text: string; again: Node } {
  const text = t.serialize(doc);
  const again = t.parse(text);
  expect(names(again)).not.toContain(RAW_BLOCK);
  expect(t.serialize(again)).toBe(text);
  return { text, again };
}

const get = (id: string): CommandSpec => {
  const found = registry.commands.get(id);
  if (!found) throw new Error(`no command ${id}`);
  return found;
};

const tested = new Set<string>();
/** A command on `text` (cursor at the start, or `select`): what it writes, and the node names it adds. */
function check(id: string, text: string, expectIn: RegExp | string, select?: [number, number], nodeName?: string): void {
  it(id, () => {
    tested.add(id);
    const next = run(get(id), stateFor(text, select));
    const { text: written, again } = roundTrip(next.doc);
    if (typeof expectIn === 'string') expect(written).toContain(expectIn);
    else expect(written).toMatch(expectIn);
    if (nodeName) expect(names(again)).toContain(nodeName);
  });
}

describe('CommonMark commands', () => {
  check('strong.toggle', 'hello world\n', '**hello**', [0, 5]);
  check('emphasis.toggle', 'hello world\n', '*hello*', [0, 5]);
  check('code.toggle', 'hello world\n', '`hello`', [0, 5]);
  check('link.insert', 'hello world\n', '[hello](https://)', [0, 5]);
  it('link.insert with nothing selected inserts a link', () => {
    const next = run(get('link.insert'), stateFor('hello\n'));
    expect(t.serialize(next.doc)).toContain('[link](https://)');
  });
  check('image.insert', 'hello world\n', '![Image](image.png)', undefined, 'image');
  check('paragraph.set', '# Title\n', 'Title');
  for (const level of [1, 2, 3, 4, 5, 6]) check(`heading.h${level}`, 'Title\n', `${'#'.repeat(level)} Title`);
  check('blockquote.toggle', 'quoted\n', '> quoted');
  check('lists.bullet', 'item\n', '- item');
  check('lists.ordered', 'item\n', '1. item');
  check('code_block.toggle', 'x = 1\n', '```\nx = 1\n```');
  check('rule.insert', 'above\n', /above\n\n---/, undefined, 'horizontal_rule');

  it('toggling off: bold, a quote, a heading, a list, a code block', () => {
    const bold = stateFor('**hello** world\n', [0, 5]);
    expect(get('strong.toggle').isActive!(bold)).toBe(true);
    expect(t.serialize(run(get('strong.toggle'), bold).doc)).toContain('hello world');
    expect(t.serialize(run(get('blockquote.toggle'), stateFor('> quoted\n')).doc).trim()).toBe('quoted');
    expect(t.serialize(run(get('heading.h2'), stateFor('## Title\n')).doc).trim()).toBe('Title');
    expect(t.serialize(run(get('lists.bullet'), stateFor('- item\n')).doc).trim()).toBe('item');
    expect(t.serialize(run(get('code_block.toggle'), stateFor('```\nx\n```\n')).doc).trim()).toBe('x');
  });
  it('a numbered list turns a bulleted one into a numbered one, and back', () => {
    const numbered = run(get('lists.ordered'), stateFor('- item\n'));
    expect(t.serialize(numbered.doc).trim()).toBe('1. item');
    expect(t.serialize(run(get('lists.bullet'), numbered).doc).trim()).toBe('- item');
  });
});

describe('GFM commands', () => {
  check('strikethrough.toggle', 'hello world\n', '~~hello~~', [0, 5]);
  it('table.insert (the pagemd table replaces GFM\'s, same id)', () => {
    tested.add('table.insert');
    const next = run(get('table.insert'), stateFor('above\n'));
    const { text, again } = roundTrip(next.doc);
    expect(text).toMatch(/\|\s+\|\s+\|\s+\|/);
    expect(names(again)).toContain('table');
  });
  for (const kind of ['note', 'tip', 'important', 'warning', 'caution']) check(`alert.${kind}`, 'careful\n', `> [!${kind.toUpperCase()}]`, undefined, 'alert');
});

describe('pagemd commands', () => {
  check('wikilinks.insert', 'hello world\n', '[[hello]]', [0, 5], 'pmd_wikilink');
  check('inline-callout.warning', 'hello\n', '[!WARNING]', undefined, 'pmd_inline_callout');
  check('inline-callout.danger', 'hello\n', '[!DANGER]', undefined, 'pmd_inline_callout');
  check('index-marker.insert', 'hello world\n', /hello<!-- ::INDEX term="hello" -->/, [0, 5], 'pmd_index_marker');
  check('fancy-lists.lower-alpha', 'item\n', 'a. item');
  check('fancy-lists.upper-alpha', 'item\n', /^A\.\s+item/);
  check('fancy-lists.lower-roman', 'item\n', 'i. item');
  check('fancy-lists.upper-roman', 'item\n', /^I\.\s+item/);
  for (const name of ['details', 'summary', 'aside', 'columns', 'spoiler', 'warning', 'caution', 'note', 'important', 'tip', 'document-header', 'title-block', 'applicability-box', 'approval-block', 'footer-notice'])
    check(`containers.${name}`, 'inside\n', new RegExp(`^::: ${name}\\ninside\\n:::`), undefined, 'pmd_container');
  check('attribute-container.insert', 'inside\n', /^::: \{\.custom\}\ninside\n:::/, undefined, 'pmd_div');
  check('callouts.warning', 'inside\n', '[[WARNING]]\ninside\n[[/WARNING]]', undefined, 'pmd_callout');
  check('callouts.danger', 'inside\n', '[[DANGER]]\ninside\n[[/DANGER]]', undefined, 'pmd_callout');
  check('figure.insert', 'above\n', '<!-- ::FIGURE src="image.png" caption="Caption" -->', undefined, 'pmd_figure');
  check('figure.make-readable', '<!-- ::FIGURE src="a.png" caption="C" id="x" -->\n', '![](a.png "C")\n<!-- ::FIGURE id="x" -->', undefined, 'pmd_figure');
  check('annotated-image.insert', 'above\n', '::: annotated-image image.png', undefined, 'pmd_annotated_image');
  check('embeds.insert', 'hello\n', '![[image.png]]', undefined, 'pmd_embed');
  check('mermaid.insert', 'above\n', '```mermaid', undefined, 'code_block');
  check('pagebreak.insert', 'above\n', '<!-- ::PAGEBREAK -->', undefined, 'pmd_pagebreak');
  check('toc.insert', 'above\n', '<!-- ::TOC -->', undefined, 'pmd_toc');
  check('section.start', 'above\n', '<!-- ::SECTION_START -->', undefined, 'pmd_section');
  check('section.end', 'above\n', '<!-- ::SECTION_END -->', undefined, 'pmd_section');
  check('layout.landscape', 'above\n', '<!-- ::LAYOUT(landscape) -->', undefined, 'pmd_layout');
  check('layout.default', 'above\n', '<!-- ::LAYOUT(default) -->', undefined, 'pmd_layout');
  check('cover.start', 'above\n', '<!-- ::COVER_START -->', undefined, 'pmd_cover');
  check('cover.end', 'above\n', '<!-- ::COVER_END -->', undefined, 'pmd_cover');
  check('index.insert', 'above\n', '<!-- ::INDEX -->', undefined, 'pmd_index');
  check('include-directive.insert', 'above\n', '<!-- ::INCLUDE path="file.md" -->', undefined, 'pmd_include_directive');
  check('include.insert', 'above\n', '!!!include(file.md)!!!', undefined, 'pmd_include');

  it('an empty paragraph is replaced by the inserted block, and a block at the end gets a paragraph after it', () => {
    const next = run(get('pagebreak.insert'), stateFor('\n'));
    expect(next.doc.firstChild!.type.name).toBe('pmd_pagebreak');
    expect(next.doc.lastChild!.type.name).toBe('paragraph');
    expect(next.selection.$from.parent.type.name).toBe('paragraph');
  });
  it('inside a box a block goes inside the box', () => {
    const state = stateFor('::: tip\ninside\n:::\n');
    const next = run(get('pagebreak.insert'), state);
    expect(names(next.doc).slice(0, 2)).toEqual(['pmd_container', 'paragraph']);
    expect(t.serialize(next.doc)).toContain('<!-- ::PAGEBREAK -->\n:::');
  });
});

/** `text` with its first node named `name` selected (a picture). */
function selectFirst(text: string, name: string): EditorState {
  const doc = t.parse(text);
  let at = -1;
  doc.descendants((node, pos) => {
    if (at < 0 && node.type.name === name) at = pos;
    return at < 0;
  });
  const state = EditorState.create({ schema: t.schema, doc });
  return state.apply(state.tr.setSelection(NodeSelection.create(doc, at)));
}

describe('P15 shape commands (Insert ▸ Shapes, D4, D5, D7)', () => {
  const ANNOTATED = 'Intro.\n\n::: annotated-image shot.png\n# the author\'s comment\noptions: { caption: "Login" }\nmarkers:\n  - { id: 1, x: 80, y: 10, label: "Save" }\n:::\n\nAfter.\n';
  const DRAWN_LIST: Record<string, ShapeList> = { 'annotated-image.add-arrow': 'arrows', 'annotated-image.add-box': 'boxes', 'annotated-image.add-line': 'lines', 'annotated-image.add-ellipse': 'ellipses', 'annotated-image.add-highlight': 'highlights' };
  const added: [string, RegExp][] = [
    ['annotated-image.add-marker', /markers:\n {2}- \{ id: 1, x: 80, y: 10, label: "Save" \}\n {2}- \{ id: 2, x: 50, y: 50, label: "Marker 2" \}/],
    ['annotated-image.add-arrow', /arrows:\n {2}- \{ x1: 35, y1: 35, x2: 50, y2: 50 \}/],
    ['annotated-image.add-box', /boxes:\n {2}- \{ x: 40, y: 40, width: 20, height: 20 \}/],
    ['annotated-image.add-text', /text:\n {2}- \{ x: 45, y: 45, text: "Text" \}/],
    ['annotated-image.add-line', /lines:\n {2}- \{ x1: 35, y1: 50, x2: 65, y2: 50 \}/],
    ['annotated-image.add-ellipse', /ellipses:\n {2}- \{ x: 40, y: 40, width: 20, height: 20 \}/],
    ['annotated-image.add-highlight', /highlights:\n {2}- \{ x: 35, y: 45, width: 30, height: 10 \}/],
  ];
  for (const [id, expected] of added) {
    it(`${id}: adds the shape, the author's lines kept`, () => {
      tested.add(id);
      const state = selectFirst(ANNOTATED, 'pmd_annotated_image');
      // FIX-S50 (OQ-63): an arrow, line, box, ellipse or highlight is drawn: the command starts draw mode (no document change); the shape is
      // added when the drag ends (addShapeTransaction, the same transaction the command used to make).
      const list = DRAWN_LIST[id];
      let next: EditorState;
      if (list) {
        let asked: Transaction | undefined;
        expect(get(id).run(state, (tr) => (asked = tr))).toBe(true);
        expect(asked!.getMeta(drawModeKey)?.list).toBe(list);
        expect(asked!.docChanged).toBe(false);
        next = state.apply(addShapeTransaction(state, list)!);
      } else next = run(get(id), state);
      const { text } = roundTrip(next.doc);
      expect(text).toMatch(expected);
      expect(text).toContain("# the author's comment\noptions: { caption: \"Login\" }\nmarkers:\n  - { id: 1, x: 80, y: 10, label: \"Save\" }");
      expect(next.selection).toBeInstanceOf(NodeSelection);
    });
  }
  it('an "Add" on a lone plain image makes it an annotated image with the shape, in one step', () => {
    const lone = selectFirst('![Shot](a.png "The window")\n', 'image');
    const next = lone.apply(addShapeTransaction(lone, 'boxes')!);
    expect(t.serialize(next.doc).trimEnd()).toBe('::: annotated-image a.png\noptions:\n  caption: "The window"\n  alt: "Shot"\nboxes:\n  - { x: 40, y: 40, width: 20, height: 20 }\n:::');
  });
  it('nothing to add to: no picture selected, a YAML error, a picture in a table cell (with the reason); P27 (R-248): a picture among words and a cropped FIGURE can', () => {
    const add = get('annotated-image.add-marker');
    expect(add.isEnabled(stateFor('words\n'))).toBe(false);
    expect(add.isEnabled(selectFirst('see ![a](a.png) here\n', 'image'))).toBe(true);
    expect(add.isEnabled(selectFirst('<!-- ::FIGURE src="a.png" crop-x="50" -->\n', 'pmd_figure'))).toBe(true);
    const cell = selectFirst('| a |\n| --- |\n| ![c](a.png) |\n', 'image');
    expect(add.isEnabled(cell)).toBe(false);
    expect(add.reason?.(cell)).toMatch(/table cell/);
    expect(add.isEnabled(selectFirst('<!-- ::FIGURE src="a.png" -->\n', 'pmd_figure'))).toBe(true);
    expect(add.isEnabled(selectFirst('::: annotated-image a.png\nmarkers: [\n:::\n', 'pmd_annotated_image'))).toBe(false);
  });
  it('annotated-image.renumber: reading order (bands of 5 %, then left to right); only ids change; off when already in order', () => {
    tested.add('annotated-image.renumber');
    const text = '::: annotated-image a.png\nmarkers:\n  - { id: 1, x: 80, y: 50, label: "C" }\n  - { id: 2, x: 10, y: 52, label: "B" }\n  - { id: 3, x: 90, y: 5, label: "A" }\n:::\n';
    const state = selectFirst(text, 'pmd_annotated_image');
    const next = run(get('annotated-image.renumber'), state);
    expect(t.serialize(next.doc).trimEnd()).toBe('::: annotated-image a.png\nmarkers:\n  - { id: 3, x: 80, y: 50, label: "C" }\n  - { id: 2, x: 10, y: 52, label: "B" }\n  - { id: 1, x: 90, y: 5, label: "A" }\n:::');
    expect(get('annotated-image.renumber').isEnabled(next)).toBe(false);
  });
});

describe('P26: footnotes and task lists', () => {
  // A reference at the cursor and its note at the end, one change (more in footnotes-task-lists.test.ts)
  check('footnotes.insert', 'Some text.\n', /\[\^1\]Some text\.\n\n\[\^1\]:/, undefined, 'pmd_footnote');
  check('task-lists.toggle', 'Buy milk\n', '- [ ] Buy milk');
});

describe('coverage', () => {
  it('every command in the three presets has a test above', () => {
    // (P16: the table tools are tested in table-commands.test.ts, which has its own count.)
    // (P20: the Image tab's Size and Caption commands, `picture.*`, in picture-size.test.ts, with its own count.)
    const untested = specs.map((c) => c.id).filter((id) => !tested.has(id) && !(id.startsWith('table.') && id !== 'table.insert') && !id.startsWith('picture.'));
    expect(untested).toEqual([]);
  });
});
