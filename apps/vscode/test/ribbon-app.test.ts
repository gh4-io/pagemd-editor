// P7 acceptance, at the app level: the shipped ribbon layout file against the real presets and the app's view
// commands. Every id the layout names exists (outside the reserved group), every command is placed (no "More" tab
// for the shipped presets), removing preset-pagemd removes its buttons with no UI change, the view commands follow the
// view state, and the editor UI's CSS uses only VS Code's variables.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { createEditor, parseRibbonLayout, type CommandSpec, type Editor, type OutputFormat, type Preset } from '@pagemd-editor/core';
import { commonmarkPreset } from '@pagemd-editor/preset-commonmark';
import { gfmPreset } from '@pagemd-editor/preset-gfm';
import { pagemdPreset } from '@pagemd-editor/preset-pagemd';
import { ribbonCss, ribbonModel } from '@pagemd-editor/ribbon';
import { selectionToolbarCss } from '@pagemd-editor/selection-toolbar';
import { slashMenuCss } from '@pagemd-editor/slash-menu';
import ribbonLayoutFile from '../webview/ribbon.layout.json';
import { commentsActions, documentActions, filesActions, findActions, viewActions, quickAccessActions } from '../webview/view-actions.ts';
import { imageToolCommands, pictureFieldCommands } from '../webview/image-tools.ts';
import { RECIPES } from '../webview/views.ts';
import type { WebviewCommand } from '../shared/protocol.ts';

const layout = parseRibbonLayout(ribbonLayoutFile);
/** P15: the image tools with nothing behind them (the layout only needs their ids). */
const IMAGE_HOST = { state: () => undefined, editable: () => true, dispatch: () => undefined, flash: () => undefined, document: null as unknown as Document };

async function build(presets: Preset[], formats: OutputFormat[] = ['pdf', 'html', 'png']): Promise<{ editor: Editor; commands: WebviewCommand[] }> {
  const commands: WebviewCommand[] = [];
  let editor: Editor | undefined;
  const output = { formats: () => formats, hasProfiles: () => true, runCommand: (c: WebviewCommand) => void commands.push(c) };
  editor = await createEditor({ presets, ribbonLayout: layout, commands: [...viewActions(() => editor!.registry.view, (c) => commands.push(c)), ...documentActions(() => undefined, output), ...filesActions({ isOpen: () => false, toggle: () => undefined }), ...findActions(() => undefined), ...commentsActions({ canChange: () => true, active: () => null, hasThreads: () => false, create: () => undefined, reply: () => undefined, toggleResolved: () => undefined, step: () => undefined }), ...imageToolCommands(IMAGE_HOST), ...pictureFieldCommands(() => undefined), ...quickAccessActions(() => undefined)], view: { mode: 'print' } });
  return { editor, commands };
}
const ids = (specs: readonly CommandSpec[]): string[] => specs.map((c) => c.id);
const placed = (editor: Editor): string[] => editor.registry.ribbon().tabs.flatMap((t) => t.groups.flatMap((g) => g.commands));

describe('the shipped ribbon layout file', () => {
  it('names the six tabs of ADR-0013 / P7, P16\'s Table and P20\'s Image; P15\'s tools moved from Insert to Image (P20); P14 filled "Check" (R-189)', () => {
    expect(layout.tabs.map((t) => t.id)).toEqual(['home', 'insert', 'table', 'image', 'layout', 'document', 'review', 'view']);
    expect(layout.tabs.flatMap((t) => t.groups).filter((g) => g.reserved)).toEqual([]);
    const insert = layout.tabs.find((t) => t.id === 'insert')!.groups;
    // P26: Insert ▸ Notes (Footnote) after Basics; Home ▸ Tasks (Checklist) after Lists
    expect(insert.map((g) => g.id)).toEqual(['insert-basics', 'insert-notes', 'insert-pictures', 'insert-box', 'insert-callout', 'insert-include']);
    expect(layout.tabs.find((t) => t.id === 'home')!.groups.map((g) => g.id)).toEqual(['home-quick', 'home-text', 'home-styles', 'home-lists', 'home-tasks', 'home-blocks', 'home-editing']) // OQ-67: Save, Undo, Redo first;
    const image = layout.tabs.find((t) => t.id === 'image')!.groups;
    // P27 (R-252): Edit picture replaces Adjust (keys, no pixels); the Convert group is gone (R-248)
    expect(image.find((g) => g.id === 'image-edit')).toMatchObject({ label: 'Edit picture', menu: false, commands: ['image.crop', 'image.rotate-left', 'image.rotate-right', 'image.flip-horizontal', 'image.flip-vertical', 'image.redact', 'image.reset'] });
    expect(image.find((g) => g.id === 'image-shapes')).toMatchObject({ menu: false });
    expect(image.find((g) => g.id === 'image-shapes')!.commands).toHaveLength(8);
    expect(image.find((g) => g.id === 'image-convert')).toBeUndefined();
    expect(layout.tabs.flatMap((t) => t.groups).find((g) => g.id === 'document-check')).toMatchObject({ id: 'document-check', label: 'Check', commands: ['document.check'] });
  });

  it('P10/P14: the Document tab has Print Preview, Export PDF/HTML/PNG, Profile and Check Document, each running its VS Code command', async () => {
    const { editor, commands } = await build([commonmarkPreset, gfmPreset, pagemdPreset()]);
    const document = editor.registry.ribbon().tabs.find((t) => t.id === 'document')!;
    expect(document.groups.map((g) => [g.id, g.commands])).toEqual([
      ['document-properties', ['document.properties']],
      ['document-contents', ['toc.insert', 'index.insert']],
      ['document-output', ['document.preview', 'document.export-pdf', 'document.export-html', 'document.export-png']],
      ['document-profile', ['document.profile']],
      ['document-files', ['document.files-in-use']], // P25
      ['document-check', ['document.check']],
    ]);
    for (const id of ['document.preview', 'document.export-pdf', 'document.export-html', 'document.export-png', 'document.profile', 'document.check']) editor.registry.commands.run(id, null as never, () => undefined);
    expect(commands).toEqual(['pagemd.printPreview', 'pagemd.exportToPdf', 'pagemd.exportToHtml', 'pagemd.exportToPng', 'pagemd.chooseProfile', 'pagemd.checkDocument']);
    const view = editor.registry.ribbon().tabs.find((t) => t.id === 'view')!;
    // its own group: a group of more than six buttons becomes a menu (the View group keeps its six views as buttons)
    expect(view.groups.find((g) => g.id === 'view-preview')!.commands).toEqual(['view.preview']);
  });

  it('P10: without pagemd (plain HTML only) Export PDF and PNG are greyed out, HTML is not', async () => {
    const { editor } = await build([commonmarkPreset, gfmPreset, pagemdPreset()], ['html']);
    expect(['document.export-pdf', 'document.export-html', 'document.export-png'].map((id) => editor.registry.commands.isEnabled(id, null as never))).toEqual([false, true, false]);
  });

  it('names only commands that exist (outside reserved groups), each once', async () => {
    const { editor } = await build([commonmarkPreset, gfmPreset, pagemdPreset()]);
    const known = new Set(ids(editor.registry.commands.list()));
    const named = layout.tabs.flatMap((t) => t.groups.filter((g) => !g.reserved).flatMap((g) => g.commands));
    expect(named.filter((id) => !known.has(id))).toEqual([]);
    expect(named.filter((id, i) => named.indexOf(id) !== i)).toEqual([]);
  });

  it('places every command: with all three presets nothing lands in "More"', async () => {
    const { editor } = await build([commonmarkPreset, gfmPreset, pagemdPreset()]);
    const tabs = editor.registry.ribbon().tabs;
    expect(tabs.map((t) => t.id)).toEqual(['home', 'insert', 'table', 'image', 'layout', 'document', 'review', 'view']);
    expect(placed(editor).sort()).toEqual(ids(editor.registry.commands.list()).sort());
  });

  it('P27 (R-252): on the Image tab, Edit picture (seven) and Shapes (eight) are buttons, not drop-downs; Insert has none of them', async () => {
    const { editor } = await build([commonmarkPreset, gfmPreset, pagemdPreset()]);
    const groups = editor.registry.ribbon().tabs.find((t) => t.id === 'image')!.groups.map((g) => g.id);
    expect(groups).toEqual(['image-shapes', 'image-edit', 'image-size', 'image-caption', 'image-details']);
    const actions = editor.registry.actions({ surface: 'ribbon', tab: 'image' });
    expect(actions.filter((a) => a.group?.id === 'image-edit')).toHaveLength(7);
    expect(actions.filter((a) => a.group?.id === 'image-shapes')).toHaveLength(8);
    const model = ribbonModel(editor.registry, { selected: 'image' });
    expect(model.groups.filter((g) => g.menu).map((g) => g.id)).toEqual([]);
    // the control: without the layout's `"menu": false` both long groups are drop-downs again (MENU_THRESHOLD)
    const plain = structuredClone(ribbonLayoutFile) as { tabs: { id: string; groups: Record<string, unknown>[] }[] };
    for (const group of plain.tabs.find((t) => t.id === 'image')!.groups) delete group['menu'];
    const old = await createEditor({ presets: [commonmarkPreset, gfmPreset, pagemdPreset()], ribbonLayout: parseRibbonLayout(plain), commands: [...imageToolCommands(IMAGE_HOST), ...pictureFieldCommands(() => undefined), ...quickAccessActions(() => undefined)] });
    expect(ribbonModel(old.registry, { selected: 'image' }).groups.filter((g) => g.menu).map((g) => g.id)).toEqual(['image-shapes', 'image-edit']);
    expect(editor.registry.actions({ surface: 'ribbon', tab: 'insert' }).filter((a) => /^(picture\.(crop|rotate|flip|redact|reset)|annotated-image\.(add|renumber))/.test(a.id))).toEqual([]);
  });

  it('removing preset-pagemd removes its buttons with no UI code change (and the layout file still works)', async () => {
    const all = await build([commonmarkPreset, gfmPreset, pagemdPreset()]);
    const without = await build([commonmarkPreset, gfmPreset]);
    const kept = new Set(placed(without.editor));
    // layout had only pagemd buttons; the Document tab keeps the app's own Properties button (P8) and the Review tab the app's comment buttons (P12)
    // (P20: the app's own image tools keep the Image tab, which shows only with a plain image selected)
    expect(without.editor.registry.ribbon().tabs.map((t) => t.id)).toEqual(['home', 'insert', 'image', 'document', 'review', 'view']);
    // (P10: and the app's own Print Preview, Export and Profile buttons; P14: Check Document)
    expect(without.editor.registry.actions({ surface: 'ribbon', tab: 'document' }).map((a) => a.id)).toEqual(['document.properties', 'document.preview', 'document.export-pdf', 'document.export-html', 'document.export-png', 'document.profile', 'document.files-in-use', 'document.check']);
    for (const gone of ['fancy-lists.lower-alpha', 'containers.tip', 'figure.insert', 'toc.insert', 'pagebreak.insert', 'index-marker.insert', 'wikilinks.insert']) expect(kept.has(gone)).toBe(false);
    for (const stays of ['strong.toggle', 'heading.h1', 'lists.bullet', 'table.insert', 'alert.note', 'strikethrough.toggle', 'view.draft']) expect(kept.has(stays)).toBe(true);
    expect(placed(all.editor).length).toBeGreaterThan(kept.size);
    // Only CommonMark and GFM commands remain, and nothing fell into "More".
    expect(without.editor.registry.ribbon().tabs.some((t) => t.id === 'more')).toBe(false);
  });

  it('no two commands share a keyboard shortcut', async () => {
    const { editor } = await build([commonmarkPreset, gfmPreset, pagemdPreset()]);
    const keys = editor.registry.commands.list().flatMap((c) => (c.keybinding ? [c.keybinding] : []));
    expect(keys.length).toBeGreaterThan(8);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
  });

  it('every ribbon action has a label and a group, and the slash menu lists the items the matrix says it does', async () => {
    const { editor } = await build([commonmarkPreset, gfmPreset, pagemdPreset()]);
    const actions = editor.registry.actions({ surface: 'ribbon' });
    expect(actions.every((a) => a.label !== '' && a.group !== undefined)).toBe(true);
    const slash = editor.registry.actions({ surface: 'slash' }).map((a) => a.id);
    for (const id of ['paragraph.set', 'heading.h1', 'table.insert', 'figure.insert', 'containers.tip', 'toc.insert', 'rule.insert']) expect(slash).toContain(id);
    expect(slash).not.toContain('strong.toggle'); // marks have no slash entry
  });
});

describe('P17: the icon-first layout', () => {
  /** Every icon name VS Code's font has (the stylesheet the webview loads). */
  const codicons = (): Set<string> => {
    const css = readFileSync(createRequire(import.meta.url).resolve('@vscode/codicons/dist/codicon.css'), 'utf8');
    return new Set([...css.matchAll(/\.codicon-([a-z0-9-]+):before/g)].map((m) => m[1]!));
  };
  const groups = layout.tabs.flatMap((t) => t.groups);

  it('every command in the ribbon has an icon, and VS Code\'s font has it', async () => {
    const { editor } = await build([commonmarkPreset, gfmPreset, pagemdPreset()]);
    const known = codicons();
    const bad = editor.registry.commands.list().filter((c) => !c.icon || !known.has(c.icon)).map((c) => `${c.id}: ${c.icon ?? '(none)'}`);
    expect(bad).toEqual([]);
  });

  it('every group has an icon the font has, and every declared size is large or small for a command the group names', () => {
    const known = codicons();
    expect(groups.filter((g) => !g.icon || !known.has(g.icon)).map((g) => g.id)).toEqual([]);
    for (const g of groups) for (const [id, size] of Object.entries(g.sizes ?? {})) {
      expect(g.commands, `${g.id} ${id}`).toContain(id);
      expect(['large', 'small']).toContain(size);
    }
  });

  it('a small group (three commands or fewer) declares at least one large command; a short title is shorter than the label', async () => {
    const { editor } = await build([commonmarkPreset, gfmPreset, pagemdPreset()]);
    const label = (id: string) => editor.registry.commands.get(id)!.label;
    expect(groups.filter((g) => g.commands.length <= 3 && !Object.values(g.sizes ?? {}).includes('large')).map((g) => g.id)).toEqual([]);
    for (const g of groups) for (const [id, title] of Object.entries(g.titles ?? {})) expect(title.length, `${g.id} ${id}`).toBeLessThanOrEqual(label(id).length + 4);
  });

  it('the check can fail: a command with no icon, a bad size and a typo are caught', () => {
    const known = codicons();
    expect(known.has('not-a-real-icon')).toBe(false);
    expect(() => parseRibbonLayout({ version: 1, tabs: [{ id: 't', label: 'T', groups: [{ id: 'g', label: 'G', commands: ['a'], sizes: { a: 'medium' } }] }] })).toThrow(/large" or "small/);
    // P20: the fold order is a whole number, kept on the group.
    expect(() => parseRibbonLayout({ version: 1, tabs: [{ id: 't', label: 'T', groups: [{ id: 'g', label: 'G', commands: ['a'], fold: 'first' }] }] })).toThrow(/"fold" must be a whole number/);
    expect(parseRibbonLayout({ version: 1, tabs: [{ id: 't', label: 'T', groups: [{ id: 'g', label: 'G', commands: ['a'], fold: 2 }] }] }).tabs[0]!.groups[0]!.fold).toBe(2);
  });
});

describe('the View tab\'s commands', () => {
  it('switch views through the very same VS Code commands as the status bar', async () => {
    const { editor, commands } = await build([commonmarkPreset]);
    for (const mode of ['print', 'web', 'draft', 'read']) editor.registry.commands.run(`view.${mode}`, null as never, () => undefined);
    expect(commands).toEqual(['pagemd.printLayout', 'pagemd.webLayout', 'pagemd.draft', 'pagemd.read']);
  });

  it('show the current view, arrangement, fit and ruler as active, and follow the view state', async () => {
    const { editor } = await build([commonmarkPreset]);
    const active = () => editor.registry.actions({ surface: 'ribbon', tab: 'view', context: { state: null as never, editable: true } }).filter((a) => a.active).map((a) => a.id);
    expect(active()).toEqual(['view.print', 'view.vertical', 'view.zoom-100', 'view.outline', 'view.ruler', 'view.inspector', 'view.comments']);
    editor.registry.view.set({ pageArrangement: 'side-by-side', fit: 'page-width', panels: { ruler: false, inspector: false, outline: false, comments: false } });
    expect(active()).toEqual(['view.print', 'view.side-by-side', 'view.fit-page-width']);
  });

  it('P9: Code and Split are views; Stacked works in Split only; the Outline toggles', async () => {
    const { editor } = await build([commonmarkPreset]);
    const enabled = (id: string) => editor.registry.commands.get(id)!.isEnabled(null as never);
    const run = (id: string) => editor.registry.commands.run(id, null as never, () => undefined);
    expect([enabled('view.code'), enabled('view.split'), enabled('view.stacked')]).toEqual([true, true, false]);
    editor.registry.view.set({ mode: 'split' });
    expect(enabled('view.stacked')).toBe(true);
    run('view.stacked');
    expect(editor.registry.view.value.arrangement).toBe('stacked');
    run('view.stacked');
    expect(editor.registry.view.value.arrangement).toBe('side-by-side');
    const outline = editor.registry.view.value.panels.outline;
    run('view.outline');
    expect(editor.registry.view.value.panels.outline).toBe(!outline);
  });

  it('zoom and ruler work in Print Layout only; Read keeps the arrangement choice; Draft has no pages', async () => {
    const { editor } = await build([commonmarkPreset]);
    const enabled = (id: string) => editor.registry.commands.get(id)!.isEnabled(null as never);
    expect([enabled('view.zoom-in'), enabled('view.ruler'), enabled('view.vertical')]).toEqual([true, true, true]);
    editor.registry.view.set({ mode: 'read' });
    expect([enabled('view.zoom-in'), enabled('view.ruler'), enabled('view.vertical')]).toEqual([false, false, true]);
    editor.registry.view.set({ mode: 'draft' });
    expect([enabled('view.zoom-in'), enabled('view.vertical'), enabled('view.draft')]).toEqual([false, false, true]);
  });

  it('zoom steps through the status bar\'s choices, and the ruler toggles', async () => {
    const { editor } = await build([commonmarkPreset]);
    const run = (id: string) => editor.registry.commands.run(id, null as never, () => undefined);
    run('view.zoom-in');
    expect(editor.registry.view.value).toMatchObject({ zoom: 1.25, fit: 'none' });
    run('view.zoom-in');
    run('view.zoom-in');
    run('view.zoom-in');
    run('view.zoom-in'); // past the last step: stays at 200 %
    expect(editor.registry.view.value.zoom).toBe(2);
    run('view.zoom-out');
    expect(editor.registry.view.value.zoom).toBe(1.5);
    run('view.zoom-100');
    expect(editor.registry.view.value).toMatchObject({ zoom: 1, fit: 'none' });
    run('view.ruler');
    expect(editor.registry.view.value.panels.ruler).toBe(false);
  });

  it('are kind "view": they work in a read-only canvas', async () => {
    const { editor } = await build([commonmarkPreset]);
    expect(editor.registry.commands.list().filter((c) => c.id.startsWith('view.')).every((c) => c.kind === 'view')).toBe(true);
    const actions = editor.registry.actions({ surface: 'ribbon', tab: 'view', context: { state: null as never, editable: false } });
    expect(actions.find((a) => a.id === 'view.draft')!.enabled).toBe(true);
  });
});

describe('view recipes (R-156)', () => {
  it('Read shows the View tab only, with no slash menu and no selection toolbar; every other view shows all tabs', () => {
    expect(RECIPES.read).toMatchObject({ ribbonTabs: ['view'], slash: false, toolbar: false });
    for (const mode of ['draft', 'web', 'print'] as const) expect(RECIPES[mode]).toMatchObject({ ribbonTabs: 'all', slash: true, toolbar: true });
  });
});

describe('styling (P7 acceptance: --vscode-* variables)', () => {
  /** The css with every `var(...)` removed: what is left must hold no color of its own. */
  const stripVars = (css: string): string => {
    let out = css;
    for (let i = 0; i < 6; i++) out = out.replace(/var\((?:[^()]|\([^()]*\))*\)/g, '');
    return out;
  };
  it.each([
    ['the ribbon', ribbonCss],
    ['the slash menu', slashMenuCss],
    ['the selection toolbar', selectionToolbarCss],
  ])('%s sets every color from a VS Code variable', (_name, css) => {
    const bare = stripVars(css);
    expect(bare).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(bare).not.toMatch(/\brgba?\(/);
    expect(bare).not.toMatch(/\b(?:color|background(?:-color)?|border(?:-[a-z]+)?-color)\s*:\s*(?:white|black|red|blue|green|gray|grey)\b/);
    expect(css).toContain('--vscode-');
  });
  it('the check can fail: a hard-coded color is caught', () => {
    expect(stripVars('.x { color: #fff; background: var(--vscode-a, #000) }')).toMatch(/#fff/);
    expect(stripVars('.x { color: var(--vscode-a, #000) }')).not.toMatch(/#000/);
  });
});


