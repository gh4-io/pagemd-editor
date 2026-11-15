// P11 find: what counts as text, where the matches are, and what a replacement does to the saved text (R-175).
import { EditorState, TextSelection } from 'prosemirror-state';
import type { DecorationSet } from 'prosemirror-view';
import { describe, expect, it } from 'vitest';
import { createTransformer } from '@pagemd-editor/transformer';
import { commonmarkItems } from '@pagemd-editor/preset-commonmark';
import { gfmItems } from '@pagemd-editor/preset-gfm';
import { pagemdItems } from '@pagemd-editor/preset-pagemd';
import { findKey, findPlugin, findRanges, indexFrom, queryExpression, replaceInto, MAX_MATCHES } from '../src/index.ts';

const t = createTransformer([...commonmarkItems, ...gfmItems, ...pagemdItems({ fields: { fancy_lists: true } })]);
const opts = { matchCase: false, wholeWord: false };
const textsOf = (text: string, query: string, options = opts): string[] => {
  const doc = t.parse(text);
  return findRanges(doc, query, options).ranges.map((r) => doc.textBetween(r.from, r.to));
};

describe('what is searched', () => {
  it('finds visible text, across bold and links, never the markup characters', () => {
    expect(textsOf('A **bo**ld word and [a link](http://x.test) here.\n', 'bold')).toEqual(['bold']);
    expect(textsOf('A **bold** word.\n', '**')).toEqual([]);
    expect(textsOf('A [link](http://x.test).\n', 'http')).toEqual([]);
    expect(textsOf('Some `code` here.\n', 'code')).toEqual(['code']);
  });
  it('does not look into a raw block (kept as its exact source, I4)', () => {
    const { nodes } = t.schema;
    const doc = nodes['doc']!.create(null, [nodes['raw_block']!.create(null, t.schema.text('raw cat inside')), nodes['paragraph']!.create(null, t.schema.text('A cat outside.'))]);
    expect(findRanges(doc, 'cat', opts).ranges.map((r) => doc.textBetween(r.from, r.to))).toEqual(['cat']);
    expect(findRanges(doc, 'cat', opts).ranges[0]!.from).toBeGreaterThan(doc.firstChild!.nodeSize); // the one in the paragraph
  });
  it('does not look into a directive, and cannot see an HTML comment', () => {
    expect(textsOf('<!-- ::PAGEBREAK -->\n\nfoo\n', 'PAGEBREAK')).toEqual([]);
    expect(textsOf('<!-- ::FIGURE src="a.png" caption="Login" -->\n\nbody\n', 'Login')).toEqual([]);
  });
  it('skips what the app says is hidden (a drawn diagram source)', () => {
    const doc = t.parse('```mermaid\ngraph LR\n```\n\ngraph here\n');
    const all = findRanges(doc, 'graph', opts).ranges;
    const visible = findRanges(doc, 'graph', opts, (node) => !(node.type.name === 'code_block' && node.attrs['params'] === 'mermaid')).ranges;
    expect(all).toHaveLength(2);
    expect(visible).toHaveLength(1);
  });
  it('a match never spans a chip or a line break', () => {
    expect(textsOf('one  \ntwo\n', 'one two')).toEqual([]);
    expect(textsOf('say [[Target]] now\n', 'say')).toEqual(['say']);
  });
});

describe('matching', () => {
  it('ignores case unless asked, and can match whole words only', () => {
    expect(textsOf('Cat cat concat CAT\n', 'cat')).toHaveLength(4);
    expect(textsOf('Cat cat concat CAT\n', 'cat', { matchCase: true, wholeWord: false })).toEqual(['cat', 'cat']);
    expect(textsOf('Cat cat concat CAT\n', 'cat', { matchCase: false, wholeWord: true })).toEqual(['Cat', 'cat', 'CAT']);
  });
  it('the query is plain text: pattern characters mean themselves', () => {
    expect(textsOf('1+1 (a) [b] a.b a*b\n', '1+1')).toEqual(['1+1']);
    expect(textsOf('1+1 (a) [b] a.b axb\n', 'a.b')).toEqual(['a.b']);
    expect(textsOf('x (a) y\n', '(a)')).toEqual(['(a)']);
    expect(queryExpression('', opts)).toBeNull();
  });
  it('whole-word counts accented letters and digits as word characters', () => {
    expect(textsOf('café cafés café2\n', 'café', { matchCase: false, wholeWord: true })).toEqual(['café']);
  });
  it('stops at the cap', () => {
    const doc = t.parse(`${'a '.repeat(MAX_MATCHES + 50)}\n`);
    const found = findRanges(doc, 'a', opts);
    expect(found.ranges).toHaveLength(MAX_MATCHES);
    expect(found.capped).toBe(true);
  });
  it('indexFrom: the first match at or after a position, wrapping', () => {
    const r = [{ from: 3, to: 4 }, { from: 9, to: 10 }];
    expect([indexFrom(r, 0), indexFrom(r, 4), indexFrom(r, 10), indexFrom([], 0)]).toEqual([0, 1, 0, -1]);
  });
});

describe('replacing', () => {
  const replaceAll = (text: string, query: string, replacement: string): string => {
    const doc = t.parse(text);
    const state = EditorState.create({ doc, schema: t.schema });
    const tr = replaceInto(state.tr, state, findRanges(doc, query, opts).ranges, replacement);
    return t.serialize(tr.doc).replace(/\n*$/, '\n'); // (the transformer leaves the file's last newline to the lossless layer)
  };
  it('keeps the marks, and writes the same text for every block it did not touch', () => {
    const before = '# Title\n\nA **bold cat** and a cat.\n\n- item one\n- item two\n';
    expect(replaceAll(before, 'cat', 'dog')).toBe('# Title\n\nA **bold dog** and a dog.\n\n- item one\n- item two\n');
  });
  it('an empty replacement deletes; a replacement longer than the match is fine', () => {
    expect(replaceAll('a cat sat\n', 'cat ', '')).toBe('a sat\n');
    expect(replaceAll('a cat sat\n', 'cat', 'tomcat')).toBe('a tomcat sat\n');
  });
  it('several matches in one block with a replacement of another length (the later ones are changed first)', () => {
    expect(replaceAll('cat and cat and cat\n', 'cat', 'elephant')).toBe('elephant and elephant and elephant\n');
    expect(replaceAll('cat and cat and cat\n', 'cat', 'x')).toBe('x and x and x\n');
  });
  it('is ONE transaction for every match', () => {
    const doc = t.parse('cat\n\ncat\n\ncat\n');
    const state = EditorState.create({ doc, schema: t.schema });
    const tr = replaceInto(state.tr, state, findRanges(doc, 'cat', opts).ranges, 'dog');
    expect(tr.steps.length).toBe(3);
    expect(t.serialize(state.apply(tr).doc)).toBe('dog\n\ndog\n\ndog');
  });
  it('a typed * in the replacement is text, written escaped, not bold', () => {
    expect(replaceAll('a cat\n', 'cat', '*dog*')).toBe('a \\*dog\\*\n');
  });
});

describe('the plugin state', () => {
  const plugin = findPlugin({ isOpen: () => true, onKey: () => true });
  const stateFor = (text: string) => EditorState.create({ doc: t.parse(text), schema: t.schema, plugins: [plugin] });
  it('holds matches and highlights while the bar is open, none after it closes', () => {
    let state = stateFor('one cat\n\ntwo cat\n');
    state = state.apply(state.tr.setMeta(findKey, { query: 'cat', options: opts, active: true }));
    const found = findKey.getState(state)!;
    expect(found.ranges).toHaveLength(2);
    expect(found.current).toBe(0);
    expect((plugin.props.decorations!.call(plugin, state) as DecorationSet).find()).toHaveLength(2);
    state = state.apply(state.tr.setMeta(findKey, { query: 'cat', options: opts, active: false }));
    expect(findKey.getState(state)!.ranges).toEqual([]);
  });
  it('finds again after the document changes, and the current match follows', () => {
    let state = stateFor('cat one\n\ncat two\n');
    state = state.apply(state.tr.setMeta(findKey, { query: 'cat', options: opts, active: true, current: 1 }));
    expect(findKey.getState(state)!.current).toBe(1);
    state = state.apply(state.tr.insertText('big ', 1)); // "big cat one": both matches move
    const found = findKey.getState(state)!;
    expect(found.ranges).toHaveLength(2);
    expect(found.ranges[0]!.from).toBe(5);
    expect(found.current).toBe(1);
  });
  it('the first match is the one at or after the cursor', () => {
    let state = stateFor('cat one\n\ncat two\n');
    const second = t.parse('cat one\n\ncat two\n').child(0).nodeSize + 1;
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, second)));
    state = state.apply(state.tr.setMeta(findKey, { query: 'cat', options: opts, active: true }));
    expect(findKey.getState(state)!.current).toBe(1);
  });
});
