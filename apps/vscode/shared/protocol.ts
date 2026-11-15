// The typed messages between the extension host and the webview (ADR-0013 decision 8, invariant I5).
// Both sides import this file; it imports nothing from host/, webview/ or 'vscode' (layer rule
// 'shared-stays-neutral'). Messages are requests (with an id, answered by a response), or events (no answer).
import type { Diagnostic, ExportResult, FieldSpec, FilesInUse, GateChoice, GatedInsertMode, OutputFormat, OutputProviderInfo, PageGeometry, PreviewResult, ResolvedStyles, TextEdit, ViewMode } from '@pagemd-editor/core';

/**
 * Bumped whenever a message changes shape. The webview sends its version in `ready`; the host refuses a mismatch.
 * 2 (P5, amendment 3): styles (`getStyles`, `createLayoutFile`, `stylesChanged`, styles in `init`), `setView`,
 * `assetsChanged`.
 * 3 (P6, amendment 4, R-142): `WebviewCommand` adds `pagemd.printLayout`, `pagemd.read`, `pagemd.switchView`.
 * 4 (P7, R-156): `DocumentInit.settings`, the `settingsChanged` event, and the `confirmGatedInsert` and
 * `addFrontmatterField` requests (gated inserts, ADR-0016 M3).
 * 5 (P8, R-161): `StylesPayload.properties` (required, shown-on-page and profile-only properties); `addFrontmatterField`
 * is gone (the webview adds a gated item's property in the insert's own edit, one undo step).
 * 6 (P9, R-164, additive): `WebviewCommand` adds `pagemd.code` and `pagemd.split` (the Code and Split views); the test-only
 * `test:codeType` and `test:moveSection` requests.
 * 7 (P10, R-170, additive): the `preview` and `exportDocument` requests; `DocumentInit.output` (what Print Preview and Export
 * can make) and `DocumentInit.mermaidScript`; `WebviewCommand` adds `pagemd.printPreview`, `pagemd.exportToPdf`,
 * `pagemd.exportToHtml`, `pagemd.exportToPng` and `pagemd.chooseProfile` (names that pagemd-vscode doesn't use).
 * 8 (P12, R-180): the `readSidecar` and `writeSidecar` requests (ISidecar: the review comments' side file), the `sidecarChanged`
 * event, and `SettingsPayload.commentAuthor`.
 * 9 (P14, R-189, additive): the `diagnostics` event (IDiagnostics: the profile's checks, for the canvas's hints), `WebviewCommand`
 * adds `pagemd.checkDocument` (Document ▸ Check), the test-only `test:hints` request.
 * 10 (P15, R-193/R-196, additive): the `readAsset` request (IAssets.readAsset: an image's bytes, for a pixel edit).
 * 11 (fix-sync-bugs, AD-FIX-02, additive): `eol`, the file's own line ending (VS Code's `TextDocument.eol`), in `init`,
 * `externalChange` and a stale `applyEdits` answer. VS Code turns every line break an edit inserts into that one, so the webview
 * writes it too (a blank or one-line file has no line break to tell it from).
 * 12 (P25, R-242, additive): the `filesInUse` request (every file that builds the document, in priority order, why each was chosen,
 * and the index of every style rule) and the `openFile` event (show one of the report's files, at a line, or reveal it).
 * 13 (FIX-PGF, AD-FIX-PGF-02, additive): the `log` event (a line for the output channel "pagemd Editor", e.g. each Print Preview stage
 * starting and finishing, at debug level).
 * 14 (readable figures, R-254, additive): `SettingsPayload.figureStyle` (`pagemdEditor.figureStyle`: how a NEW figure is written).
 * 15 (native split, additive): `SettingsPayload.nativeSplit`; the `viewMode` and `splitCursor` events (webview → host) and `nativeCursor` (host → webview):
 * in Split view VS Code's own text editor opens beside the canvas and the two keep their cursors together.
 * 16 (code engines experiment, additive): `SettingsPayload.codeEngine` (which editor the Code view is made of) and `SettingsPayload.editorOptions`
 * (VS Code's own `editor.*` settings the Monaco views follow).
 */
export const PROTOCOL_VERSION = 16;

/** A file's line ending as VS Code keeps it: every line break an edit inserts becomes this one (protocol v11). */
export type LineEnding = '\n' | '\r\n';

// ── webview → host ──

/** Requests the webview sends; the host answers each one. */
export type HostRequests = {
  /** IDocumentSync: `version` is the document version the edits were computed against. */
  applyEdits: { params: { edits: TextEdit[]; version: number }; result: ApplyEditsResult };
  /** IAssets: bytes travel as binary (C5), not base64. Returns a path relative to the `.md` (C2). */
  writeAsset: { params: { bytes: Uint8Array; name: string }; result: string };
  /** IAssets: returns a path relative to the `.md`, or undefined when nothing (usable) was picked. */
  pickFile: { params: { filter?: string[] }; result: string | undefined };
  /**
   * IAssets (P15, R-196): the bytes of the image at `path` (relative to the `.md`), as binary. Refused (with the reason) for
   * anything the canvas could not show: outside the document's folder and the workspace, not an image file, over 50 MB.
   */
  readAsset: { params: { path: string }; result: Uint8Array };
  /** IStyles: the document's styles as they are now (P5). */
  getStyles: { params: Record<string, never>; result: StylesPayload };
  /**
   * IStyles (ADR-0014, R-129, R-130): after the author's confirmation, the host writes `.pagemd/layouts/<doc>.css`
   * (and, the first time, `.pagemd/profiles/<doc>.json` plus the frontmatter's `profile:` line) for `page`.
   * 'declined': the author said no, nothing was written (the change isn't kept). Fails with the reason when it
   * can't be done safely (not a file, a profile name clash, a profile it would break).
   */
  createLayoutFile: { params: { page: PageGeometry }; result: CreateLayoutResult };
  /**
   * A gated insert while `pagemdEditor.gatedInsert` is `ask` (P7, ADR-0016 M3): the host shows the prompt ("Add
   * <field>", "Insert Anyway", "Don't Ask Again"; the last one also switches the setting to `auto`, R-154).
   */
  confirmGatedInsert: { params: { label: string; field: string; value: unknown }; result: GateChoice };
  /**
   * IOutput (P10): the Print Preview page of the document as VS Code has it now (unsaved edits included). `nonce` is the
   * page's script nonce: the preview frame inherits the page's CSP, so only scripts carrying it run (Paged.js, mermaid).
   */
  preview: { params: { nonce: string }; result: PreviewResult };
  /** IOutput (P10): export the document as VS Code has it now; the host asks where (a Save dialog). */
  exportDocument: { params: { format: OutputFormat }; result: ExportResult };
  /**
   * ISidecar (P12, R-180): the review comments' side file `.pagemd/comments/<doc>.json`. Answers the parsed JSON, or null when
   * there is no file; fails with the reason when the file cannot be read (not valid JSON).
   */
  readSidecar: { params: { kind: SidecarKind }; result: Json };
  /** ISidecar (P12): writes the whole file (two-space JSON, a final newline), creating `.pagemd/comments/` as needed. */
  writeSidecar: { params: { kind: SidecarKind; data: Json }; result: void };
  /**
   * Files in Use (P25, protocol v12): the report for the document as VS Code has it now (core's `FilesInUse`). Plain styles give the
   * rows that were found and the problems; a document that is not a file gives none.
   */
  filesInUse: { params: Record<string, never>; result: FilesInUse };
};

/** What `test:contrast` answers (P13b). */
/**
 * Test-only (FIX-PGF, item 3): what the canvas did between `test:trace` start and stop, sampled every frame: full rebuilds (a new
 * editor state), patches (the changed blocks only), pagination runs and their time, whether the paper sheets or the page gaps were
 * missing in any frame, and when the pages were back as before.
 */
export interface TraceTestState {
  rebuilds: number;
  patches: number;
  runs: number;
  runMs: number[];
  /** The paper layer taken out of the page (each time). */
  layerRemovals: number;
  frames: number;
  /** Frames with no paper layer, or with fewer sheets or page gaps than before the trace started (by more than one). */
  framesWithoutPages: number;
  /** Time from the start to the first frame from which the sheets and gaps stay as many as at the end (ms), or null. */
  pagesBackAtMs: number | null;
  longestFrameGapMs: number;
  /** How far the scroll position moved in any frame (px): the view jumping while the pages are laid out again. */
  scrollMovedPx: number;
  before: { papers: number; gaps: number };
  after: { papers: number; gaps: number };
}

export interface ContrastTestState {
  highContrast: boolean;
  probes: { name: string; color: string; background: string; ratio: number }[];
  /** Probes that were not found on the page. */
  missing: string[];
}

/** The side files there are (ISidecar). */
export type SidecarKind = 'comments';

/** What a side file holds: JSON (`ISidecar` types it `unknown`; the plugin checks the shape). */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type CreateLayoutResult = 'created' | 'declined';

/**
 * The document's styles as the host resolved them (P5): pagemd's profile CSS scoped to the canvas, the page, the
 * running header/footer and the layout file (ResolvedStyles, R-127). `styles` is null when the document gets plain
 * styles (not a file, a profile not found, a YAML error, a missing stylesheet: `notes` say why), and the webview
 * uses style-default's then.
 */
export interface StylesPayload {
  styles: ResolvedStyles | null;
  /**
   * The profile's defaults for syntax gates (e.g. `{ fancy_lists: true }`), layered under the frontmatter the way
   * pagemd does (R-124, amendment 2): `gateFields(text, gateDefaults)`. `{}` for plain styles.
   */
  gateDefaults: Record<string, unknown>;
  /** Why the canvas looks as it does: "Using default layout", a profile not found, a missing stylesheet, … */
  notes: StyleNote[];
  /** What the profile and template say about the document's properties (P8, protocol v5); empty for plain styles. */
  properties: PropertiesInfo;
}

/**
 * The Document tab's hints (P8, ADR-0016): from @pagemd/meta's `requirements(profile, template)` and `catalogue(profile)`,
 * worked out on the host, which can read the profile and the template.
 */
export interface PropertiesInfo {
  /** The profile's `validation.required_fields`, as written. */
  required: string[];
  /** Every `metadata.x` the template shows on the page. */
  shownOnPage: string[];
  /** Fields only this profile has (its own defaults or required fields the catalogue doesn't know). */
  profileFields: FieldSpec[];
  /** The profile's own defaults (`metadata.defaults`), shown as what a missing property becomes. */
  defaults: Record<string, unknown>;
}

/** One note about the styles (amendment 9). The same shape as style-pagemd's StyleNote. */
export interface StyleNote {
  kind: StyleNoteKind;
  message: string;
  /** The file or name concerned, as written. */
  source?: string;
}

export type StyleNoteKind =
  | 'using-default-layout'
  | 'not-a-file'
  | 'frontmatter-error'
  | 'profile-not-found'
  | 'profile-error'
  | 'missing-stylesheet'
  | 'missing-pagemd-files'
  | 'css-error'
  /** P18: the template has no `{{content}}` (additive; the protocol stays v11, AD-P18-12). */
  | 'template-without-content'
  | 'import-dropped';

/**
 * The answer to `applyEdits`. 'ok' carries the new version. 'stale' (the document changed meanwhile, or VS Code
 * refused the edit) carries the document as it is now, so the webview can re-read it.
 */
export type ApplyEditsResult = { status: 'ok'; version: number } | { status: 'stale'; text: string; version: number; eol?: LineEnding };

/** Events the webview sends. */
export type HostEvents = {
  /** The webview has loaded and wants the document. */
  ready: { protocol: number };
  /** Native split (protocol v15): the view the webview shows now (the host opens or closes VS Code's text editor beside it for Split). */
  viewMode: { mode: ViewMode };
  /**
   * Native split (protocol v15): the canvas's cursor is at `offset` (a position in the document's text), in the block [from, to). With
   * `move` the host puts VS Code's text editor's cursor there; always it marks the block.
   */
  splitCursor: { offset: number; from: number; to: number; move: boolean };
  /** ILinks: open a link or a file (the host decides what it may open). */
  openLink: { href: string };
  /**
   * Run VS Code's undo, redo or save after the webview has sent its pending edits (R-87 amendments 4 and 5):
   * VS Code skips saving a file it doesn't yet know is dirty, and an undo would skip typing it hasn't received.
   * `pagemd.webLayout` / `pagemd.draft` (P5, R-132) are how the status bar's clickable view name switches views:
   * the same commands the Command Palette offers ("pagemd: Web Layout" / "pagemd: Draft"), so there is one place
   * that decides which session they act on (the active editor). Protocol v3 (P6, R-142) adds `pagemd.printLayout` /
   * `pagemd.read` ("pagemd: Print Layout" / "pagemd: Read") and `pagemd.switchView`, the view picker the status bar's
   * view name opens.
   */
  runCommand: { command: WebviewCommand };
  /**
   * Files in Use (P25, protocol v12): show a file of the last `filesInUse` report beside the document (at `line`, 1-based), or with
   * `reveal` in VS Code's Explorer (the system's file manager outside the workspace). Any other path is refused.
   */
  openFile: { path: string; line?: number; reveal?: boolean };
  /**
   * FIX-PGF (protocol v13): a line for the output channel "pagemd Editor" (the host shortens it to 500 characters). 'debug' lines show
   * only when the channel's log level is Debug ("Developer: Set Log Level…"); Print Preview writes one per stage start and end.
   */
  log: { level: 'debug' | 'info'; message: string };
};

/** The only VS Code commands the webview may ask for. */
export type WebviewCommand =
  | 'undo'
  | 'redo'
  | 'save'
  | 'pagemd.webLayout'
  | 'pagemd.draft'
  | 'pagemd.printLayout'
  | 'pagemd.read'
  | 'pagemd.switchView'
  // Protocol v6 (P9): "pagemd: Code" / "pagemd: Split".
  | 'pagemd.code'
  | 'pagemd.split'
  // Protocol v7 (P10): Print Preview, Export and the profile picker.
  | 'pagemd.printPreview'
  | 'pagemd.exportToPdf'
  | 'pagemd.exportToHtml'
  | 'pagemd.exportToPng'
  | 'pagemd.chooseProfile'
  // Protocol v9 (P14): "pagemd: Check Document" (pagemd-vscode's own is `pagemd.validate`).
  | 'pagemd.checkDocument';

// ── host → webview ──

/** Requests the host sends; the webview answers each one. */
export type WebviewRequests = {
  /** VS Code is about to save: send any pending edits now. */
  flush: { params: Record<string, never>; result: void };
  /** Test-only (R-89): type `text` at the end of top-level block `block`. Handled only when `init.testing`. */
  'test:type': { params: { text: string; block: number }; result: void };
  /**
   * Test-only (R-89; P5 amendment 11's `?v=` question): the `<img alt="…">` currently on the canvas, its `src`
   * attribute and whether it finished loading. null when no such image is there. Handled only when `init.testing`.
   */
  'test:imageState': { params: { alt: string }; result: { src: string; complete: boolean; naturalWidth: number } | null };
  /** Test-only (P7): the ribbon as drawn: its tab labels, the selected tab, how many buttons the selected tab shows, and every command's keybinding. */
  /** `tab` (P19, test only): selects that tab first; `disabled`: the drawn buttons that are off. */
  'test:ribbon': { params: { tab?: string }; result: { tabs: string[]; selected: string | null; buttons: number; keybindings: string[]; disabled: string[]; commands: string[] } };
  /** Test-only (P7): runs the action `id` through the action runner (the gate policy included); false when no such action. */
  'test:runAction': { params: { id: string }; result: boolean };
  /** Test-only (P15): selects the `nth` node named `name` on the canvas (a picture, for the image tools); false when there is none. */
  'test:selectNode': { params: { name: string; nth?: number; inside?: boolean }; result: boolean };
  /** Test-only (P15): the status bar's text now (its messages: "Saved …", a refusal). */
  'test:statusText': { params: Record<string, never>; result: string };
  /**
   * Test-only (fix run undo-bg-table-split): the pages on the canvas now, after the next layout: whether the pagination is on, how
   * many paper sheets are drawn, and the canvas's text (so a test sees that an undo was read).
   */
  // P21: `running` (additive, testing only): each paper's header and footer boxes as drawn, left | center | right
  'test:pages': { params: Record<string, never>; result: { on: boolean; papers: number; text: string; running?: { header: string[]; footer: string[] }[] } };
  /**
   * Test-only (P13b, amendment 8f): the colors of what the editor draws, as the webview's theme gives them now. `highContrast` is
   * whether VS Code put the page in a high-contrast theme; each probe is a part of the editor's own UI with its text color, the
   * background it really sits on and their WCAG contrast ratio (null when the part is not on the page).
   */
  'test:contrast': { params: Record<string, never>; result: ContrastTestState };
  /** Test-only (FIX-PGF, item 3): starts the frame-by-frame trace of the canvas, or stops it and answers what it saw. */
  'test:trace': { params: { action: 'start' | 'stop' }; result: TraceTestState | null };
  /** Test-only (P8): sets a document property through `registry.properties`, as the Document tab does; false when it can't. */
  'test:setProperty': { params: { key: string; value: unknown }; result: boolean };
  /** Test-only (P9): types `text` at offset `at` of the Code view, as the author would (switching to it first). */
  'test:codeType': { params: { text: string; at: number }; result: void };
  /**
   * Test-only (fix-sync-bugs, protocol v11): presses `keys` in the canvas or the Code view through their own key handling (a
   * one-character key is typed, with the canvas's typing shortcuts; any other is a key name such as 'Enter' or 'Backspace'),
   * after putting the cursor at `at` (a canvas position, or an offset in the Code view's text). Answers what each then holds.
   */
  /** Test-only: scrolls one pane of Split view to `fraction` of its range, then answers the block at the top of each pane (and how many blocks there are). */
  'test:scroll': { params: { target: 'canvas' | 'code'; fraction: number }; result: { codeBlock: number; canvasBlock: number; blocks: number } };
  'test:keys': { params: { target: 'canvas' | 'code'; keys: string[]; at?: number }; result: KeysTestState };
  /** Test-only (P9): Move up / Move down on the Outline for the section of the heading labelled `heading`; false when it can't move. */
  'test:moveSection': { params: { heading: string; direction: 'up' | 'down' }; result: boolean };
  /** Test-only (P10): the Print Preview's state (rendering again first when `refresh`) and the canvas's drawn diagrams. */
  'test:preview': { params: { refresh?: boolean }; result: PreviewTestState };
  /**
   * Test-only (P11): an image pasted (or, with `drop`, dropped) onto the canvas, as the browser delivers it: a File in the
   * clipboard's (or the drop's) file list. Answers whether the canvas took the event (its default was prevented).
   */
  'test:paste': { params: { name: string; type: string; bytes: Uint8Array; drop?: boolean; text?: string }; result: boolean };
  /**
   * Test-only (P11): drives the find bar as the author would. `key` presses Ctrl+F or Ctrl+H on the canvas; `query` and
   * `replacement` type into the boxes; `do` presses a bar button. Answers what the bar shows.
   */
  'test:find': { params: { key?: 'f' | 'h'; query?: string; replacement?: string; do?: 'next' | 'previous' | 'replace' | 'replaceAll' | 'close' }; result: FindTestState };
  /**
   * Test-only (P12): drives the Comments panel as the author would. `do` presses one of its buttons (`new` types `text` into the
   * new-comment box and sends it; `reply` types `text` into thread `id`'s reply box; `select` goes to the thread; `block` first puts the cursor in that top-level block). Answers what it shows.
   */
  /** Test-only (P14): the problem hints on the canvas now (block index, worst severity, messages). */
  'test:hints': { params: Record<string, never>; result: HintsTestState };
  /**
   * Test-only (P25): the Files in Use panel, opened first. `heading`: the cursor goes into the first heading of that level first;
   * `click`: presses the Open button of the row whose file is named so; `rule`: presses the winning rule of that property in "where did
   * this come from". Answers what the panel shows.
   */
  'test:files': { params: { heading?: number; click?: string; rule?: string }; result: FilesTestState };
  'test:comments': { params: { do?: 'open' | 'new' | 'reply' | 'resolve' | 'delete' | 'reattach' | 'remove-marker' | 'select'; id?: string; text?: string; index?: number; block?: number }; result: CommentsTestState };
};

/** What `test:files` answers (P25). */
export interface FilesTestState {
  visible: boolean;
  /** The rows' file names, in the order shown. */
  rows: string[];
  /** "Where did this come from": each property's source kind and the winning rule's text (file:line selector declaration). */
  where: { property: string; source: string; rule: string }[];
}

/** What `test:hints` answers (P14). */
export interface HintsTestState {
  hints: { block: number; severity: Diagnostic['severity']; messages: string[] }[];
  /** The last `diagnostics` event's state. */
  enabled: boolean;
  shown: boolean;
}

/** What `test:comments` answers (P12). */
export interface CommentsTestState {
  open: boolean;
  status: string;
  /** The panel's note (why the file is not ready, or a save problem). */
  note: string;
  threads: { id: string; resolved: boolean; messages: number; active: boolean }[];
  orphans: string[];
  bare: string[];
  composing: boolean;
}

/** What `test:find` answers (P11). */
export interface FindTestState {
  open: boolean;
  /** The match counter's text ("2 of 5", "No results"). */
  count: string;
  matches: number;
  /** Whether the replace row is showing. */
  replaceRow: boolean;
  /** The selected text of the canvas. */
  selected: string;
}

/** What `test:keys` answers: the canvas's top-level blocks ('type:text'), the one holding the cursor, the Code view's text. */
export interface KeysTestState {
  blocks: string[];
  cursorBlock: number;
  codeText: string | null;
}

/** What `test:preview` answers (P10). */
export interface PreviewTestState {
  visible: boolean;
  busy: boolean;
  pages: number | null;
  provider: string | null;
  diagrams: number | null;
  message: string | null;
  /** Whether a script written in the document ran inside the preview (it must not: the CSP). */
  documentScriptRan: boolean;
  /** Diagram blocks drawn on the canvas. */
  drawnOnCanvas: number;
  /** The preview's pictures: how many, how many loaded, and the addresses of those that failed (first 5). */
  images?: { total: number; loaded: number; broken: string[] };
  /** Diagrams drawn in the preview (mermaid's pictures in the page), not just placeholders counted. */
  drawnInPreview?: number;
}

/** Events the host sends. */
export type WebviewEvents = {
  /** The answer to `ready`: the document and where it lives. */
  init: DocumentInit;
  /** The document changed outside the webview (git checkout, another editor, VS Code's undo). */
  externalChange: { text: string; version: number; eol?: LineEnding };
  /**
   * The styles changed (a profile, layout or stylesheet was edited or created, or the frontmatter now names another
   * profile, P5 amendment 8). Carries the new styles and the profile's gate defaults; when the gate values change,
   * the webview re-reads the document (R-124).
   */
  stylesChanged: StylesPayload;
  /** Switch the view (the "pagemd: Web Layout" / "pagemd: Draft" commands and the status bar, R-132). */
  setView: { mode: ViewMode };
  /**
   * Image files in the document's folder changed on disk (inventory row C9, amendment 11): paths relative to the
   * document's folder, '/'-separated, as images name them; the canvas reloads the matching images.
   */
  assetsChanged: { paths: string[] };
  /** The editor's settings changed (P7): `pagemdEditor.gatedInsert`. */
  settingsChanged: SettingsPayload;
  /** The document was saved (P10, protocol v7): a Print Preview that shows renders again. */
  saved: Record<string, never>;
  /** A side file changed on disk (P12, protocol v8: git checkout, another window): read it again. Our own writes cause one too. */
  sidecarChanged: { kind: SidecarKind };
  /**
   * IDiagnostics (P14, protocol v9): the profile's checks for the document at `version` (whose text was `text`), as the core's
   * `Diagnostic` (character positions in `text`). Sent after each run (opening, typing stops, saving, a profile file
   * changed, "Check Document"); `items` is empty when the profile asks for no checks or the setting hides them.
   */
  diagnostics: DiagnosticsPayload;
  /** Native split (protocol v15): the cursor of VS Code's text editor moved (the author's) to `offset`; the canvas follows. */
  nativeCursor: { offset: number };
  /** The user's colour theme for the Code view (protocol v16), or null when it cannot be found; sent after `init` and when the theme changes. */
  codeTheme: CodeThemePayload | null;
};

/** A colour theme as VS Code's own services take it (protocol v16): the theme file with its `include`s merged, as JSON text. */
export interface CodeThemePayload {
  id: string;
  uiTheme: 'vs' | 'vs-dark' | 'hc-black' | 'hc-light';
  json: string;
  /** `editor.tokenColorCustomizations` and `workbench.colorCustomizations` as the user set them. */
  tokenColorCustomizations: unknown;
  colorCustomizations: unknown;
}

/** The `diagnostics` event (P14). */
export interface DiagnosticsPayload {
  version: number;
  text: string;
  items: Diagnostic[];
  /** The profile asks for checks (it has a `validation` setting). */
  enabled: boolean;
  /** `pagemdEditor.showProblems`: false hides every result (it can only hide, ADR-0017 V5). */
  shown: boolean;
}

/** The settings the webview needs (P7). */
export interface SettingsPayload {
  /** `pagemdEditor.gatedInsert` (ADR-0016 M3). */
  gatedInsert: GatedInsertMode;
  /** The name review comments carry (P12, protocol v8): `pagemdEditor.commentAuthor`, else the computer's user name. */
  commentAuthor: string;
  /** `pagemdEditor.figureStyle` (protocol v14, R-254): how a new figure is written; every style is read whatever this is. */
  figureStyle: FigureStyle;
  /** `pagemdEditor.nativeSplit` (protocol v15): Split opens VS Code's own text editor beside the canvas instead of the built-in Code pane. */
  nativeSplit: boolean;
  /** `pagemdEditor.codeEngine` (protocol v16, experiment): what the Code view and the Split view's code pane are made of. */
  codeEngine: CodeEngine;
  /** VS Code's `editor.*` settings for markdown (protocol v16): the keys that are set, by their names (`minimap.enabled`, `fontSize`, …). */
  editorOptions: Record<string, unknown>;
}

/** monaco-vscode: Monaco with VS Code's own services (grammar, theme), loaded when the Code view first opens; codemirror: the built-in view. */
export type CodeEngine = 'codemirror' | 'monaco-vscode';

/** readable: `![alt](src "caption")` and a comment line only if needed; native: one `<!-- ::FIGURE src=… -->` line; legacy: the comment, then the picture. */
export type FigureStyle = 'readable' | 'native' | 'legacy';

export interface DocumentInit {
  protocol: number;
  text: string;
  version: number;
  /** The file's line ending (protocol v11); absent: read from the text (`\n` when it has no line break). */
  eol?: LineEnding;
  /** The file name, for the status bar and messages. */
  fileName: string;
  /** The document's folder as a webview address, ending in '/'; relative image paths resolve against it (C1). */
  documentBase: string;
  /** True only when the extension host runs under the test runner (PMD_TEST=1, R-89). */
  testing: boolean;
  /** The document's styles, resolved before `init` is sent (amendment 3): the first read already follows them. */
  styles: StylesPayload;
  /** The editor's settings now (protocol v4); changes arrive as `settingsChanged`. */
  settings: SettingsPayload;
  /** What Print Preview and Export can make (protocol v7): pagemd's renderer, or the plain-HTML fallback. */
  output: OutputProviderInfo[];
  /** The webview address of the mermaid browser build (protocol v7): diagrams on the canvas. */
  mermaidScript: string;
}

// ── envelopes ──

export type RequestMap = Record<string, { params: unknown; result: unknown }>;
export type EventMap = Record<string, unknown>;

export type RequestMessage<R extends RequestMap> = { [M in keyof R & string]: { kind: 'request'; id: number; method: M; params: R[M]['params'] } }[keyof R & string];
export type EventMessage<E extends EventMap> = { [N in keyof E & string]: { kind: 'event'; name: N; data: E[N] } }[keyof E & string];
export type ResponseMessage = { kind: 'response'; id: number; ok: true; result: unknown } | { kind: 'response'; id: number; ok: false; error: string };

export type WebviewToHost = RequestMessage<HostRequests> | EventMessage<HostEvents> | ResponseMessage;
export type HostToWebview = RequestMessage<WebviewRequests> | EventMessage<WebviewEvents> | ResponseMessage;
