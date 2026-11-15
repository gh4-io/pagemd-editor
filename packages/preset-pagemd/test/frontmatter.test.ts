// P8 (R-160, R-161): the frontmatter node and the document properties. Which text is a frontmatter follows pagemd's
// reader (gray-matter), the node writes back exactly what it read, and a property edit changes only that value
// (ADR-0016 M4, ADR-0007): comments, key order, quoting and the author's own key stay.
import { EditorState, type Transaction } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { diffToEdits, applyEdits } from '@pagemd-editor/lossless';
import { commonmarkItems } from '@pagemd-editor/preset-commonmark';
import { gfmItems } from '@pagemd-editor/preset-gfm';
import { createTransformer } from '@pagemd-editor/transformer';
import { canonical, FRONTMATTER_NODE, frontmatterBlock, frontmatterProperties as props, gateFields, pagemdItems, readProperties } from '../src/index.ts';
import { corpus, transformerFor } from './corpus-files.ts';

const t = createTransformer([...commonmarkItems, ...gfmItems, ...pagemdItems()]);

/** Runs `edit` on the document read from `text` and returns the saved text (only changed blocks rewritten). */
function saved(text: string, edit: (tr: Transaction) => boolean): { text: string; ok: boolean; edits: number } {
  const doc = t.parse(text);
  const tr = EditorState.create({ doc }).tr;
  const ok = edit(tr);
  const edits = diffToEdits(doc, tr.doc, text);
  return { text: applyEdits(text, edits), ok, edits: edits.length };
}

describe('which text is a frontmatter (pagemd reads it with gray-matter)', () => {
  // gray-matter 4.0.3's answers for these texts, recorded in session 23 (pagemd's parser, `extractFrontmatter`).
  it.each([
    ['plain', '---\ntitle: A\n---\n\nBody\n', 'title: A'],
    ['Windows line endings', '---\r\ntitle: A\r\n---\r\nBody', 'title: A'],
    ['empty', '---\n---\nBody', null],
    ['one blank line', '---\n\n---\n', ''],
    ['spaces after the dashes', '---  \ntitle: A\n---\t\nx', 'title: A'],
    ['comments only', '---\n# only a comment\n---\n', '# only a comment'],
  ])('%s: a frontmatter', (_name, text, yaml) => {
    const block = frontmatterBlock(text);
    expect(block?.yaml === null ? null : block?.yaml.replace(/\r/g, '')).toBe(yaml);
  });

  it.each([
    // gray-matter: no frontmatter at all
    ['four dashes', '----\ntitle: A\n----\n'],
    ['not at the start', 'Text\n---\na: 1\n---\n'],
    ['indented', ' ---\na: 1\n---\n'],
    // gray-matter takes these as a frontmatter in an unusual way; the editor leaves them as markdown (unchanged since P3)
    ['a language after the dashes', '---yaml\ntitle: A\n---\n'],
    ['more after the closing dashes', '---\ntitle: A\n---x\nBody\n'],
    ['a longer closing line', '---\na: 1\n----\nBody\n'],
    ['no closing line', '---\ntitle: A\n'],
    ['"..." closing (gray-matter: a YAML error)', '---\ntitle: A\n...\nBody\n'],
  ])('%s: left as markdown', (_name, text) => {
    expect(frontmatterBlock(text)).toBeNull();
    expect(t.parse(text).child(0).type.name).not.toBe(FRONTMATTER_NODE);
  });

  it('a frontmatter is one node with its exact lines; the rest of the document reads as before', () => {
    const doc = t.parse('---\ntitle: Doc # comment\ndoc_id: X-1\n---\n\n# Body\n');
    expect(doc.childCount).toBe(2);
    expect(doc.child(0).type.name).toBe(FRONTMATTER_NODE);
    expect(doc.child(0).attrs).toEqual({ yaml: 'title: Doc # comment\ndoc_id: X-1', open: '---', close: '---' });
    expect(doc.child(1).type.name).toBe('heading');
  });

  it('only at the very start of the document, never inside a block', () => {
    expect(t.parse('> ---\n> a: 1\n> ---\n').child(0).type.name).toBe('blockquote');
    expect(t.parse('Text\n\n---\na: 1\n---\n').child(0).type.name).toBe('paragraph');
  });
});

describe('written back exactly (ADR-0007)', () => {
  it.each(['---\ntitle: A\n---\n\nBody\n', '---\r\ntitle: A\r\nlist:\r\n  - x\r\n---\r\nBody\r\n', '---\n---\n', '---\n\n---\n', '---  \na: 1 # c\n---\t\n'])('untouched: byte for byte (%j)', (text) => {
    expect(saved(text, () => true).text).toBe(text);
  });

  it('written fresh (a changed block): the same text', () => {
    for (const text of ['---\ntitle: A\n# c\n---', '---\n---', '---\n\n---', '---  \na: 1\n---\t']) expect(t.serialize(t.parse(text))).toBe(text);
  });

  it('the golden corpus: every file with a frontmatter has the node, and reads back to the same document', () => {
    const withFrontmatter = corpus.filter((f) => frontmatterBlock(f.text));
    expect(withFrontmatter.length).toBeGreaterThan(20);
    for (const file of withFrontmatter) {
      const reader = transformerFor(file.text);
      const doc = reader.parse(file.text);
      expect(doc.child(0).type.name, file.name).toBe(FRONTMATTER_NODE);
      expect(reader.parse(reader.serialize(doc)).child(0).eq(doc.child(0)), file.name).toBe(true);
    }
  });
});

describe('properties: reading', () => {
  it('reads with pagemd\'s rules and names each property by the catalogue (nicknames: doc_id → document_id)', () => {
    const state = props.read(t.parse('---\ntitle: Doc\ndoc_id: X-1\ndate: 2024-01-15\ncustom_thing: 3\n---\n'))!;
    expect(state.entries.map((e) => [e.key, e.written])).toEqual([
      ['title', 'title'],
      ['document_id', 'doc_id'],
      ['effective_date', 'date'], // `date` is an alias of effective_date in @pagemd/meta
      ['custom_thing', 'custom_thing'],
    ]);
    expect(state.entries[2]!.value).toBeInstanceOf(Date); // js-yaml 4's rules, as pagemd
  });
  it('none: null; unreadable: an error and no entries', () => {
    expect(props.read(t.parse('# Just text\n'))).toBeNull();
    const bad = props.read(t.parse('---\ntitle: [unclosed\n---\n'))!;
    expect(bad.entries).toEqual([]);
    expect(bad.error).toMatch(/./);
    expect(props.read(t.parse('---\n- a list\n---\n'))!.error).toMatch(/not a list of "key: value"/);
  });
  it('canonical names follow @pagemd/meta (aliases and spelling)', () => {
    expect(['doc_id', 'rev', 'eff_date', 'docId', 'title'].map(canonical)).toEqual(['document_id', 'revision', 'effective_date', 'document_id', 'title']);
    expect(readProperties('')).toEqual({ data: {} });
  });
});

describe('properties: editing changes only that value (M4)', () => {
  const doc = '---\n# The document\ntitle: Old title   # keep me\ndoc_id: "X-1"\nauthors:\n  - Ann\n---\n\n# Body\n\nText.\n';

  it('a value: one line changes, comments, order and quoting stay', () => {
    const out = saved(doc, (tr) => props.set(tr, 'title', 'New title'));
    expect(out.ok).toBe(true);
    expect(out.text).toBe(doc.replace('Old title', 'New title'));
    expect(out.edits).toBe(1);
  });

  it('a property written under a nickname is edited in place under that key (doc_id stays doc_id)', () => {
    const out = saved(doc, (tr) => props.set(tr, 'document_id', 'X-2'));
    expect(out.text).toBe(doc.replace('"X-1"', '"X-2"'));
  });

  it('a new property is added after the others; the rest stays', () => {
    const out = saved(doc, (tr) => props.set(tr, 'fancy_lists', true));
    expect(out.text).toBe(doc.replace('  - Ann\n', '  - Ann\nfancy_lists: true\n'));
  });

  it('no frontmatter yet: one is added at the start, the body is untouched', () => {
    const out = saved('# Body\n\nText.\n', (tr) => props.set(tr, 'fancy_lists', true));
    expect(out.text).toBe('---\nfancy_lists: true\n---\n\n# Body\n\nText.\n');
    expect(saved('---\n# only a comment\n---\nBody\n', (tr) => props.set(tr, 'title', 'T')).text).toBe('---\n# only a comment\ntitle: T\n---\nBody\n');
  });

  it('Windows line endings stay Windows line endings', () => {
    const crlf = '---\r\ntitle: A\r\n---\r\n\r\nBody\r\n';
    expect(saved(crlf, (tr) => props.set(tr, 'title', 'B')).text).toBe(crlf.replace('A', 'B'));
    expect(saved(crlf, (tr) => props.set(tr, 'version', '2')).text).toBe('---\r\ntitle: A\r\nversion: "2"\r\n---\r\n\r\nBody\r\n');
  });

  it('a date stays a plain calendar date (changed or added)', () => {
    const text = '---\ndate: 2024-01-15\n---\n';
    expect(saved(text, (tr) => props.set(tr, 'effective_date', '2024-02-01')).text).toBe('---\ndate: 2024-02-01\n---\n');
    expect(saved('---\ntitle: A\n---\n', (tr) => props.set(tr, 'effective_date', '2024-02-01')).text).toBe('---\ntitle: A\neffective_date: 2024-02-01\n---\n');
    // not a date property: text that looks like a date is quoted, so it stays text
    expect(saved('---\ntitle: A\n---\n', (tr) => props.set(tr, 'version', '2024-02-01')).text).toBe('---\ntitle: A\nversion: "2024-02-01"\n---\n');
  });

  it('removing: that line only (comments kept); the last one leaves the frontmatter empty', () => {
    expect(saved(doc, (tr) => props.remove(tr, 'document_id')).text).toBe(doc.replace('doc_id: "X-1"\n', ''));
    expect(saved('---\ntitle: A\n---\nB\n', (tr) => props.remove(tr, 'title')).text).toBe('---\n---\nB\n');
    expect(saved(doc, (tr) => props.remove(tr, 'nothing_here')).ok).toBe(false);
  });

  it('setting the same value changes nothing', () => {
    const out = saved(doc, (tr) => props.set(tr, 'title', 'Old title'));
    expect(out.edits).toBe(0);
  });

  it('unreadable YAML: nothing is changed (only the raw text can be edited then)', () => {
    const bad = '---\ntitle: [unclosed\n---\n';
    expect(saved(bad, (tr) => props.set(tr, 'title', 'x'))).toEqual({ text: bad, ok: false, edits: 0 });
    expect(saved(bad, (tr) => props.setText(tr, 'title: fixed')).text).toBe('---\ntitle: fixed\n---\n');
  });

  it('the raw text: replaced as typed (line endings normalised, trailing blank lines dropped); empty keeps an empty frontmatter', () => {
    expect(saved(doc, (tr) => props.setText(tr, 'a: 1\r\nb: 2\n\n')).text).toBe('---\na: 1\nb: 2\n---\n\n# Body\n\nText.\n');
    expect(saved(doc, (tr) => props.setText(tr, '')).text).toBe('---\n---\n\n# Body\n\nText.\n');
  });

  it('a change the edit can\'t make in place is refused, never guessed (duplicate keys)', () => {
    const dup = '---\ntitle: A\ntitle: B\n---\n';
    expect(saved(dup, (tr) => props.set(tr, 'title', 'C')).ok).toBe(false);
  });

  it('gates and TOC settings come from the same reader', () => {
    expect(gateFields('---\nfancy_lists: true\n---\n')).toEqual({ fancy_lists: true });
    // a closing line with more on it: not a frontmatter for the editor, so nothing switches on
    expect(gateFields('---\nfancy_lists: true\n---x\n')).toEqual({ fancy_lists: false });
  });
});
