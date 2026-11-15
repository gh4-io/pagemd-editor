// IDiagnostics, host side (P14, ADR-0017, R-189): the checks the document's profile asks for, run by plugin-diagnostics'
// host entry (@pagemd/validate, the rules `pagemd validate` runs) over VS Code's file API, shown in VS Code's Problems panel
// and sent to the webview for the canvas's hints. They run off the typing path: on opening, once typing stops, on save,
// when the profile's files change (the styles service's change event), when an image in the document's folders changes,
// and on "pagemd: Check Document". With no `validation` setting in the profile nothing is checked (R-30). The setting
// `pagemdEditor.showProblems` (default on) can only hide results (ADR-0017 V5): off, nothing runs and nothing shows.
import * as vscode from 'vscode';
import * as nodePath from 'node:path';
import { checkDocument, codeOf, type CheckEnvironment, type PagemdDiagnostic, toCoreDiagnostics } from '@pagemd-editor/plugin-diagnostics/check';
import type { DiagnosticsPayload } from '../../shared/protocol.ts';
import { pagemdPathOf, vscodeFileSystem } from './styles.ts';
import { pagemdEnvironment } from './environment.ts';

/** How long typing must pause before the checks run again. */
export const CHECK_DEBOUNCE_MS = 700;

/** The setting that hides every pagemd problem (it can only hide, ADR-0017 V5). */
export const SHOW_PROBLEMS = 'pagemdEditor.showProblems';

export function showProblems(uri?: vscode.Uri): boolean {
  return vscode.workspace.getConfiguration('pagemdEditor', uri).get<boolean>('showProblems') !== false;
}

/** The answer of one run: what the Problems panel shows for the document, and why. */
export interface CheckSummary {
  /** The profile asks for checks. */
  enabled: boolean;
  /** `pagemdEditor.showProblems` is on. */
  shown: boolean;
  errors: number;
  warnings: number;
  infos: number;
}

/**
 * The extension's one `DiagnosticCollection` ("pagemd"), shared by every editor session: a document open in two pagemd
 * editors has one entry, removed when the last of them closes.
 */
export class ProblemsCollection implements vscode.Disposable {
  readonly collection: vscode.DiagnosticCollection;
  readonly #users = new Map<string, number>();

  constructor(collection: vscode.DiagnosticCollection = vscode.languages.createDiagnosticCollection('pagemd')) {
    this.collection = collection;
  }

  acquire(uri: vscode.Uri): void {
    this.#users.set(uri.toString(), (this.#users.get(uri.toString()) ?? 0) + 1);
  }

  release(uri: vscode.Uri): void {
    const key = uri.toString();
    const left = (this.#users.get(key) ?? 1) - 1;
    if (left > 0) {
      this.#users.set(key, left);
      return;
    }
    this.#users.delete(key);
    this.collection.delete(uri);
  }

  dispose(): void {
    this.collection.dispose();
  }
}

const SEVERITY: Record<PagemdDiagnostic['severity'], vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
};

/** One check result as a VS Code diagnostic: the document's line, else its first line, with the file concerned linked. */
export function toVscodeDiagnostic(document: vscode.TextDocument, d: PagemdDiagnostic): vscode.Diagnostic {
  const line = d.where?.line;
  const range = typeof line === 'number' && line > 0 && line < document.lineCount ? document.lineAt(line).range : new vscode.Range(0, 0, 0, 0);
  const out = new vscode.Diagnostic(range, d.message, SEVERITY[d.severity]);
  out.source = 'pagemd';
  out.code = codeOf(d);
  if (d.where?.file) {
    out.relatedInformation = [new vscode.DiagnosticRelatedInformation(new vscode.Location(vscode.Uri.file(d.where.file), new vscode.Position(0, 0)), `In ${nodePath.basename(d.where.file)}`)];
  }
  return out;
}

export interface HostDiagnostics extends vscode.Disposable {
  /** Runs the checks now (dropping a scheduled run) and answers what they found. */
  run(): Promise<CheckSummary>;
  /** Runs them after `delay` ms (later calls move the run). */
  schedule(delay?: number): void;
  /** Called with each run's results, for the webview. */
  onResults(listener: (payload: DiagnosticsPayload) => void): vscode.Disposable;
  /** The last results sent (or null before the first run). */
  readonly last: DiagnosticsPayload | null;
}

export interface HostDiagnosticsOptions {
  problems: ProblemsCollection;
  extensionUri: vscode.Uri;
  log(line: string): void;
  /** Overrides the checks (tests). */
  check?: typeof checkDocument;
}

export type HostDiagnosticsFactory = (document: vscode.TextDocument) => HostDiagnostics;

/** One document's checks (one per editor session). */
export class PagemdHostDiagnostics implements HostDiagnostics {
  readonly #document: vscode.TextDocument;
  readonly #options: HostDiagnosticsOptions;
  readonly #fs = vscodeFileSystem();
  readonly #cache = new Map<unknown, unknown>();
  readonly #listeners = new Set<(payload: DiagnosticsPayload) => void>();
  readonly #disposables: vscode.Disposable[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  #runs = 0;
  #last: DiagnosticsPayload | null = null;
  #disposed = false;

  constructor(document: vscode.TextDocument, options: HostDiagnosticsOptions) {
    this.#document = document;
    this.#options = options;
    options.problems.acquire(document.uri);
    this.#disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => e.document === document && this.schedule(CHECK_DEBOUNCE_MS)),
      vscode.workspace.onDidSaveTextDocument((saved) => saved === document && this.schedule(0)),
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration(SHOW_PROBLEMS, document.uri) && this.schedule(0)),
    );
  }

  get last(): DiagnosticsPayload | null {
    return this.#last;
  }

  onResults(listener: (payload: DiagnosticsPayload) => void): vscode.Disposable {
    this.#listeners.add(listener);
    return { dispose: () => this.#listeners.delete(listener) };
  }

  schedule(delay = 0): void {
    if (this.#disposed) return;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.run().catch((error) => this.#options.log(`pagemd checks failed: ${error instanceof Error ? error.message : String(error)}`)), delay);
  }

  async run(): Promise<CheckSummary> {
    clearTimeout(this.#timer);
    const run = ++this.#runs;
    const document = this.#document;
    const version = document.version;
    const text = document.getText();
    const shown = showProblems(document.uri);
    let found: PagemdDiagnostic[] = [];
    let enabled = false;
    if (shown) {
      this.#cache.clear(); // a profile may have changed on disk since the last run
      const check = this.#options.check ?? checkDocument;
      const result = await check({ path: document.uri.scheme === 'file' ? document.uri.fsPath : null, text }, this.#env());
      found = result?.diagnostics ?? [];
      enabled = result?.enabled ?? false;
    }
    // A newer run started meanwhile, or the editor closed: its answer wins.
    if (run !== this.#runs || this.#disposed) return this.#summary(found, enabled, shown);
    if (found.length > 0) this.#options.problems.collection.set(document.uri, found.map((d) => toVscodeDiagnostic(document, d)));
    else this.#options.problems.collection.delete(document.uri);
    const payload: DiagnosticsPayload = { version, text, items: toCoreDiagnostics(text, found), enabled, shown };
    this.#last = payload;
    for (const listener of [...this.#listeners]) listener(payload);
    return this.#summary(found, enabled, shown);
  }

  dispose(): void {
    this.#disposed = true;
    clearTimeout(this.#timer);
    for (const d of this.#disposables.splice(0)) d.dispose();
    this.#options.problems.release(this.#document.uri);
  }

  #summary(found: PagemdDiagnostic[], enabled: boolean, shown: boolean): CheckSummary {
    const count = (s: PagemdDiagnostic['severity']) => found.filter((d) => d.severity === s).length;
    return { enabled, shown, errors: count('error'), warnings: count('warning'), infos: count('info') };
  }

  #env(): CheckEnvironment {
    const path = this.#document.uri.scheme === 'file' ? this.#document.uri.fsPath : null;
    const { homePath, sharedProfilesPath } = pagemdEnvironment(this.#options.log);
    return {
      fs: this.#fs,
      pagemdPath: pagemdPathOf(this.#options.extensionUri),
      homePath,
      sharedProfilesPath,
      ...(path ? { cwd: nodePath.dirname(path) } : {}),
      path: nodePath,
      cache: this.#cache,
    };
  }
}

/** Makes a `HostDiagnosticsFactory` over one shared Problems collection. */
export function pagemdHostDiagnostics(options: HostDiagnosticsOptions): HostDiagnosticsFactory {
  return (document) => new PagemdHostDiagnostics(document, options);
}

/** The message "pagemd: Check Document" shows after a run. */
export function summaryMessage(summary: CheckSummary): string {
  if (!summary.shown) return 'pagemd Editor: pagemd problems are hidden (setting pagemdEditor.showProblems).';
  if (!summary.enabled) return "pagemd Editor: this document's profile asks for no checks (it has no validation setting).";
  const parts = [
    [summary.errors, 'error'],
    [summary.warnings, 'warning'],
    [summary.infos, 'note'],
  ]
    .filter(([n]) => (n as number) > 0)
    .map(([n, word]) => `${n} ${word}${n === 1 ? '' : 's'}`);
  return parts.length === 0 ? 'pagemd Editor: no problems found.' : `pagemd Editor: ${parts.join(', ')} (see the Problems panel).`;
}
