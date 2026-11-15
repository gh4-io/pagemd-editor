// The custom editor (ADR-0002): a CustomTextEditorProvider, so VS Code owns the file, the dirty mark, undo/redo,
// save and git. One EditorSession per open editor panel wires the webview's messages to the host services.
import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { OutputFormat, ViewMode } from '@pagemd-editor/core';
import { Channel } from '../shared/channel.ts';
import { PROTOCOL_VERSION, type WebviewCommand, type HostEvents, type HostRequests, type WebviewEvents, type WebviewRequests } from '../shared/protocol.ts';
import { ASSET_FOLDER, HostAssets, documentRelative, resolveImageFolder } from './services/assets.ts';
import type { CheckSummary, HostDiagnostics, HostDiagnosticsFactory } from './services/diagnostics.ts';
import { eolOf, HostDocumentSync } from './services/document-sync.ts';
import { workspaceFileSystem } from './services/file-system.ts';
import { affectsSettings, confirmGatedInsert, readNativeSplit, readSettings } from './services/gated-insert.ts';
import { NativeSplit } from './services/native-split.ts';
import { affectsCodeTheme, readCodeTheme } from './services/code-theme.ts';
import { HostFiles } from './services/files.ts';
import { HostLinks } from './services/links.ts';
import { HostSidecar, sidecarName } from './services/sidecar.ts';
import { HostOutput, insideRoots, mermaidScriptOf } from './services/output.ts';
import { NO_FILES, pagemdPathOf, PLAIN_STYLES, plainHostStyles, type HostStyles, type HostStylesFactory } from './services/styles.ts';

/** Registered in package.json `contributes.customEditors` (priority "option": Open With…, R-87). */
export const VIEW_TYPE = 'pagemd-editor.editor';

/** VS Code gives save participants about 1.5 s; the webview must hand over its pending edits well before that. */
const FLUSH_TIMEOUT_MS = 1000;

/** What each command the webview may ask for runs in VS Code. */
const WEBVIEW_COMMANDS: Readonly<Record<WebviewCommand, string>> = {
  undo: 'undo',
  redo: 'redo',
  save: 'workbench.action.files.save',
  'pagemd.webLayout': 'pagemd.webLayout',
  'pagemd.draft': 'pagemd.draft',
  // Protocol v3 (P6, R-142); the commands themselves are registered in extension.ts.
  'pagemd.printLayout': 'pagemd.printLayout',
  'pagemd.read': 'pagemd.read',
  'pagemd.switchView': 'pagemd.switchView',
  // Protocol v6 (P9).
  'pagemd.code': 'pagemd.code',
  'pagemd.split': 'pagemd.split',
  // Protocol v7 (P10).
  'pagemd.printPreview': 'pagemd.printPreview',
  'pagemd.exportToPdf': 'pagemd.exportToPdf',
  'pagemd.exportToHtml': 'pagemd.exportToHtml',
  'pagemd.exportToPng': 'pagemd.exportToPng',
  'pagemd.chooseProfile': 'pagemd.chooseProfile',
  // Protocol v9 (P14).
  'pagemd.checkDocument': 'pagemd.checkDocument',
};

/** Image files watched for the canvas refresh (inventory row C9, amendment 11). */
/**
 * Non-recursive on purpose (P5 finding): a recursive (`**`) out-of-workspace `RelativePattern` watcher never
 * fired in a real VS Code (verified in test:vscode) — only a flat pattern did. The document folder and the
 * asset folder (`ASSET_FOLDER`) are watched separately instead of one `**` pattern.
 */
const IMAGE_GLOB = '*.{png,jpg,jpeg,gif,svg,webp,bmp,avif}';

type HostChannel = Channel<WebviewRequests, HostRequests, WebviewEvents, HostEvents>;

export interface ProviderOptions {
  log(line: string): void;
  /** FIX-PGF: a line written only when the output channel's log level is Debug (each Print Preview stage); dropped when absent. */
  debug?(line: string): void;
  /** True under the test runner (PMD_TEST=1): the webview then accepts test-only requests (R-89). */
  testing: boolean;
  /** Resolves each document's styles (P5); plain styles for every document when absent. */
  styles?: HostStylesFactory;
  /** P10: overrides where pagemd's runtime file is (tests). */
  runtimeFile?: string;
  /** P14: runs each document's checks (Problems panel and hints); none when absent. */
  diagnostics?: HostDiagnosticsFactory;
}

export class EditorProvider implements vscode.CustomTextEditorProvider {
  /** The open sessions by document URI (the newest panel when a document is open twice). */
  readonly sessions = new Map<string, EditorSession>();
  readonly #extensionUri: vscode.Uri;
  readonly #options: ProviderOptions;
  #activeSession: EditorSession | undefined;

  constructor(extensionUri: vscode.Uri, options: ProviderOptions) {
    this.#extensionUri = extensionUri;
    this.#options = options;
  }

  /** The pagemd editor panel VS Code currently shows, if any (R-132: what a view command / status-bar click acts on). */
  get activeSession(): EditorSession | undefined {
    return this.#activeSession;
  }

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    const key = document.uri.toString();
    const session = new EditorSession(document, panel, this.#extensionUri, this.#options);
    this.sessions.set(key, session);
    if (panel.active) this.#activeSession = session;
    panel.onDidChangeViewState(() => {
      if (panel.active) this.#activeSession = session;
      else if (this.#activeSession === session) this.#activeSession = undefined;
    });
    panel.onDidDispose(() => {
      session.dispose();
      if (this.sessions.get(key) === session) this.sessions.delete(key);
      if (this.#activeSession === session) this.#activeSession = undefined;
    });
  }
}

export class EditorSession implements vscode.Disposable {
  readonly channel: HostChannel;
  /** Resolves once the webview has loaded and received the document. */
  readonly ready: Promise<void>;
  readonly #document: vscode.TextDocument;
  readonly #panel: vscode.WebviewPanel;
  readonly #log: (line: string) => void;
  readonly #disposables: vscode.Disposable[] = [];
  readonly #styles: HostStyles;
  /** Print Preview, Export and the profile picker (P10). */
  readonly output: HostOutput;
  /** The profile's checks (P14); undefined when the provider has none. */
  readonly diagnostics: HostDiagnostics | undefined;
  #isReady = false;
  #sendTheme: () => Promise<void> = async () => undefined;
  /** Native split (protocol v15): VS Code's own text editor beside the canvas while Split shows. */
  readonly #native: NativeSplit;
  #mode: ViewMode | undefined;

  constructor(document: vscode.TextDocument, panel: vscode.WebviewPanel, extensionUri: vscode.Uri, options: ProviderOptions) {
    this.#document = document;
    this.#panel = panel;
    this.#log = options.log;
    const webview = panel.webview;
    const folder = vscode.Uri.joinPath(document.uri, '..');

    webview.options = {
      enableScripts: true,
      // The bundle, plus where document images may live: the document's folder and the workspace (C1); (P10) pagemd's own
      // folder, whose templates and styles the Print Preview may name (D19).
      localResourceRoots: [
        vscode.Uri.joinPath(extensionUri, 'dist', 'webview'),
        folder,
        ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri),
        vscode.Uri.file(pagemdPathOf(extensionUri)),
      ],
    };
    const bundle = (...path: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', ...path)).toString();
    webview.html = webviewHtml(webview.cspSource, bundle('main.js'), undefined, bundle('codicons', 'codicon.css'));

    // FIX-PGF: VS Code says whether a message reached the webview; one that did not (a lost Print Preview answer would leave
    // "Rendering…" until its time limit) is written to the log instead of being ignored.
    const debug = options.debug ?? (() => undefined);
    this.channel = new Channel((message) => {
      const what = describeMessage(message);
      Promise.resolve(webview.postMessage(message)).then(
        (delivered) => {
          if (delivered === false) this.#log(`A message to the editor page was not delivered (${what}).`);
        },
        (error: unknown) => this.#log(`A message to the editor page was not delivered (${what}): ${error instanceof Error ? error.message : String(error)}`),
      );
    });
    this.#native = new NativeSplit(document, panel, (offset) => this.#isReady && this.channel.emit('nativeCursor', { offset }), this.#log);
    this.#disposables.push(this.#native);
    const syncNative = (): void => this.#native.setWanted(this.#mode === 'split' && readNativeSplit());
    this.channel.on('viewMode', ({ mode }) => {
      this.#mode = mode;
      syncNative();
    });
    this.channel.on('splitCursor', ({ offset, from, to, move }) => this.#native.mark(offset, from, to, move));
    this.#disposables.push(vscode.workspace.onDidChangeConfiguration((event) => event.affectsConfiguration('pagemdEditor.nativeSplit') && syncNative()));
    this.channel.on('log', ({ level, message }) => {
      const line = `[page] ${String(message).slice(0, 500)}`;
      if (level === 'info') this.#log(line);
      else debug(line);
    });
    this.#disposables.push(webview.onDidReceiveMessage((message) => this.channel.receive(message)));

    const sync = new HostDocumentSync(document, (text, version, eol) => this.channel.emit('externalChange', { text, version, eol }));
    // P11 (R-174): pasted and dropped images go where `pagemdEditor.imageFolder` says (below the document's folder).
    let warned = false;
    const imageFolder = (): string => {
      const { folder: chosen, invalid } = resolveImageFolder(vscode.workspace.getConfiguration('pagemdEditor', document.uri).get('imageFolder'));
      if (invalid !== undefined && !warned) {
        warned = true;
        const message = `pagemd Editor: the setting pagemdEditor.imageFolder ("${invalid}") must be a folder below the document's own folder (no .. and no drive or leading /). Using ${ASSET_FOLDER}.`;
        this.#log(message);
        void vscode.window.showWarningMessage(message);
      }
      return chosen;
    };
    // P15 (R-196): a pixel edit reads the picture's bytes, only from where the canvas can show pictures (not pagemd's folder).
    const assets = new HostAssets(document.uri, workspaceFileSystem, imageFolder, {
      fs: workspaceFileSystem,
      roots: () => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri),
      ignoreCase: process.platform === 'win32' || process.platform === 'darwin',
    });
    const links = new HostLinks(document.uri, this.#log);
    const styles = (this.#styles = (options.styles ?? plainHostStyles)(document));
    this.#disposables.push(sync, styles);
    const output = (this.output = new HostOutput(document, webview, { extensionUri, log: this.#log, debug, styles, ...(options.runtimeFile ? { runtimeFile: options.runtimeFile } : {}) }));
    // P14 (R-189): the profile's checks, run on the host and shown in the Problems panel and as hints on the canvas.
    const diagnostics = (this.diagnostics = options.diagnostics?.(document));
    if (diagnostics) {
      this.#disposables.push(diagnostics);
      this.#disposables.push(diagnostics.onResults((payload) => this.#isReady && this.channel.emit('diagnostics', payload)));
      // The profile, its layout or a stylesheet changed: check again.
      this.#disposables.push(styles.onChange(() => diagnostics.schedule(150)));
    }
    let imageWatchers = this.#watchImages(folder, imageFolder());
    this.#disposables.push({ dispose: () => imageWatchers.splice(0).forEach((w) => w.dispose()) });
    this.#disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration('pagemdEditor.imageFolder', document.uri)) return;
        imageWatchers.splice(0).forEach((w) => w.dispose());
        imageWatchers = this.#watchImages(folder, imageFolder());
      }),
    );

    this.channel.handle('applyEdits', ({ edits, version }) => sync.applyEdits(edits, version));
    this.channel.handle('writeAsset', ({ bytes, name }) => assets.writeAsset(toBytes(bytes), name));
    this.channel.handle('pickFile', ({ filter }) => assets.pickFile(filter));
    this.channel.handle('readAsset', ({ path }) => assets.readAsset(path));
    this.channel.handle('getStyles', () => styles.get());
    this.channel.handle('createLayoutFile', ({ page }) => styles.createLayoutFile(page));
    this.channel.handle('confirmGatedInsert', (info) => confirmGatedInsert(info));
    this.channel.handle('preview', ({ nonce }) => output.preview(nonce));
    this.channel.handle('exportDocument', ({ format }) => output.export(format));
    // P12 (R-180): the review comments' side file, and a note to the webview when it changes on disk.
    const sidecar = new HostSidecar(document.uri, workspaceFileSystem);
    this.channel.handle('readSidecar', ({ kind }) => sidecar.read(kind));
    this.channel.handle('writeSidecar', ({ kind, data }) => sidecar.write(kind, data));
    this.#disposables.push(...this.#watchSidecar(document.uri, sidecar));
    this.#disposables.push(vscode.workspace.onDidSaveTextDocument((saved) => saved === document && this.#isReady && this.channel.emit('saved', {})));
    this.#disposables.push(vscode.workspace.onDidChangeConfiguration((event) => this.#isReady && affectsSettings(event) && this.channel.emit('settingsChanged', readSettings())));
    // The Code view's colour theme (Monaco with VS Code's services): the user's own, sent after init and when it changes.
    const sendTheme = async (): Promise<void> => {
      if (!this.#isReady || readSettings().codeEngine !== 'monaco-vscode') return;
      this.channel.emit('codeTheme', await readCodeTheme());
    };
    this.#sendTheme = sendTheme;
    this.#disposables.push(vscode.window.onDidChangeActiveColorTheme(() => void sendTheme()), vscode.workspace.onDidChangeConfiguration((event) => affectsCodeTheme(event) && void sendTheme()));
    this.#disposables.push(styles.onChange((payload) => this.#isReady && this.channel.emit('stylesChanged', payload)));
    this.#disposables.push(styles.onChange(() => this.#allowAssetFolders(styles.assetFolders?.() ?? [], false)));
    this.channel.on('openLink', ({ href }) => links.open(href));
    // P25 (protocol v12): Files in Use. Only a file of the last report is ever opened (the webview is not trusted with paths).
    const files = new HostFiles(this.#log);
    this.channel.handle('filesInUse', async () => files.remember((await styles.filesInUse?.()) ?? NO_FILES));
    this.channel.on('openFile', (request) => void files.open(request));
    this.channel.on('runCommand', ({ command }) => {
      // Only these: the webview must never run arbitrary VS Code commands.
      if (typeof command === 'string' && Object.hasOwn(WEBVIEW_COMMANDS, command)) void vscode.commands.executeCommand(WEBVIEW_COMMANDS[command]);
    });

    this.ready = new Promise((resolve) => {
      this.channel.on('ready', async ({ protocol }) => {
        if (protocol !== PROTOCOL_VERSION) {
          const message = `pagemd Editor: the webview speaks protocol ${protocol}, the host ${PROTOCOL_VERSION}. Reload the window.`;
          this.#log(message);
          void vscode.window.showErrorMessage(message);
          return;
        }
        // Styles are resolved before init (protocol v2), so the first read already follows the profile's gates.
        let payload = PLAIN_STYLES;
        try {
          payload = await styles.get();
        } catch (error) {
          this.#log(`Styles could not be resolved, using plain styles: ${error instanceof Error ? error.message : String(error)}`);
        }
        // FIX-template-asset-paths: a logo next to a profile outside the workspace may be shown (before init, so nothing typed is lost)
        this.#allowAssetFolders(styles.assetFolders?.() ?? [], true);
        this.channel.emit('init', {
          protocol: PROTOCOL_VERSION,
          text: document.getText(),
          version: document.version,
          eol: eolOf(document), // protocol v11: VS Code's own line ending, which every inserted line break becomes
          fileName: document.uri.path.split('/').pop() ?? '',
          documentBase: `${webview.asWebviewUri(folder).toString().replace(/\/$/, '')}/`,
          testing: options.testing,
          styles: payload,
          settings: readSettings(),
          output: output.info(),
          mermaidScript: webview.asWebviewUri(mermaidScriptOf(extensionUri)).toString(),
        });
        this.#isReady = true;
        void this.#sendTheme();
        // P14: the first check runs once the webview has the document (off the opening path).
        this.diagnostics?.schedule(0);
        resolve();
      });
    });

    // Typing reaches the document after a short pause; a save must not miss the last few keystrokes.
    this.#disposables.push(
      vscode.workspace.onWillSaveTextDocument((e) => {
        if (e.document === document && this.#isReady) e.waitUntil(this.flush());
      }),
    );
  }

  /**
   * FIX-template-asset-paths (R-259): the webview may load files only from its resource folders (the document's folder, the
   * workspace, pagemd's own). A template's logo next to a profile kept elsewhere (`pipeline_profile: C:\…\Resources\…`) is in
   * none of them, so its folder is added when the editor opens. VS Code may load the page again for that, which is why it is
   * done before `init` only; a folder needed later is named in the log (reopen the editor), never added while the author types.
   */
  #allowAssetFolders(folders: string[], atOpen: boolean): void {
    const webview = this.#panel.webview;
    const roots = webview.options.localResourceRoots ?? [];
    const missing = folders.filter((folder) => !insideRoots(folder, roots.map((root) => root.fsPath)));
    if (missing.length === 0) return;
    if (!atOpen) {
      this.#log(`The template's pictures are now also in ${missing.join(', ')}: reopen the editor to show them on the page.`);
      return;
    }
    webview.options = { ...webview.options, localResourceRoots: [...roots, ...missing.map((folder) => vscode.Uri.file(folder))] };
    this.#log(`The template's pictures are in ${missing.join(', ')}: the editor may show files from there.`);
  }

  /** Asks the webview to send its pending edits now; gives up quietly after FLUSH_TIMEOUT_MS. */
  async flush(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => (timer = setTimeout(() => (this.#log('Flush before save timed out.'), resolve()), FLUSH_TIMEOUT_MS)));
    try {
      await Promise.race([this.channel.request('flush', {}), timeout]);
    } catch (error) {
      this.#log(`Flush before save failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  get document(): vscode.TextDocument {
    return this.#document;
  }

  get panel(): vscode.WebviewPanel {
    return this.#panel;
  }

  /** "pagemd: Web Layout" / "pagemd: Draft" (R-132): tells the webview to switch views. No-op before `ready`. */
  setView(mode: ViewMode): void {
    if (this.#isReady) this.channel.emit('setView', { mode });
  }

  /** "pagemd: Export PDF/HTML/PNG" (P10): the webview's typing first, then the Save dialog and the export. */
  async exportAs(format: OutputFormat): Promise<void> {
    if (this.#isReady) await this.flush();
    await this.output.export(format);
  }

  /** "pagemd: Choose Profile" (P10, R-170 Q8): the webview's typing first, then the picker; writes `profile:`. */
  async chooseProfile(pick?: string): Promise<string | undefined> {
    if (this.#isReady) await this.flush();
    return this.output.chooseProfile(pick);
  }

  /** "pagemd: Check Document" (P14): the webview's typing first, then the checks now. Undefined without checks. */
  async checkNow(): Promise<CheckSummary | undefined> {
    if (!this.diagnostics) return undefined;
    if (this.#isReady) await this.flush();
    return this.diagnostics.run();
  }

  /** "pagemd: Create Layout File" (R-132): writes the current page, unchanged. Rejects with the reason. */
  async createLayoutFileForCurrentPage(): Promise<'created' | 'declined'> {
    const payload = await this.#styles.get();
    if (!payload.styles) throw new Error('This document has plain styles: there is no pagemd profile to add a layout file to.');
    return this.#styles.createLayoutFile(payload.styles.page);
  }

  dispose(): void {
    this.channel.close();
    for (const d of this.#disposables.splice(0)) d.dispose();
  }

  /**
   * Tells the webview when the document's side file changes on disk (P12). One flat pattern for the folder (a recursive one
   * never fired outside the workspace, P5); the callback keeps only this document's file. Our own writes come back too: the
   * webview finds nothing new in them.
   */
  #watchSidecar(document: vscode.Uri, sidecar: HostSidecar): vscode.Disposable[] {
    const mine = sidecarName(document.path);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onEvent = (uri: vscode.Uri): void => {
      if (uri.path.split('/').pop() !== mine) return;
      clearTimeout(timer);
      timer = setTimeout(() => this.#isReady && this.channel.emit('sidecarChanged', { kind: 'comments' }), 150);
    };
    try {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(sidecar.folder, '*.json'));
      return [watcher, watcher.onDidChange(onEvent), watcher.onDidCreate(onEvent), watcher.onDidDelete(onEvent), { dispose: () => clearTimeout(timer) }];
    } catch (error) {
      this.#log(`Could not watch the comments file: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  /**
   * Watches image files for the canvas refresh (inventory row C9, amendment 11): the document's own folder, plus
   * the image folder pasted images go to (the default, and the one the setting names). Each watcher is flat (see IMAGE_GLOB's comment).
   */
  #watchImages(folder: vscode.Uri, imageFolder: string): vscode.Disposable[] {
    let pending = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flushPaths = (): void => {
      if (!this.#isReady || pending.size === 0) return;
      this.channel.emit('assetsChanged', { paths: [...pending] });
      pending = new Set();
    };
    const onEvent = (uri: vscode.Uri): void => {
      const relative = documentRelative(this.#document.uri.path, uri.path);
      if (relative) pending.add(relative);
      clearTimeout(timer);
      timer = setTimeout(flushPaths, 200);
      // P14: an image appeared or went away: the assets check may answer differently.
      this.diagnostics?.schedule(300);
    };
    const disposables: vscode.Disposable[] = [];
    const bases = [folder, ...[...new Set([ASSET_FOLDER, imageFolder])].map((f) => vscode.Uri.joinPath(folder, f))];
    for (const base of bases) {
      try {
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(base, IMAGE_GLOB));
        disposables.push(watcher, watcher.onDidChange(onEvent), watcher.onDidCreate(onEvent), watcher.onDidDelete(onEvent));
      } catch (error) {
        this.#log(`Could not watch images under ${base.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return disposables;
  }
}

/** FIX-PGF: a message named for the log (never its contents: a preview answer is megabytes). */
function describeMessage(message: unknown): string {
  const m = (message ?? {}) as { kind?: unknown; name?: unknown; method?: unknown; id?: unknown };
  return m.kind === 'response' ? `the answer to request ${String(m.id)}` : m.kind === 'event' ? `the event "${String(m.name)}"` : `the request "${String(m.method)}"`;
}

/** Bytes as they arrive over postMessage: a typed array or an ArrayBuffer (C5). */
function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error('writeAsset: bytes must be binary (Uint8Array or ArrayBuffer).');
}

/**
 * The webview page. The Content Security Policy allows only our bundle (by nonce), our own style elements (same
 * nonce), images from the allowed folders, https and data: URLs, and fonts from the same places plus data: URLs
 * (P5, amendment 10: book-wiki's fonts are `data:` URLs, embedded by its own profile CSS). `codiconsUri` is VS Code's
 * icon stylesheet shipped with the extension (P8, R-162); the CSP already allows it (style-src and font-src).
 */
export function webviewHtml(cspSource: string, scriptUri: string, nonce = randomBytes(16).toString('base64'), codiconsUri?: string): string {
  const csp = [
    "default-src 'none'",
    `img-src ${cspSource} https: data:`,
    // P10 (AD-P10-05): inline styles are allowed (no nonce: a nonce would switch 'unsafe-inline' off). Paged.js writes its
    // own style elements in the Print Preview frame (which inherits this policy), and mermaid's drawings carry theirs.
    // Scripts stay nonce-only, so a document's own scripts never run, in the preview either.
    `style-src ${cspSource} 'unsafe-inline'`,
    `font-src ${cspSource} data:`,
    // Experiment (code engines): the Monaco-with-VS-Code-services script compiles the grammar engine's wasm and reads its own files
    // (grammars, themes, wasm) from the extension. Scripts stay nonce-only.
    `script-src 'nonce-${nonce}' 'wasm-unsafe-eval'`,
    `connect-src ${cspSource}`,
  ].join('; ');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />${codiconsUri ? `
    <link rel="stylesheet" href="${codiconsUri}" />` : ''}
  </head>
  <body>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>
`;
}
