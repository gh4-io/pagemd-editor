// The small host services (ADR-0013 decision 6, DQ-3): one Lumino token each. The app (apps/vscode)
// provides them; the core only names them. Optional services may be absent, and whatever uses them
// falls back (for example, the Print Preview button hides when IOutput is missing).
import { Token } from '@lumino/coreutils';

/** Something that can be switched off again (a listener, a registration). */
export interface Disposable {
  dispose(): void;
}

/**
 * One minimal text edit (R-74 c). `from`/`to` are character positions in the current document text
 * (JavaScript string indices, i.e. UTF-16 code units), `to` exclusive. Edits in one list never overlap
 * and are sorted by `from`.
 */
export interface TextEdit {
  from: number;
  to: number;
  text: string;
}

// ── the seven services ──

/** Required. Applies minimal edits to the real document and reports changes made elsewhere. */
export interface IDocumentSync {
  /** `version` is the document version the edits were computed against; 'stale' → re-sync. */
  applyEdits(edits: TextEdit[], version: number): Promise<'ok' | 'stale'>;
  onExternalChange(cb: (text: string, version: number) => void): Disposable;
}

/** Optional. Writes a pasted image next to the document; picks a file. Returns document-relative paths. */
export interface IAssets {
  writeAsset(bytes: Uint8Array, name: string): Promise<string>;
  pickFile(filter?: string[]): Promise<string | undefined>;
  /**
   * P15 (ADR-0018, R-196, additive): the bytes of the image at `path` (relative to the document, as the text writes it),
   * for a pixel edit. Only images the canvas can already show: inside the document's folder or the workspace, an image
   * file type, at most 50 MB; anything else is refused with the reason.
   */
  readAsset(path: string): Promise<Uint8Array>;
}

/**
 * Optional (falls back to plain styles). ADR-0014: creates a layout file when none exists, or when the layout is
 * pagemd's own (never written). `onChange` (P5, R-127): the styles changed (a profile, stylesheet or the
 * frontmatter's profile was edited); the callback gets the new styles.
 */
export interface IStyles {
  getStyles(): Promise<ResolvedStyles>;
  onChange(cb: (styles: ResolvedStyles) => void): Disposable;
  createLayoutFile(page: PageGeometry): Promise<void>;
}

/** Optional (its buttons hide when absent). */
export interface IOutput {
  providers(): OutputProviderInfo[];
  preview(): Promise<PreviewResult>;
  export(format: OutputFormat): Promise<ExportResult>;
}

/**
 * Optional (ADR-0015, built in P12, R-180): reads and writes `.pagemd/comments/<doc>.json` (the file name without its
 * extension). `read` answers null for no file and throws when the file cannot be read; the shape is checked by plugin-comments.
 */
export interface ISidecar {
  read(kind: 'comments'): Promise<unknown>;
  write(kind: 'comments', data: unknown): Promise<void>;
}

/** Optional. Opens links and files. */
export interface ILinks {
  open(href: string): void;
}

/** Optional (ADR-0017). Results from @pagemd/validate, computed on the host. */
export interface IDiagnostics {
  onResults(cb: (diagnostics: Diagnostic[]) => void): Disposable;
}

// ── shapes the services use ──

export type OutputFormat = 'pdf' | 'html' | 'png';

/** Page size and margins as numbers, in millimetres, for pagination and the ruler. */
export interface PageGeometry {
  width: number;
  height: number;
  margins: { top: number; right: number; bottom: number; left: number };
}

/**
 * Running header or footer text per position (P5, R-127; from @pagemd/theme-kit's `runningContent`). Texts keep
 * pagemd's `:::PAGE` / `:::PAGES` tokens as written; from P6 (R-141/R-142) they may also hold `:::STRING(name)`, a
 * named string from a layout's own margin boxes (`string(name)`), set by the elements `ResolvedStyles.strings` names. `spansWidth`: the text (in `center`) spans the whole width
 * (pagemd's `span`), left and right stay empty.
 */
export interface RunningContent {
  left?: string;
  center?: string;
  right?: string;
  inside?: string;
  outside?: string;
  spansWidth?: boolean;
}

/**
 * P21: what one page type writes in the boxes of a header or footer, on top of the plain page's: text (with pagemd's
 * tokens), `null` (the box is cleared), or absent (the box is inherited from the plain page, box by box, as pagemd's PDF
 * does). A box the layout writes with the document's properties (`var()`) already holds that property's text here.
 */
export type RunningOverride = { left?: string | null; center?: string | null; right?: string | null };

/** P21: one page type's header/footer boxes; `first` is `@page name:first` (the first page of each run of the type). */
export interface NamedRunning {
  header?: RunningOverride;
  footer?: RunningOverride;
  first?: { header?: RunningOverride; footer?: RunningOverride };
}

/** ADR-0013 decision 7, grown in P5 (R-127, ADR-0013 amendment). */
export interface ResolvedStyles {
  /** Scoped to `.pmd-canvas`, `@page` removed. */
  css: string;
  page: PageGeometry;
  /** Was `string` before P5 (R-127). */
  header?: RunningContent;
  footer?: RunningContent;
  /** `false`: no header or footer on the first page; an object replaces (or, with `false`, hides) either one. */
  firstPage?: false | { header?: false | RunningContent; footer?: false | RunningContent };
  /** The header/footer text size, e.g. '9pt'. */
  marginFontSize?: string;
  /**
   * P6 (R-141/R-142): which elements set each `:::STRING(name)` (a layout's `string-set` rules, e.g.
   * `{ 'chapter-title': '.book-content h1' }`), selectors as the layout wrote them.
   */
  strings?: Record<string, string>;
  /** Named pages (`@page landscape { … }`), for P6's LAYOUT. */
  namedPages?: Record<string, PageGeometry>;
  /**
   * P21 (ADR-0013 amendment): each page type's own header and footer boxes (`@page wide { @top-left … }`, and
   * `@page wide:first`, the first page of each run of that type), keyed by the page type in lower case. Optional and
   * additive: a layout whose named pages write no boxes has none, and every page shows what it showed before.
   */
  namedRunning?: Record<string, NamedRunning>;
  /** The profile's layout file; `bundled` = pagemd's own file, never written (ADR-0014 amendment). null: none. */
  layout?: { path: string; bundled: boolean } | null;
  /** The profile in use, for the status bar. */
  profile?: string;
  /** True when no layout file was found (ADR-0014). */
  usingDefault: boolean;
  /** Which files contributed. */
  sources: string[];
  /**
   * P18 (R-228): the profile's HTML template as the canvas draws it around the document's text in the views styled by the
   * profile. Absent: no template, or one without `{{content}}` (the text alone, as before P18).
   */
  template?: PageTemplate;
}

/** The element that stands for pagemd's `{{content}}` in `PageTemplate.html` (P18): the text area goes there. */
export const TEMPLATE_SLOT = 'pmd-content-slot';

/** P18 (R-228): a profile's HTML template, ready for the canvas (style-pagemd fills it; components/template-frame draws it). */
export interface PageTemplate {
  /**
   * The template's `<body>` content with its tokens filled from the document's properties exactly as pagemd fills them
   * (@pagemd/theme-kit's fillTemplate), HTML comments and `<style>` blocks taken out (their CSS is in `ResolvedStyles.css`), and
   * one empty `<pmd-content-slot>` element (TEMPLATE_SLOT) where `{{content}}` was. Not yet made safe: the webview drops scripts,
   * frames and event attributes when it parses it.
   */
  html: string;
  /** The classes the template's `<body>` carries (the canvas stands for the body). */
  bodyClass?: string;
}

export interface OutputProviderInfo {
  id: string;
  label: string;
  formats: OutputFormat[];
}

export interface PreviewResult {
  /** The page to show: a whole HTML document (P10: pagemd's render with Paged.js, or plain HTML). */
  html: string;
  /** Which provider made it (P10, additive): 'pagemd' or 'html' (the built-in fallback). */
  provider?: string;
  /** The color scheme the PDF uses (P10, additive): the preview frame shows the same one. */
  colorScheme?: 'light' | 'dark' | 'auto';
  /** Why the preview isn't pagemd's own (P10, additive), e.g. "pagemd's renderer could not be loaded". */
  message?: string;
}

export interface ExportResult {
  ok: boolean;
  /** Where the output was written (a path or URI string, R-74 b). */
  target?: string;
  message?: string;
}

export interface Diagnostic {
  /** Character positions in the document text, like TextEdit. */
  from: number;
  to: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  code?: string;
  source: string;
}

// ── host side (ADR-0013 decision 7): implemented by style-* and output-* packages ──

/** Which document; `uri` is a string so the core never needs VS Code's `Uri` (R-74 b). */
export interface DocRef {
  uri: string;
}

export interface DocSnapshot extends DocRef {
  text: string;
  version: number;
}

export interface StyleProvider {
  resolve(doc: DocRef): Promise<ResolvedStyles>;
}

export interface OutputProvider {
  id: string;
  formats: OutputFormat[];
  available(): Promise<boolean>;
  preview(doc: DocSnapshot): Promise<PreviewResult>;
  /** `target` is a path or URI string, not VS Code's `Uri` (R-74 b). */
  export(doc: DocSnapshot, format: OutputFormat, target: string): Promise<ExportResult>;
}

// ── the tokens (ADR-0012: Lumino Token, one per service) ──

export const IDocumentSync = new Token<IDocumentSync>('@pagemd-editor/core:IDocumentSync', 'Applies minimal text edits; receives external changes. Required.');
export const IAssets = new Token<IAssets>('@pagemd-editor/core:IAssets', 'Writes pasted images; picks files. Optional.');
export const IStyles = new Token<IStyles>('@pagemd-editor/core:IStyles', 'Resolved page styles; creates a layout file. Optional.');
export const IOutput = new Token<IOutput>('@pagemd-editor/core:IOutput', 'Print Preview and Export. Optional.');
export const ISidecar = new Token<ISidecar>('@pagemd-editor/core:ISidecar', 'Review-comment side files. Optional.');
export const ILinks = new Token<ILinks>('@pagemd-editor/core:ILinks', 'Opens links and files. Optional.');
export const IDiagnostics = new Token<IDiagnostics>('@pagemd-editor/core:IDiagnostics', 'Validation results. Optional.');

/** All seven, for tests and for hosts that list what they provide. */
export const SERVICE_TOKENS = [IDocumentSync, IAssets, IStyles, IOutput, ISidecar, ILinks, IDiagnostics] as const;
