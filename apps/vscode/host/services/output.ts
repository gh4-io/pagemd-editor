// IOutput on the host (P10, ADR-0008, R-167–R-170): Print Preview, Export and the profile picker for one document.
// pagemd's renderer (output-pagemd) runs in-process from its runtime file (dist/host/pagemd/runtime.mjs, loaded on the
// first use, AD-P10-01); when that file is missing or fails to load, the built-in plain HTML (output-html) is used and
// editing is never affected. A PDF or PNG needs a browser: Chrome, then Edge, then `pagemdEditor.browserPath` (R-169);
// nothing is ever downloaded.
import * as vscode from 'vscode';
import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { DocSnapshot, ExportResult, OutputFormat, OutputProviderInfo, PreviewResult } from '@pagemd-editor/core';
import { HTML_INFO, HtmlOutput } from '@pagemd-editor/output-html';
import { NO_BROWSER, PAGEMD_INFO, PagemdOutput, type Embedded, type PagemdRuntime, type PreviewPage } from '@pagemd-editor/output-pagemd';
import { MERMAID_CONFIG, redactedPictures } from '@pagemd-editor/preset-pagemd';
import { frontmatterProfileEdit, listProfiles, type ProfileChoice } from '@pagemd-editor/style-pagemd';
import { defaultStyles } from '@pagemd-editor/style-default';
import { readerFor } from '../symbols.ts';
import { pagemdPathOf, vscodeFileSystem, type HostStyles } from './styles.ts';
import { pagemdEnvironment } from './environment.ts';

/** The runtime file, next to the host bundle (esbuild.mjs `buildRuntime`). */
export function runtimeFileOf(extensionUri: vscode.Uri): string {
  return vscode.Uri.joinPath(extensionUri, 'dist', 'host', 'pagemd', 'runtime.mjs').fsPath;
}

/** The mermaid browser build for the webview (esbuild.mjs `copyMermaid`). */
export function mermaidScriptOf(extensionUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'mermaid', 'mermaid.min.js');
}

/** FIX-preview: the largest file put into the preview page (a `data:` address), and the most in one page. */
export const EMBED_LIMITS = { file: 25 * 1024 * 1024, page: 100 * 1024 * 1024 };

/** The media type a file is given in the preview page, by its extension (pictures, fonts, styles). */
const MEDIA_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml',
  bmp: 'image/bmp', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', css: 'text/css',
};

export function mediaTypeOf(path: string): string {
  return MEDIA_TYPES[nodePath.extname(path).slice(1).toLowerCase()] ?? 'application/octet-stream';
}

/** Whether `path` is inside one of the folders `roots` (the webview's own list), on any platform. */
export function insideRoots(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    const rel = nodePath.relative(root, path);
    return rel === '' || (!rel.startsWith('..') && !nodePath.isAbsolute(rel));
  });
}

/** The diagram library as a `data:` address, read once per file. */
const libraries = new Map<string, Promise<string | null>>();

/** One load for the whole extension host; a failure is kept (the app then uses plain HTML). */
const loads = new Map<string, Promise<PagemdRuntime>>();

/** Loads the runtime file (an ES module; the host bundle is CommonJS, so a real `import()` of a file URL). */
export function loadRuntime(file: string): Promise<PagemdRuntime> {
  let load = loads.get(file);
  if (!load) {
    load = existsSync(file)
      ? (import(pathToFileURL(file).href) as Promise<{ runtime: PagemdRuntime }>).then((m) => m.runtime)
      : Promise.reject(new Error(`pagemd's renderer is not built (${file})`));
    loads.set(file, load);
  }
  return load;
}

/** `pagemdEditor.browserPath` (R-169): used when neither Chrome nor Edge is found. */
export function browserSetting(): string | undefined {
  const value = vscode.workspace.getConfiguration('pagemdEditor').get<string>('browserPath');
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** The file extension and Save-dialog filter for each format. */
const FORMATS: Readonly<Record<OutputFormat, { ext: string; filter: string }>> = {
  pdf: { ext: 'pdf', filter: 'PDF' },
  html: { ext: 'html', filter: 'HTML' },
  png: { ext: 'png', filter: 'PNG image' },
};

/**
 * Where `pagemd build` writes a format (R-170 Q6): next to the document, the same name (`a.md` → `a.pdf`). The Save
 * dialog opens there.
 */
export function defaultTarget(documentPath: string, format: OutputFormat): string {
  return documentPath.replace(/\.md$/i, '') + `.${FORMATS[format].ext}`;
}

export interface HostOutputOptions {
  extensionUri: vscode.Uri;
  log(line: string): void;
  /** FIX-PGF: a line for the log at debug level (each step of making a Print Preview page). */
  debug?(line: string): void;
  styles: HostStyles;
  /** Overrides the runtime file (tests). */
  runtimeFile?: string;
}

/**
 * Why the editor's own plain HTML refuses a document (P27, R-251: fail closed), or null: it has redacted pictures, which only
 * pagemd's build can black out (it bakes a covered copy).
 */
export function redactionRefusal(pictures: readonly string[]): string | null {
  if (pictures.length === 0) return null;
  const names = [...new Set(pictures)];
  return `This document has redacted pictures (${names.slice(0, 3).join(', ')}${names.length > 3 ? ', …' : ''}). The editor's own plain HTML can't black them out, so it does not show or export this document: pagemd's renderer is needed (it bakes a covered copy).`;
}

/** Print Preview, Export and the profile picker for one open document. */
export class HostOutput {
  readonly #document: vscode.TextDocument;
  readonly #webview: vscode.Webview;
  readonly #options: HostOutputOptions;
  readonly pagemd: PagemdOutput;
  readonly html: HtmlOutput;
  #page: PreviewPage | undefined;
  #fallbackReason: string | undefined;
  /** FIX-PGF: previews of this document asked for and not answered yet (by number, with when they were asked). */
  readonly #previews = new Map<number, number>();
  #previewCount = 0;

  constructor(document: vscode.TextDocument, webview: vscode.Webview, options: HostOutputOptions) {
    this.#document = document;
    this.#webview = webview;
    this.#options = options;
    const runtimeFile = options.runtimeFile ?? runtimeFileOf(options.extensionUri);
    this.pagemd = new PagemdOutput({
      load: () =>
        loadRuntime(runtimeFile).catch((error: unknown) => {
          this.#fallbackReason = `pagemd's renderer could not be loaded: ${messageOf(error)}`;
          options.log(this.#fallbackReason);
          throw error;
        }),
      cliPath: () => pagemdPathOf(options.extensionUri),
      browserSetting,
      pathOf: () => (document.uri.scheme === 'file' ? document.uri.fsPath : null),
      page: () => this.#page ?? this.#pageFor(''),
      mermaidConfig: MERMAID_CONFIG,
      trace: (step) => options.debug?.(`Print Preview (host): ${step}`),
    });
    this.html = new HtmlOutput({
      render: (text) => readerFor(text).transformer.markdownIt.render(text),
      css: async () => (await options.styles.get()).styles?.css ?? defaultStyles().css,
      write: async (target, html) => vscode.workspace.fs.writeFile(vscode.Uri.file(target), Buffer.from(html, 'utf8')),
      // P27 (R-251, amendment 6): fail closed: the plain HTML can't black out a redacted picture, so it refuses the document.
      refuse: (text) => redactionRefusal(redactedPictures(readerFor(text).transformer.parse(text))),
    });
  }

  /** What Print Preview and Export can make, for `init` (the runtime file is there: pagemd; else plain HTML). */
  info(): OutputProviderInfo[] {
    const file = this.#options.runtimeFile ?? runtimeFileOf(this.#options.extensionUri);
    return existsSync(file) ? [PAGEMD_INFO, HTML_INFO] : [HTML_INFO];
  }

  #snapshot(): DocSnapshot {
    return { uri: this.#document.uri.toString(), text: this.#document.getText(), version: this.#document.version };
  }

  /**
   * The webview the preview shows in: its nonce, the mermaid script, and file paths as webview addresses (D19). FIX-preview: the
   * preview frame can't load webview addresses in VS Code, so its files are put into the page (`embed`, `mermaidData`).
   */
  #pageFor(nonce: string): PreviewPage {
    const webview = this.#webview;
    const library = mermaidScriptOf(this.#options.extensionUri);
    let budget = EMBED_LIMITS.page;
    return {
      nonce,
      mermaidScript: webview.asWebviewUri(library).toString(),
      mapFileUrl: (url) => {
        try {
          const path = fileURLToPath(url);
          const trailing = url.endsWith('/') ? '/' : '';
          return webview.asWebviewUri(vscode.Uri.file(path)).toString().replace(/\/?$/, trailing);
        } catch {
          return null;
        }
      },
      embed: async (url): Promise<Embedded> => {
        if (url.endsWith('/')) return null; // a folder (the page's <base>): stays a webview address
        let path: string;
        try {
          path = fileURLToPath(url);
        } catch {
          return null;
        }
        const name = nodePath.basename(path);
        // Only what the webview itself may read (its resource folders): the preview reads nothing more than the canvas could.
        const roots = (webview.options.localResourceRoots ?? []).map((root) => root.fsPath);
        if (!insideRoots(path, roots)) return { problem: `${name} (outside the folders the editor may open)` };
        const file = vscode.Uri.file(path);
        let size: number;
        try {
          const stat = await vscode.workspace.fs.stat(file);
          if (stat.type !== vscode.FileType.File) return { problem: `${name} (not a file)` };
          size = stat.size;
        } catch {
          return { problem: `${name} (not found)` };
        }
        if (size > EMBED_LIMITS.file) return { problem: `${name} (larger than ${EMBED_LIMITS.file / 1024 / 1024} MB)` };
        if (size > budget) return { problem: `${name} (the preview's ${EMBED_LIMITS.page / 1024 / 1024} MB of files is used up)` };
        try {
          const bytes = await vscode.workspace.fs.readFile(file);
          budget -= bytes.byteLength;
          return { url: `data:${mediaTypeOf(path)};base64,${Buffer.from(bytes).toString('base64')}` };
        } catch (error) {
          return { problem: `${name} (${messageOf(error)})` };
        }
      },
      mermaidData: () => {
        let data = libraries.get(library.fsPath);
        if (!data) {
          data = Promise.resolve(vscode.workspace.fs.readFile(library)).then(
            (bytes) => `data:text/javascript;base64,${Buffer.from(bytes).toString('base64')}`,
            () => null,
          );
          libraries.set(library.fsPath, data);
        }
        return data;
      },
    };
  }

  /** The Print Preview page (R-170 Q5): pagemd's, else plain HTML with the reason. */
  async preview(nonce: string): Promise<PreviewResult> {
    // FIX-PGF: each request is numbered and logged (debug); one asked while an earlier one is still being made is said at info level,
    // so a preview that never comes back names where it is (the earlier render still running in the extension host).
    const n = ++this.#previewCount;
    const asked = Date.now();
    const earlier = [...this.#previews.entries()];
    this.#previews.set(n, asked);
    if (earlier.length > 0) this.#options.log(`Print Preview: request ${n} while ${earlier.map(([k, at]) => `request ${k} (asked ${Math.round((asked - at) / 1000)} s ago)`).join(', ')} is still being made.`);
    this.#options.debug?.(`Print Preview (host): request ${n} started`);
    try {
      const result = await this.#preview(nonce);
      this.#options.debug?.(`Print Preview (host): request ${n} answered after ${Date.now() - asked} ms (${result.provider ?? 'pagemd'}, ${result.html.length} characters)`);
      return result;
    } finally {
      this.#previews.delete(n);
    }
  }

  async #preview(nonce: string): Promise<PreviewResult> {
    this.#page = this.#pageFor(nonce);
    const doc = this.#snapshot();
    if (this.#document.uri.scheme === 'file' && (await this.pagemd.available())) {
      try {
        return await this.pagemd.preview(doc);
      } catch (error) {
        const message = `pagemd could not render this document: ${messageOf(error)}`;
        this.#options.log(message);
        return { ...(await this.html.preview(doc)), message: this.html.refusal(doc) ?? message };
      }
    }
    const reason = this.#document.uri.scheme !== 'file' ? 'Only a document saved as a file can be previewed with pagemd.' : (this.#fallbackReason ?? "pagemd's renderer is not available");
    // P27 (R-251): a refused document (redactions) says why it is refused, not only why pagemd was not used
    return { ...(await this.html.preview(doc)), message: this.html.refusal(doc) ?? reason };
  }

  /** Exports to `target` with pagemd (or plain HTML when pagemd isn't available). No dialog. */
  async exportTo(format: OutputFormat, target: string): Promise<ExportResult> {
    if (this.#document.uri.scheme !== 'file') return { ok: false, message: 'Save the document as a file first: pagemd exports a file on disk.' };
    const provider = (await this.pagemd.available()) ? this.pagemd : this.html;
    return provider.export(this.#snapshot(), format, target);
  }

  /**
   * Export (R-170 Q6): the Save dialog opens next to the document with `pagemd build`'s name; then the export runs with a
   * progress notice and ends with Open / Show in Folder, or the reason it failed (no browser: a button to the setting).
   */
  async export(format: OutputFormat): Promise<ExportResult> {
    if (this.#document.uri.scheme !== 'file') {
      const message = 'Save the document as a file first: pagemd exports a file on disk.';
      void vscode.window.showErrorMessage(`pagemd Editor: ${message}`);
      return { ok: false, message };
    }
    const spec = FORMATS[format];
    const picked = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(defaultTarget(this.#document.uri.fsPath, format)),
      filters: { [spec.filter]: [spec.ext] },
      saveLabel: 'Export',
      title: `Export ${format.toUpperCase()}`,
    });
    if (!picked) return { ok: false, message: 'cancelled' };
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `pagemd: exporting ${nodePath.basename(picked.fsPath)}…` },
      () => this.exportTo(format, picked.fsPath),
    );
    if (result.ok) {
      const where = vscode.Uri.file(result.target ?? picked.fsPath);
      const detail = result.message ? ` (${result.message})` : '';
      void vscode.window.showInformationMessage(`pagemd: exported ${nodePath.basename(where.fsPath)}${detail}.`, 'Open', 'Show in Folder').then((choice) => {
        if (choice === 'Open') void vscode.env.openExternal(where);
        else if (choice === 'Show in Folder') void vscode.commands.executeCommand('revealFileInOS', where);
      });
    } else if (result.message === NO_BROWSER) {
      void vscode.window.showErrorMessage(`pagemd Editor: ${NO_BROWSER}`, 'Open Settings').then((choice) => {
        if (choice === 'Open Settings') void vscode.commands.executeCommand('workbench.action.openSettings', 'pagemdEditor.browserPath');
      });
    } else {
      this.#options.log(`Export failed: ${result.message ?? ''}`);
      void vscode.window.showErrorMessage(`pagemd Editor: export failed: ${result.message ?? 'unknown error'}`);
    }
    return result;
  }

  /** The profiles the picker offers (R-170 Q8), as `pagemd list profiles` finds them. */
  async profiles(): Promise<ProfileChoice[]> {
    if (this.#document.uri.scheme !== 'file') return [];
    const { homePath, sharedProfilesPath } = pagemdEnvironment(this.#options.log);
    return listProfiles(this.#document.uri.fsPath, { fs: vscodeFileSystem(), pagemdPath: pagemdPathOf(this.#options.extensionUri), path: nodePath, homePath, sharedProfilesPath });
  }

  /**
   * The profile picker's choice (R-170 Q8): writes the frontmatter's `profile:` (the author's own key kept, ADR-0016 M4) as
   * one edit, one VS Code undo step; the canvas and the styles follow the changed text. `pick` chooses (tests pass a name).
   */
  async chooseProfile(pick?: string): Promise<string | undefined> {
    const choices = await this.profiles();
    if (choices.length === 0) {
      void vscode.window.showInformationMessage('pagemd Editor: no pagemd profiles were found for this document.');
      return undefined;
    }
    const current = (await this.#options.styles.get()).styles?.profile;
    // L3-1: the last entry goes to "Get Profile Packs…" (the only way from here to the network, and only when chosen).
    const chosen =
      pick === undefined
        ? await vscode.window.showQuickPick(
            [
              ...choices.map((c) => ({ label: c.name, description: choiceDescription(c, current), detail: c.description ?? undefined, name: c.name as string | undefined })),
              { label: GET_MORE_LABEL, description: 'install more from the library', detail: undefined, name: undefined },
            ],
            { placeHolder: 'The document\'s profile (written to its frontmatter as "profile:")' },
          )
        : undefined;
    if (chosen && chosen.label === GET_MORE_LABEL && chosen.name === undefined) {
      await vscode.commands.executeCommand('pagemd.getProfilePacks');
      return undefined;
    }
    const name = pick ?? chosen?.name;
    if (!name || name === current) return name;
    const text = this.#document.getText();
    const change = frontmatterProfileEdit(text, name);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(this.#document.uri, new vscode.Range(this.#document.positionAt(change.from), this.#document.positionAt(change.to)), change.text);
    if (!(await vscode.workspace.applyEdit(edit))) throw new Error('VS Code refused the change to the profile line.');
    return name;
  }
}

/** L3-1: the picker's last entry. */
export const GET_MORE_LABEL = 'Get more profile packs…';

const SOURCE_LABEL: Readonly<Record<ProfileChoice['source'], string>> = {
  pagemd: "pagemd's own",
  project: 'this project',
  workspace: "this project's .pagemd",
  document: "the document's folder",
  library: 'library',
  home: '~/.pagemd',
};

/** L2-8: where a profile is; a pack's version ("library 0.1.0"); a name found twice says the build will stop (R-264). */
export function choiceDescription(c: ProfileChoice, current: string | null | undefined): string {
  return [
    c.name === current ? '(current)' : '',
    c.source === 'library' && c.version ? `${SOURCE_LABEL.library} ${c.version}` : SOURCE_LABEL[c.source],
    c.duplicates.length > 0 ? '(found twice: the build will stop)' : '',
  ]
    .filter(Boolean)
    .join(' ');
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
