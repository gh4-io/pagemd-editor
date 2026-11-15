// @pagemd-editor/style-default: plain styles (layered-architecture.md §3). Draft view follows the VS Code
// theme through its CSS variables, so the document reads like the rest of the editor. It is what the webview
// uses when no IStyles service is provided (P2 provides none; style-pagemd arrives in P5).
import type { PageGeometry, ResolvedStyles } from '@pagemd-editor/core';

/**
 * The plain page: Letter with 1 in (25.4 mm) margins, the page pagemd's default layout (theme-kit's letter.css)
 * and Paged.js itself use, so plain styles show the same page as the PDF (P5, amendment 10; was a placeholder A4
 * until P5, R-91). Numbers in millimetres, equal to @pagemd/theme-kit's FALLBACK_PAGE (style-default may import
 * core only; style-pagemd's test compares the two).
 */
export const PLAIN_PAGE: Readonly<PageGeometry> = Object.freeze({
  width: 215.9,
  height: 279.4,
  margins: Object.freeze({ top: 25.4, right: 25.4, bottom: 25.4, left: 25.4 }),
});

/** Draft: VS Code's editor font and colors, a readable line length, scoped to `.pmd-canvas`. */
export const draftCss = `
.pmd-canvas { max-width: 50em; margin: 0 auto; padding: 16px 24px 48px;
  font-family: var(--vscode-editor-font-family, system-ui); font-size: var(--vscode-editor-font-size, 14px);
  line-height: 1.6; color: var(--vscode-editor-foreground); }
.pmd-canvas h1, .pmd-canvas h2, .pmd-canvas h3, .pmd-canvas h4, .pmd-canvas h5, .pmd-canvas h6 { line-height: 1.25; margin: 1.2em 0 0.4em; }
.pmd-canvas p, .pmd-canvas ul, .pmd-canvas ol, .pmd-canvas blockquote, .pmd-canvas pre { margin: 0 0 0.8em; }
.pmd-canvas a { color: var(--vscode-textLink-foreground); }
.pmd-canvas blockquote { padding-left: 1em; border-left: 3px solid var(--vscode-textBlockQuote-border);
  color: var(--vscode-textBlockQuote-foreground, inherit); }
.pmd-canvas code, .pmd-canvas pre { font-family: var(--vscode-editor-font-family, monospace);
  background: var(--vscode-textCodeBlock-background); border-radius: 3px; }
.pmd-canvas code { padding: 0 0.2em; }
.pmd-canvas pre { padding: 0.6em 0.8em; overflow-x: auto; }
.pmd-canvas pre code { padding: 0; background: none; }
.pmd-canvas hr { border: none; border-top: 1px solid var(--vscode-editorWidget-border, currentColor); }
.pmd-canvas img { max-width: 100%; }
`;

/** The plain styles as ResolvedStyles, the same shape IStyles returns (ADR-0013 decision 7). */
export function defaultStyles(): ResolvedStyles {
  return { css: draftCss, page: PLAIN_PAGE, usingDefault: true, sources: ['@pagemd-editor/style-default'] };
}
