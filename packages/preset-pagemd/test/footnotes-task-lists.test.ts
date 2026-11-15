// P26: footnotes and task lists in the editor. Each reads as its own node or attribute (not a raw block), an unchanged
// document writes back byte for byte, a changed block is written by @pagemd/syntax's write rules, the canvas's numbers follow
// pagemd's, Insert ▸ Footnote is one change, a ticked box changes exactly one character of the file, and the Checklist command
// makes and unmakes tasks. Controls show each check can fail.
import { readFileSync } from 'node:fs';
import type { Node } from 'prosemirror-model';
import { EditorState, TextSelection, type Transaction } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { RAW_BLOCK, topBlocks } from '@pagemd-editor/core';
import { applyEdits, diffToEdits } from '@pagemd-editor/lossless';
import { commonmarkItems } from '@pagemd-editor/preset-commonmark';
import { gfmItems } from '@pagemd-editor/preset-gfm';
import { createTransformer } from '@pagemd-editor/transformer';
import {
  FOOTNOTE,
  FOOTNOTE_REF,
  footnoteNumbers,
  footnotesPlugin,
  insertFootnoteTransaction,
  nextLabel,
  pagemdItems,
  TASK,
  toggleTaskTransaction,
} from '../src/index.ts';

const t = createTransformer([...commonmarkItems, ...gfmItems, ...pagemdItems({})]);
const fancy = createTransformer([...commonmarkItems, ...gfmItems, ...pagemdItems({ fields: { fancy_lists: true } })]);
const commands = pagemdItems({}).flatMap((item) => item.commands ?? []);
const command = (id: string) => commands.find((c) => c.id === id)!;

/** Saves `next` against `doc` the way the editor does (only changed blocks are written). */
const save = (doc: Node, next: Node, source: string): string => applyEdits(source, diffToEdits(doc, next, source));
const nodes = (doc: Node, name: string): { node: Node; pos: number }[] => {
  const out: { node: Node; pos: number }[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === name) out.push({ node, pos });
    return true;
  });
  return out;
};
const stateAt = (text: string, pos: (doc: Node) => number, plugins = [footnotesPlugin()]): EditorState => {
  const doc = t.parse(text);
  return EditorState.create({ doc, schema: t.schema, selection: TextSelection.near(doc.resolve(pos(doc))), plugins });
};
/** One dispatch, as the canvas makes it (appended transactions included): VS Code gets it as one edit, so one undo step (R-94). */
const dispatchOnce = (state: EditorState, tr: Transaction): EditorState => state.applyTransaction(tr).state;
const run = (state: EditorState, id: string): EditorState => {
  let next = state;
  let calls = 0;
  expect(command(id).run(state, (tr: Transaction) => ((next = dispatchOnce(state, tr)), calls++))).toBe(true);
  expect(calls).toBe(1);
  return next;
};

const SHOWCASE = [
  'Footnote 1 link[^first].',
  '',
  'Footnote 2 link[^second].',
  '',
  'Inline footnote^[Text of inline footnote] definition.',
  '',
  'Duplicated footnote reference[^second].',
  '',
  '[^first]: Footnote **can have markup**',
  '',
  '    and multiple paragraphs.',
  '',
  '[^second]: Footnote text.',
  '',
].join('\n');

// The user's own showcase file, named by PAGEMD_SHOWCASE_FILE (no machine path in the repo, SAN-0b); skipped when unset
const EXAMPLE = process.env['PAGEMD_SHOWCASE_FILE'];
const exampleText = (): string | null => {
  if (!EXAMPLE) return null;
  try {
    return readFileSync(EXAMPLE, 'utf8');
  } catch {
    return null;
  }
};

describe('footnotes: read, written back, numbered as pagemd numbers them', () => {
  it('references are inline nodes, notes are blocks where they are written; nothing is raw; unchanged = byte for byte', () => {
    const doc = t.parse(SHOWCASE);
    expect(nodes(doc, RAW_BLOCK)).toEqual([]);
    expect(nodes(doc, FOOTNOTE_REF).map((r) => r.node.attrs['data'])).toEqual([
      { form: 'ref', label: 'first' },
      { form: 'ref', label: 'second' },
      { form: 'inline', content: 'Text of inline footnote' },
      { form: 'ref', label: 'second' },
    ]);
    expect(nodes(doc, FOOTNOTE).map((n) => [n.node.attrs['data'], n.node.childCount])).toEqual([
      [{ form: 'definition', label: 'first' }, 2],
      [{ form: 'definition', label: 'second' }, 1],
    ]);
    expect(save(doc, doc, SHOWCASE)).toBe(SHOWCASE);
  });

  it('written fresh (a changed block) by the write rules: the same markdown', () => {
    expect(t.serialize(t.parse(SHOWCASE))).toBe(SHOWCASE.replace(/\n$/, ''));
  });

  it('numbers by first reference, [2:1] for a second reference, as pagemd prints them', () => {
    const doc = t.parse(SHOWCASE);
    const marks = footnoteNumbers(doc);
    expect(nodes(doc, FOOTNOTE_REF).map((r) => marks.get(r.pos)?.caption)).toEqual(['[1]', '[2]', '[3]', '[2:1]']);
    expect(nodes(doc, FOOTNOTE).map((n) => marks.get(n.pos)?.caption)).toEqual(['1', '2']);
  });

  it('a note nothing refers to, and a reference whose note is deleted on the canvas, have no number and say why', () => {
    const doc = t.parse('A[^a].\n\n[^a]: Used.\n\n[^b]: Unused.\n');
    const marks = footnoteNumbers(doc);
    expect(nodes(doc, FOOTNOTE).map((n) => marks.get(n.pos))).toEqual([{ caption: '1' }, { caption: null, problem: 'Nothing refers to [^b], so pagemd leaves this note out' }]);
    const note = nodes(doc, FOOTNOTE)[0]!;
    const without = doc.copy(doc.content).type.create(null, doc.content.cut(0, note.pos));
    expect(footnoteNumbers(without).get(nodes(without, FOOTNOTE_REF)[0]!.pos)?.problem).toMatch(/No note \[\^a\]/);
  });

  it('a note inside a list, a quote and a table cell reference read and write back', () => {
    const text = '- item[^1]\n\n> quoted[^2]\n\n| a |\n|---|\n| x[^1] |\n\n[^1]: One.\n\n[^2]: Two.\n';
    const doc = t.parse(text);
    expect(nodes(doc, RAW_BLOCK)).toEqual([]);
    expect(nodes(doc, FOOTNOTE_REF)).toHaveLength(3);
    expect(save(doc, doc, text)).toBe(text);
  });

  it('control: without the footnotes item the showcase is plain text and code (as pagemd printed it before)', () => {
    const plain = createTransformer([...commonmarkItems, ...gfmItems, ...pagemdItems({}).filter((i) => i.id !== 'footnotes')]);
    expect(() => plain.parse(SHOWCASE)).not.toThrow();
    expect(nodes(plain.parse(SHOWCASE), FOOTNOTE_REF)).toEqual([]);
  });
});

describe('Insert ▸ Footnote (Word: References ▸ Insert Footnote)', () => {
  const TEXT = '# Title\n\nSome text here.\n\nMore.\n';

  it('adds a reference at the cursor and a numbered note at the end, in one change; the cursor is in the note', () => {
    const state = stateAt(TEXT, (doc) => nodes(doc, 'paragraph')[0]!.pos + 10);
    const next = run(state, 'footnotes.insert');
    const text = save(state.doc, next.doc, TEXT);
    expect(text).toBe('# Title\n\nSome text[^1] here.\n\nMore.\n\n[^1]:\n');
    expect(next.selection.$from.node(1).type.name).toBe(FOOTNOTE);
    // Typing goes into the note
    const typed = next.apply(next.tr.insertText('The note.'));
    expect(save(state.doc, typed.doc, TEXT)).toBe('# Title\n\nSome text[^1] here.\n\nMore.\n\n[^1]: The note.\n');
    // One dispatch made both (VS Code undoes them as one step: the edits go in one WorkspaceEdit)
    expect(diffToEdits(state.doc, next.doc, TEXT).length).toBeGreaterThan(0);
  });

  it('the next free number as the label; the second footnote is numbered 2 on the canvas', () => {
    const state = stateAt('A[^1].\n\n[^1]: One.\n\nB.\n', (doc) => nodes(doc, 'paragraph').at(-1)!.pos + 2);
    expect(nextLabel(state.doc)).toBe('2');
    const next = run(state, 'footnotes.insert');
    const marks = footnoteNumbers(next.doc);
    expect(nodes(next.doc, FOOTNOTE_REF).map((r) => marks.get(r.pos)?.caption)).toEqual(['[1]', '[2]']);
  });

  it('control: off where no inline text can go (a horizontal rule selected)', () => {
    const doc = t.parse('---\n\nText.\n');
    const state = EditorState.create({ doc, schema: t.schema, selection: TextSelection.create(doc, 0) });
    expect(insertFootnoteTransaction(state)).toBeNull();
  });
});

describe('Word: deleting a reference deletes its note (one undo step)', () => {
  const TEXT = 'Keep[^1] and drop[^2].\n\n[^1]: Kept.\n\n[^2]: Dropped.\n';

  it('the note goes with its last reference, in the same dispatch (one edit, one undo step)', () => {
    const state = stateAt(TEXT, () => 1);
    const ref = nodes(state.doc, FOOTNOTE_REF)[1]!;
    const next = dispatchOnce(state, state.tr.delete(ref.pos, ref.pos + ref.node.nodeSize));
    expect(save(state.doc, next.doc, TEXT)).toBe('Keep[^1] and drop.\n\n[^1]: Kept.\n');
    // control: without the plugin the note stays (a note nothing refers to)
    const bare = stateAt(TEXT, () => 1, []);
    expect(save(bare.doc, dispatchOnce(bare, bare.tr.delete(ref.pos, ref.pos + ref.node.nodeSize)).doc, TEXT)).toBe('Keep[^1] and drop.\n\n[^1]: Kept.\n\n[^2]: Dropped.\n');
  });

  it('control: a cut keeps the note (pasting the reference back finds it again); another reference keeps it too', () => {
    const state = stateAt('A[^1] B[^1].\n\n[^1]: Note.\n', () => 1);
    const [first] = nodes(state.doc, FOOTNOTE_REF);
    const one = dispatchOnce(state, state.tr.delete(first!.pos, first!.pos + 1));
    expect(nodes(one.doc, FOOTNOTE)).toHaveLength(1);
    const cut = stateAt(TEXT, () => 1);
    const ref = nodes(cut.doc, FOOTNOTE_REF)[1]!;
    const after = dispatchOnce(cut, cut.tr.delete(ref.pos, ref.pos + 1).setMeta('uiEvent', 'cut'));
    expect(nodes(after.doc, FOOTNOTE)).toHaveLength(2);
  });
});

describe('task lists: read, written back, ticked', () => {
  const TEXT = '- [x] Finish my changes\n- [ ] Push my commits\n- [X]  Capital, two spaces\n  - [ ] nested\n- plain\n';

  it('a task is a list item with its box as written; unchanged = byte for byte; fresh = the same markdown', () => {
    const doc = t.parse(TEXT);
    expect(nodes(doc, RAW_BLOCK)).toEqual([]);
    expect(nodes(doc, 'list_item').map((i) => i.node.attrs[TASK])).toEqual([
      { checked: true, mark: 'x', gap: ' ' },
      { checked: false, mark: ' ', gap: ' ' },
      { checked: true, mark: 'X', gap: '  ' },
      { checked: false, mark: ' ', gap: ' ' },
      null,
    ]);
    expect(nodes(doc, 'paragraph').map((p) => p.node.textContent)).toEqual(['Finish my changes', 'Push my commits', 'Capital, two spaces', 'nested', 'plain']);
    expect(save(doc, doc, TEXT)).toBe(TEXT);
    expect(t.serialize(doc)).toBe(TEXT.replace(/\n$/, ''));
  });

  it('ticking a box changes exactly that one character of the file (one change)', () => {
    const doc = t.parse(TEXT);
    const state = EditorState.create({ doc, schema: t.schema });
    nodes(doc, 'list_item').forEach((item, k) => {
      const tr = toggleTaskTransaction(state, item.pos);
      if (!item.node.attrs[TASK]) return expect(tr).toBeNull();
      expect(tr!.steps).toHaveLength(1);
      const text = save(doc, state.apply(tr!).doc, TEXT);
      const differ = [...text].map((c, i) => (c === TEXT[i] ? -1 : i)).filter((i) => i >= 0);
      expect(text.length, `item ${k}`).toBe(TEXT.length);
      expect(differ, `item ${k}`).toHaveLength(1);
    });
  });

  it('the rest of the list stays as written even where writing it fresh would differ ([links]() would become [links](<>))', () => {
    const text = '- [x] one\r\n- [ ] @mentions, [links](), **formatting**\r\n- [x] three\r\n';
    const doc = t.parse(text);
    const state = EditorState.create({ doc, schema: t.schema });
    const item = nodes(doc, 'list_item')[0]!;
    expect(save(doc, state.apply(toggleTaskTransaction(state, item.pos)!).doc, text)).toBe(text.replace('[x] one', '[ ] one'));
    // control: without the task item's patch rule the whole list is written fresh and another item changes too
    const plain = createTransformer([...commonmarkItems, ...gfmItems, ...pagemdItems({}).map((i) => (i.id === 'task-lists' ? { ...i, patch: undefined } : i))]);
    const pdoc = plain.parse(text);
    const pstate = EditorState.create({ doc: pdoc, schema: plain.schema });
    expect(applyEdits(text, diffToEdits(pdoc, pstate.apply(toggleTaskTransaction(pstate, item.pos)!).doc, text))).toContain('[links](<>)');
  });

  it('control: a patch that does not read back as the changed block is not used (the block is written fresh)', () => {
    const bad = createTransformer([...commonmarkItems, ...gfmItems, ...pagemdItems({}).map((i) => (i.id === 'task-lists' ? { ...i, patch: () => '- [x] something else' } : i))]);
    const text = '- [ ] one\n';
    const doc = bad.parse(text);
    const state = EditorState.create({ doc, schema: bad.schema });
    expect(applyEdits(text, diffToEdits(doc, state.apply(toggleTaskTransaction(state, 1)!).doc, text))).toBe('- [x] one\n');
  });

  it('the same in a numbered list, a lettered one and a loose list', () => {
    for (const [text, tr] of [['1. [ ] one\n2. [x] two\n', t], ['a. [ ] one\nb. [x] two\n', fancy], ['- [ ] one\n\n- [x] two\n', t]] as const) {
      const doc = tr.parse(text);
      const state = EditorState.create({ doc, schema: tr.schema });
      const item = nodes(doc, 'list_item')[0]!;
      const saved = applyEdits(text, diffToEdits(doc, state.apply(toggleTaskTransaction(state, item.pos)!).doc, text));
      expect(saved).toBe(text.replace('[ ]', '[x]'));
    }
  });

  it('control: an item whose text starts "[ ]" by escape, or a box later in the line, is no task', () => {
    for (const text of ['- \\[ ] escaped\n', '- some [ ] text\n', '- [ ]\n']) {
      expect(nodes(t.parse(text), 'list_item').map((i) => i.node.attrs[TASK])).toEqual([null]);
    }
  });
});

describe('Home ▸ Lists ▸ Checklist', () => {
  it('in a list: every selected item gets an empty box; again: the boxes go (the list stays)', () => {
    const TEXT = '- one\n- two\n';
    const state = stateAt(TEXT, () => 3, []);
    const all = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 3, state.doc.content.size - 3)));
    const on = run(all, 'task-lists.toggle');
    expect(save(state.doc, on.doc, TEXT)).toBe('- [ ] one\n- [ ] two\n');
    expect(command('task-lists.toggle').isActive!(on)).toBe(true);
    const off = run(on, 'task-lists.toggle');
    expect(save(state.doc, off.doc, TEXT)).toBe(TEXT);
  });

  it('outside a list: the paragraph becomes a bulleted checklist (one change)', () => {
    const TEXT = 'Buy milk\n';
    const state = stateAt(TEXT, () => 2, []);
    const next = run(state, 'task-lists.toggle');
    expect(save(state.doc, next.doc, TEXT)).toBe('- [ ] Buy milk\n');
  });

  it('control: not active in a plain list', () => {
    const state = stateAt('- one\n', () => 3, []);
    expect(command('task-lists.toggle').isActive!(state)).toBe(false);
  });
});

describe('the user\'s showcase file (PAGEMD_SHOWCASE_FILE, e.g. the Desktop example.md; skipped when unset or missing)', () => {
  const text = exampleText();
  it.skipIf(!text)('the Footnotes and Task lists sections read as footnotes and tasks; the file writes back byte for byte', () => {
    const doc = t.parse(text!);
    expect(nodes(doc, FOOTNOTE_REF)).toHaveLength(4);
    expect(nodes(doc, FOOTNOTE)).toHaveLength(2);
    expect(nodes(doc, 'list_item').filter((i) => i.node.attrs[TASK])).toHaveLength(7);
    expect(save(doc, doc, text!)).toBe(text);
    // Ticking each task box changes one character of the file (CRLF kept)
    const state = EditorState.create({ doc, schema: t.schema });
    for (const item of nodes(doc, 'list_item').filter((i) => i.node.attrs[TASK])) {
      const saved = save(doc, state.apply(toggleTaskTransaction(state, item.pos)!).doc, text!);
      expect([...saved].filter((c, i) => c !== text![i]).length).toBe(1);
      expect(saved.length).toBe(text!.length);
    }
    expect(topBlocks(doc).length).toBeGreaterThan(50);
  });
});

describe('the Inspector (P8 fields)', () => {
  const items = pagemdItems({});
  const footnoteFields = items.find((i) => i.id === 'footnotes')!.fields!;
  const taskFields = items.find((i) => i.id === 'task-lists')!.extend!.nodes!['list_item']!.fields!;
  const fieldsOf = (binding: { fields: unknown }, owner: Node) => (typeof binding.fields === 'function' ? binding.fields(owner) : binding.fields) as { key: string }[];

  it('a reference shows its label, an inline note its text; a change goes into the data (written by the write rule)', () => {
    const doc = t.parse(SHOWCASE);
    const [first, , inline] = nodes(doc, FOOTNOTE_REF);
    const ref = footnoteFields[FOOTNOTE_REF]!;
    expect(fieldsOf(ref, first!.node).map((f) => f.key)).toEqual(['label']);
    expect(ref.values(first!.node)).toEqual({ label: 'first' });
    expect(fieldsOf(ref, inline!.node).map((f) => f.key)).toEqual(['content']);
    expect(ref.apply(inline!.node, { content: 'New text' })).toEqual({ data: { form: 'inline', content: 'New text' } });
    // control: unchanged values change nothing; an empty label is refused
    expect(ref.apply(first!.node, { label: 'first' })).toEqual({});
    expect(ref.apply(first!.node, { label: '' })).toEqual({});
  });

  it('a task shows Done; ticking it there toggles the box (the keyboard\'s way); a plain item has no field', () => {
    const doc = t.parse('- [ ] todo\n- plain\n');
    const [task, plain] = nodes(doc, 'list_item');
    expect(fieldsOf(taskFields, task!.node).map((f) => f.key)).toEqual(['checked']);
    expect(taskFields.values(task!.node)).toEqual({ checked: false });
    expect(taskFields.apply(task!.node, { checked: true })).toEqual({ [TASK]: { checked: true, mark: 'x', gap: ' ' } });
    expect(fieldsOf(taskFields, plain!.node)).toEqual([]);
    expect(taskFields.apply(task!.node, { checked: false })).toEqual({});
  });
});
