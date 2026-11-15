// A small stand-in for the 'vscode' module, so host code can be unit-tested with Vitest outside VS Code.
// vitest.config.ts maps every `import 'vscode'` here. Add only what tests need; keep shapes faithful to
// @types/vscode. The real API is exercised by the tests in the VS Code test host (test/vscode).
import type * as vscode from 'vscode';
import { posix } from 'node:path';

type Listener<T> = (e: T) => unknown;

/** vscode.EventEmitter's shape, enough for the events the host listens to. */
export class EventEmitter<T> {
  readonly #listeners = new Set<Listener<T>>();
  readonly event = (listener: Listener<T>): { dispose(): void } => {
    this.#listeners.add(listener);
    return { dispose: () => this.#listeners.delete(listener) };
  };
  fire(e: T): void {
    for (const listener of [...this.#listeners]) listener(e);
  }
  get size(): number {
    return this.#listeners.size;
  }
}

// ── values ──

export class Uri {
  private constructor(
    readonly scheme: string,
    readonly authority: string,
    readonly path: string,
  ) {}
  static parse(value: string): Uri {
    const m = /^([a-z][a-z0-9+.-]*):(?:\/\/([^/]*))?(.*)$/i.exec(value);
    return m ? new Uri(m[1]!, m[2] ?? '', m[3] ?? '') : new Uri('file', '', value);
  }
  static file(path: string): Uri {
    return new Uri('file', '', path.startsWith('/') ? path : `/${path}`);
  }
  /** A POSIX stand-in for VS Code's platform-native fsPath (P5: the styles service uses it as a plain path). */
  get fsPath(): string {
    return this.path;
  }
  static joinPath(base: Uri, ...segments: string[]): Uri {
    const parts: string[] = [];
    for (const part of [...base.path.split('/'), ...segments.flatMap((s) => s.split('/'))]) {
      if (part === '..') parts.pop();
      else if (part !== '' && part !== '.') parts.push(part);
    }
    return new Uri(base.scheme, base.authority, `/${parts.join('/')}`);
  }
  toString(): string {
    return `${this.scheme}://${this.authority}${this.path}`;
  }
}

export class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
}

export class Range {
  readonly start: Position;
  readonly end: Position;
  /** `new Range(start, end)` or, as VS Code also takes it, `new Range(startLine, startCharacter, endLine, endCharacter)`. */
  constructor(start: Position | number, end: Position | number, endLine?: number, endCharacter?: number) {
    if (typeof start === 'number') {
      this.start = new Position(start, end as number);
      this.end = new Position(endLine ?? start, endCharacter ?? (end as number));
    } else {
      this.start = start;
      this.end = end as Position;
    }
  }
}

/** P14: VS Code's problem severities (the numbers are VS Code's). */
export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}

export class Location {
  constructor(
    readonly uri: Uri,
    readonly range: Position | Range,
  ) {}
}

export class DiagnosticRelatedInformation {
  constructor(
    readonly location: Location,
    readonly message: string,
  ) {}
}

export class Diagnostic {
  source?: string;
  code?: string | number;
  relatedInformation?: DiagnosticRelatedInformation[];
  constructor(
    readonly range: Range,
    readonly message: string,
    readonly severity: DiagnosticSeverity = DiagnosticSeverity.Error,
  ) {}
}

/** P14: a DiagnosticCollection (what the Problems panel shows), entries by URI string. */
export class MockDiagnosticCollection {
  readonly entries = new Map<string, Diagnostic[]>();
  disposed = false;
  constructor(readonly name: string) {}
  set(uri: Uri, diagnostics: Diagnostic[]): void {
    this.entries.set(uri.toString(), diagnostics);
  }
  delete(uri: Uri): void {
    this.entries.delete(uri.toString());
  }
  get(uri: Uri): Diagnostic[] | undefined {
    return this.entries.get(uri.toString());
  }
  clear(): void {
    this.entries.clear();
  }
  dispose(): void {
    this.disposed = true;
    this.entries.clear();
  }
}

/** VS Code's symbol kinds (P9: the Outline's icons); the numbers are VS Code's. */
export enum ExtensionMode {
  Production = 1,
  Development = 2,
  Test = 3,
}

export enum SymbolKind {
  File = 0,
  Module = 1,
  Namespace = 2,
  Package = 3,
  Class = 4,
  Method = 5,
  Property = 6,
  Field = 7,
  Constructor = 8,
  Enum = 9,
  Interface = 10,
  Function = 11,
  Variable = 12,
  Constant = 13,
  String = 14,
  Number = 15,
  Boolean = 16,
  Array = 17,
  Object = 18,
  Key = 19,
  Null = 20,
  EnumMember = 21,
  Struct = 22,
  Event = 23,
  Operator = 24,
  TypeParameter = 25,
}

export class DocumentSymbol {
  children: DocumentSymbol[] = [];
  constructor(
    readonly name: string,
    readonly detail: string,
    readonly kind: SymbolKind,
    readonly range: Range,
    readonly selectionRange: Range,
  ) {}
}

/** A watch pattern relative to a base folder (P5): enough for `workspace.createFileSystemWatcher`. */
export class RelativePattern {
  constructor(
    readonly base: Uri,
    readonly pattern: string,
  ) {}
}

export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64,
}

export class WorkspaceEdit {
  readonly edits: { uri: Uri; range: Range; text: string }[] = [];
  replace(uri: Uri, range: Range, text: string): void {
    this.edits.push({ uri, range, text });
  }
}

export enum EndOfLine {
  LF = 1,
  CRLF = 2,
}

/** A text document with real offset ⇄ position conversion; `setText` plays VS Code applying a change. */
export class MockTextDocument {
  version = 1;
  isDirty = false;
  /** The file's line ending, as VS Code reads it from the text (a blank file: `files.eol`; tests set it). */
  eol: EndOfLine;
  constructor(
    readonly uri: Uri,
    private text: string,
  ) {
    this.eol = text.includes('\r\n') ? EndOfLine.CRLF : EndOfLine.LF;
  }
  getText(): string {
    return this.text;
  }
  get lineCount(): number {
    return this.text.split(/\r\n|\r|\n/).length;
  }
  lineAt(line: number): { text: string; range: Range } {
    const text = this.text.split(/\r\n|\r|\n/)[line] ?? '';
    return { text, range: new Range(new Position(line, 0), new Position(line, text.length)) };
  }
  positionAt(offset: number): Position {
    const before = this.text.slice(0, offset);
    const line = before.split(/\r\n|\r|\n/).length - 1;
    const lastBreak = Math.max(before.lastIndexOf('\n'), before.lastIndexOf('\r'));
    return new Position(line, offset - lastBreak - 1);
  }
  offsetAt(position: Position): number {
    const re = /\r\n|\r|\n/g;
    let offset = 0;
    for (let line = 0; line < position.line; line++) {
      const m = re.exec(this.text);
      if (!m) return this.text.length;
      offset = m.index + m[0].length;
    }
    return offset + position.character;
  }
  /** Replaces the text as VS Code would, bumping the version and firing onDidChangeTextDocument. */
  setText(text: string): void {
    this.text = text;
    this.version++;
    this.isDirty = true;
    workspaceEvents.change.fire({ document: this as unknown as vscode.TextDocument, contentChanges: [{ text }] as unknown as vscode.TextDocumentContentChangeEvent[], reason: undefined });
  }
}

// ── namespaces ──

export interface MockOutputChannel {
  readonly name: string;
  readonly lines: string[];
  /** FIX-PGF: lines written at debug level (a LogOutputChannel's `debug`). */
  readonly debugLines: string[];
  appendLine(value: string): void;
  debug(value: string): void;
  dispose(): void;
}

export const createdChannels: MockOutputChannel[] = [];
export const registeredEditors: { viewType: string; provider: unknown; options: unknown }[] = [];
export const shownErrors: string[] = [];
export const shownInfo: string[] = [];
export const executedCommands: unknown[][] = [];
export const openedExternal: string[] = [];
/** What showOpenDialog returns next. */
export const dialog: { next: Uri[] | undefined } = { next: undefined };

/** Every `showWarningMessage` call (P5, the create-layout confirm prompt). */
export const shownWarnings: { message: string; detail?: string; modal?: boolean; items: string[] }[] = [];
/** The button `showWarningMessage` returns next (undefined = dismissed / "Cancel"). */
export const warningDialog: { next: string | undefined } = { next: undefined };

/** Every `showQuickPick` call's items (P6, the view picker), and the label it picks next (undefined = dismissed). */
export const quickPicks: { items: string[]; descriptions?: (string | undefined)[]; placeHolder?: string }[] = [];
export const quickPick: { next: string | undefined } = { next: undefined };
/** L3: the labels ticked in the next multi-select lists, one entry per list shown (an undefined entry = dismissed). */
export const quickPickMany: { queue: (string[] | undefined)[] } = { queue: [] };
/** L3: what showInputBox returns next. */
export const inputBox: { next: string | undefined } = { next: undefined };
/** L3: the GitHub sign-in (`authentication.getSession`): every call, and the session it answers (null: none / refused). */
export const authCalls: { provider: string; scopes: readonly string[]; options: unknown }[] = [];
export const authSession: { next: { accessToken: string } | null; silentNext: { accessToken: string } | null } = { next: null, silentNext: null };
/** L3: the cancel button of the next withProgress (call `cancel()` from a test to press it). */
export const progressCancel = new EventEmitter<void>();
/** L3: every progress message reported through withProgress. */
export const progressMessages: string[] = [];

/** P10: every `showSaveDialog` call (the Export dialog) and what it answers next (undefined = cancelled). */
export const saveDialogs: { defaultUri?: Uri; filters?: Record<string, string[]>; saveLabel?: string }[] = [];
export const saveDialog: { next: Uri | undefined } = { next: undefined };
/** P10: every `withProgress` title. */
export const progressTitles: string[] = [];

/** P25: where `vscode.open` shows a file. */
export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
  Two = 2,
}

export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15,
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

/** R-234: the build item. `statusItems` lists every one created; `tabs.active` is the active tab's input (set by a test, then `tabs.changed.fire()`). */
export interface MockStatusItem {
  text: string;
  tooltip?: unknown;
  command?: string;
  name?: string;
  accessibilityInformation?: unknown;
  visible: boolean;
  show(): void;
  hide(): void;
  dispose(): void;
}
export const statusItems: MockStatusItem[] = [];
export const tabs: { active: { viewType?: string } | undefined; changed: EventEmitter<unknown> } = { active: undefined, changed: new EventEmitter<unknown>() };

/** Native split (protocol v15): the text editor beside the canvas; tests drive it through `editors`. */
export class Selection {
  constructor(readonly anchor: Position, readonly active: Position) {}
}
export class ThemeColor {
  constructor(readonly id: string) {}
}
export enum TextEditorRevealType {
  Default = 0,
  InCenter = 1,
  InCenterIfOutsideViewport = 2,
  AtTop = 3,
}
export class TabInputText {
  constructor(readonly uri: Uri) {}
}
export const editors: { visible: unknown[]; selection: EventEmitter<unknown>; visibleChanged: EventEmitter<unknown[]> } = { visible: [], selection: new EventEmitter<unknown>(), visibleChanged: new EventEmitter<unknown[]>() };

export const window = {
  get visibleTextEditors(): unknown[] {
    return editors.visible;
  },
  onDidChangeTextEditorSelection: editors.selection.event,
  onDidChangeVisibleTextEditors: editors.visibleChanged.event,
  onDidChangeActiveColorTheme: new EventEmitter<unknown>().event,
  createTextEditorDecorationType: () => ({ dispose() {} }),
  createStatusBarItem(): MockStatusItem {
    const item: MockStatusItem = { text: '', visible: false, show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} };
    statusItems.push(item);
    return item;
  },
  tabGroups: {
    get activeTabGroup() {
      return { activeTab: tabs.active ? { input: tabs.active } : undefined };
    },
    onDidChangeTabs: tabs.changed.event,
    all: [] as { viewColumn: number; tabs: unknown[] }[],
    close: async () => true,
  },
  createOutputChannel(name: string, _options?: { log: true }): MockOutputChannel {
    const channel: MockOutputChannel = {
      name,
      lines: [],
      debugLines: [],
      appendLine(value) {
        this.lines.push(value);
      },
      debug(value) {
        this.debugLines.push(value);
      },
      dispose() {},
    };
    createdChannels.push(channel);
    return channel;
  },
  registerCustomEditorProvider(viewType: string, provider: unknown, options?: unknown) {
    registeredEditors.push({ viewType, provider, options });
    return { dispose() {} };
  },
  showErrorMessage(message: string) {
    shownErrors.push(message);
    return Promise.resolve(undefined);
  },
  showInformationMessage(message: string) {
    shownInfo.push(message);
    return Promise.resolve(undefined);
  },
  showWarningMessage(message: string, optionsOrItem?: { detail?: string; modal?: boolean } | string, ...rest: string[]) {
    // VS Code takes the options object first or straight away the buttons (L3 uses both forms).
    const options = typeof optionsOrItem === 'object' ? optionsOrItem : undefined;
    const items = typeof optionsOrItem === 'string' ? [optionsOrItem, ...rest] : rest;
    shownWarnings.push({ message, detail: options?.detail, modal: options?.modal, items });
    return Promise.resolve(warningDialog.next);
  },
  showQuickPick<T extends { label: string }>(items: readonly T[], options?: { placeHolder?: string; canPickMany?: boolean }): Promise<T | T[] | undefined> {
    quickPicks.push({ items: items.map((i) => i.label), descriptions: items.map((i) => (i as { description?: string }).description), ...(options?.placeHolder ? { placeHolder: options.placeHolder } : {}) });
    // L3: a list you can tick several of answers with `quickPickMany.next` (labels; undefined = dismissed), then the next list's.
    if (options?.canPickMany) {
      const labels = quickPickMany.queue.shift();
      return Promise.resolve(labels === undefined ? undefined : items.filter((i) => labels.includes(i.label)));
    }
    return Promise.resolve(items.find((i) => i.label === quickPick.next));
  },
  showInputBox: () => Promise.resolve(inputBox.next),
  showOpenDialog: () => Promise.resolve(dialog.next),
  showSaveDialog(options: { defaultUri?: Uri; filters?: Record<string, string[]>; saveLabel?: string }) {
    saveDialogs.push(options);
    return Promise.resolve(saveDialog.next);
  },
  withProgress<T>(options: { title?: string }, task: (progress: { report(value: { message?: string }): void }, token: { onCancellationRequested: vscode.Event<void> }) => Promise<T>): Promise<T> {
    progressTitles.push(options.title ?? '');
    return task({ report: (v) => void (v.message && progressMessages.push(v.message)) }, { onCancellationRequested: progressCancel.event });
  },
};

export const workspaceEvents = {
  change: new EventEmitter<vscode.TextDocumentChangeEvent>(),
  willSave: new EventEmitter<vscode.TextDocumentWillSaveEvent>(),
  didSave: new EventEmitter<vscode.TextDocument>(),
};

/** How applyEdit behaves: 'apply' (default) changes the MockTextDocument; 'refuse' returns false. */
export const applyEditMode: { value: 'apply' | 'refuse'; delayMs: number } = { value: 'apply', delayMs: 0 };

// ── an in-memory file system backing `workspace.fs` (P5: the styles service reads/writes real-looking files) ──

const normalizeKey = (p: string): string => (p.replace(/\/+$/, '') || '/').replace(/\\/g, '/');

/** Files by absolute path (mock URI convention, leading '/'); populate before a test, or via `workspace.fs`. */
export const mockFiles = new Map<string, Uint8Array>();
/** Folders that exist even with nothing in them yet. */
export const mockDirs = new Set<string>(['/']);

function hasEntry(key: string): boolean {
  return mockFiles.has(key) || mockDirs.has(key) || [...mockFiles.keys(), ...mockDirs].some((p) => p.startsWith(`${key}/`));
}

const mockFs = {
  async stat(uri: Uri): Promise<{ type: number; size: number; ctime: number; mtime: number }> {
    const key = normalizeKey(uri.path);
    const file = mockFiles.get(key);
    if (file) return { type: FileType.File, size: file.length, ctime: 0, mtime: 0 };
    if (hasEntry(key)) return { type: FileType.Directory, size: 0, ctime: 0, mtime: 0 };
    throw new Error(`ENOENT, no such file or directory '${uri.path}'`);
  },
  async readFile(uri: Uri): Promise<Uint8Array> {
    const data = mockFiles.get(normalizeKey(uri.path));
    if (!data) throw new Error(`ENOENT, no such file or directory '${uri.path}'`);
    return data;
  },
  async writeFile(uri: Uri, content: Uint8Array): Promise<void> {
    const key = normalizeKey(uri.path);
    const existed = mockFiles.has(key);
    mockFiles.set(key, content);
    fireFsEvent(existed ? 'change' : 'create', uri.path);
  },
  async createDirectory(uri: Uri): Promise<void> {
    mockDirs.add(normalizeKey(uri.path));
  },
  async readDirectory(uri: Uri): Promise<[string, number][]> {
    const key = normalizeKey(uri.path);
    const prefix = key === '/' ? '/' : `${key}/`;
    const entries = new Map<string, number>();
    for (const f of mockFiles.keys()) {
      if (!f.startsWith(prefix)) continue;
      const rest = f.slice(prefix.length);
      const name = rest.split('/')[0]!;
      entries.set(name, rest.includes('/') ? FileType.Directory : FileType.File);
    }
    for (const d of mockDirs) {
      if (!d.startsWith(prefix) || d === key) continue;
      const name = d.slice(prefix.length).split('/')[0]!;
      if (!entries.has(name)) entries.set(name, FileType.Directory);
    }
    if (entries.size === 0 && !mockDirs.has(key)) throw new Error(`ENOENT, no such file or directory '${uri.path}'`);
    return [...entries];
  },
};

// ── file system watchers (P5, amendment 6/8: `createFileSystemWatcher`) ──

interface MockWatcher {
  baseDir: string;
  pattern: string;
  change: EventEmitter<Uri>;
  create: EventEmitter<Uri>;
  delete: EventEmitter<Uri>;
}

/** Every watcher created and not yet disposed (a test can inspect this instead of only firing events). */
export const fsWatchers: MockWatcher[] = [];

/** A small glob → RegExp, enough for the patterns this repo's watchers use (`**`, `*`, `{a,b}`). */
function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '*' && pattern[i + 1] === '*') {
      out += '.*';
      i++;
      if (pattern[i + 1] === '/') i++;
    } else if (c === '*') out += '[^/]*';
    else if (c === '{') {
      const end = pattern.indexOf('}', i);
      out += `(?:${pattern
        .slice(i + 1, end)
        .split(',')
        .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|')})`;
      i = end;
    } else if ('.+^$()|[]\\'.includes(c)) out += `\\${c}`;
    else out += c;
  }
  return new RegExp(`^${out}$`);
}

/** Fires every watcher whose base + pattern matches `path` (a test helper: also called by mockFs.writeFile). */
export function fireFsEvent(kind: 'change' | 'create' | 'delete', path: string): void {
  for (const w of [...fsWatchers]) {
    const rel = posix.relative(w.baseDir, normalizeKey(path));
    if (rel.startsWith('..')) continue;
    if (globToRegExp(w.pattern).test(rel)) w[kind].fire(Uri.file(path));
  }
}

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

/** Fires on `getConfiguration(...).update` and tests' `fireConfigurationChange` (P7: the gatedInsert setting). */
export const configurationEvents = { change: new EventEmitter<{ affectsConfiguration(section: string): boolean }>() };
/** What `getConfiguration(...).inspect(key)` returns, keyed `'section.key'`. */
export const configurationScopes = new Map<string, { globalValue?: unknown; workspaceValue?: unknown; workspaceFolderValue?: unknown }>();
/** Every `getConfiguration(...).update` call, in order. */
export const configurationUpdates: { key: string; value: unknown; target: unknown }[] = [];

/** L3: the GitHub sign-in, as VS Code's `authentication.getSession` answers it. */
export const authentication = {
  getSession(provider: string, scopes: readonly string[], options?: { createIfNone?: boolean; silent?: boolean }) {
    authCalls.push({ provider, scopes, options });
    return Promise.resolve(options?.createIfNone ? authSession.next : authSession.silentNext);
  },
};

export const workspace = {
  /** L3: false in a workspace the user has not trusted. */
  isTrusted: true,
  workspaceFolders: undefined as { uri: Uri }[] | undefined,
  onDidChangeTextDocument: workspaceEvents.change.event,
  onWillSaveTextDocument: workspaceEvents.willSave.event,
  onDidSaveTextDocument: workspaceEvents.didSave.event,
  async applyEdit(edit: WorkspaceEdit): Promise<boolean> {
    if (applyEditMode.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, applyEditMode.delayMs)); // VS Code applies edits asynchronously
    if (applyEditMode.value === 'refuse') return false;
    // One WorkspaceEdit on one document = one change (VS Code applies it as one operation).
    const doc = openDocuments.find((d) => d.uri.toString() === edit.edits[0]?.uri.toString());
    if (!doc) return false;
    // VS Code turns every line break an edit inserts into the document's own line ending.
    const eol = doc.eol === EndOfLine.CRLF ? '\r\n' : '\n';
    const spans = edit.edits.map((e) => ({ from: doc.offsetAt(e.range.start), to: doc.offsetAt(e.range.end), text: e.text.replace(/\r\n|\r|\n/g, eol) })).sort((a, b) => a.from - b.from);
    let text = doc.getText();
    for (const s of [...spans].reverse()) text = text.slice(0, s.from) + s.text + text.slice(s.to);
    doc.setText(text);
    return true;
  },
  fs: mockFs,
  getWorkspaceFolder(uri: Uri): { uri: Uri } | undefined {
    return workspace.workspaceFolders?.find((f) => uri.path === f.uri.path || uri.path.startsWith(`${f.uri.path.replace(/\/$/, '')}/`));
  },
  createFileSystemWatcher(pattern: RelativePattern | string) {
    const entry: MockWatcher = {
      baseDir: normalizeKey(pattern instanceof RelativePattern ? pattern.base.path : '/'),
      pattern: pattern instanceof RelativePattern ? pattern.pattern : pattern,
      change: new EventEmitter<Uri>(),
      create: new EventEmitter<Uri>(),
      delete: new EventEmitter<Uri>(),
    };
    fsWatchers.push(entry);
    return {
      onDidChange: entry.change.event,
      onDidCreate: entry.create.event,
      onDidDelete: entry.delete.event,
      dispose() {
        const i = fsWatchers.indexOf(entry);
        if (i >= 0) fsWatchers.splice(i, 1);
      },
    };
  },
  onDidChangeConfiguration: configurationEvents.change.event,
  getConfiguration(section?: string) {
    const prefix = section ? `${section}.` : '';
    return {
      get: (key: string, fallback?: unknown) => configuration.get(`${prefix}${key}`) ?? fallback,
      /** The value at each scope, from `configurationScopes` (a test sets what a user, workspace or folder wrote). */
      inspect: (key: string) => configurationScopes.get(`${prefix}${key}`),
      update(key: string, value: unknown, target?: unknown) {
        configurationUpdates.push({ key: `${prefix}${key}`, value, target });
        configuration.set(`${prefix}${key}`, value);
        configurationEvents.change.fire({ affectsConfiguration: (name: string) => `${prefix}${key}`.startsWith(name) });
        return Promise.resolve();
      },
    };
  },
};

/** Backs `workspace.getConfiguration(section).get(key)`, keyed `'section.key'`. */
export const configuration = new Map<string, unknown>();

/** Documents that workspace.applyEdit can change. */
export const openDocuments: MockTextDocument[] = [];

export const env = {
  openExternal(uri: Uri) {
    openedExternal.push(uri.toString());
    return Promise.resolve(true);
  },
};

/** Symbol providers registered by `languages.registerDocumentSymbolProvider` (P9). */
export const symbolProviders: { selector: unknown; provider: { provideDocumentSymbols(document: unknown): unknown }; metadata: unknown }[] = [];

/** Diagnostic collections created by `languages.createDiagnosticCollection` (P14). */
export const diagnosticCollections: MockDiagnosticCollection[] = [];

export const languages = {
  createDiagnosticCollection(name: string) {
    const collection = new MockDiagnosticCollection(name);
    diagnosticCollections.push(collection);
    return collection;
  },
  registerDocumentSymbolProvider(selector: unknown, provider: { provideDocumentSymbols(document: unknown): unknown }, metadata?: unknown) {
    const entry = { selector, provider, metadata };
    symbolProviders.push(entry);
    return { dispose: () => symbolProviders.splice(symbolProviders.indexOf(entry), 1) };
  },
};

/** Commands registered by `commands.registerCommand` (P5, R-132), by id. */
export const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();

export const commands = {
  executeCommand(...args: unknown[]) {
    executedCommands.push(args);
    const [id, ...rest] = args;
    const handler = typeof id === 'string' ? registeredCommands.get(id) : undefined;
    return Promise.resolve(handler?.(...rest));
  },
  registerCommand(id: string, handler: (...args: unknown[]) => unknown) {
    registeredCommands.set(id, handler);
    return { dispose: () => registeredCommands.delete(id) };
  },
};

// ── test helpers ──

/** A minimal ExtensionContext: only the parts the host touches. */
export function createExtensionContext(extensionMode: number = ExtensionMode.Development): vscode.ExtensionContext {
  // P11: the two mementos the default-editor sync remembers what it wrote in.
  const memento = () => {
    const data = new Map<string, unknown>();
    return { keys: () => [...data.keys()], get: (key: string, fallback?: unknown) => (data.has(key) ? data.get(key) : fallback), update: (key: string, value: unknown) => (data.set(key, value), Promise.resolve()) };
  };
  return { subscriptions: [] as { dispose(): unknown }[], extensionUri: Uri.file('/ext'), extension: { packageJSON: { version: '9.9.9-test' } }, extensionMode, globalState: memento(), workspaceState: memento() } as unknown as vscode.ExtensionContext;
}

/** A webview panel whose messages tests can read (`posted`) and send (`receive`); starts active (R-132). */
export function createWebviewPanel() {
  const received = new EventEmitter<unknown>();
  const disposed = new EventEmitter<void>();
  const viewState = new EventEmitter<{ webviewPanel: unknown }>();
  const posted: unknown[] = [];
  const state = { active: true };
  const webview = {
    options: {} as vscode.WebviewOptions,
    html: '',
    cspSource: 'https://webview.test',
    asWebviewUri: (uri: Uri) => Uri.parse(`https://webview.test${uri.path}`),
    postMessage(message: unknown) {
      posted.push(structuredClone(message));
      return Promise.resolve(true);
    },
    onDidReceiveMessage: received.event,
  };
  const panel = {
    webview,
    get active() {
      return state.active;
    },
    onDidDispose: disposed.event,
    onDidChangeViewState: viewState.event,
    dispose: () => disposed.fire(),
  };
  return {
    panel: panel as unknown as vscode.WebviewPanel,
    webview,
    posted,
    receive: (m: unknown) => received.fire(structuredClone(m)),
    dispose: () => disposed.fire(),
    /** Plays VS Code activating or backgrounding this panel (a tab switch). */
    setActive: (active: boolean) => {
      state.active = active;
      viewState.fire({ webviewPanel: panel });
    },
  };
}

/** Resets the recorded calls between tests. */
export function resetMock(): void {
  for (const list of [createdChannels, registeredEditors, shownErrors, shownInfo, shownWarnings, executedCommands, openedExternal, openDocuments, fsWatchers, configurationUpdates, symbolProviders, diagnosticCollections, statusItems]) list.length = 0;
  tabs.active = undefined;
  registeredCommands.clear();
  mockFiles.clear();
  mockDirs.clear();
  mockDirs.add('/');
  configuration.clear();
  configurationScopes.clear();
  dialog.next = undefined;
  warningDialog.next = undefined;
  quickPicks.length = 0;
  quickPick.next = undefined;
  saveDialogs.length = 0;
  saveDialog.next = undefined;
  progressTitles.length = 0;
  applyEditMode.value = 'apply';
  applyEditMode.delayMs = 0;
  workspace.workspaceFolders = undefined;
}

/** The installed extensions (the colour theme lookup of the Code view): none by default. */
export const extensions = { all: [] as { packageJSON: unknown; extensionUri: Uri }[], getExtension: () => undefined as unknown, onDidChange: new EventEmitter<unknown>().event };
