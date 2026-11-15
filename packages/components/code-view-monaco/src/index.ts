// @pagemd-editor/code-view-monaco: the Code view in Monaco (prototype, branch exp/monaco-code-view). The same interface as
// @pagemd-editor/code-view (the app swaps one import), so the sync rules stay as they were: the view keeps the text VS Code has
// (the base) apart from typing not yet sent; the app takes the edits after a pause; text from elsewhere is merged under typing
// not yet sent. Undo stays VS Code's (R-94): Ctrl/Cmd+Z/Y are rebound to the host, and text from the host goes in with
// `applyEdits`, which Monaco keeps out of its own undo stack.
// Monaco is its own script (`monaco/monaco.js`, see monaco-entry.ts), loaded when the first view is made. Until it is there the
// view holds the text, blocks and cursor itself and applies them when Monaco arrives (the app calls the view at once).
// Line endings: Monaco's model keeps the file's own line ending and counts it in its offsets, so no translation is needed at the edges.
import type * as Monaco from '@codingame/monaco-vscode-editor-api';
import type { TextEdit } from '@pagemd-editor/core';

// The same shapes as @pagemd-editor/code-view (components may only use core, so they are repeated here until one of the two goes).
export type CodeKind = 'heading' | 'code' | 'quote' | 'list' | 'table' | 'html' | 'directive' | 'meta' | 'rule' | 'raw' | 'text';
export interface CodeBlock {
  from: number;
  to: number;
  kind: CodeKind;
  /** Headings: 1–6 (a heading folds its whole section). */
  level?: number;
}
export type CodeCommand = 'undo' | 'redo' | 'save';
export interface CodeViewOptions {
  text: string;
  lineEnding?(): string | undefined;
  nonce?: string;
  editable?: boolean;
  onChange?(): void;
  onCursor?(offset: number): void;
  onCommand?(command: CodeCommand): void;
  onBlur?(): void;
  /** The view was scrolled (Split view keeps the canvas's scrolling with it). */
  onScroll?(): void;
}

/** A colour theme as VS Code's own services take it: the theme file (its `include`s merged) as JSON text, and the user's customizations. */
export interface CodeTheme {
  id: string;
  uiTheme: 'vs' | 'vs-dark' | 'hc-black' | 'hc-light';
  json: string;
  tokenColorCustomizations: unknown;
  colorCustomizations: unknown;
}

/** What this view takes besides the shared options (code engines experiment): which Monaco, and VS Code's `editor.*` settings. */
export interface MonacoCodeViewOptions extends CodeViewOptions {
  /** The user's colour theme (null or absent: the view's default of the same kind as VS Code's current theme). */
  theme?: CodeTheme | null;
  /** VS Code's `editor.*` settings by name (`minimap.enabled`, `fontSize`, …), applied over the defaults. */
  editorOptions?: Record<string, unknown>;
  /** Test runs only: errors and warnings the page logs are also written on the view, so a screenshot shows them. */
  debug?: boolean;
}

/** The smallest single replacement that turns `from` into `to`. */
export function textDiff(from: string, to: string): TextEdit | null {
  if (from === to) return null;
  let start = 0;
  const max = Math.min(from.length, to.length);
  while (start < max && from.charCodeAt(start) === to.charCodeAt(start)) start++;
  let end = 0;
  while (end < max - start && from.charCodeAt(from.length - 1 - end) === to.charCodeAt(to.length - 1 - end)) end++;
  return { from: start, to: from.length - end, text: to.slice(start, to.length - end) };
}

/** The line ending a text uses ('\n' when it has none). */
export function lineEndingOf(text: string): string {
  return /\r\n|\r|\n/.exec(text)?.[0] ?? '\n';
}

const toLf = (text: string): string => text.replace(/\r\n?/g, '\n');

/**
 * `incoming` (a text from elsewhere, against `base`) merged with the typing not yet sent (`current`, against `base`): the
 * incoming change is applied on top of the typing, in `incoming`'s line ending. (No CodeMirror ChangeSet here: two single
 * replacements and one position map.)
 */
export function rebase(base: string, current: string, incoming: string): string {
  const [b, c, i] = [toLf(base), toLf(current), toLf(incoming)];
  const local = textDiff(b, c);
  const remote = textDiff(b, i);
  let merged = c;
  if (remote) {
    if (!local) merged = i;
    else {
      const from = mapOffset(remote.from, local, 1);
      const to = Math.max(from, mapOffset(remote.to, local, 1));
      merged = c.slice(0, from) + remote.text + c.slice(to);
    }
  }
  const eol = lineEndingOf(incoming);
  return eol === '\n' ? merged : merged.replace(/\n/g, eol);
}

type MonacoApi = typeof Monaco;

// Captured while the page's own script runs (`currentScript` is only set then): where the Monaco script sits next to it.
const here = typeof document === 'undefined' ? null : (document.currentScript as HTMLScriptElement | null);
const BASE = here?.src ? here.src.replace(/[^/]*$/, 'monaco/') : null;

let loading: Promise<MonacoApi> | undefined;
/**
 * Loads Monaco with VS Code's services (one script and its stylesheet) once per page. The script sets `__pmdMonacoReady`, a promise of
 * the API that resolves when the services are up.
 */
function loadMonaco(nonce?: string): Promise<MonacoApi> {
  const g = globalThis as unknown as { __pmdMonacoReady?: Promise<MonacoApi>; __pmdMonacoBase?: string };
  loading ??= new Promise<MonacoApi>((resolve, reject) => {
    if (!BASE) return reject(new Error('monaco: the page script has no address to load it from'));
    g.__pmdMonacoBase = `${BASE}monaco-vscode.js`; // the script's import.meta.url
    // The library builds its files' addresses with many `../` from its own source layout, which lands outside the extension once it is
    // bundled: every address that ends in one of its files is read from next to the script instead. Theme files (made in the page from
    // the host's text) are served from memory at an address nothing else uses.
    const base = BASE;
    const realFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : undefined;
      const theme = href?.startsWith(THEME_ORIGIN) ? themeFiles.get(href) : undefined;
      if (theme !== undefined) return Promise.resolve(new Response(theme, { headers: { 'content-type': 'application/json' } }));
      const own = href ? /(?:external\/vscode-oniguruma\/release\/onig\.wasm|resources\/[^?#]+)$/.exec(new URL(href, location.href).pathname) : null;
      return realFetch(own ? `${base}${own[0]}` : input, init);
    };
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = `${BASE}monaco-vscode.css`;
    document.head.append(css);
    const script = document.createElement('script');
    if (nonce) script.nonce = nonce;
    script.src = `${BASE}monaco-vscode.js`;
    script.onload = () => (g.__pmdMonacoReady ? g.__pmdMonacoReady.then(resolve, reject) : reject(new Error('monaco did not load')));
    script.onerror = () => reject(new Error('monaco did not load'));
    document.head.append(script);
  });
  return loading;
}

/** Theme files by address: where the script reads them from (see the fetch above). */
const THEME_ORIGIN = 'https://pmd.theme/';
const themeFiles: Map<string, string> = ((globalThis as unknown as { __pmdThemeFiles?: Map<string, string> }).__pmdThemeFiles ??= new Map());

/** VS Code's `editor.*` names (dotted for nested ones) as Monaco's options. */
function monacoOptions(settings: Record<string, unknown> | undefined): Monaco.editor.IEditorOptions {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings ?? {})) {
    const path = key.split('.');
    let at = out;
    for (const part of path.slice(0, -1)) at = (at[part] ??= {}) as Record<string, unknown>;
    at[path[path.length - 1]!] = value;
  }
  return out as Monaco.editor.IEditorOptions;
}

/** Where an offset goes after the replacement `edit` (`assoc` 1: a start moves behind inserted text; -1: an end stays before it). */
export function mapOffset(pos: number, edit: TextEdit, assoc: 1 | -1): number {
  const end = edit.from + edit.text.length;
  if (pos < edit.from || (pos === edit.from && assoc === -1)) return pos;
  if (pos > edit.to || (pos === edit.to && assoc === 1)) return pos - (edit.to - edit.from) + edit.text.length;
  return assoc === 1 ? end : edit.from;
}

const mapBlock = (b: CodeBlock, edit: TextEdit): CodeBlock => {
  const from = mapOffset(b.from, edit, 1);
  return { ...b, from, to: Math.max(from, mapOffset(b.to, edit, -1)) };
};

export class CodeView {
  readonly element: HTMLElement;
  readonly #o: CodeViewOptions;
  #api?: MonacoApi;
  #editor?: Monaco.editor.IStandaloneCodeEditor;
  #model?: Monaco.editor.ITextModel;
  #marks?: Monaco.editor.IEditorDecorationsCollection;
  #theme: CodeTheme | null | undefined;
  #editorOptions: Record<string, unknown> | undefined;
  #folds = new EventTarget();
  #destroyed = false;
  /** Set while text from outside (or a reveal) is going in: those changes are not the author's. */
  #outside = false;
  /** The text VS Code has, as far as this view knows. */
  #base: string;
  /** The text shown, until Monaco is there (then the model holds it). */
  #held: string;
  #blocks: CodeBlock[] = [];
  #editable: boolean;
  #at: number | undefined;
  #mark: { from: number; to: number } | null = null;
  #focus = false;

  constructor(parent: HTMLElement, options: MonacoCodeViewOptions) {
    this.#o = options;
    this.#theme = options.theme;
    this.#editorOptions = options.editorOptions;
    this.#base = options.text;
    this.#held = options.text;
    this.#editable = options.editable ?? true;
    this.element = parent.ownerDocument.createElement('div');
    this.element.className = 'pmd-code';
    parent.append(this.element);
    if (options.debug) this.#showLogs();
    void loadMonaco(options.nonce).then(
      (api) => this.#start(api),
      (error: unknown) => {
        console.error(error);
        this.element.textContent = `The editor did not load: ${error instanceof Error ? error.message : String(error)}`; // seen, not silent
      },
    );
  }

  #showLogs(): void {
    const box = this.element.ownerDocument.createElement('pre');
    box.style.cssText = 'position:absolute;z-index:99;left:0;right:0;bottom:0;max-height:40%;overflow:auto;margin:0;padding:4px;font-size:10px;background:#300;color:#fcc;white-space:pre-wrap';
    this.element.style.position = 'relative';
    this.element.append(box);
    const add = (line: string) => void (box.textContent += `${line.slice(0, 300)}\n`);
    for (const level of ['error', 'warn'] as const) {
      const original = console[level].bind(console);
      console[level] = (...args: unknown[]) => (add(`${level}: ${args.map(String).join(' ')}`), original(...args));
    }
    const realFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const response = await realFetch(input, init).catch((error: unknown) => (add(`fetch failed: ${url} ${String(error)}`), Promise.reject(error)));
      if (!response.ok) add(`fetch ${response.status}: ${url}`);
      return response;
    };
    window.addEventListener('error', (e) => add(`error: ${e.message}`));
    window.addEventListener('unhandledrejection', (e) => add(`rejected: ${String(e.reason)}`));
  }

  get text(): string {
    return this.#model ? this.#model.getValue() : this.#held;
  }

  get pending(): boolean {
    return this.text !== this.#base;
  }

  get focused(): boolean {
    return this.#editor?.hasTextFocus() ?? false;
  }

  get cursor(): number {
    const pos = this.#editor?.getPosition();
    return pos && this.#model ? this.#model.getOffsetAt(pos) : (this.#at ?? 0);
  }

  takeEdits(): { edits: TextEdit[]; base: string; text: string } | null {
    const text = this.text;
    const edit = textDiff(this.#base, text);
    if (!edit) return null;
    const base = this.#base;
    this.#base = text;
    return { edits: [edit], base, text };
  }

  receive(text: string): void {
    if (text === this.#base) return;
    const eol = this.#eolFor(text);
    // The file's line ending changed (VS Code's Change End of Line Sequence): its text wins.
    if (eol !== this.#eolOf(this.text)) return this.reset(text);
    const next = this.pending ? rebase(this.#base, this.text, text) : text;
    this.#base = text;
    this.#show(next);
  }

  reset(text: string): void {
    this.#base = text;
    this.#show(text);
  }

  setBlocks(blocks: readonly CodeBlock[], text: string): void {
    const shown = this.text;
    const edit = text === shown ? null : textDiff(text, shown);
    this.#blocks = edit ? blocks.map((b) => mapBlock(b, edit)) : [...blocks];
    this.#paint();
  }

  setEditable(editable: boolean): void {
    this.#editable = editable;
    this.#editor?.updateOptions({ readOnly: !editable });
  }

  /** Puts the cursor at `offset` and scrolls it into view, without taking the focus; `block` (Split view) is marked. */
  reveal(offset: number, block?: { from: number; to: number }): void {
    this.#at = offset;
    this.#mark = block ?? null;
    this.#paintMark();
    const editor = this.#editor;
    const model = this.#model;
    if (!editor || !model) return;
    const pos = model.getPositionAt(offset);
    this.#outside = true;
    try {
      editor.setPosition(pos);
      editor.revealPositionInCenter(pos);
    } finally {
      this.#outside = false;
    }
  }

  /** Marks `block` as the one the other side's cursor is in, without touching the selection here (OQ-66). */
  mark(block: { from: number; to: number }): void {
    this.#mark = block;
    this.#paintMark();
  }

  focus(): void {
    this.#focus = true;
    this.#editor?.focus();
  }

  /** Presses `key` as the author would (tests in the VS Code host): one character is typed, 'Enter' and 'Backspace' are keys. */
  press(key: string): boolean {
    const editor = this.#editor;
    if (!editor) return false;
    if ([...key].length === 1) return (editor.trigger('keyboard', 'type', { text: key }), true);
    if (key === 'Enter') return (editor.trigger('keyboard', 'type', { text: '\n' }), true);
    if (key === 'Backspace') return (editor.trigger('keyboard', 'deleteLeft', {}), true);
    return false;
  }

  /** The offset in the text at the top edge of the view (inside a wrapped line by how far it is scrolled). */
  topOffset(): number {
    const editor = this.#editor;
    const model = this.#model;
    if (!editor || !model) return 0;
    const top = editor.getScrollTop();
    const line = Math.max(1, Math.min(model.getLineCount(), editor.getVisibleRanges()[0]?.startLineNumber ?? 1));
    const start = editor.getTopForLineNumber(line);
    const height = (line < model.getLineCount() ? editor.getTopForLineNumber(line + 1) : editor.getContentHeight()) - start;
    const frac = height > 0 ? Math.min(1, Math.max(0, (top - start) / height)) : 0;
    return model.getOffsetAt({ lineNumber: line, column: 1 }) + Math.floor(frac * model.getLineLength(line));
  }

  /** Scrolls so `offset` is at the top edge of the view (no cursor move). */
  scrollToOffset(offset: number): void {
    const editor = this.#editor;
    const model = this.#model;
    if (!editor || !model) return;
    const pos = model.getPositionAt(offset);
    const start = editor.getTopForLineNumber(pos.lineNumber);
    const height = (pos.lineNumber < model.getLineCount() ? editor.getTopForLineNumber(pos.lineNumber + 1) : editor.getContentHeight()) - start;
    const length = model.getLineLength(pos.lineNumber);
    editor.setScrollTop(start + (length > 0 ? ((pos.column - 1) / length) * height : 0), 1); // 1: Immediate
  }

  /** Types `text` at `offset` as the author would (tests in the VS Code host). */
  insertAt(offset: number, text: string): void {
    const model = this.#model;
    if (!model) return;
    const pos = model.getPositionAt(Math.min(offset, model.getValueLength()));
    this.#editor!.executeEdits('test', [{ range: { startLineNumber: pos.lineNumber, startColumn: pos.column, endLineNumber: pos.lineNumber, endColumn: pos.column }, text }]);
  }

  refresh(): void {
    this.#editor?.layout();
  }

  destroy(): void {
    this.#destroyed = true;
    this.#editor?.dispose();
    this.#model?.dispose();
    this.element.remove();
  }

  /** Monaco arrived: make the model and the editor from what the view has been holding. */
  #start(api: MonacoApi): void {
    if (this.#destroyed) return;
    this.#api = api;
    // The language is markdown (Monaco's own Monarch grammar, or VS Code's TextMate one): the colours are the language's, not ours.
    api.languages.registerFoldingRangeProvider('markdown', {
      onDidChange: (listener) => {
        const on = () => listener(this as never);
        this.#folds.addEventListener('change', on);
        return { dispose: () => this.#folds.removeEventListener('change', on) };
      },
      provideFoldingRanges: (model) => (model === this.#model ? this.#foldRanges(model) : []),
    });
    const text = this.#held;
    const model = api.editor.createModel(text, 'markdown');
    model.setEOL(this.#eolFor(text) === '\r\n' ? api.editor.EndOfLineSequence.CRLF : api.editor.EndOfLineSequence.LF);
    this.#model = model;
    this.#applyTheme();
    const style = getComputedStyle(this.element);
    const editor = api.editor.create(this.element, {
      model,
      readOnly: !this.#editable,
      automaticLayout: true,
      wordWrap: 'on',
      fontSize: parseFloat(style.getPropertyValue('--vscode-editor-font-size')) || 13,
      fontFamily: style.getPropertyValue('--vscode-editor-font-family') || 'monospace',
      scrollBeyondLastLine: false,
      folding: true,
      showFoldingControls: 'mouseover',
      renderLineHighlight: 'line',
      quickSuggestions: false,
      suggestOnTriggerCharacters: false,
      wordBasedSuggestions: 'off',
      hover: { enabled: 'off' },
      links: false,
      contextmenu: true,
      ariaLabel: 'Markdown source',
      ...monacoOptions(this.#editorOptions),
    });
    this.#editor = editor;
    this.#marks = editor.createDecorationsCollection();
    // VS Code's undo, redo and save (R-94). Monaco's own history is never used.
    const { KeyMod, KeyCode } = api;
    const command = (name: CodeCommand) => () => this.#o.onCommand?.(name);
    editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyZ, command('undo'));
    editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyY, command('redo'));
    editor.addCommand(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyZ, command('redo'));
    editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyS, command('save'));
    model.onDidChangeContent((event) => {
      // The blocks follow the typing until the app sends new ones (the decorations follow by themselves).
      for (const change of [...event.changes].sort((a, b) => b.rangeOffset - a.rangeOffset)) {
        const edit = { from: change.rangeOffset, to: change.rangeOffset + change.rangeLength, text: change.text };
        this.#blocks = this.#blocks.map((b) => mapBlock(b, edit));
      }
      if (!this.#outside) this.#o.onChange?.();
    });
    editor.onDidChangeCursorPosition((event) => {
      if (!this.#outside && editor.hasTextFocus()) this.#o.onCursor?.(model.getOffsetAt(event.position));
    });
    editor.onDidBlurEditorText(() => this.#o.onBlur?.());
    editor.onDidScrollChange((event) => event.scrollTopChanged && this.#o.onScroll?.());
    this.#paint();
    if (this.#at !== undefined) this.reveal(this.#at, this.#mark ?? undefined);
    if (this.#focus) editor.focus();
  }

  /** The user's theme (or, without one, VS Code's default of the same kind) as the services' current colour theme. */
  setTheme(theme: CodeTheme | null): void {
    this.#theme = theme;
    this.#applyTheme();
  }

  #applyTheme(): void {
    (this.#api as unknown as { __pmd?: { applyTheme(theme: CodeTheme | null, kind: string): void } } | undefined)?.__pmd?.applyTheme(this.#theme ?? null, this.#themeKind());
  }

  #themeKind(): 'light' | 'dark' | 'hc-light' | 'hc-dark' {
    const cls = document.body.classList;
    return cls.contains('vscode-high-contrast-light') ? 'hc-light' : cls.contains('vscode-high-contrast') ? 'hc-dark' : cls.contains('vscode-light') ? 'light' : 'dark';
  }

  /** VS Code's `editor.*` settings changed: apply them. */
  setEditorOptions(options: Record<string, unknown>): void {
    this.#editorOptions = options;
    this.#editor?.updateOptions(monacoOptions(options));
  }

  /** The folds follow the blocks; the block mark follows the other side's cursor. */
  #paint(): void {
    this.#folds.dispatchEvent(new Event('change'));
    this.#paintMark();
  }

  #paintMark(): void {
    const model = this.#model;
    if (!model || !this.#marks) return;
    const m = this.#mark;
    if (!m) return void this.#marks.clear();
    const a = model.getPositionAt(Math.min(m.from, model.getValueLength()));
    const b = model.getPositionAt(Math.min(m.to, model.getValueLength()));
    this.#marks.set([{ range: { startLineNumber: a.lineNumber, startColumn: 1, endLineNumber: b.lineNumber, endColumn: 1 }, options: { isWholeLine: true, className: 'pmd-code-synced' } }]);
  }

  /** A heading folds its section (up to the next heading of the same or a higher level), any other block of several lines folds after its first line. */
  #foldRanges(model: Monaco.editor.ITextModel): Monaco.languages.FoldingRange[] {
    const blocks = this.#blocks;
    const length = model.getValueLength();
    const lineOf = (offset: number) => model.getPositionAt(Math.min(offset, length)).lineNumber;
    const out: Monaco.languages.FoldingRange[] = [];
    blocks.forEach((block, i) => {
      let to = block.to;
      if (block.kind === 'heading') {
        const level = block.level ?? 1;
        let k = i + 1;
        while (k < blocks.length && !(blocks[k]!.kind === 'heading' && (blocks[k]!.level ?? 1) <= level)) k++;
        to = blocks[k - 1]!.to;
      }
      const start = lineOf(block.from);
      const end = lineOf(to);
      if (end > start) out.push({ start, end });
    });
    return out;
  }

  #show(text: string): void {
    const model = this.#model;
    if (!model) {
      this.#held = text;
      return;
    }
    const api = this.#api!;
    const eol = this.#eolFor(text) === '\r\n' ? api.editor.EndOfLineSequence.CRLF : api.editor.EndOfLineSequence.LF;
    this.#outside = true;
    try {
      if (model.getEndOfLineSequence() !== eol) model.setEOL(eol);
      const edit = textDiff(model.getValue(), text);
      if (!edit) return;
      const a = model.getPositionAt(edit.from);
      const b = model.getPositionAt(edit.to);
      model.applyEdits([{ range: { startLineNumber: a.lineNumber, startColumn: a.column, endLineNumber: b.lineNumber, endColumn: b.column }, text: edit.text }]);
    } finally {
      this.#outside = false;
    }
  }

  #eolFor(text: string): string {
    return (this.#o.lineEnding?.() ?? lineEndingOf(text)) === '\r\n' ? '\r\n' : '\n';
  }

  #eolOf(text: string): string {
    return lineEndingOf(text) === '\r\n' ? '\r\n' : '\n';
  }
}

/** The view's frame and the Split view's block mark. Editor UI: VS Code's theme variables. */
export const codeViewCss = `
.pmd-code > .monaco-editor { flex: 1; min-height: 0; }
.pmd-code-synced { background: var(--vscode-editor-lineHighlightBackground, rgba(128,128,128,0.12)); box-shadow: inset 2px 0 0 var(--vscode-editorIndentGuide-activeBackground1, rgba(128,128,128,0.5)); }
`;
