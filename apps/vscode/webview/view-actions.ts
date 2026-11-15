// The View tab's commands (P7, R-156): switching the view, the page arrangement, the zoom, the ruler, (P8) the Inspector and
// (P9) the Code and Split views, Split's arrangement and the Outline. They are
// `kind: 'view'` commands the app hands to `createEditor({ commands })`; the core only sees closures. A view switch
// asks the host to run the very same VS Code command the status bar's view name and the Command Palette run, so one
// place decides which editor it acts on (R-132). Zoom, fit and arrangement are ViewState.
import type { CommandSpec, OutputFormat, ViewMode, ViewState } from '@pagemd-editor/core';
import type { WebviewCommand } from '../shared/protocol.ts';
import { RECIPES } from './views.ts';

const MODES: readonly { mode: ViewMode; command: WebviewCommand; label: string; icon: string }[] = [
  { mode: 'print', command: 'pagemd.printLayout', label: 'Print Layout', icon: 'file' },
  { mode: 'web', command: 'pagemd.webLayout', label: 'Web Layout', icon: 'browser' },
  { mode: 'draft', command: 'pagemd.draft', label: 'Draft', icon: 'edit' },
  { mode: 'read', command: 'pagemd.read', label: 'Read', icon: 'book' },
  // P9 (R-164): the text itself, alone or next to the canvas.
  { mode: 'code', command: 'pagemd.code', label: 'Code', icon: 'code' },
  { mode: 'split', command: 'pagemd.split', label: 'Split', icon: 'editor-layout' },
  // P10 (R-170): pagemd's exact render.
  { mode: 'preview', command: 'pagemd.printPreview', label: 'Print Preview', icon: 'open-preview' },
];

/** Zoom steps, the status bar's choices (1 = 100 %). */
const STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2];

export function viewActions(getView: () => ViewState, runCommand: (command: WebviewCommand) => void): CommandSpec[] {
  // The editor creates its ViewState together with the registry that holds these commands, so it is read lazily.
  const view: Pick<ViewState, 'value' | 'set'> = {
    get value() {
      return getView().value;
    },
    set: (change) => getView().set(change),
  };
  const paged = (): boolean => RECIPES[view.value.mode]?.paged === true;
  /** Zoom works in Print Layout; Read always fits the page(s) to the window. */
  const zoomable = (): boolean => view.value.mode === 'print';
  const command = (id: string, label: string, rest: Pick<CommandSpec, 'isEnabled' | 'run'> & Partial<Pick<CommandSpec, 'isActive' | 'icon'>>): CommandSpec => ({ id, label, kind: 'view', ...rest });
  const step = (direction: 1 | -1): void => {
    const current = view.value.fit === 'none' ? view.value.zoom : 1;
    const next = direction === 1 ? STEPS.find((s) => s > current + 0.001) : [...STEPS].reverse().find((s) => s < current - 0.001);
    if (next !== undefined) view.set({ fit: 'none', zoom: next });
  };
  return [
    ...MODES.map(({ mode, command: vscodeCommand, label, icon }) =>
      command(`view.${mode}`, label, {
        icon,
        isEnabled: () => RECIPES[mode] !== undefined,
        isActive: () => view.value.mode === mode,
        run: () => (runCommand(vscodeCommand), true),
      }),
    ),
    command('view.vertical', 'Vertical pages', {
      icon: 'split-vertical',
      isEnabled: paged,
      isActive: () => view.value.pageArrangement === 'vertical',
      run: () => (view.set({ pageArrangement: 'vertical' }), true),
    }),
    command('view.side-by-side', 'Side by side', {
      icon: 'split-horizontal',
      isEnabled: paged,
      isActive: () => view.value.pageArrangement === 'side-by-side',
      run: () => (view.set({ pageArrangement: 'side-by-side' }), true),
    }),
    ...(
      [
        ['page-width', 'Page width', 'arrow-both'],
        ['one-page', 'One page', 'file'],
        ['multi-page', 'Multiple pages', 'files'],
      ] as const
    ).map(([fit, label, icon]) =>
      command(`view.fit-${fit}`, label, {
        icon,
        isEnabled: zoomable,
        isActive: () => view.value.fit === fit,
        run: () => (view.set({ fit }), true),
      }),
    ),
    command('view.zoom-in', 'Zoom in', { icon: 'zoom-in', isEnabled: zoomable, run: () => (step(1), true) }),
    command('view.zoom-out', 'Zoom out', { icon: 'zoom-out', isEnabled: zoomable, run: () => (step(-1), true) }),
    command('view.zoom-100', '100 %', {
      icon: 'screen-normal',
      isEnabled: zoomable,
      isActive: () => view.value.fit === 'none' && view.value.zoom === 1,
      run: () => (view.set({ fit: 'none', zoom: 1 }), true),
    }),
    command('view.ruler', 'Ruler', {
      icon: 'symbol-ruler',
      isEnabled: zoomable,
      isActive: () => view.value.panels.ruler,
      run: () => (view.set({ panels: { ruler: !view.value.panels.ruler } }), true),
    }),
    // P9: Split view's two panes side by side, or the Code view on top of the canvas.
    command('view.stacked', 'Stacked', {
      icon: 'split-vertical',
      isEnabled: () => view.value.mode === 'split',
      isActive: () => view.value.arrangement === 'stacked',
      run: () => (view.set({ arrangement: view.value.arrangement === 'stacked' ? 'side-by-side' : 'stacked' }), true),
    }),
    // P9: the Outline panel on the left (closed by default, like the Inspector; AD-P9-08), in every view.
    command('view.outline', 'Outline', {
      icon: 'list-tree',
      isEnabled: () => true,
      isActive: () => view.value.panels.outline,
      run: () => (view.set({ panels: { outline: !view.value.panels.outline } }), true),
    }),
    // P12 (R-181): the Comments panel on the right, wherever the canvas shows (not Code or Print Preview).
    command('view.comments', 'Comments', {
      icon: 'comment-discussion',
      isEnabled: () => RECIPES[view.value.mode]?.components.includes('canvas') === true,
      isActive: () => view.value.panels.comments,
      run: () => (view.set({ panels: { comments: !view.value.panels.comments } }), true),
    }),
    // P8: the Inspector panel on the right (closed by default, R-160 amendment 8), in every view.
    command('view.inspector', 'Inspector', {
      icon: 'layout-sidebar-right',
      isEnabled: () => true,
      isActive: () => view.value.panels.inspector,
      run: () => (view.set({ panels: { inspector: !view.value.panels.inspector } }), true),
    }),
  ];
}

/**
 * The Document tab's "Properties" button (P8): opens the Inspector on its Document tab. An app command (the Inspector
 * is the app's panel), kind 'view' so it also works in Read (where the Document tab doesn't show, R-156).
 */
export function documentActions(openProperties: () => void, output?: OutputActions): CommandSpec[] {
  const actions: CommandSpec[] = [{ id: 'document.properties', label: 'Properties', icon: 'symbol-property', kind: 'view', isEnabled: () => true, run: () => (openProperties(), true) }];
  if (!output) return actions;
  // P10 (R-170): Print Preview, Export (each through the VS Code command of the same name, so the host flushes, asks where
  // and runs it) and the profile picker. A format the providers can't make is greyed out (no pagemd: HTML only).
  const can = (format: OutputFormat): boolean => output.formats().includes(format);
  const run = (command: WebviewCommand) => () => (output.runCommand(command), true);
  return [
    ...actions,
    { id: 'document.preview', label: 'Print Preview', icon: 'open-preview', kind: 'view', isEnabled: () => true, run: run('pagemd.printPreview') },
    { id: 'document.export-pdf', label: 'Export PDF', icon: 'file-pdf', kind: 'view', isEnabled: () => can('pdf'), run: run('pagemd.exportToPdf') },
    { id: 'document.export-html', label: 'Export HTML', icon: 'file-code', kind: 'view', isEnabled: () => can('html'), run: run('pagemd.exportToHtml') },
    { id: 'document.export-png', label: 'Export PNG', icon: 'file-media', kind: 'view', isEnabled: () => can('png'), run: run('pagemd.exportToPng') },
    { id: 'document.profile', label: 'Profile', icon: 'symbol-namespace', kind: 'view', isEnabled: () => output.hasProfiles(), run: run('pagemd.chooseProfile') },
    // P14 (R-189): "pagemd: Check Document": the profile's checks now, then the Problems panel (the place P10 kept, R-170 Q7).
    { id: 'document.check', label: 'Check Document', icon: 'checklist', kind: 'view', isEnabled: () => true, run: run('pagemd.checkDocument') },
  ];
}

/**
 * The Document tab's "Files in Use" button (P25, R-242): opens and closes the panel listing every file that builds the document. An
 * app command (`kind: 'view'`, it edits nothing), on in every view; the user chose the Document tab and a chain-link icon.
 */
export function filesActions(api: { isOpen(): boolean; toggle(): void }): CommandSpec[] {
  return [{ id: 'document.files-in-use', label: 'Files in Use', icon: 'link', kind: 'view', isEnabled: () => true, isActive: () => api.isOpen(), run: () => (api.toggle(), true) }];
}

/** What the Document tab's output buttons need from the app (P10). */
export interface OutputActions {
  /** The formats Print Preview and Export can make (`init.output`). */
  formats(): readonly OutputFormat[];
  /** Whether the document can name a pagemd profile (it is a file; pagemd styles it). */
  hasProfiles(): boolean;
  runCommand(command: WebviewCommand): void;
}

/**
 * The Home tab's Find and Replace (P11, R-175): `kind: 'view'` commands (they edit nothing themselves), so the keymap
 * plugin leaves their keys to the find plugin, which handles Ctrl/Cmd+F and Ctrl/Cmd+H itself, in Read too. The keybindings
 * here are the shortcut hints, and the R-158 clash check reads them: both are deliberate overrides of VS Code's own keys.
 */
export function findActions(open: (replace: boolean) => void): CommandSpec[] {
  return [
    { id: 'find.open', label: 'Find', icon: 'search', kind: 'view', keybinding: 'Mod-f', isEnabled: () => true, run: () => (open(false), true) },
    { id: 'find.replace', label: 'Replace', icon: 'replace', kind: 'view', keybinding: 'Mod-h', isEnabled: () => true, run: () => (open(true), true) },
  ];
}

/** What the Review tab's comment buttons need from the app (P12, R-181). */
export interface CommentsActions {
  /** Comments can be added and changed: the side file is ready and the canvas is editable and showing. */
  canChange(): boolean;
  /** The thread the buttons act on (selected in the panel, or the one the cursor is in), and whether it is resolved. */
  active(): { id: string; resolved: boolean } | null;
  /** Whether the document has any comment to step through. */
  hasThreads(): boolean;
  create(): void;
  reply(): void;
  toggleResolved(): void;
  step(direction: 1 | -1): void;
}

/**
 * The Review tab's comment buttons (P12, R-181): New comment, Reply, Resolve, Previous, Next. `kind: 'view'`: they change the
 * side file, not the text the keymap guards (the anchor line a new comment adds is made by the app, as one edit). No shortcut
 * keys (Word's Ctrl+Alt+M would need a place on R-158's list).
 */
export function commentsActions(api: CommentsActions): CommandSpec[] {
  const command = (id: string, label: string, icon: string, rest: Pick<CommandSpec, 'isEnabled' | 'run'> & Partial<Pick<CommandSpec, 'isActive'>>): CommandSpec => ({ id, label, icon, kind: 'view', ...rest });
  return [
    command('comments.new', 'New comment', 'comment-add', { isEnabled: () => api.canChange(), run: () => (api.create(), true) }),
    command('comments.reply', 'Reply', 'reply', { isEnabled: () => api.canChange() && api.active() !== null && !api.active()!.resolved, run: () => (api.reply(), true) }),
    command('comments.resolve', 'Resolve', 'check', {
      isEnabled: () => api.canChange() && api.active() !== null,
      isActive: () => api.active()?.resolved === true,
      run: () => (api.toggleResolved(), true),
    }),
    command('comments.previous', 'Previous comment', 'arrow-up', { isEnabled: () => api.hasThreads(), run: () => (api.step(-1), true) }),
    command('comments.next', 'Next comment', 'arrow-down', { isEnabled: () => api.hasThreads(), run: () => (api.step(1), true) }),
  ];
}

/**
 * The Home tab's first group (OQ-67, Word's Quick Access): Save, Undo and Redo. They are VS Code's own commands (R-94: VS Code's undo
 * list is the only one, and it owns save): `run` sends what is typed first, then asks the host (the same path as Ctrl+Z, Ctrl+S).
 */
export function quickAccessActions(run: (command: 'save' | 'undo' | 'redo') => void): CommandSpec[] {
  const spec = (id: string, label: string, icon: string, command: 'save' | 'undo' | 'redo'): CommandSpec => ({ id, label, icon, kind: 'view', isEnabled: () => true, run: () => (run(command), true) });
  return [spec('file.save', 'Save', 'save', 'save'), spec('history.undo', 'Undo', 'discard', 'undo'), spec('history.redo', 'Redo', 'redo', 'redo')];
}
