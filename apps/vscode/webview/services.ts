// The host services as the webview's editor sees them (R-87 amendment 2): each one is a plugin that provides
// a core token (ADR-0013) and forwards every call to the host through the channel from messaging.ts.
import { IAssets, IDiagnostics, IDocumentSync, ILinks, ISidecar, IStyles, type Diagnostic, type Disposable, type EditorPlugin, type PageGeometry, type ResolvedStyles, type TextEdit } from '@pagemd-editor/core';
import { defaultStyles } from '@pagemd-editor/style-default';
import type { CreateLayoutResult, DiagnosticsPayload, Json, LineEnding, StylesPayload } from '../shared/protocol.ts';
import type { WebviewChannel } from './messaging.ts';

type ExternalListener = (text: string, version: number) => void;

/**
 * IDocumentSync over messages. Also knows the document version the host last reported and (protocol v11) the file's line
 * ending: VS Code turns every line break an edit inserts into that one, so the webview's edits must use it too.
 */
export class DocumentSyncClient implements IDocumentSync {
  readonly #channel: WebviewChannel;
  readonly #listeners = new Set<ExternalListener>();
  #version: number;
  #eol: LineEnding | undefined;
  #changes = 0;

  constructor(channel: WebviewChannel, version: number, eol?: LineEnding) {
    this.#channel = channel;
    this.#version = version;
    this.#eol = eol;
    channel.on('externalChange', ({ text, version: v, eol: e }) => this.#external(text, v, e));
  }

  /** The document version the next edits should be computed against. */
  get version(): number {
    return this.#version;
  }

  /** The file's line ending as the host last reported it; undefined from a host that doesn't say (before v11). */
  get eol(): LineEnding | undefined {
    return this.#eol;
  }

  /** How many outside changes (and stale answers) have arrived: a request that sees this move learned the host's text from them. */
  get changes(): number {
    return this.#changes;
  }

  async applyEdits(edits: TextEdit[], version: number): Promise<'ok' | 'stale'> {
    const result = await this.#channel.request('applyEdits', { edits, version });
    if (result.status === 'ok') {
      this.#version = result.version;
      return 'ok';
    }
    // Stale: the host sent the document as it is now; everyone re-reads it.
    this.#external(result.text, result.version, result.eol);
    return 'stale';
  }

  onExternalChange(cb: ExternalListener): Disposable {
    this.#listeners.add(cb);
    return { dispose: () => this.#listeners.delete(cb) };
  }

  #external(text: string, version: number, eol: LineEnding | undefined): void {
    this.#version = version;
    if (eol) this.#eol = eol;
    this.#changes++;
    for (const listener of this.#listeners) listener(text, version);
  }
}

export class AssetsClient implements IAssets {
  readonly #channel: WebviewChannel;

  constructor(channel: WebviewChannel) {
    this.#channel = channel;
  }

  writeAsset(bytes: Uint8Array, name: string): Promise<string> {
    return this.#channel.request('writeAsset', { bytes, name });
  }

  pickFile(filter?: string[]): Promise<string | undefined> {
    return this.#channel.request('pickFile', filter ? { filter } : {});
  }

  /** P15 (protocol v10): the picture's bytes, read by the host (R-196's limits apply there). */
  async readAsset(path: string): Promise<Uint8Array> {
    const bytes: unknown = await this.#channel.request('readAsset', { path });
    if (bytes instanceof Uint8Array) return bytes;
    if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
    throw new Error('readAsset: the host sent no picture bytes.');
  }
}

/** ISidecar over messages (P12, protocol v8): the review comments' side file, read and written on the host. */
export class SidecarClient implements ISidecar {
  readonly #channel: WebviewChannel;

  constructor(channel: WebviewChannel) {
    this.#channel = channel;
  }

  read(kind: 'comments'): Promise<unknown> {
    return this.#channel.request('readSidecar', { kind });
  }

  write(kind: 'comments', data: unknown): Promise<void> {
    return this.#channel.request('writeSidecar', { kind, data: data as Json });
  }

  /** The host says the file changed on disk. */
  onChanged(cb: () => void): Disposable {
    return this.#channel.on('sidecarChanged', () => cb());
  }
}

/**
 * IDiagnostics over messages (P14, protocol v9): the profile's checks run on the host; each run's results arrive as a
 * `diagnostics` event. Keeps the last one (the canvas shows it again after a re-read).
 */
export class DiagnosticsClient implements IDiagnostics {
  readonly #listeners = new Set<(payload: DiagnosticsPayload) => void>();
  #last: DiagnosticsPayload | null = null;

  constructor(channel: WebviewChannel) {
    channel.on('diagnostics', (payload) => {
      this.#last = payload;
      for (const listener of [...this.#listeners]) listener(payload);
    });
  }

  /** The last results (null before the first run). */
  get last(): DiagnosticsPayload | null {
    return this.#last;
  }

  onResults(cb: (diagnostics: Diagnostic[]) => void): Disposable {
    return this.onPayload((payload) => cb(payload.shown ? payload.items : []));
  }

  /** Like onResults, with the text the results are about and whether the profile asks for checks. */
  onPayload(cb: (payload: DiagnosticsPayload) => void): Disposable {
    this.#listeners.add(cb);
    return { dispose: () => this.#listeners.delete(cb) };
  }
}

export class LinksClient implements ILinks {
  readonly #channel: WebviewChannel;

  constructor(channel: WebviewChannel) {
    this.#channel = channel;
  }

  open(href: string): void {
    this.#channel.emit('openLink', { href });
  }
}

type StylesListener = (payload: StylesPayload) => void;

/**
 * IStyles over messages (P5, protocol v2). Keeps the latest styles the host sent (in `init`, then every
 * `stylesChanged`), so the canvas and the status bar read them without asking. A document with plain styles
 * (`payload.styles` null) gets style-default's.
 */
export class StylesClient implements IStyles {
  readonly #channel: WebviewChannel;
  readonly #listeners = new Set<StylesListener>();
  #payload: StylesPayload;

  constructor(channel: WebviewChannel, initial: StylesPayload) {
    this.#channel = channel;
    this.#payload = initial;
    channel.on('stylesChanged', (payload) => this.#changed(payload));
  }

  /** The latest styles, gate defaults and notes the host sent. */
  get payload(): StylesPayload {
    return this.#payload;
  }

  /** The styles to use now: the document's, or style-default's plain styles. */
  get styles(): ResolvedStyles {
    return this.#payload.styles ?? defaultStyles();
  }

  async getStyles(): Promise<ResolvedStyles> {
    this.#payload = await this.#channel.request('getStyles', {});
    return this.styles;
  }

  onChange(cb: (styles: ResolvedStyles) => void): Disposable {
    return this.onPayload(() => cb(this.styles));
  }

  /** Like onChange, with the gate defaults and notes too (the webview re-reads the document on a gate change). */
  onPayload(cb: StylesListener): Disposable {
    this.#listeners.add(cb);
    return { dispose: () => this.#listeners.delete(cb) };
  }

  async createLayoutFile(page: PageGeometry): Promise<void> {
    await this.createLayout(page);
  }

  /** createLayoutFile, telling whether the author confirmed ('created') or not ('declined'). */
  createLayout(page: PageGeometry): Promise<CreateLayoutResult> {
    return this.#channel.request('createLayoutFile', { page });
  }

  #changed(payload: StylesPayload): void {
    this.#payload = payload;
    for (const listener of this.#listeners) listener(payload);
  }
}

export interface HostClients {
  sync: DocumentSyncClient;
  assets: AssetsClient;
  links: LinksClient;
  styles: StylesClient;
  sidecar: SidecarClient;
  diagnostics: DiagnosticsClient;
}

export function createClients(channel: WebviewChannel, version: number, styles: StylesPayload, eol?: LineEnding): HostClients {
  return { sync: new DocumentSyncClient(channel, version, eol), assets: new AssetsClient(channel), links: new LinksClient(channel), styles: new StylesClient(channel, styles), sidecar: new SidecarClient(channel), diagnostics: new DiagnosticsClient(channel) };
}

/** The clients as editor plugins, one token each (IStyles from P5, protocol v2). */
export function servicePlugins(clients: HostClients): EditorPlugin<unknown>[] {
  return [
    { id: 'vscode:document-sync', provides: IDocumentSync, activate: () => clients.sync },
    { id: 'vscode:assets', provides: IAssets, activate: () => clients.assets },
    { id: 'vscode:links', provides: ILinks, activate: () => clients.links },
    { id: 'vscode:styles', provides: IStyles, activate: () => clients.styles },
    { id: 'vscode:sidecar', provides: ISidecar, activate: () => clients.sidecar },
    { id: 'vscode:diagnostics', provides: IDiagnostics, activate: () => clients.diagnostics },
  ];
}
