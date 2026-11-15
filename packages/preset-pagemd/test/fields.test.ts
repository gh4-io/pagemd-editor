// P8 acceptance (R-160, R-161): the Inspector's Element fields. Changing a field edits only that item's text (a FIGURE
// caption: only that directive line); every field reads back what was written; the fields are @pagemd/syntax's params.
import type { Node } from 'prosemirror-model';
import { EditorState, NodeSelection, TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { createEditor, type Editor, type FieldTarget, type ItemField } from '@pagemd-editor/core';
import { applyEdits, diffToEdits } from '@pagemd-editor/lossless';
import { commonmarkPreset } from '@pagemd-editor/preset-commonmark';
import { gfmPreset } from '@pagemd-editor/preset-gfm';
import { createTransformer, type Transformer } from '@pagemd-editor/transformer';
import { attributePairs, gateFields, gateKey, paramFields, pagemdPreset, useLayoutNames } from '../src/index.ts';
import { syntaxItem } from '../src/shared/write.ts';
import { corpus } from './corpus-files.ts';

const editor: Editor = await createEditor({ presets: [commonmarkPreset, gfmPreset, pagemdPreset()] });
const readers = new Map<string, Transformer>();
/** The reader for a text (its gate values), with the editor's own schema. */
const reader = (text: string): Transformer => {
  const fields = gateFields(text);
  let found = readers.get(gateKey(fields));
  if (!found) readers.set(gateKey(fields), (found = createTransformer(pagemdPreset({ fields }).items.concat(), { schema: editor.schema })));
  return found;
};
// The transformer needs every preset's items: build it from the registry's items with the gate values swapped in.
const readerFor = (text: string): Transformer => {
  const fields = gateFields(text);
  const key = gateKey(fields);
  let found = readers.get(`all${key}`);
  if (!found) {
    const pagemd = pagemdPreset({ fields }).items;
    const items = editor.registry.items().map((item) => pagemd.find((p) => p.id === item.id) ?? item);
    readers.set(`all${key}`, (found = createTransformer(items, { schema: editor.schema })));
  }
  return found;
};
void reader;

/** The selection that selects the node at `pos` (an atom) or puts the cursor in it. */
function stateAt(doc: Node, pos: number): EditorState {
  const node = doc.nodeAt(pos)!;
  const selection = node.isText ? TextSelection.create(doc, pos) : node.isAtom || node.isLeaf ? NodeSelection.create(doc, pos) : TextSelection.create(doc, pos + 1);
  return EditorState.create({ doc, selection });
}

/** Sets section `section`'s field `key` on the target found at `pos`; returns the saved text and the number of edits. */
function change(text: string, pos: number, name: string, section: string, values: (old: Record<string, unknown>) => Record<string, unknown>): { text: string; edits: number; target: FieldTarget } {
  const t = readerFor(text);
  const doc = t.parse(text);
  const state = stateAt(doc, pos);
  const target = editor.registry.fieldsFor(state).find((x) => x.name === name)!;
  expect(target, `no target ${name} at ${pos}`).toBeDefined();
  const old = target.sections.find((s) => s.id === section)!.values;
  const tr = state.tr;
  expect(editor.registry.applyFields(tr, target, section, values(old))).toBe(true);
  const edits = diffToEdits(doc, tr.doc, text);
  return { text: applyEdits(text, edits), edits: edits.length, target };
}

/** Positions of every node named `name`. */
function positions(doc: Node, name: string): number[] {
  const found: number[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === name) found.push(pos);
  });
  return found;
}

const lines = (text: string): string[] => text.split('\n');
/** The position of the first text node containing `needle`, plus 1 (inside it). */
function textPos(doc: Node, needle: string): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found < 0 && node.isText && node.text!.includes(needle)) found = pos + node.text!.indexOf(needle) + 1;
    return found < 0;
  });
  return found;
}
/** The line numbers that differ between two texts with the same number of lines. */
const changedLines = (a: string, b: string): number[] => lines(a).flatMap((line, i) => (line === lines(b)[i] ? [] : [i]));

describe('acceptance: changing a FIGURE caption edits only that directive line', () => {
  const doc = '# Guide\n\nIntro.\n\n<!-- ::FIGURE src="shots/login.png"   caption="The login page" width=half -->\n\nMore text.\n\n<!-- ::FIGURE src="b.png" caption="Other" -->\n';
  it('one edit, one line; the other parameters keep their own text (width=half stays unquoted)', () => {
    const at = positions(readerFor(doc).parse(doc), 'pmd_figure')[0]!;
    const out = change(doc, at, 'pmd_figure', 'figure', (old) => ({ ...old, caption: 'The new login page' }));
    expect(out.edits).toBe(1);
    expect(changedLines(doc, out.text)).toEqual([4]);
    // @pagemd/syntax's write rule (C3) joins the parameters with one space; each unchanged one is as written.
    expect(lines(out.text)[4]).toBe('<!-- ::FIGURE src="shots/login.png" caption="The new login page" width=half -->');
  });
  it('control: without the parameters as written (`raw`), width would be rewritten too (so the test above can fail)', () => {
    const t = readerFor(doc);
    const node = t.parse(doc).child(2);
    const data = node.attrs['data'] as { attrs: object };
    const fresh = t.serialize(node.type.create({ data: { attrs: { ...data.attrs, caption: 'The new login page' } } }));
    expect(fresh).toBe('<!-- ::FIGURE src="shots/login.png" caption="The new login page" width="half" -->');
  });
});

describe('the fields are @pagemd/syntax\'s params (imported, I1)', () => {
  it.each(['figure', 'annotated-image', 'embeds', 'wikilinks', 'toc', 'section', 'index-marker', 'include', 'containers'])('%s', (id) => {
    const params = syntaxItem(id).params as { key: string; type: string }[];
    expect(paramFields(id).map((f) => [f.key, f.type])).toEqual(params.map((p) => [p.key, p.type]));
  });
  it('annotated images: list rows with their own fields, and colors (D6)', () => {
    const fields = paramFields('annotated-image');
    const markers = fields.find((f) => f.key === 'markers')!;
    expect(markers.type).toBe('list');
    // P27 (R-250, C13): a marker's Size (a multiplier, 0.5-4) and Show label boxes
    expect(markers.fields!.map((f) => f.key)).toEqual(['id', 'x', 'y', 'label', 'size', 'showLabel']);
    expect(markers.fields!.find((f) => f.key === 'size')).toMatchObject({ type: 'number', label: 'Size', min: 0.5, max: 4, default: 1 });
    expect(markers.fields!.find((f) => f.key === 'showLabel')).toMatchObject({ type: 'boolean', label: 'Show label' });
    expect(fields.find((f) => f.key === 'arrows')!.fields!.find((f) => f.key === 'color')!.type).toBe('color');
  });
  it('P27 (R-249 to R-251, C13): the picture keys and the redactions have Inspector boxes on both forms', () => {
    const options = paramFields('annotated-image').find((f) => f.key === 'options')!.fields!;
    expect(options.map((f) => f.key)).toEqual(expect.arrayContaining(['crop-x', 'crop-y', 'pos-x', 'pos-y', 'crop-fit', 'rotate', 'flip', 'showLabels']));
    expect(options.find((f) => f.key === 'rotate')).toMatchObject({ type: 'enum', values: ['0', '90', '180', '270'] });
    expect(options.find((f) => f.key === 'flip')).toMatchObject({ type: 'enum', values: ['h', 'v', 'hv'] });
    expect(paramFields('annotated-image').find((f) => f.key === 'redact')!.fields!.map((f) => f.key)).toEqual(['x', 'y', 'width', 'height']);
    expect(paramFields('figure').map((f) => f.key)).toEqual(expect.arrayContaining(['crop-x', 'crop-y', 'pos-x', 'pos-y', 'rotate', 'flip']));
  });
});

describe('what the Element tab shows', () => {
  const text = '# Title {#t .big}\n\nA [link](https://x.org "T") and [[Page|Shown]].\n\n- one\n- two\n';
  const doc = readerFor(text).parse(text);
  const at = (pos: number) => editor.registry.fieldsFor(EditorState.create({ doc, selection: TextSelection.create(doc, pos) }));
  it('in a heading: its level and its {…} attributes, as two sections', () => {
    const [target] = at(3);
    expect(target!.name).toBe('heading');
    expect(target!.sections.map((s) => [s.id, s.values])).toEqual([
      ['heading', { level: '1' }],
      ['attributes', { id: 't', classes: 'big', other: [] }],
    ]);
  });
  it('in a link: the link (a mark), then the paragraph around it', () => {
    const targets = at(textPos(doc, 'link'));
    expect(targets.map((t) => t.name)).toEqual(['link', 'paragraph']);
    expect(targets[0]!.sections[0]!.values).toEqual({ href: 'https://x.org', title: 'T' });
  });
  it('in a list item: the list (innermost first)', () => {
    const pos = positions(doc, 'bullet_list')[0]! + 3;
    expect(at(pos).map((t) => t.name)).toEqual(['paragraph', 'bullet_list']);
  });
});

describe('edits write only what changed, and read back', () => {
  it('a link\'s address (a mark): one edit, the {…} and the text kept', () => {
    const text = 'See [the site](https://a.org){target=_blank} now.\n';
    const out = change(text, 6, 'link', 'link', (old) => ({ ...old, href: 'https://b.org' }));
    // The paragraph is written fresh (only it changes); writeAttributes (C3) quotes a value it writes.
    expect(out.edits).toBe(1);
    expect(out.text).toBe('See [the site](https://b.org){target="_blank"} now.\n');
  });
  it('a heading\'s level; an underlined heading becomes # at level 3', () => {
    expect(change('Title\n=====\n\nx\n', 1, 'heading', 'heading', () => ({ level: '2' })).text).toBe('Title\n---\n\nx\n');
    expect(change('Title\n=====\n\nx\n', 1, 'heading', 'heading', () => ({ level: '3' })).text).toBe('### Title\n\nx\n');
  });
  it('{…} attributes: id and classes kept in the order written; a new pair at the end', () => {
    expect(attributePairs([['class', 'a'], ['id', 'x'], ['data-k', 'v']], { id: 'y', classes: 'a', other: [{ key: 'data-k', value: 'v' }, { key: 'n', value: '1' }] })).toEqual([
      ['class', 'a'],
      ['id', 'y'],
      ['data-k', 'v'],
      ['n', '1'],
    ]);
    expect(attributePairs([['id', 'x']], { id: '', classes: '', other: [] })).toBeNull();
    expect(change('# T {#a .b}\n', 1, 'heading', 'attributes', (old) => ({ ...old, id: 'c' })).text).toBe('# T {#c .b}\n');
  });
  it('a wikilink\'s target and display', () => {
    const text = 'Go to [[Home|the start]].\n';
    expect(change(text, 7, 'pmd_wikilink', 'wikilinks', () => ({ target: 'Index', display: 'the start' })).text).toBe('Go to [[Index|the start]].\n');
  });
  it('a box\'s kind and title', () => {
    const text = '::: warning Careful\nBody\n:::\n';
    expect(change(text, 0, 'pmd_container', 'containers', () => ({ name: 'tip', title: 'Note this' })).text).toBe('::: tip Note this\nBody\n:::\n');
  });
  it('a TOC\'s levels (numbers written as directive text) and a flag', () => {
    const text = '<!-- ::TOC levels=3 -->\n';
    // A changed value is written quoted by @pagemd/syntax's directive writer; pagemd reads both.
    expect(change(text, 0, 'pmd_toc', 'toc', (old) => ({ ...old, levels: 4, section: true })).text).toBe('<!-- ::TOC levels="4" section -->\n');
  });
  it('a LAYOUT name: in the parentheses when written there; the named pages are offered', () => {
    useLayoutNames(() => ['wide']);
    const text = '<!-- ::LAYOUT(landscape) -->\n';
    const out = change(text, 0, 'pmd_layout', 'layout', () => ({ name: 'wide' }));
    expect(out.text).toBe('<!-- ::LAYOUT(wide) -->\n');
    expect(out.target.sections[0]!.fields[0]!.values).toEqual(['default', 'landscape', 'wide']);
    useLayoutNames(() => []);
  });
  it('an index term', () => {
    const text = 'Word <!-- ::INDEX term="foo" --> here.\n';
    expect(change(text, 6, 'pmd_index_marker', 'index-marker', (old) => ({ ...old, term: 'bar' })).text).toBe('Word <!-- ::INDEX term="bar" --> here.\n');
  });
  it('a lettered list\'s markers, and its start (the list\'s own)', () => {
    const text = '---\nfancy_lists: true\n---\n\nc. one\nd. two\n';
    const doc = readerFor(text).parse(text);
    const list = positions(doc, 'ordered_list')[0]!;
    expect(change(text, list, 'ordered_list', 'fancy-lists', (old) => ({ ...old, type: 'I' })).text).toBe('---\nfancy_lists: true\n---\n\nIII. one\nIV.  two\n');
    expect(change(text, list, 'ordered_list', 'lists', (old) => ({ ...old, start: 1 })).text).toBe('---\nfancy_lists: true\n---\n\na. one\nb. two\n');
  });
  it('an annotated image: a marker added through the list, the rest of the YAML as written', () => {
    const text = '::: annotated-image shot.png\n# my markers\nmarkers:\n  - { id: 1, x: 10, y: 20, label: "First" }\n:::\n';
    const out = change(text, 0, 'pmd_annotated_image', 'annotated-image', (old) => ({ ...old, markers: [...(old['markers'] as object[]), { id: '2', x: 50, y: 50 }] }));
    expect(out.text).toContain('# my markers');
    expect(out.text).toContain('{ id: 1, x: 10, y: 20, label: "First" }');
    expect(out.text).toMatch(/id: "?2"?, x: 50, y: 50/);
  });
  it('a code block\'s language; indented code becomes fenced when it gets one', () => {
    expect(change('```js\nx\n```\n', 0, 'code_block', 'code_block', () => ({ language: 'ts' })).text).toBe('```ts\nx\n```\n');
    expect(change('Text\n\n    x = 1\n', 6, 'code_block', 'code_block', () => ({ language: 'py' })).text).toBe('Text\n\n```py\nx = 1\n```\n');
  });
  it('read-only fields (an unknown directive) change nothing', () => {
    const text = '<!-- ::BREAK -->\n';
    const doc = readerFor(text).parse(text);
    const [target] = editor.registry.fieldsFor(stateAt(doc, 0));
    expect(target!.sections[0]!.fields[0]!.readOnly).toBe(true);
    expect(target!.sections[0]!.values).toEqual({ source: '<!-- ::BREAK -->' });
    expect(editor.registry.applyFields(EditorState.create({ doc }).tr, target!, 'unknown-directive', { source: 'x' })).toBe(false);
  });
});

describe('a lettered list\'s start is the list\'s own (the fancy writer uses `order`, P8)', () => {
  it('every lettered or Roman list in the corpus reads with order equal to its marker start', () => {
    const differ: string[] = [];
    let lists = 0;
    for (const file of corpus) {
      readerFor(file.text).parse(file.text).descendants((node) => {
        const fancy = node.attrs['pmdFancy'] as { start: number } | null | undefined;
        if (node.type.name !== 'ordered_list' || !fancy) return;
        lists++;
        if (node.attrs['order'] !== fancy.start) differ.push(`${file.name}: order ${String(node.attrs['order'])}, start ${fancy.start}`);
      });
    }
    expect(lists).toBeGreaterThan(10);
    expect(differ).toEqual([]);
  });
});

describe('corpus diff test for field edits (every item with fields, in every corpus file)', () => {
  /**
   * Where pagemd's own reader doesn't take a `{…}` the editor wrote (markdown-it-attrs leaves it as text after this
   * sentence, in pagemd's PDF too): the editor reads it as pagemd does (I1), so the attributes read back empty.
   */
  const PAGEMD_KEEPS_AS_TEXT = new Set(['pagemd/examples/md/09-toc-stress.md block 45 attributes.id']);
  /** Text fields an author can type anything into. */
  const textFields = (fields: readonly ItemField[]) => fields.filter((f) => f.type === 'string' && !f.readOnly && !f.values);

  it('setting the values a node already has changes nothing; changing one text field rewrites only that block, and reads back', () => {
    let checked = 0;
    const problems: string[] = [];
    for (const file of corpus) {
      const t = readerFor(file.text);
      const doc = t.parse(file.text);
      // Each kind of section is edited (and the file read again) at most three times per file: enough to cover every
      // item, quick enough to run with the other tests. The "same values" check runs on every block.
      const edited = new Map<string, number>();
      doc.forEach((block, offset, index) => {
        const target = editor.registry.fieldsFor(stateAt(doc, offset)).find((x) => x.from === offset);
        if (!target) return;
        for (const section of target.sections) {
          // The same values: no change at all.
          const same = EditorState.create({ doc }).tr;
          editor.registry.applyFields(same, target, section.id, section.values);
          if (diffToEdits(doc, same.doc, file.text).length !== 0) problems.push(`${file.name} block ${index} ${section.id}: unchanged values changed the text`);
          const field = textFields(section.fields)[0];
          if (!field || (edited.get(section.id) ?? 0) >= 3) continue;
          edited.set(section.id, (edited.get(section.id) ?? 0) + 1);
          const tr = EditorState.create({ doc }).tr;
          if (!editor.registry.applyFields(tr, target, section.id, { ...section.values, [field.key]: 'ChangedByP8' })) continue;
          const edits = diffToEdits(doc, tr.doc, file.text);
          const saved = applyEdits(file.text, edits);
          const again = t.parse(saved);
          const back = editor.registry.fieldsFor(stateAt(again, offset)).find((x) => x.from === offset)?.sections.find((s) => s.id === section.id)?.values[field.key];
          if (PAGEMD_KEEPS_AS_TEXT.has(`${file.name} block ${index} ${section.id}.${field.key}`)) continue;
          if (edits.length !== 1) problems.push(`${file.name} block ${index} ${section.id}.${field.key}: ${edits.length} edits`);
          else if (back !== 'ChangedByP8') problems.push(`${file.name} block ${index} ${section.id}.${field.key}: read back ${JSON.stringify(back)}`);
          else if (again.childCount !== doc.childCount) problems.push(`${file.name} block ${index}: the document has ${again.childCount} blocks after the edit, ${doc.childCount} before`);
          checked++;
        }
        void block;
      });
    }
    expect(problems).toEqual([]);
    expect(checked).toBeGreaterThan(100);
  }, 120_000);
});

describe('{…} attributes are offered only where they can be added safely', () => {
  const sectionsAt = (text: string, pos: number) => editor.registry.fieldsFor(stateAt(readerFor(text).parse(text), pos)).flatMap((t) => t.sections.map((s) => `${t.name}:${s.id}`));
  it('indented code: none (they would become code); fenced code: yes', () => {
    expect(sectionsAt('Text\n\n    x = 1\n', 6)).toEqual(['code_block:code_block']);
    expect(sectionsAt('```js\nx\n```\n', 0)).toEqual(['code_block:code_block', 'code_block:attributes']);
  });
  it('a paragraph that is only ":::": none (it would open a box)', () => {
    expect(sectionsAt('Text\n\n:::\n', 6)).toEqual([]);
    expect(sectionsAt('Text\n\nWords\n', 6)).toEqual(['paragraph:attributes']);
  });
});

describe('P16: the table\'s Element fields (caption, columns, {…})', () => {
  const T = '| A | B |\n| --- | --- |\n| 1 | 2 |';
  const edit = (text: string, values: (old: Record<string, unknown>) => Record<string, unknown>): { text: string; edits: number; target: FieldTarget } => change(text, 2, 'table', 'multimd-table', values);
  const fieldsOfTable = (text: string): { keys: string[]; values: Record<string, unknown> } => {
    const target = editor.registry.fieldsFor(stateAt(readerFor(text).parse(text), 2)).find((x) => x.name === 'table')!;
    const section = target.sections.find((s) => s.id === 'multimd-table')!;
    return { keys: section.fields.map((f) => f.key), values: section.values };
  };

  it('shows the caption, its kind and place, the columns and the attribute fields; the "later phase" help text is gone', () => {
    const { keys, values } = fieldsOfTable(`Table: Numbers\n\n${T}\n`);
    expect(keys).toEqual(['caption', 'captionKind', 'captionPosition', 'columns', 'id', 'classes', 'other']);
    expect(values).toMatchObject({ caption: 'Numbers', captionKind: 'Table: paragraph', captionPosition: 'above', columns: [{ align: 'none', wrap: false }, { align: 'none', wrap: false }] });
    const target = editor.registry.fieldsFor(stateAt(readerFor(T).parse(T), 2)).find((x) => x.name === 'table')!;
    expect(JSON.stringify(target.sections.map((s) => s.fields))).not.toContain('later phase');
  });

  it('adds a "Table:" caption below, changes it, moves it above, writes it as a [text] line, removes it: only that table changes', () => {
    const added = edit(`${T}\n`, (old) => ({ ...old, caption: 'Numbers' }));
    expect(added.text).toBe(`${T}\n\nTable: Numbers\n`);
    expect(added.edits).toBe(1);
    expect(edit(added.text, (old) => ({ ...old, caption: 'Counts' })).text).toBe(`${T}\n\nTable: Counts\n`);
    expect(edit(added.text, (old) => ({ ...old, captionPosition: 'above' })).text).toBe(`Table: Numbers\n\n${T}\n`);
    expect(edit(added.text, (old) => ({ ...old, captionKind: '[text] line' })).text).toBe(`${T}\n[Numbers]\n`);
    expect(edit(added.text, (old) => ({ ...old, caption: '' })).text).toBe(`${T}\n`);
  });

  it('a table with {…} gets a new caption above (pagemd does not read one below the {…} line)', () => {
    const out = edit(`${T}\n{.striped}\n`, (old) => ({ ...old, caption: 'Numbers' }));
    expect(out.text).toBe(`Table: Numbers\n\n${T}\n{.striped}\n`);
    expect(readerFor(out.text).parse(out.text).child(0).attrs['model'].tableCaption.text).toBe('Numbers');
    // and {…} added to a table with a caption below moves the caption above too
    const both = edit(`${T}\n\nTable: Numbers\n`, (old) => ({ ...old, classes: 'compact' }));
    expect(both.text).toBe(`Table: Numbers\n\n${T}\n{.compact}\n`);
  });

  it('sets a column\'s alignment and wrap; the other columns, and the extra rows of a list, change nothing', () => {
    const out = edit(`${T}\n`, (old) => ({ ...old, columns: [{ align: 'right', wrap: true }, { align: 'none', wrap: false }, { align: 'left', wrap: false }] }));
    expect(out.text).toBe('| A | B |\n| ---:+ | --- |\n| 1 | 2 |\n');
    expect(readerFor(out.text).parse(out.text).child(0).type.name).toBe('table'); // wrap marks read back as a table
    expect(edit(out.text, (old) => ({ ...old, columns: [{ align: 'center', wrap: true }, (old['columns'] as unknown[])[1]] })).text).toBe('| A | B |\n| :---:+ | --- |\n| 1 | 2 |\n');
  });

  it('id, classes and other attributes go to the {…} line under the table', () => {
    const out = edit(`${T}\n`, (old) => ({ ...old, id: 't1', classes: 'compact striped', other: [{ key: 'data-x', value: '1' }] }));
    expect(out.text).toBe(`${T}\n{#t1 .compact .striped data-x="1"}\n`);
  });

  it('FIX-FT: a table with short rows has its usual fields (its first change evens it out, AD-FIX-FT-05)', () => {
    const ragged = '| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 | 4 |\n| 5 | 6 |\n';
    const { keys } = fieldsOfTable(ragged);
    expect(keys).not.toContain('tools');
    expect(keys[0]).toBe('caption');
  });
});
