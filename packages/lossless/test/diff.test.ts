// lossless: only edited blocks change (ADR-0007, R-75, R-85; P1 acceptance criterion 2).
import { structuredPatch } from 'diff';
import type { Node } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import { createTransformer, sourceOf } from '@pagemd-editor/transformer';
import { commonmarkItems } from '@pagemd-editor/preset-commonmark';
import { applyEdits, diffToEdits } from '../src/index.ts';
import { docsFiles, plainFiles } from '../../../test/corpus/sources.ts';

const t = createTransformer(commonmarkItems);
const { schema } = t;

/** A copy of `doc` with top-level block `index` replaced (every other block stays the same object). */
const replaceBlock = (doc: Node, index: number, block: Node): Node => doc.copy(doc.content.replaceChild(index, block));
const para = (text: string): Node => schema.nodes['paragraph']!.create(null, schema.text(text));
const hunks = (a: string, b: string): number => structuredPatch('a', 'b', a, b, '', '', { context: 0 }).hunks.length;

/** Saves `next` against `doc` read from `source`; returns the new text and the edits. */
const save = (doc: Node, next: Node, source: string) => {
  const edits = diffToEdits(doc, next, source);
  return { edits, text: applyEdits(source, edits) };
};

const SOURCE = '# Title\n\nFirst paragraph\nwrapped.\n\n* one\n* two\n\n```js\ncode\n```\n\nLast paragraph.\n';

describe('diffToEdits', () => {
  it('no change → no edits', () => {
    const doc = t.parse(SOURCE);
    expect(diffToEdits(doc, doc, SOURCE)).toEqual([]);
  });

  it('one changed block → one edit covering only that block', () => {
    const doc = t.parse(SOURCE);
    const { edits, text } = save(doc, replaceBlock(doc, 1, para('Changed paragraph.')), SOURCE);
    expect(edits).toEqual([{ from: 9, to: 33, text: 'Changed paragraph.' }]);
    expect(text).toBe('# Title\n\nChanged paragraph.\n\n* one\n* two\n\n```js\ncode\n```\n\nLast paragraph.\n');
  });

  it('two separate changed blocks → two edits; neighbours untouched', () => {
    const doc = t.parse(SOURCE);
    const next = replaceBlock(replaceBlock(doc, 1, para('A')), 4, para('B'));
    const { edits, text } = save(doc, next, SOURCE);
    expect(edits).toHaveLength(2);
    expect(text).toBe('# Title\n\nA\n\n* one\n* two\n\n```js\ncode\n```\n\nB\n');
  });

  it('a run of adjacent changed blocks → one edit, keeping the original gap between them', () => {
    const source = 'a\n\n\n\nb\n\nc\n';
    const doc = t.parse(source);
    const next = replaceBlock(replaceBlock(doc, 0, para('A')), 1, para('B'));
    const { edits, text } = save(doc, next, source);
    expect(edits).toHaveLength(1);
    expect(text).toBe('A\n\n\n\nB\n\nc\n');
  });

  it('inserts and deletes blocks with one blank line of separation', () => {
    const doc = t.parse(SOURCE);
    const inserted = doc.copy(doc.content.addToEnd(para('New end.')));
    expect(save(doc, inserted, SOURCE).text).toBe(`${SOURCE.slice(0, -1)}\n\nNew end.\n`);
    const atStart = doc.copy(doc.content.addToStart(para('New start.')));
    expect(save(doc, atStart, SOURCE).text).toBe(`New start.\n\n${SOURCE}`);
    const deleted = doc.copy(doc.content.cut(0, doc.child(0).nodeSize).append(doc.content.cut(doc.child(0).nodeSize + doc.child(1).nodeSize)));
    expect(save(doc, deleted, SOURCE).text).toBe('# Title\n\n* one\n* two\n\n```js\ncode\n```\n\nLast paragraph.\n');
  });

  it('rewritten blocks use the file line ending (CRLF)', () => {
    const source = 'one\r\n\r\ntwo\r\n';
    const doc = t.parse(source);
    const block = schema.nodes['paragraph']!.create(null, schema.text('line a\nline b'));
    expect(save(doc, replaceBlock(doc, 1, block), source).text).toBe('one\r\n\r\nline a\r\nline b\r\n');
  });

  it('keeps the author’s wrapping in an edited paragraph (R-85 B)', () => {
    const source = 'first line\nsecond line\n';
    const doc = t.parse(source);
    const edited = schema.nodes['paragraph']!.create(null, schema.text(`${doc.child(0).textContent} more`));
    expect(save(doc, replaceBlock(doc, 0, edited), source).text).toBe('first line\nsecond line more\n');
  });

  it('a block equal to the original (e.g. after undo) keeps its original bytes (R-85 A)', () => {
    const source = '*  item  with   odd spacing\n\nnext\n';
    const doc = t.parse(source);
    const original = doc.child(0);
    const equalCopy = original.type.create(original.attrs, original.content, original.marks); // new object, same content
    expect(equalCopy).not.toBe(doc.child(0));
    expect(diffToEdits(doc, replaceBlock(doc, 0, equalCopy), source)).toEqual([]);
  });

  it('saving twice reuses text without re-reading (R-85 C)', () => {
    const doc = t.parse(SOURCE);
    const first = replaceBlock(doc, 1, para('Once.'));
    const saved = save(doc, first, SOURCE).text;
    expect(sourceOf(first)?.text).toBe(saved);
    const second = replaceBlock(first, 4, para('Twice.'));
    const { edits, text } = save(first, second, saved);
    expect(edits).toHaveLength(1);
    expect(text).toBe('# Title\n\nOnce.\n\n* one\n* two\n\n```js\ncode\n```\n\nTwice.\n');
    expect(t.parse(text).eq(second)).toBe(true);
  });

  it('an empty file gets the typed text', () => {
    const doc = t.parse('');
    expect(save(doc, replaceBlock(doc, 0, para('Hello')), '').text).toBe('Hello');
  });

  it('refuses a document it has no source for, or the wrong source', () => {
    const doc = t.parse(SOURCE);
    const unparsed = schema.topNodeType.create(null, para('x'));
    expect(() => diffToEdits(unparsed, doc, SOURCE)).toThrow(/not read by the transformer/);
    expect(() => diffToEdits(doc, doc, `${SOURCE}x`)).toThrow(/not the text/);
  });
});

// P1 acceptance criterion 2, over real files: change one block → exactly one diff hunk, and the
// result reads back as the edited document.
describe('one-block edit → exactly one diff hunk (corpus)', () => {
  const entries = [...plainFiles, ...docsFiles];
  it.each(entries.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
    const doc = t.parse(entry.text);
    let tried = 0;
    doc.forEach((block, _offset, index) => {
      if (block.type.name !== 'paragraph' || tried >= 5) return;
      tried++;
      const next = replaceBlock(doc, index, para(`Edited block ${index}.`));
      const { edits, text } = save(doc, next, entry.text);
      expect(edits).toHaveLength(1);
      expect(hunks(entry.text, text)).toBe(1);
      expect(t.parse(text).eq(next)).toBe(true);
    });
  });
});
