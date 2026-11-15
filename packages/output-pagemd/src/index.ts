// output-pagemd (P10, ADR-0008, R-167–R-170): Print Preview and Export through pagemd's own renderer, in-process.
// Host only and optional (layered-architecture R3): the editor edits without it; when its runtime can't be loaded the
// app falls back to output-html. The runtime (runtime.ts, the only file here that imports pagemd) is bundled from the
// local pagemd checkout into its own file and loaded on first use (AD-P10-01); this file never imports pagemd, so the
// host bundle stays small and starts without it.
import type { DocSnapshot, ExportResult, OutputFormat, OutputProvider, OutputProviderInfo, PreviewResult } from '@pagemd-editor/core';
import { embedFileUrls, mermaidRunner, previewWatch, rewriteFileUrls, type Embedded } from './preview-page.ts';

export { embedFileUrls, mermaidRunner, previewWatch, rewriteFileUrls, outsideScripts, type Embedded } from './preview-page.ts';

/** What the runtime file offers (runtime.ts): pagemd's in-process entry (C6), wrapped. */
export interface PagemdRuntime {
  /** pagemd's Print Preview page: its HTML with Paged.js, file paths absolute, diagrams as placeholders. */
  renderForPreview(text: string, options: { markdownPath: string; cliPath: string; nonce: string; beforePolyfill: string }): Promise<{ html: string; colorScheme: string; profile: string }>;
  /** Writes one format exactly as `pagemd build -o <format>` does. */
  exportText(text: string | null, options: { markdownPath: string; format: OutputFormat; target: string; cliPath: string; browserPath?: string }): Promise<{ path: string; pages?: number }>;
  /** pagemd's own browser search: Chrome, then Microsoft Edge (C6); null when neither is found. */
  detectBrowser(): string | null;
  /** The mermaid library version pagemd draws with. */
  mermaidVersion(): string;
}

/** What a preview page needs from the webview it will show in (the srcdoc frame inherits the page's CSP). */
export interface PreviewPage {
  /** The webview page's script nonce: only scripts carrying it run (Paged.js, mermaid, pagemd's own). */
  nonce: string;
  /** The webview address of the mermaid browser build shipped with the extension. */
  mermaidScript: string;
  /** A `file://` URL as the webview can load it, or null to leave it (D19). */
  mapFileUrl(fileUrl: string): string | null;
  /**
   * FIX-preview: the file behind a `file://` URL put into the page itself (a `data:` address), since the preview frame can't load
   * webview addresses in VS Code; a reason when it can't be (not found, outside the folders the webview may read, too large);
   * null to leave it to `mapFileUrl` (a folder, such as the `<base>`). Without it, every address goes to `mapFileUrl`.
   */
  embed?(fileUrl: string): Promise<Embedded>;
  /** FIX-preview: the diagram library as a `data:` address (asked only for a document with a diagram); null when missing. */
  mermaidData?(): Promise<string | null>;
}

/**
 * Stands for the diagram library's address in the page until it is known whether the document has a diagram. A `data:` address,
 * because pagemd turns any relative `src` into a `file://` path (renderer-pdf's `rewritePaths`) and leaves `data:` alone.
 */
const MERMAID_SRC = 'data:,pmd-mermaid-library';
/** A diagram placeholder pagemd writes for a page that draws diagrams itself (`@pagemd/parser`, diagrams: 'placeholder'). */
const DIAGRAM = /<pre class="mermaid" data-mermaid-id=/;

export interface PagemdOutputOptions {
  /** Loads the runtime file (the app knows where it is). Called once; a failure means "not available". */
  load(): Promise<PagemdRuntime>;
  /** pagemd's folder: its bundled profiles, layouts, styles and templates (R-128: the extension's copy, or a setting). */
  cliPath(): string;
  /** `pagemdEditor.browserPath`: used when neither Chrome nor Edge is found (R-169). */
  browserSetting(): string | undefined;
  /** The document's file path; null when it isn't a file on disk (untitled, a git view). */
  pathOf(doc: DocSnapshot): string | null;
  /** The webview the preview will show in. */
  page(): PreviewPage;
  /** The mermaid settings the canvas uses (`@pagemd/syntax`'s MERMAID_CONFIG, through preset-pagemd). */
  mermaidConfig: Readonly<Record<string, unknown>>;
  /** FIX-PGF: each step of making a preview page, finished (the app writes it to its log at debug level). */
  trace?(step: string): void;
}

/** The formats on the Document tab (R-170): PDF, HTML and PNG, each as `pagemd build` makes it. */
export const PAGEMD_FORMATS: readonly OutputFormat[] = ['pdf', 'html', 'png'];

/** Said when a PDF or PNG is asked for and no browser is found (R-169: never downloaded). */
export const NO_BROWSER = 'No Chrome or Microsoft Edge was found. Install one, or set "pagemdEditor.browserPath" to a Chromium browser.';

export const PAGEMD_INFO: OutputProviderInfo = { id: 'pagemd', label: 'pagemd', formats: [...PAGEMD_FORMATS] };

export class PagemdOutput implements OutputProvider {
  readonly id = 'pagemd';
  readonly formats: OutputFormat[] = [...PAGEMD_FORMATS];
  readonly #options: PagemdOutputOptions;
  #runtime: Promise<PagemdRuntime> | undefined;

  constructor(options: PagemdOutputOptions) {
    this.#options = options;
  }

  /** The runtime, loaded once (a failed load is kept: the app falls back to plain HTML). */
  runtime(): Promise<PagemdRuntime> {
    this.#runtime ??= this.#options.load();
    return this.#runtime;
  }

  async available(): Promise<boolean> {
    try {
      await this.runtime();
      return true;
    } catch {
      return false;
    }
  }

  /** The browser for PDF and PNG (R-169): Chrome, then Edge, then the setting; null when none. */
  async browser(): Promise<string | null> {
    const found = (await this.runtime()).detectBrowser();
    if (found) return found;
    const setting = this.#options.browserSetting()?.trim();
    return setting ? setting : null;
  }

  async preview(doc: DocSnapshot): Promise<PreviewResult> {
    const markdownPath = this.#requirePath(doc);
    let since = Date.now();
    const step = (what: string): void => {
      const now = Date.now();
      this.#options.trace?.(`${what} after ${now - since} ms`);
      since = now;
    };
    const runtime = await this.runtime();
    step('runtime ready');
    const page = this.#options.page();
    const result = await runtime.renderForPreview(doc.text, {
      markdownPath,
      cliPath: this.#options.cliPath(),
      nonce: page.nonce,
      beforePolyfill: previewWatch(page.nonce) + mermaidRunner(page.nonce, page.mermaidData ? MERMAID_SRC : page.mermaidScript, this.#options.mermaidConfig),
    });
    step(`pagemd rendered ${result.html.length} characters`);
    let html = result.html;
    const problems: string[] = [];
    if (page.embed) {
      const embedded = await embedFileUrls(html, page.embed);
      html = embedded.html;
      problems.push(...embedded.problems);
      step(`files put into the page (${embedded.problems.length} could not be)`);
    }
    html = rewriteFileUrls(html, page.mapFileUrl);
    if (page.mermaidData) {
      // The library (5 MB) goes into the page only when there is something to draw.
      const library = DIAGRAM.test(html) ? await page.mermaidData() : null;
      if (DIAGRAM.test(html) && !library) problems.push('the diagram library (missing from the extension)');
      html = library ? html.replace(`src="${MERMAID_SRC}"`, () => `src="${library}"`) : html.replace(/<script nonce="[^"]*" src="data:,pmd-mermaid-library"><\/script>\n?/, '');
      if (library) step('diagram library put into the page');
    }
    return {
      html,
      provider: 'pagemd',
      colorScheme: colorSchemeOf(result.colorScheme),
      ...(problems.length > 0 ? { message: `Some files could not be shown: ${problems.join(', ')}.` } : {}),
    };
  }

  async export(doc: DocSnapshot, format: OutputFormat, target: string): Promise<ExportResult> {
    try {
      const markdownPath = this.#requirePath(doc);
      const browserPath = format === 'html' ? ((await this.browser()) ?? undefined) : await this.browser();
      if (format !== 'html' && !browserPath) return { ok: false, message: NO_BROWSER };
      const runtime = await this.runtime();
      const result = await runtime.exportText(doc.text, {
        markdownPath,
        format,
        target,
        cliPath: this.#options.cliPath(),
        ...(browserPath ? { browserPath } : {}),
      });
      return { ok: true, target: result.path, ...(result.pages ? { message: `${result.pages} page${result.pages === 1 ? '' : 's'}` } : {}) };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  #requirePath(doc: DocSnapshot): string {
    const path = this.#options.pathOf(doc);
    if (!path) throw new Error('Only a document saved as a file can be previewed or exported with pagemd.');
    return path;
  }
}

function colorSchemeOf(value: string): 'light' | 'dark' | 'auto' {
  return value === 'dark' ? 'dark' : value === 'auto' ? 'auto' : 'light';
}
