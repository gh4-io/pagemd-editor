// Native split (protocol v15): in Split view VS Code's own text editor is the Code side, opened in the next column beside the
// canvas. It is the real editor (the user's theme, settings, keybindings and extensions); the extension API cannot put one inside
// a webview, so the two are two tabs of one window on the same document. The document is the one source of text (typing in either
// reaches the other through VS Code, one undo stack); this class only keeps the cursors together and marks the canvas's block.
import * as vscode from 'vscode';

/** How long a cursor move made here is ignored when it comes back as a selection event. */
const ECHO_MS = 100;

export class NativeSplit implements vscode.Disposable {
  readonly #document: vscode.TextDocument;
  readonly #panel: vscode.WebviewPanel;
  readonly #onCursor: (offset: number) => void;
  readonly #log: (line: string) => void;
  readonly #disposables: vscode.Disposable[] = [];
  #editor: vscode.TextEditor | undefined;
  /** True when this class opened the tab (only then does it close it). */
  #opened = false;
  #opening = false;
  #wanted = false;
  #moving = false;
  #mark: vscode.TextEditorDecorationType | undefined;

  constructor(document: vscode.TextDocument, panel: vscode.WebviewPanel, onCursor: (offset: number) => void, log: (line: string) => void) {
    this.#document = document;
    this.#panel = panel;
    this.#onCursor = onCursor;
    this.#log = log;
    this.#disposables.push(
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.textEditor !== this.#editor || this.#moving) return;
        this.#onCursor(document.offsetAt(event.selections[0]!.active));
      }),
      vscode.window.onDidChangeVisibleTextEditors((editors) => {
        if (this.#editor && !editors.includes(this.#editor)) this.#editor = undefined; // the author closed it
      }),
    );
  }

  /** Whether the text editor should be beside the canvas now (Split view, setting on). */
  setWanted(wanted: boolean): void {
    this.#wanted = wanted;
    if (wanted) void this.#open();
    else void this.#close();
  }

  /** The canvas's cursor is at `offset` in block [from, to): mark the block, and with `move` put the text editor's cursor there. */
  mark(offset: number, from: number, to: number, move: boolean): void {
    const editor = this.#editor;
    if (!editor) return;
    const doc = this.#document;
    this.#mark ??= vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: new vscode.ThemeColor('editor.lineHighlightBackground') });
    editor.setDecorations(this.#mark, [new vscode.Range(doc.positionAt(from), doc.positionAt(to))]);
    if (!move) return;
    const at = doc.positionAt(offset);
    this.#moving = true;
    editor.selection = new vscode.Selection(at, at);
    editor.revealRange(new vscode.Range(at, at), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    setTimeout(() => (this.#moving = false), ECHO_MS);
  }

  dispose(): void {
    this.#wanted = false;
    void this.#close();
    this.#mark?.dispose();
    for (const d of this.#disposables.splice(0)) d.dispose();
  }

  #findEditor(): vscode.TextEditor | undefined {
    const key = this.#document.uri.toString();
    return vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === key && e.viewColumn !== this.#panel.viewColumn);
  }

  async #open(): Promise<void> {
    if (this.#editor || this.#opening) return;
    this.#opening = true;
    try {
      this.#editor = this.#findEditor();
      if (!this.#editor) {
        // 'default' is VS Code's text editor even when pagemd's editor is set as the default for .md files.
        await vscode.commands.executeCommand('vscode.openWith', this.#document.uri, 'default', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true, preview: false });
        this.#opened = true;
        // The tab is there before its editor is listed as visible.
        for (let tries = 0; tries < 40 && !(this.#editor = this.#findEditor()); tries++) await new Promise((r) => setTimeout(r, 50));
        this.#opened = this.#editor !== undefined;
      }
      if (!this.#editor) this.#log('Native split: the text editor did not open beside the page.');
    } catch (error) {
      this.#log(`Native split: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.#opening = false;
    }
    if (!this.#wanted) await this.#close(); // the view changed while it was opening
  }

  async #close(): Promise<void> {
    const editor = this.#editor;
    this.#editor = undefined;
    if (!editor || !this.#opened) return;
    this.#opened = false;
    const key = this.#document.uri.toString();
    for (const group of vscode.window.tabGroups.all) {
      if (group.viewColumn !== editor.viewColumn) continue;
      const tab = group.tabs.find((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === key);
      if (tab) await vscode.window.tabGroups.close(tab);
    }
  }
}
