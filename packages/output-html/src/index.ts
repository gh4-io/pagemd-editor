// output-html (P10): the built-in Print Preview and HTML export, used when pagemd's renderer (output-pagemd) can't be
// loaded. Plain HTML from the editor's own reader, styled with the document's profile CSS as the canvas has it (scoped to
// `.pmd-canvas`). No pages, no pagemd template: a fallback, so editing and a readable preview never depend on pagemd.
import type { DocSnapshot, ExportResult, OutputFormat, OutputProvider, OutputProviderInfo, PreviewResult } from '@pagemd-editor/core';

export interface HtmlOutputOptions {
  /** The document's body as HTML (the app's markdown reader). */
  render(text: string): string;
  /** The content CSS to use (the canvas's: the profile's, scoped to `.pmd-canvas`, or the plain styles). */
  css(doc: DocSnapshot): Promise<string>;
  /** Writes a file (export). */
  write(target: string, html: string): Promise<void>;
  /** Why pagemd's own preview isn't used, shown with the preview. */
  reason?: string;
  /**
   * P27 (R-251, amendment 6): why this document must not be shown or exported by this fallback, or null. A document with redacted
   * pictures is refused: plain HTML can't black them out (only pagemd's build bakes a covered copy), so it fails closed.
   */
  refuse?(text: string): string | null;
}

export const HTML_INFO: OutputProviderInfo = { id: 'html', label: 'Plain HTML', formats: ['html'] };

/** The class the content sits in, so the canvas's scoped CSS applies unchanged. */
export const CONTENT_CLASS = 'pmd-canvas';

const escapeText = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A whole page: the CSS (with `</style` made harmless), the title, the body in `.pmd-canvas`. */
export function htmlPage(body: string, css: string, title: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeText(title)}</title>
<style>
body { margin: 0; padding: 24px; background: #fff; color: #000; }
${css.replace(/<\/style/gi, '<\\/style')}
</style>
</head>
<body>
<div class="${CONTENT_CLASS}">
${body}
</div>
</body>
</html>
`;
}

/** The document's file name without folders, for the page title. */
function titleOf(doc: DocSnapshot): string {
  const name = doc.uri.split(/[\\/]/).pop() ?? '';
  return decodeURIComponent(name) || 'Document';
}

export class HtmlOutput implements OutputProvider {
  readonly id = 'html';
  readonly formats: OutputFormat[] = ['html'];
  readonly #options: HtmlOutputOptions;

  constructor(options: HtmlOutputOptions) {
    this.#options = options;
  }

  async available(): Promise<boolean> {
    return true;
  }

  async page(doc: DocSnapshot): Promise<string> {
    return htmlPage(this.#options.render(doc.text), await this.#options.css(doc), titleOf(doc));
  }

  /** Why this document is refused (redactions, R-251), or null. */
  refusal(doc: DocSnapshot): string | null {
    return this.#options.refuse?.(doc.text) ?? null;
  }

  async preview(doc: DocSnapshot): Promise<PreviewResult> {
    const refused = this.refusal(doc);
    // Fail closed (R-251): the refused document is not drawn at all, only the reason.
    if (refused) return { html: htmlPage(`<p class="pmd-refused">${escapeText(refused)}</p>`, '', titleOf(doc)), provider: 'html', colorScheme: 'light', message: refused };
    return { html: await this.page(doc), provider: 'html', colorScheme: 'light', ...(this.#options.reason ? { message: this.#options.reason } : {}) };
  }

  async export(doc: DocSnapshot, format: OutputFormat, target: string): Promise<ExportResult> {
    if (format !== 'html') return { ok: false, message: `Plain HTML can't make ${format.toUpperCase()}: pagemd's renderer isn't available${this.#options.reason ? ` (${this.#options.reason})` : ''}.` };
    const refused = this.refusal(doc);
    if (refused) return { ok: false, message: refused }; // nothing is written (R-251: fail closed)
    try {
      await this.#options.write(target, await this.page(doc));
      return { ok: true, target };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }
}
