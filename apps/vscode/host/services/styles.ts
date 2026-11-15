// IStyles, host side (P5, protocol v2). The seam between the editor session and whatever resolves a document's
// styles: the session asks for the styles before `init`, answers `getStyles` / `createLayoutFile`, and forwards
// every change as a `stylesChanged` event. `plainHostStyles` gives every document plain styles and can't create
// a layout file; it is what a document that isn't a file gets, and the default until the extension passes the
// pagemd-backed service (style-pagemd with the host's file system adapter, watchers and confirm prompt).
import * as vscode from 'vscode';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import type { FilesInUse, PageGeometry } from '@pagemd-editor/core';
import {
  assetFolders,
  CASCADE_NOTE,
  filesInUse,
  perDocumentNames,
  planLayoutFile,
  resolveStyles,
  type FileSystem,
  type LayoutBasis,
  type LayoutFilePlan,
  type Logger,
  type StyleEnvironment,
  type StyleResolution,
} from '@pagemd-editor/style-pagemd';
import type { CreateLayoutResult, StylesPayload } from '../../shared/protocol.ts';
import { pagemdEnvironment } from './environment.ts';

export interface HostStyles extends vscode.Disposable {
  /** The document's styles now. Never rejects for a document problem: plain styles plus notes. */
  get(): Promise<StylesPayload>;
  /** Called with the new styles whenever they change. */
  onChange(listener: (payload: StylesPayload) => void): vscode.Disposable;
  /** Asks the author to confirm, then writes the layout file (ADR-0014, R-129, R-130). Rejects with the reason. */
  createLayoutFile(page: PageGeometry): Promise<CreateLayoutResult>;
  /** P25: every file that builds the document now, in priority order (resolved again for the text as it is now). Absent: no files. */
  filesInUse?(): Promise<FilesInUse>;
  /**
   * FIX-template-asset-paths (R-259): the folders of the pictures and files the template and the profile's CSS pull in from next to
   * themselves, in the last resolution (the webview must be allowed to load from them). Absent: none.
   */
  assetFolders?(): string[];
}

/** P25: the report for a document with no pagemd styles (not a file, or no pagemd-backed service). */
export const NO_FILES: FilesInUse = Object.freeze({ document: null, profile: null, files: [], problems: [], cascade: CASCADE_NOTE, rules: [], plain: true }) as FilesInUse;

/** Makes the styles service for one open document. */
export type HostStylesFactory = (document: vscode.TextDocument) => HostStyles;

/** Plain styles: no profile, no gate defaults. */
export const PLAIN_STYLES: StylesPayload = Object.freeze({ styles: null, gateDefaults: {}, notes: [], properties: { required: [], shownOnPage: [], profileFields: [], defaults: {} } }) as StylesPayload;

export const plainHostStyles: HostStylesFactory = () => ({
  get: () => Promise.resolve(PLAIN_STYLES),
  onChange: () => ({ dispose() {} }),
  createLayoutFile: () => Promise.reject(new Error('This document has plain styles: there is no pagemd profile to add a layout file to.')),
  filesInUse: () => Promise.resolve(NO_FILES),
  dispose() {},
});

// ── the pagemd-backed service (amendment 2, 6, 8; R-128, R-129, R-130) ──

/** How long to wait after the last change before re-resolving (frontmatter edits, and file-system events). */
const DEBOUNCE_MS = 400;
/**
 * New files under a resource folder, one level deep, mirroring the resolver's own search tiers (R-24: `./`,
 * `./{type}/`, `./.pagemd/{type}/`; none of them need recursion). Not `**` (P5 finding, EditorProvider's
 * IMAGE_GLOB comment): a recursive out-of-workspace `RelativePattern` watcher never fired in a real VS Code.
 */
const RESOURCE_GLOBS = ['*.{json,css,html}', '{profiles,templates,layouts,styles}/*.{json,css,html}', '.pagemd/*.{json,css,html}', '.pagemd/{profiles,templates,layouts,styles}/*.{json,css,html}'];
/** pagemd's own bundled folders are at most one level deep (`styles/presets/`, `styles/syntax/`). */
const PAGEMD_RESOURCE_GLOB = '{*,*/*}';
const PAGEMD_RESOURCE_FOLDERS = ['profiles', 'layouts', 'styles', 'templates'];

/** True when the document already uses its own per-document profile and layout file (R-129, R-143). */
export function ownLayout(basis: LayoutBasis, names: ReturnType<typeof perDocumentNames>): boolean {
  const same = (a: string, b: string) => nodePath.normalize(a) === nodePath.normalize(b);
  return !!basis.layout && !basis.layout.bundled && same(basis.layout.path, names.layoutPath) && basis.profilePath !== null && same(basis.profilePath, names.profilePath);
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The document's path for style-pagemd: a real file path, or null (a `git diff` view, an untitled document). */
function documentPath(document: vscode.TextDocument): string | null {
  return document.uri.scheme === 'file' ? document.uri.fsPath : null;
}

/** `~` expands to the home folder (the setting may be written that way). */
function expandHome(value: string): string {
  return value === '~' || value.startsWith('~/') || value.startsWith('~\\') ? nodePath.join(os.homedir(), value.slice(1)) : value;
}

/** pagemd's own folder (R-128): the `pagemdEditor.pagemdPath` setting, else the extension's bundled copy. */
export function pagemdPathOf(extensionUri: vscode.Uri): string {
  const setting = vscode.workspace.getConfiguration('pagemdEditor').get<string>('pagemdPath');
  if (typeof setting === 'string' && setting.trim() !== '') return expandHome(setting.trim());
  return vscode.Uri.joinPath(extensionUri, 'dist', 'defaults').fsPath;
}

/** The resolver's FileSystem port over `vscode.workspace.fs` (amendment 6): every method answers a Promise. */
export function vscodeFileSystem(): FileSystem {
  return {
    async exists(path) {
      try {
        await vscode.workspace.fs.stat(vscode.Uri.file(path));
        return true;
      } catch {
        return false;
      }
    },
    async readText(path) {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(path));
      return Buffer.from(bytes).toString('utf8');
    },
    async stat(path) {
      try {
        const s = await vscode.workspace.fs.stat(vscode.Uri.file(path));
        // eslint-disable-next-line no-bitwise
        return { isFile: (s.type & vscode.FileType.File) !== 0, isDirectory: (s.type & vscode.FileType.Directory) !== 0, size: s.size };
      } catch {
        return null;
      }
    },
    async list(path) {
      const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(path));
      return entries.map(([name]) => name);
    },
  };
}

/** The resolver's logger (amendment 6): warnings and errors go to the Output channel; trace/debug are dropped. */
function loggerFor(category: string, log: (line: string) => void): Logger {
  const forward =
    (level: string) =>
    (...args: unknown[]): void =>
      log(`[styles:${category}] ${level}: ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`);
  return { trace() {}, debug() {}, info() {}, warn: forward('warn'), error: forward('error') };
}

function toPayload(resolution: StyleResolution): StylesPayload {
  return { styles: resolution.styles, gateDefaults: resolution.gateDefaults, notes: resolution.notes, properties: resolution.properties };
}

export interface PagemdStylesOptions {
  /** The extension's install folder (dist/defaults is the bundled copy of pagemd's own files, R-128). */
  extensionUri: vscode.Uri;
  log(line: string): void;
}

/** One document's pagemd-backed styles: resolve, watch, and offer to create a layout file. */
class PagemdHostStyles implements HostStyles {
  readonly #document: vscode.TextDocument;
  readonly #options: PagemdStylesOptions;
  readonly #fs = vscodeFileSystem();
  /** The resolver's profile cache, shared for this document's session (amendment 6); cleared on any change. */
  readonly #cache = new Map<unknown, unknown>();
  readonly #listeners = new Set<(payload: StylesPayload) => void>();
  readonly #staticWatchers: vscode.Disposable[];
  #sourceWatchers: vscode.Disposable[] = [];
  readonly #textListener: vscode.Disposable;
  #refreshTimer: ReturnType<typeof setTimeout> | undefined;
  #lastResolution: StyleResolution | undefined;
  #lastPayloadJson: string | undefined;
  #disposed = false;

  constructor(document: vscode.TextDocument, options: PagemdStylesOptions) {
    this.#document = document;
    this.#options = options;
    this.#staticWatchers = this.#watchStaticFolders();
    this.#textListener = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document === this.#document) this.#scheduleRefresh(DEBOUNCE_MS);
    });
  }

  async get(): Promise<StylesPayload> {
    const resolution = await this.#resolveNow();
    return toPayload(resolution);
  }

  onChange(listener: (payload: StylesPayload) => void): vscode.Disposable {
    this.#listeners.add(listener);
    return { dispose: () => this.#listeners.delete(listener) };
  }

  async createLayoutFile(page: PageGeometry): Promise<CreateLayoutResult> {
    const resolution = this.#lastResolution ?? (await this.#resolveNow());
    if (!resolution.basis) throw new Error('This document has plain styles: there is no pagemd profile to add a layout file to.');
    const basis = resolution.basis;
    const env = this.#envNow();
    const names = perDocumentNames(basis.documentPath, nodePath);
    // R-143: the document's own layout file (its per-document profile, R-129) is rewritten without the box, since
    // nothing shared is touched; the webview's status bar says so. Any other layout still asks first.
    if (!ownLayout(basis, names) && !(await this.#confirm(basis, names))) return 'declined';

    let plan: LayoutFilePlan;
    try {
      plan = await planLayoutFile({ path: basis.documentPath, text: this.#document.getText() }, basis, page, env);
    } catch (error) {
      throw new Error(messageOf(error));
    }
    await this.#applyPlan(plan);
    this.#cache.clear();
    await this.#refresh();
    return 'created';
  }

  async filesInUse(): Promise<FilesInUse> {
    const resolution = await this.#resolveNow();
    return filesInUse(resolution, this.#envNow());
  }

  assetFolders(): string[] {
    return this.#lastResolution ? assetFolders(this.#lastResolution, nodePath) : [];
  }

  dispose(): void {
    this.#disposed = true;
    clearTimeout(this.#refreshTimer);
    this.#textListener.dispose();
    for (const d of [...this.#staticWatchers, ...this.#sourceWatchers.splice(0)]) d.dispose();
  }

  #envNow(): StyleEnvironment {
    const path = documentPath(this.#document);
    const { homePath, sharedProfilesPath } = pagemdEnvironment(this.#options.log);
    return {
      fs: this.#fs,
      pagemdPath: pagemdPathOf(this.#options.extensionUri),
      homePath,
      sharedProfilesPath,
      ...(path ? { cwd: nodePath.dirname(path) } : {}),
      path: nodePath,
      cache: this.#cache,
      log: (category) => loggerFor(category, this.#options.log),
    };
  }

  async #resolveNow(): Promise<StyleResolution> {
    const path = documentPath(this.#document);
    const resolution = await resolveStyles({ path, text: this.#document.getText() }, this.#envNow());
    this.#lastResolution = resolution;
    this.#rewatchSources(resolution.sources);
    return resolution;
  }

  #scheduleRefresh(delay: number): void {
    clearTimeout(this.#refreshTimer);
    this.#refreshTimer = setTimeout(() => void this.#refresh(), delay);
  }

  async #refresh(): Promise<void> {
    if (this.#disposed) return;
    let resolution: StyleResolution;
    try {
      resolution = await this.#resolveNow();
    } catch (error) {
      this.#options.log(`Styles could not be resolved: ${messageOf(error)}`);
      return;
    }
    const payload = toPayload(resolution);
    const json = JSON.stringify(payload);
    if (json === this.#lastPayloadJson) return; // nothing a viewer would see changed
    this.#lastPayloadJson = json;
    for (const listener of [...this.#listeners]) listener(payload);
  }

  /** A watcher on every file the last resolution depends on (amendment 8): torn down and rebuilt each time. */
  #rewatchSources(sources: string[]): void {
    for (const d of this.#sourceWatchers.splice(0)) d.dispose();
    for (const file of sources) {
      if (!file) continue;
      this.#sourceWatchers.push(...this.#watch(nodePath.dirname(file), nodePath.basename(file)));
    }
  }

  /** New files under `.pagemd/`, `styles/`, `profiles/`, `layouts/` (document folder, project root, home, pagemd's
   *  own folder), watched for the life of this document (amendment 8). */
  #watchStaticFolders(): vscode.Disposable[] {
    const out: vscode.Disposable[] = [];
    const path = documentPath(this.#document);
    const roots = new Set<string>();
    if (path) roots.add(nodePath.dirname(path));
    const workspaceRoot = vscode.workspace.getWorkspaceFolder(this.#document.uri)?.uri.fsPath;
    if (workspaceRoot) roots.add(workspaceRoot);
    for (const root of roots) for (const glob of RESOURCE_GLOBS) out.push(...this.#watch(root, glob));
    const { homePath: home, sharedProfilesPath } = pagemdEnvironment();
    if (home) for (const glob of ['.pagemd/*.{json,css,html}', '.pagemd/{profiles,templates,layouts,styles}/*.{json,css,html}']) out.push(...this.#watch(home, glob));
    // L2: a profile pack installed (or removed) in the shared profiles folder
    out.push(...this.#watch(sharedProfilesPath, '*.{json,yaml,yml}'));
    const pagemdPath = pagemdPathOf(this.#options.extensionUri);
    for (const folder of PAGEMD_RESOURCE_FOLDERS) out.push(...this.#watch(nodePath.join(pagemdPath, folder), PAGEMD_RESOURCE_GLOB));
    return out;
  }

  #watch(baseDir: string, pattern: string): vscode.Disposable[] {
    try {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(baseDir), pattern));
      const trigger = (): void => {
        this.#cache.clear();
        this.#scheduleRefresh(150);
      };
      return [watcher, watcher.onDidChange(trigger), watcher.onDidCreate(trigger), watcher.onDidDelete(trigger)];
    } catch (error) {
      this.#options.log(`Could not watch ${baseDir}/${pattern}: ${messageOf(error)}`);
      return [];
    }
  }

  async #confirm(basis: LayoutBasis, names: ReturnType<typeof perDocumentNames>): Promise<boolean> {
    const rel = nodePath.relative(basis.documentDir, names.layoutPath);
    const detail = basis.usingDefault
      ? `This document has no layout file yet, so it shows pagemd's default page. pagemd Editor will create ${rel} for it.`
      : `This document's current layout can't be changed here directly${basis.layout?.bundled ? " (it is pagemd's own file)" : ''}. pagemd Editor will create ${rel} with this page's size and margins.`;
    const choice = await vscode.window.showWarningMessage('Create a layout file for this document?', { modal: true, detail }, 'Create Layout File');
    return choice === 'Create Layout File';
  }

  async #applyPlan(plan: LayoutFilePlan): Promise<void> {
    for (const write of plan.writes) {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(nodePath.dirname(write.path)));
      await vscode.workspace.fs.writeFile(vscode.Uri.file(write.path), new TextEncoder().encode(write.text));
    }
    if (plan.edit) {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(this.#document.uri, new vscode.Range(this.#document.positionAt(plan.edit.from), this.#document.positionAt(plan.edit.to)), plan.edit.text);
      const applied = await vscode.workspace.applyEdit(edit);
      if (!applied) throw new Error(`The frontmatter could not be updated to use ${plan.profilePath}.`);
    }
  }
}

/** Makes a `HostStylesFactory` backed by style-pagemd: one `PagemdHostStyles` per open document. */
export function pagemdHostStyles(options: PagemdStylesOptions): HostStylesFactory {
  return (document) => new PagemdHostStyles(document, options);
}
