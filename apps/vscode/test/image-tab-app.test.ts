// P20 (the Image tab), at the app level: the shipped layout file against the real presets and the app's commands. Insert
// keeps only the commands that put a picture in (AD-P20-01, "move, do not copy"); the Image tab holds every moved command
// once and the new Size, Caption and Details buttons; the read-only views and Code leave the tab out; and the app's rules
// (context-tabs.ts) pick Image for a selected picture, also in a table cell, and Table for the cell's text (AD-P20-02).
// P27 (R-252): the tab's groups are Edit picture, Shapes, Size, Caption and Details; Edit picture and Shapes stay buttons (the
// layout's `"menu": false`) and fold only when the ribbon is too narrow; both Convert buttons and their ids are gone.
import { EditorState, NodeSelection, TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { createEditor, parseRibbonLayout, type Editor } from '@pagemd-editor/core';
import { commonmarkPreset } from '@pagemd-editor/preset-commonmark';
import { gfmPreset } from '@pagemd-editor/preset-gfm';
import { pagemdPreset } from '@pagemd-editor/preset-pagemd';
import { CursorTabs } from '@pagemd-editor/ribbon';
import { createTransformer } from '@pagemd-editor/transformer';
import ribbonLayoutFile from '../webview/ribbon.layout.json';
import { cursorTabs } from '../webview/context-tabs.ts';
import { imageToolCommands, pictureFieldCommands } from '../webview/image-tools.ts';
import { commentsActions, documentActions, findActions, viewActions } from '../webview/view-actions.ts';
import { RECIPES } from '../webview/views.ts';

const layout = parseRibbonLayout(ribbonLayoutFile);
const IMAGE_HOST = { state: () => undefined, editable: () => true, dispatch: () => undefined, flash: () => undefined, document: null as unknown as Document };

async function build(open: (field: string | undefined) => void = () => undefined): Promise<Editor> {
  let editor: Editor | undefined;
  editor = await createEditor({
    presets: [commonmarkPreset, gfmPreset, pagemdPreset()],
    ribbonLayout: layout,
    commands: [
      ...viewActions(() => editor!.registry.view, () => undefined),
      ...documentActions(() => undefined),
      ...findActions(() => undefined),
      ...commentsActions({ canChange: () => true, active: () => null, hasThreads: () => false, create: () => undefined, reply: () => undefined, toggleResolved: () => undefined, step: () => undefined }),
      ...imageToolCommands(IMAGE_HOST),
      ...pictureFieldCommands(open),
    ],
  });
  return editor;
}

const MOVED = [
  'annotated-image.add-marker', 'annotated-image.add-arrow', 'annotated-image.add-box', 'annotated-image.add-text', 'annotated-image.add-line', 'annotated-image.add-ellipse', 'annotated-image.add-highlight', 'annotated-image.renumber',
];
/** P27 (R-252): Edit picture. */
const EDIT = ['image.crop', 'image.rotate-left', 'image.rotate-right', 'image.flip-horizontal', 'image.flip-vertical', 'image.redact', 'image.reset'];
/** P27 (R-248): gone everywhere. (The Edit picture ids are P15's, now writing keys, R-249; cohesion matrix plan.) */
const GONE = ['figure.convert', 'annotated-image.convert'];
const NEW = ['picture.width-full', 'picture.width-half', 'picture.width-third', 'picture.width-quarter', 'picture.width-original', 'picture.caption', 'picture.caption-remove', 'picture.alt', 'picture.path', 'picture.properties'];
const tabIds = (layoutTabs: typeof layout.tabs, id: string): string[] => layoutTabs.find((t) => t.id === id)!.groups.flatMap((g) => g.commands);

describe('P20: the layout (Insert puts pictures in, the Image tab adjusts them)', () => {
  it('Insert > Pictures is the only picture group on Insert: image, figure, annotated image, embed', () => {
    const insert = tabIds(layout.tabs, 'insert');
    expect(layout.tabs.find((t) => t.id === 'insert')!.groups.find((g) => g.id === 'insert-pictures')!.commands).toEqual(['image.insert', 'figure.insert', 'annotated-image.insert', 'embeds.insert', 'figure.make-readable']);
    expect(insert.filter((id) => MOVED.includes(id) || id.startsWith('picture.'))).toEqual([]);
  });

  it('the Image tab follows Table, holds Edit picture, Shapes, Size, Caption and Details, each command once (P27, R-252)', () => {
    expect(layout.tabs.map((t) => t.id).slice(2, 5)).toEqual(['table', 'image', 'layout']);
    const image = layout.tabs.find((t) => t.id === 'image')!;
    expect(image.label).toBe('Image');
    expect(image.groups.map((g) => g.label)).toEqual(['Shapes', 'Edit picture', 'Size', 'Caption', 'Details']);
    const ids = tabIds(layout.tabs, 'image');
    expect([...ids].sort()).toEqual([...EDIT, ...MOVED, ...NEW].sort());
    // P27 amendment 3: Details folds first, then Caption, Size, Shapes; Edit picture last.
    expect(Object.fromEntries(image.groups.map((g) => [g.id, g.fold ?? 0]))).toEqual({ 'image-edit': 1, 'image-shapes': 2, 'image-size': 3, 'image-caption': 4, 'image-details': 5 });
    // R-252: the two long groups stay buttons (they fold only when the ribbon is too narrow).
    expect(image.groups.filter((g) => g.menu === false).map((g) => g.id)).toEqual(['image-shapes', 'image-edit']);
  });

  it('P27 (R-248): no Convert command exists anywhere (layout, commands, slash menu)', async () => {
    const editor = await build();
    const named = layout.tabs.flatMap((t) => t.groups.flatMap((g) => g.commands));
    for (const id of GONE) {
      expect(named, id).not.toContain(id);
      expect(editor.registry.commands.get(id), id).toBeUndefined();
    }
    expect(editor.registry.actions({ surface: 'slash', search: 'convert' }).map((a) => a.id)).toEqual([]);
    // the control: the check sees a command that is there
    expect(editor.registry.commands.get('image.crop')).toBeDefined();
  });

  it('no command id is on two tabs or in two groups; every command the app and presets have is placed', async () => {
    const editor = await build();
    const named = layout.tabs.flatMap((t) => t.groups.flatMap((g) => g.commands));
    expect(named.filter((id, i) => named.indexOf(id) !== i)).toEqual([]);
    for (const id of [...EDIT, ...MOVED, ...NEW]) expect(editor.registry.commands.get(id), id).toBeDefined();
    expect(editor.registry.ribbon().tabs.some((t) => t.id === 'more')).toBe(false);
  });

  it('control: the old Insert groups put back would put the moved ids on two tabs (the duplicate check above fails)', () => {
    const old = structuredClone(ribbonLayoutFile) as { tabs: { id: string; groups: { id: string; label: string; commands: string[] }[] }[] };
    old.tabs.find((t) => t.id === 'insert')!.groups.push({ id: 'insert-image-tools', label: 'Image tools', commands: EDIT.slice(0, 6) });
    const named = parseRibbonLayout(old).tabs.flatMap((t) => t.groups.flatMap((g) => g.commands));
    expect(named.filter((id, i) => named.indexOf(id) !== i)).toEqual(EDIT.slice(0, 6));
  });
});

describe('P20: the views (Print Preview, Read and Code never show the Image tab)', () => {
  it('Read, Print Preview and Code leave `image` out of their tab lists; Draft, Web, Print and Split show it', () => {
    for (const mode of ['read', 'preview', 'code'] as const) {
      const tabs = RECIPES[mode]!.ribbonTabs;
      expect(tabs === 'all' || tabs.includes('image'), mode).toBe(false);
    }
    for (const mode of ['draft', 'web', 'print', 'split'] as const) expect(RECIPES[mode]!.ribbonTabs, mode).toBe('all');
  });
});

describe('P20: the app\'s rules for the tabs that follow the cursor (context-tabs.ts)', () => {
  const TEXT = 'Intro.\n\n| ![Cell picture](cell.png) | b |\n|---|---|\n| c | d |\n\n<!-- ::FIGURE src="shot.png" caption="Login" -->\n\nAfter.\n';

  async function states() {
    const editor = await build();
    const t = createTransformer(editor.registry.items(), { schema: editor.schema });
    const doc = t.parse(TEXT);
    const base = EditorState.create({ schema: editor.schema, doc });
    const find = (name: string, accept: (pos: number) => boolean = () => true): number => {
      let at = -1;
      doc.descendants((node, pos) => {
        if (at < 0 && node.type.name === name && accept(pos)) at = pos;
        return at < 0;
      });
      if (at < 0) throw new Error(`no ${name}`);
      return at;
    };
    const select = (pos: number) => base.apply(base.tr.setSelection(NodeSelection.create(doc, pos)));
    const cursor = (pos: number) => base.apply(base.tr.setSelection(TextSelection.create(doc, pos)));
    const cellPicture = find('image');
    const textCell = find('text', (pos) => doc.nodeAt(pos)!.text === 'b');
    return {
      text: cursor(1),
      figure: select(find('pmd_figure')),
      cellPicture: select(cellPicture),
      cellText: cursor(textCell),
    };
  }

  it('first match wins: a selected picture (also in a table cell) gives Image, the cell text Table, plain text nothing', async () => {
    const s = await states();
    const rules = cursorTabs(() => true);
    expect([s.text, s.figure, s.cellPicture, s.cellText].map((state) => rules.autoTab(state))).toEqual([null, 'image', 'image', 'table']);
    expect([s.text, s.figure, s.cellPicture, s.cellText].map((state) => rules.contextTabs['image']!(state))).toEqual([false, true, true, false]);
  });

  it('a read-only canvas never shows the Image tab, even with a picture selected', async () => {
    const s = await states();
    const rules = cursorTabs(() => false);
    expect(rules.contextTabs['image']!(s.figure)).toBe(false);
    expect(rules.autoTab(s.figure)).toBe(null);
  });

  it('played through the ribbon\'s own logic: Home → cell → picture in the cell → cell text → out gives Table, Image, Table, Home', async () => {
    const s = await states();
    const tabs = new CursorTabs(cursorTabs(() => true));
    let selected: string | undefined = 'home';
    const seen: (string | undefined)[] = [];
    for (const state of [s.cellText, s.cellPicture, s.cellText, s.text]) seen.push((selected = tabs.follow(state, selected, () => true).selected));
    expect(seen).toEqual(['table', 'image', 'table', 'home']);
  });

  it('Caption, Alt text and Change picture open the Inspector box for the selected picture; off with no picture', async () => {
    const opened: (string | undefined)[] = [];
    const editor = await build((field) => opened.push(field));
    const s = await states();
    for (const id of ['picture.caption', 'picture.alt', 'picture.path', 'picture.properties']) expect(editor.registry.commands.run(id, s.figure, () => undefined), id).toBe(true);
    expect(opened).toEqual(['caption', 'alt', 'src', undefined]);
    for (const id of ['picture.caption', 'picture.alt', 'picture.path', 'picture.properties']) expect(editor.registry.commands.isEnabled(id, s.text), id).toBe(false);
    // A plain image in a table cell has alt text and a path, but a figure can't sit in a cell: Caption is off.
    expect(editor.registry.commands.isEnabled('picture.caption', s.cellPicture)).toBe(false);
    expect(editor.registry.commands.isEnabled('picture.alt', s.cellPicture)).toBe(true);
  });
});
