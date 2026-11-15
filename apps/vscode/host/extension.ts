// Extension entry point (host side, Node). Registers the custom editor (P2), its commands (P5, R-132) and (P9) the
// symbol provider behind VS Code's own Outline.
// This folder is the only place allowed to import 'vscode'.
import * as vscode from 'vscode';
import type { ExportResult, OutputFormat, ViewMode } from '@pagemd-editor/core';
import type { CommentsTestState, ContrastTestState, FilesTestState, FindTestState, HintsTestState, KeysTestState, PreviewTestState, TraceTestState, WebviewRequests } from '../shared/protocol.ts';
import { aboutText, readBuildInfo, statusItemText } from './build-info.ts';
import { reopenWithPagemd, watchDefaultEditors } from './default-editor.ts';
import { EditorProvider, VIEW_TYPE } from './EditorProvider.ts';
import { pagemdHostDiagnostics, ProblemsCollection, summaryMessage, type CheckSummary } from './services/diagnostics.ts';
import { COMMAND as GET_PACKS, getProfilePacks, type PacksPlan } from './services/profile-packs.ts';
import { pagemdHostStyles, pagemdPathOf } from './services/styles.ts';
import type { ProfileChoice } from '@pagemd-editor/style-pagemd';
import { PagemdSymbolProvider, SYMBOL_SELECTOR } from './symbols.ts';

/** Test-only handles (R-89), returned by activate() when the test runner sets PMD_TEST=1. */
export interface TestApi {
  /** Resolves once the editor for `uri` has loaded and received its document. */
  whenReady(uri: string): Promise<void>;
  /** Types `text` at the end of top-level block `block` in the editor for `uri`. */
  type(uri: string, text: string, block: number): Promise<void>;
  /** The `<img alt="…">` on the canvas for `uri` now: its `src`, and whether it finished loading (P5, amendment 11). */
  imageState(uri: string, alt: string): Promise<{ src: string; complete: boolean; naturalWidth: number } | null>;
  /** The ribbon as drawn in the editor for `uri` (P7). */
  ribbon(uri: string, tab?: string): Promise<{ tabs: string[]; selected: string | null; buttons: number; keybindings: string[]; disabled: string[] }>;
  /** Runs the ribbon action `id` in the editor for `uri`, through the action runner (P7). False when there is none. */
  runAction(uri: string, id: string): Promise<boolean>;
  /** P15: selects the `nth` node named `name` on the canvas of the editor for `uri` (a picture); false when there is none. */
  selectNode(uri: string, name: string, nth?: number, inside?: boolean): Promise<boolean>;
  /** P15: the status bar's text in the editor for `uri` (its messages). */
  statusText(uri: string): Promise<string>;
  /** Fix run undo-bg-table-split: the pages on the canvas for `uri` now (see the protocol's `test:pages`). */
  pages(uri: string): Promise<{ on: boolean; papers: number; text: string; running?: { header: string[]; footer: string[] }[] }>;
  /** FIX-PGF (item 3): starts the canvas's frame-by-frame trace, or stops it and returns what it saw (see the protocol's `test:trace`). */
  trace(uri: string, action: 'start' | 'stop'): Promise<TraceTestState | null>;
  /** P25: the Files in Use panel in the editor for `uri` (see the protocol's `test:files`). */
  files(uri: string, params: { heading?: number; click?: string; rule?: string }): Promise<FilesTestState>;
  /** P13b: the colors of the editor's own UI in the editor for `uri` (see the protocol's `test:contrast`). */
  contrast(uri: string): Promise<ContrastTestState>;
  /** P8: sets a document property as the Inspector's Document tab does (one transaction); false when it can't. */
  setProperty(uri: string, key: string, value: unknown): Promise<boolean>;
  /** P9: types `text` at offset `at` of the Code view of the editor for `uri`. */
  codeType(uri: string, text: string, at: number): Promise<void>;
  /** fix-sync-bugs: presses `keys` in the canvas or the Code view of the editor for `uri` (see the protocol's `test:keys`). */
  keys(uri: string, target: 'canvas' | 'code', keys: string[], at?: number): Promise<KeysTestState>;
  /** Native-free Split scroll sync: scrolls one pane to a fraction of its range; the block at the top of each pane. */
  scroll(uri: string, target: 'canvas' | 'code', fraction: number): Promise<{ codeBlock: number; canvasBlock: number; blocks: number }>;
  /** P9: Move up / Move down on the Outline for the section of the heading labelled `heading`; false when it can't move. */
  moveSection(uri: string, heading: string, direction: 'up' | 'down'): Promise<boolean>;
  /** P10: exports the document for `uri` to `target` (no Save dialog), after the webview's typing. */
  exportTo(uri: string, format: OutputFormat, target: string): Promise<ExportResult>;
  /** P10: the profile picker's choice, written to the frontmatter (no Quick Pick). */
  chooseProfile(uri: string, name: string): Promise<string | undefined>;
  /** Phase L2-8: what the profile picker offers for `uri` (host side: the picker never crosses into the webview). */
  profiles(uri: string): Promise<ProfileChoice[]>;
  /** P11: pastes (or drops) an image file onto the canvas of the editor for `uri`, as the browser delivers it. */
  paste(uri: string, file: { name: string; type: string; bytes: Uint8Array }, how?: { drop?: boolean; text?: string }): Promise<boolean>;
  /** P11: drives the find bar of the editor for `uri` (see the protocol's `test:find`). */
  find(uri: string, step: { key?: 'f' | 'h'; query?: string; replacement?: string; do?: 'next' | 'previous' | 'replace' | 'replaceAll' | 'close' }): Promise<FindTestState>;
  /** P12: drives the Comments panel of the editor for `uri` (see the protocol's `test:comments`). */
  comments(uri: string, step: WebviewRequests['test:comments']['params']): Promise<CommentsTestState>;
  /** P10: the Print Preview's state (rendered again first when `refresh`). */
  preview(uri: string, refresh?: boolean): Promise<PreviewTestState>;
  /** P14: runs the checks of the editor for `uri` now (as "pagemd: Check Document" does, without its message). */
  checkNow(uri: string): Promise<CheckSummary | undefined>;
  /** P14: the problem hints on the canvas of the editor for `uri`. */
  hints(uri: string): Promise<HintsTestState>;
  /** P14: what the Problems panel lists for `uri` from pagemd (severity 0 error, 1 warning, 2 information; 0-based line). */
  problems(uri: string): { severity: number; message: string; code: string; line: number }[];
}

export interface ActivationInfo {
  readonly viewType: string;
  readonly test?: TestApi;
}

/** The commands registered on the Command Palette and asked for by the webview's status bar (R-132). */
const VIEW_COMMANDS: { id: string; mode: ViewMode }[] = [
  { id: 'pagemd.printLayout', mode: 'print' },
  { id: 'pagemd.webLayout', mode: 'web' },
  { id: 'pagemd.draft', mode: 'draft' },
  { id: 'pagemd.read', mode: 'read' },
  // P9 (R-164): the Code and Split views.
  { id: 'pagemd.code', mode: 'code' },
  { id: 'pagemd.split', mode: 'split' },
  // P10 (R-170): pagemd's exact render.
  { id: 'pagemd.printPreview', mode: 'preview' },
];

/** The view picker's entries (P6, R-142): "pagemd: Switch View", opened by the status bar's view name. */
const VIEW_PICKS: { label: string; mode: ViewMode }[] = [
  { label: 'Print Layout', mode: 'print' },
  { label: 'Web Layout', mode: 'web' },
  { label: 'Draft', mode: 'draft' },
  { label: 'Read', mode: 'read' },
  { label: 'Code', mode: 'code' },
  { label: 'Split', mode: 'split' },
  { label: 'Print Preview', mode: 'preview' },
];

/** P10 (R-170): "pagemd: Export PDF / HTML / PNG" (names pagemd-vscode doesn't register, so both can be installed). */
const EXPORT_COMMANDS: { id: string; format: OutputFormat }[] = [
  { id: 'pagemd.exportToPdf', format: 'pdf' },
  { id: 'pagemd.exportToHtml', format: 'html' },
  { id: 'pagemd.exportToPng', format: 'png' },
];

export function activate(context: vscode.ExtensionContext): ActivationInfo {
  // FIX-PGF: a log channel (levels): what was written before stays an ordinary line; Print Preview's stages are written at debug
  // level, shown after "Developer: Set Log Level…" ▸ pagemd Editor ▸ Debug.
  const log = vscode.window.createOutputChannel('pagemd Editor', { log: true });
  // The test handles (R-89) need PMD_TEST=1 and an extension that is not installed as a package (R-209): a packaged copy never answers.
  const testing = process.env['PMD_TEST'] === '1' && context.extensionMode !== vscode.ExtensionMode.Production;
  const styles = pagemdHostStyles({ extensionUri: context.extensionUri, log: (line) => log.appendLine(line) });
  // P14 (R-189): one Problems collection ("pagemd") for every pagemd editor.
  const problems = new ProblemsCollection();
  const diagnostics = pagemdHostDiagnostics({ problems, extensionUri: context.extensionUri, log: (line) => log.appendLine(line) });
  const provider = new EditorProvider(context.extensionUri, { log: (line) => log.appendLine(line), debug: (line) => log.debug(line), testing, styles, diagnostics });
  // R-234: which build is this? A quiet status bar item while a pagemd editor is the active tab, and "pagemd: About this build".
  const build = readBuildInfo(context.extensionUri.fsPath);
  const about = aboutText(build, String(context.extension?.packageJSON?.version ?? 'unknown'));
  const buildItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 0);
  buildItem.text = statusItemText(build);
  buildItem.tooltip = about;
  buildItem.command = 'pagemd.about';
  buildItem.name = 'pagemd build';
  buildItem.accessibilityInformation = { label: about, role: 'button' };
  const showBuildItem = (): void => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input as { viewType?: string } | undefined;
    if (input?.viewType === VIEW_TYPE) buildItem.show();
    else buildItem.hide();
  };
  showBuildItem();
  context.subscriptions.push(
    log,
    problems,
    buildItem,
    vscode.window.tabGroups.onDidChangeTabs(showBuildItem),
    vscode.commands.registerCommand('pagemd.about', () => {
      void vscode.window.showInformationMessage(about);
    }),
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      // Keep the canvas (and its cursor) when the tab is hidden; re-creating it would re-read the file.
      // `enableFindWidget`: VS Code's own find (Ctrl+F) works in the views the canvas's find bar doesn't cover (Code, Print Preview);
      // while the cursor is in the canvas the bar takes the key (P11, R-175).
      webviewOptions: { retainContextWhenHidden: true, enableFindWidget: true },
      supportsMultipleEditorsPerDocument: true,
    }),
    // P9: VS Code's own Outline lists pagemd's items (the headings come from VS Code's Markdown extension).
    vscode.languages.registerDocumentSymbolProvider(SYMBOL_SELECTOR, new PagemdSymbolProvider(), { label: 'pagemd' }),
    ...VIEW_COMMANDS.map(({ id, mode }) =>
      vscode.commands.registerCommand(id, () => {
        const session = provider.activeSession;
        if (!session) {
          void vscode.window.showInformationMessage('pagemd Editor: no pagemd editor is active.');
          return;
        }
        session.setView(mode);
      }),
    ),
    // The picker: a Quick Pick of the views. A command can also be given the mode to switch to (tests, keybindings).
    vscode.commands.registerCommand('pagemd.switchView', async (mode?: ViewMode) => {
      const session = provider.activeSession;
      if (!session) {
        void vscode.window.showInformationMessage('pagemd Editor: no pagemd editor is active.');
        return;
      }
      const picked = VIEW_PICKS.find((p) => p.mode === mode) ?? (await vscode.window.showQuickPick(VIEW_PICKS, { placeHolder: 'Switch the view' }));
      if (picked) session.setView(picked.mode);
    }),
    ...EXPORT_COMMANDS.map(({ id, format }) =>
      vscode.commands.registerCommand(id, async () => {
        const session = provider.activeSession;
        if (!session) {
          void vscode.window.showInformationMessage('pagemd Editor: no pagemd editor is active.');
          return;
        }
        await session.exportAs(format);
      }),
    ),
    // P10 (R-170 Q8): the profile picker; writes the frontmatter's `profile:` line.
    vscode.commands.registerCommand('pagemd.chooseProfile', async () => {
      const session = provider.activeSession;
      if (!session) {
        void vscode.window.showInformationMessage('pagemd Editor: no pagemd editor is active.');
        return;
      }
      try {
        await session.chooseProfile();
      } catch (error) {
        void vscode.window.showErrorMessage(`pagemd Editor: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
    // L3 (R-263, R-264): "pagemd: Get Profile Packs…". The only command that touches the network. A plan (ids to install or remove) skips the
    // pickers, for tests and keybindings; the source is always the setting, never an argument.
    vscode.commands.registerCommand(GET_PACKS, async (plan?: PacksPlan) => {
      try {
        return await getProfilePacks(
          {
            log: (line) => log.appendLine(line),
            showLog: () => log.show(true),
            projectRoot: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null,
            hasPagemdEditor: () => (vscode.window.tabGroups.activeTabGroup.activeTab?.input as { viewType?: string } | undefined)?.viewType === VIEW_TYPE,
            cliPath: () => pagemdPathOf(context.extensionUri),
          },
          plan && typeof plan === 'object' ? plan : undefined,
        );
      } catch (error) {
        log.appendLine(`Get Profile Packs failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        void vscode.window.showErrorMessage(`pagemd Editor: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      }
    }),
    // P14 (R-189): "pagemd: Check Document": the checks now, then the Problems panel (pagemd-vscode's own is `pagemd.validate`).
    vscode.commands.registerCommand('pagemd.checkDocument', async () => {
      const session = provider.activeSession;
      if (!session) {
        void vscode.window.showInformationMessage('pagemd Editor: no pagemd editor is active.');
        return;
      }
      try {
        const summary = await session.checkNow();
        if (!summary) return;
        if (summary.shown && summary.enabled && summary.errors + summary.warnings + summary.infos > 0) await vscode.commands.executeCommand('workbench.actions.view.problems');
        void vscode.window.showInformationMessage(summaryMessage(summary));
      } catch (error) {
        void vscode.window.showErrorMessage(`pagemd Editor: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
    // P11 (R-176): "pagemd: Reopen with pagemd Editor", and the setting that makes chosen files open in it by themselves.
    vscode.commands.registerCommand('pagemd.reopenWithEditor', () => reopenWithPagemd(VIEW_TYPE)),
    watchDefaultEditors(context, VIEW_TYPE, (line) => log.appendLine(line)),
    vscode.commands.registerCommand('pagemd.createLayoutFile', async () => {
      const session = provider.activeSession;
      if (!session) {
        void vscode.window.showInformationMessage('pagemd Editor: no pagemd editor is active.');
        return;
      }
      try {
        const result = await session.createLayoutFileForCurrentPage();
        if (result === 'created') void vscode.window.showInformationMessage('pagemd Editor: layout file created.');
      } catch (error) {
        void vscode.window.showErrorMessage(`pagemd Editor: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
  );
  log.appendLine('pagemd Editor activated.');

  if (!testing) return { viewType: VIEW_TYPE };
  const session = (uri: string) => {
    const found = provider.sessions.get(uri);
    if (!found) throw new Error(`No pagemd editor is open for ${uri}.`);
    return found;
  };
  return {
    viewType: VIEW_TYPE,
    test: {
      whenReady: async (uri) => {
        for (let i = 0; i < 200 && !provider.sessions.has(uri); i++) await new Promise((r) => setTimeout(r, 50));
        await session(uri).ready;
      },
      type: (uri, text, block) => session(uri).channel.request('test:type', { text, block }),
      imageState: (uri, alt) => session(uri).channel.request('test:imageState', { alt }),
      ribbon: (uri, tab) => session(uri).channel.request('test:ribbon', tab ? { tab } : {}),
      runAction: (uri, id) => session(uri).channel.request('test:runAction', { id }),
      selectNode: (uri, name, nth, inside) => session(uri).channel.request('test:selectNode', { name, ...(nth !== undefined ? { nth } : {}), ...(inside ? { inside } : {}) }),
      statusText: (uri) => session(uri).channel.request('test:statusText', {}),
      pages: (uri) => session(uri).channel.request('test:pages', {}),
      trace: (uri, action) => session(uri).channel.request('test:trace', { action }),
      files: (uri, params) => session(uri).channel.request('test:files', params),
      contrast: (uri) => session(uri).channel.request('test:contrast', {}),
      setProperty: (uri, key, value) => session(uri).channel.request('test:setProperty', { key, value }),
      codeType: (uri, text, at) => session(uri).channel.request('test:codeType', { text, at }),
      scroll: (uri, target, fraction) => session(uri).channel.request('test:scroll', { target, fraction }),
      keys: (uri, target, keys, at) => session(uri).channel.request('test:keys', { target, keys, ...(at !== undefined ? { at } : {}) }),
      moveSection: (uri, heading, direction) => session(uri).channel.request('test:moveSection', { heading, direction }),
      exportTo: async (uri, format, target) => {
        await session(uri).flush();
        return session(uri).output.exportTo(format, target);
      },
      chooseProfile: (uri, name) => session(uri).chooseProfile(name),
      profiles: (uri) => session(uri).output.profiles(),
      paste: (uri, file, how) => session(uri).channel.request('test:paste', { ...file, ...how }),
      find: (uri, step) => session(uri).channel.request('test:find', step),
      comments: (uri, step) => session(uri).channel.request('test:comments', step),
      preview: (uri, refresh) => session(uri).channel.request('test:preview', refresh ? { refresh } : {}),
      checkNow: (uri) => session(uri).checkNow(),
      hints: (uri) => session(uri).channel.request('test:hints', {}),
      problems: (uri) =>
        (problems.collection.get(vscode.Uri.parse(uri)) ?? []).map((d) => ({ severity: d.severity, message: d.message, code: String(typeof d.code === 'object' ? d.code.value : (d.code ?? '')), line: d.range.start.line })),
    },
  };
}

export function deactivate(): void {}
