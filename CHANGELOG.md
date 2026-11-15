# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project will
use [Semantic Versioning](https://semver.org/) once code ships.

## [0.1.0] - 2026-10-06

The first installable version: everything built in phases P0 to P16 plus P13a, packaged as a local `.vsix` (not published).

### Fixed
- P16: a multi-line table row in a header or a headerless table no longer fails the whole document; a line break inside a table cell is kept as a line break; changing a table caption's kind no longer deletes a second caption.
- P16 / OQ-29 (pagemd-common): the cell after a `||` span (`| 1 || 2 |`) is no longer dropped from pagemd's own HTML or the PDF.
- P16: a table whose column wraps (`---+` in the separator) opened as raw text; it is now an editable table.
- P15: an annotated image inserted from the ribbon or slash menu (since P4) failed to draw on the canvas; it now draws.

### Changed
- P13a: the bundles are minified (the host 4.4 MB to 0.9 MB, the page 2.7 MB to 1.2 MB); the manifest says version 0.1.0 and is no longer private.
- OQ-42 / R-191: **a plain document is quiet.** pagemd's default profile (`standard_letter`) no longer asks for required properties, so a
  document that names no profile gets no checks (no "missing document_id/title" errors in `pagemd validate` or the Problems panel).
  `sop`, `technical-report` and `book-wiki` still check theirs.

### Added
- P13a (session 31, R-204–R-208): **ready for daily use.** `npm run package` builds `pagemd-editor-0.1.0.vsix` (about 7 MB; minified, no source
  maps, no sources) from a clean build; `npm run test:vsix` installs that file into a clean VS Code and checks it from outside (the editor
  opens, its commands are registered, Export HTML works from the installed copy, no test-only handle answers). `ThirdPartyNotices.txt` is
  now generated from what is really bundled (every library's version, licence and licence text, pagemd's Apache-2.0 text included) and a
  test fails when a bundled library is missing from it. A user README for the extension page. Tests: a cross-view journey (one document
  through Print, Web, Draft, Read, Code and Split) and a 120-page benchmark (open, typing, re-pagination, save, outside change, memory).
  `node scripts/windows.mjs` runs the suites on Windows from a sibling git worktree.
- P16 (session 30, R-198–R-202): **table editing.** A **Table** tab (after Insert) adds, deletes and moves rows and columns, merges and
  splits cells, turns the header row on and off, aligns columns (left, centre, right, none) and deletes the table; its buttons are on
  only when the cursor is in a table. Tab / Shift+Tab move between cells (Tab in the last cell adds a row), Enter goes to the cell below,
  the arrow keys and Shift+arrows select cells, dragging selects cells, Backspace empties them. Copying selected cells puts a markdown
  table on the clipboard; pasting one into selected cells fills them. A new row stays in the body group it was added to; merging keeps
  every word. The Inspector edits a table's caption (add, remove, `Table:` line or `[text]`, above or below), each column's alignment and
  wrap, and its `{…}` id and classes. Multi-line table rows (one paragraph per cell) are editable and keep their line breaks; a cell with
  a list, or a row pagemd's reader would lose words from, still opens as raw text. A table whose rows have different lengths keeps its
  text editable with the table tools off. A changed table is written whole in pagemd's canonical form (the author's column padding is not kept).
- P15 (session 29, ADR-0018): **the image editor.** Mark up screenshots on the canvas: double-click an annotated image (or press
  Enter on it) to select, drag, resize, nudge (arrow keys) or delete its markers, arrows, boxes, text notes, lines, ellipses and
  highlights; each change is one undo step and changes only that shape's line of YAML (comments and the author's style kept).
  **Insert ▸ Shapes** adds a shape (a plain picture or FIGURE becomes an annotated image first) and renumbers markers in reading
  order; the Inspector's row follows the selected shape. **Insert ▸ Image tools**: Crop (a FIGURE can keep its original and show only
  part of it), Rotate left/right, Flip, Redact save a NEW picture `<name>-edited.<ext>` in the image folder and point the document at
  it, with shapes or the crop moved to follow, as one undo step; the original is never overwritten, and Redact warns that the original
  and git history still hold what was painted over. **Insert ▸ Convert**: to a figure, to an annotated image. Protocol v10
  (`readAsset`: only pictures the editor can already show, at most 50 MB).
- C8 + P14 (session 28): **pagemd problems in the editor.** When a document's profile asks for checks (its `validation` setting), the
  results appear in VS Code's Problems panel and as a coloured bar at the left of the block a problem is in (its message as the
  tooltip): missing or empty required properties, values of the wrong type, a lettered list without `fancy_lists`, a template, layout,
  stylesheet, included file or image that isn't there, FIGURE settings pagemd ignores, unknown directives, and more. They are the same
  results as `pagemd validate` (one shared package, `@pagemd/validate`, in pagemd-common). They refresh on opening, when typing stops,
  on save and when the profile's files change; **Document ▸ Check ▸ Check Document** ("pagemd: Check Document") checks at once. New
  setting `pagemdEditor.showProblems` (hides them; never adds checks); new package `plugin-diagnostics`; protocol v9. In pagemd and
  pagemd-common (no changelog of their own, AD-C6-15): `@pagemd/validate`, `pagemd validate` rebuilt on it (rendering's file search; the
  false "no layout.source defined" warning gone; a "Notes:" list; line numbers), `pagemd build --dry-run`, `validation: true` or a
  per-level object in `profile.schema.json` (`validation.schema` removed), js-yaml 5.4.3.
- P12 (session 27): **review comments** (Review ▸ Comments, View ▸ Show ▸ Comments): put the cursor in a paragraph (or select words), write
  a comment, and the document gains exactly one line, `<!-- ::COMMENT id="c7" -->`, directly above that block; the thread (quote, name, time,
  messages) goes into `.pagemd/comments/<document>.json` next to it. A Comments panel on the right shows every thread with Reply,
  Resolve / Reopen and Delete, and lists what no longer matches (a thread whose line was edited away or undone, a line with no thread)
  under "Needs attention" with Re-attach here and Remove marker. The PDF and HTML are unchanged (pagemd prints the line as an HTML
  comment) and Print Layout's pages are the PDF's. A side file the editor does not understand is never overwritten. New setting
  `pagemdEditor.commentAuthor`; new packages `plugin-comments` and `components/comments-margin`; protocol v8 (`readSidecar`, `writeSidecar`,
  `sidecarChanged`); the lossless layer saves a `tight` block (the anchor) without a blank line after it (ADR-0007 note).
- P11 (session 26): **paste or drop a picture** onto the canvas (it is saved into `.pagemd/assets/img/`, or the folder in the new setting
  `pagemdEditor.imageFolder`, as `image-<date>-<time>.png` for a paste or under its own cleaned name for a drop, never overwriting; one
  `<!-- ::FIGURE src="…" -->` per picture goes into the document as one undo step and the Inspector's caption box takes the focus);
  **find and replace on the canvas** (Ctrl/Cmd+F, Ctrl/Cmd+H, Home ▸ Editing: visible text only, highlighted matches, Match case, Whole
  word, Replace all as one undo step; VS Code's own find in the Code view); the setting **`pagemdEditor.openByDefault`** (file patterns
  copied into VS Code's `workbench.editorAssociations`) and the command **"pagemd: Reopen with pagemd Editor"**, because VS Code
  chooses an editor by file name only (the "open pagemd documents automatically" rule of ADR-0008 is withdrawn). New packages
  `plugin-image-paste` and `plugin-find`; protocol unchanged (v7); Ctrl+F and Ctrl+H join R-158's deliberate overrides.
- P10 (session 25): **Print Preview** (View ▸ Print Preview, "pagemd: Print Preview": pagemd's own page laid out by Paged.js,
  read-only, refreshed on open, on save and by Refresh; plain HTML when pagemd's renderer isn't available), **Export PDF / HTML / PNG**
  (Document tab and "pagemd: Export …": exactly as `pagemd build` makes them, of the current text, through a Save dialog next to the
  document; Chrome, then Edge, then the new setting `pagemdEditor.browserPath`; no browser is downloaded), the **profile picker**
  (Document ▸ Profile, "pagemd: Choose Profile": writes `profile:`), and **diagrams drawn on the canvas** in Print Layout, Web Layout
  and Read (mermaid 12.1.0, pagemd's version). New packages `output-pagemd`, `output-html`, `components/preview-frame`; protocol v7;
  `PreviewResult` grows `provider`, `colorScheme`, `message`; pagemd's runtime file built from the local pagemd checkout
  (`PAGEMD_CHECKOUT`); the layer rule `outputs-only-in-host`.
- C6 (session 25, in pagemd and pagemd-common, recorded here: neither has a changelog): pagemd draws diagrams with the `mermaid`
  library (12.1.0, exact) in one browser page per document instead of mermaid-cli; finds Microsoft Edge after Chrome; `@pagemd/syntax`
  holds the mermaid fence helpers, `MERMAID_VERSION` and `MERMAID_CONFIG`; `@pagemd/exporters` gains `renderForPreview` and
  `exportText` (`pagemd build` writes through them); `validate` no longer draws diagrams; `PAGEMD_TIMEOUT` reaches the PDF.

- P9 (session 24): the **Outline panel** (left, View ▸ Outline: the title, headings, numbered figures, tables, boxes, callouts, TOC,
  includes; click to go there; drag a heading or use Move up / Move down to move its whole section as one change and one undo step),
  **VS Code's own Outline** lists pagemd's items (a `DocumentSymbolProvider` for markdown files), the **Code view** ("pagemd: Code":
  the text in CodeMirror 6, coloured and folded by block, VS Code's undo) and **Split view** ("pagemd: Split": the Code view next to
  the canvas, side by side or stacked, cursors kept in the same block). New packages `components/outline-panel`,
  `components/code-view`, `components/split-view`, `plugin-source-map`; `OutlineEntry.number` and `block`; protocol v6.

- P8 (session 23): the **Inspector** (a right-hand panel: Element tab with each item's fields, Document tab with the document's
  properties), the **properties card** at the top of the page (same form, raw-YAML view), the frontmatter as one node (written back
  exactly; a property edit changes only that value, keeps comments, order and the author's own key), "Browse…" for file paths, list
  rows and colours for annotated images, **gated inserts as one undo step**, Document ▸ Properties and View ▸ Inspector, and **VS
  Code's own icons** (`@vscode/codicons`, CC BY 4.0; `apps/vscode/ThirdPartyNotices.txt`). Protocol v5 (the host's
  `addFrontmatterField` request and style-pagemd's `frontmatterFieldEdit` are removed: the webview adds a gated item's property in
  the insert's own edit).
- P7 (session 22): the **ribbon** (Home, Insert, Layout, Document, Review, View, arranged by
  `apps/vscode/webview/ribbon.layout.json`; "More" for unplaced commands; an empty "Image tools" slot reserved for the image
  editor), the **`/` slash menu** (search, one-undo-step insert), the **selection toolbar**, **keyboard shortcuts**
  (`plugin-keymap`), commands for every item of the CommonMark, GFM and pagemd presets, **Insert Table**, the View tab
  (views, page arrangement, fit, zoom, ruler), and the **`pagemdEditor.gatedInsert` setting** (ask / auto / warn; the prompt
  adds the property to the frontmatter). `Registry.actions()`, command kinds, protocol v4, the action runner; cohesion matrix
  §3/§4 with a test against the real registry. Planned: P16 table editing.
- P7 shortcuts (R-158): the Word-style keys win while the cursor is in the document (Ctrl/Cmd+B, I, E, K, Shift+X, Shift+., Alt+C); the
  seven that shadow a VS Code default are on an explicit allow-list checked by `test:vscode`, and a handled key no longer reaches VS Code.
- P7 review fixes (R-157): shortcuts moved off VS Code's own keybindings (checked by `test:vscode`) and run through the same
  gate as the buttons; the gate is decided when a button is used; the property is added once; the slash menu re-finds its text
  after a prompt; "Don't Ask Again" writes at the right settings scope.
- The planning documentation set: product vision, proposed architecture, ADR-0001 … ADR-0009, open
  questions, draft roadmap, devlog, and the session-1 and session-2 handoffs.
- Research: engine cost/benefit analysis with PoC evidence scripts, the Milkdown architecture
  comparison, the reference-project survey, and the pagemd dialect inventory.
- The agent breadcrumb system: README hidden breadcrumbs → `.agents/rules.md` → `docs/README.md`
  index; `CLAUDE.md` and `AGENTS.md` pointers.
- `scripts/check-docs.mjs`: checks the breadcrumb trail's integrity.
- `docs/architecture/layered-architecture.md` (layered design with visuals), ADR-0010, and the session-3 handoff.
- Session 3: `docs/architecture/pagemd-common.md` (pagemd package map), `docs/architecture/cohesion-matrix.md`,
  ADR-0011 … ADR-0015, 21 phase plans in `docs/phases/`, and the session-4 handoff.
- Session 4: ADR-0016 (`@pagemd/meta`), ADR-0017 (`@pagemd/validate`), phases C7, C8, P14; the "working code
  beats recollection" rule in `.agents/rules.md`.
- Session 5: the session-6 handoff; OQ-12 (publishing pagemd-common) and OQ-13 (ignored profile defaults).
- Session 6: phase C0 built in pagemd (branch `phase/c0-golden-corpus`: golden corpus, collect script, CLI
  output snapshots); the model-routing table in `.agents/rules.md`; OQ-14–16; R-50, R-51; the session-7 handoff.
- Session 7: phase C1 built. It created the local `pagemd-common` repo with `@pagemd/syntax`, and pagemd's
  parser now uses it (pagemd `cd583e9`, pagemd-common `36f35b0`). Also: C1 "As built", the session-8 handoff.
- Session 7 decisions: R-52 (include paths should be document-relative; fixed in C2) and R-53 (the unused
  `PAGEMD_DEBUG_CONTAINERS` code is deleted); the C2 plan and dialect inventory now say so.
- Session 8: phase C7 built. `@pagemd/meta` is in pagemd-common, and pagemd uses it (branch
  `phase/c7-meta`), with the conflict report `pagemd-common/docs/meta-conflicts.md`. Also: C7 "As built",
  R-54–R-65 (OQ-18 decided), and the session-9 handoff.
- Session 9: phase P0 built. The npm-workspaces monorepo (`@pagemd-editor/*`) with one stub per layer
  (core, transformer, lossless, preset-commonmark, plugin-history, components/canvas, apps/vscode), esbuild
  host + webview bundles, dependency-cruiser layer rules written as folder patterns, Vitest (+ `vscode`
  stand-in), Playwright, the corpus harness, a VS Code activation test, and `npm run check`. Also: `.nvmrc`
  (Node 24), R-66, R-67, OQ-19, P0 "As built", and the session-10 handoff.
- Session 10: phase U1. All three repos moved to their newest libraries (markdown-it 15, js-yaml 5,
  puppeteer 25, shiki 4, yargs 18, vitest 5 …); `npm run deps:check`; a layer self-test guard that fails if
  any source file goes unread; VS Code floor 1.138 (test host 1.139.1); `allowScripts` (esbuild). Docs:
  U1, C9 and P15 phase plans, ADR-0018 (Proposed), the image-tool evaluation, the image-editor integration
  inventory, R-68–R-83, OQ-21, and the session-11 handoff.
- Session 11: phase P1 built (branch `phase/p1-core`). `core` (ADR-0013 TypeScript, `ItemRegistry`,
  `CommandRegistry`, `ViewState`, the 7 service tokens, `createEditor` on Lumino's `PluginRegistry`,
  `raw_block`), `transformer` (per-top-level-block parse with source ranges, raw fallback, writers), `lossless`
  (`diffToEdits`, `applyEdits`), `preset-commonmark` (13 items). Tests: the golden corpus (CommonMark spec
  examples, 9 plain files, `docs/**/*.md`), one-hunk edits, fast-check property tests, registry contract
  tests (971 in all). `.gitattributes` keeps the corpus bytes. Docs: P1 "As built", R-84, R-85, the
  session-12 handoff.

- Session 12: phase P2 built (branch `phase/p2-shell`). The VS Code custom editor `pagemd-editor.editor` ("Open
  With…" on `.md`): typed host ⇄ webview protocol (`shared/protocol.ts`, `shared/channel.ts`), host services
  (`IDocumentSync` with version checks, `IAssets` with the C2 path contract, `ILinks` with a link policy, a
  `FileSystem` port), the webview editor in Draft view with minimal-edit sync, outside-change re-read and cursor
  keeping, images from the document's folder (C1), and new packages `status-bar` and `style-default`; `canvas`
  built. Tests: host and webview unit tests, 11 Playwright tests with a stand-in host, and the real VS Code round
  trip (edit → save → `git diff`, undo, `git checkout`, CRLF). Docs: P2 "As built", R-86–R-92, OQ-23, OQ-24, the
  session-13 handoff.

- Session 13/14: phase P3 built (branch `phase/p3-gfm`). `preset-gfm` (tables, strikethrough, autolinks, GFM
  alerts), new packages `plugin-history` (VS Code-only undo/redo, R-94), `plugin-clipboard` (copy/paste as
  markdown), `plugin-input-rules` (typing shortcuts), and `components/raw-block-editor` (inline CodeMirror 6 for
  anything unmodeled). Everyday editing keys (Enter, Backspace-join, list Enter/Tab) via `prosemirror-commands` +
  `prosemirror-schema-list`, added directly to `components/canvas` (R-95). A new shared mechanism,
  `Editor.pmPlugins`, lets any feature plugin add ProseMirror behaviour to the canvas (ADR-0013 amendment). Four
  `preset-commonmark` items (heading, lists, blockquote, code-block) got real input rules. Tests: `preset-gfm`'s
  own corpus round-trip, unit tests per new plugin, 5 new Playwright scenarios; `npm test` 1048, `test:e2e` 16,
  `test:vscode` unchanged (6). Docs: P3 "As built", R-94–R-98, OQ-23/24 resolved, the session-14 handoff.
- Session 15: phase C9 built upstream (branch `phase/c9-images` in pagemd-common and pagemd; no editor code).
  `@pagemd/syntax`: annotated-image `lines:`, `ellipses:`, `highlights:` and the `alt`/`width`/`link`/`class`
  options; one document-order figure numbering for FIGURE and annotated images (no number without a caption);
  `listImageRefs()`; nested Inspector `params` with a `color` type; `![[path|alt]]`; image defect fixes (PD4, PD5,
  PD10, PD12, PD13, PD15, PD16, PD18, PD21, PD22, PD24). pagemd: `pagemd archive` finds every image form; PDF
  leading-`/` paths start at the project root; 7 fixture documents in the corpus; a PDF smoke test; wiki and
  example README updated. Tests: pagemd-common 745, pagemd 1125. Docs: C9 amendments and "As built", R-101–R-104,
  OQ-27, dialect and image inventories, the session-15 handoff.
- Session 16: phases C2 + C3 built upstream (branch `phase/c2-c3-editor-mode` in pagemd-common and pagemd; no editor
  code). `@pagemd/syntax`: `createDialect({ mode: 'editor' })` and `applyDialect(md, opts)`, with a line range on
  every block token, directives kept as written, `!!!include(…)!!!` as an atom, typographer off, wikilink/embed marks,
  a table model and a YAML-error note; a write rule `write(data, content?)` on every item but `attrs-fix` (keeping the
  author's style; annotated-image YAML edited in place with `yaml` 2.9.1), `itemOccurrences()`, escaping helpers.
  pagemd: include paths resolve from the document's folder (R-52; `14-wiki-book` builds). Tests: pagemd-common 860
  (fast-check property tests added), pagemd 1136 (whole-corpus line-range and round-trip tests). Docs: C2/C3
  amendments and "As built", R-106–R-109, OQ-28, the session-16 handoff.

- Session 17: phase P4 built (branch `phase/p4-preset-pagemd` in all three repos). New package `preset-pagemd`: every
  pagemd item as a `SyntaxItem` (27 items), reading through `@pagemd/syntax`'s `applyDialect` in editor mode and
  writing through its write rules; pagemd tables and alerts replace GFM's; `{…}` attributes and fancy-list markers
  on CommonMark nodes; FIGURE and annotated images drawn by pagemd's renderer with its structural CSS (D1, D2, D18);
  a live TOC; the fancy-lists gate from the frontmatter. Core: `SyntaxItem.extend` (ADR-0013 amendment, R-114).
  Upstream: named-container and table-attribute line ranges, the named-container `closed` flag, the annotated-image
  structural CSS export (pagemd-common); corpus and CSS tests (pagemd). Tests: editor 1207 unit, 21 Playwright, 7 VS
  Code scenarios; pagemd-common 867; pagemd 1142 (no snapshot changed).
- Session 18: phases C4 + C5 built upstream (branch `phase/c4-c5-resolver-theme` in pagemd-common and pagemd; editor docs
  only). pagemd-common: `@pagemd/resolver` (every lookup once, sync and async; `resolveDocument()`; in-memory
  FileSystem) and `@pagemd/theme-kit` (moved from pagemd: `buildStyles()`, the style block, running header/footer,
  `pageGeometry()`, pagemd's default CSS and `letter.css`). pagemd: core adapters, the renderer through
  `resolveDocument()`, a profile may set `fancy_lists`/`highlight_theme` (R-124). Tests: pagemd-common 1040, pagemd
  1245 (no snapshot changed).
- Session 20: phase P5 built (branch `phase/p5-styles` in all three repos; pagemd's own `bundle` command is
  untouched, R-137, OQ-37). New package `style-pagemd` (host-run, browser-safe: `resolve → read → buildStyles → scope`,
  postcss 8.5.28); protocol v2 (`getStyles`/`createLayoutFile`, `stylesChanged`/`setView`/`assetsChanged`); the
  canvas opens in **Web Layout** by default (R-132), styled by the document's actual profile CSS, scoped to
  `.pmd-canvas` with `@page` stripped; a page with no layout shows pagemd's own default page and a note
  (ADR-0014); the status bar shows the profile, the resolved layout (`Layout: letter (pagemd)`) and every other
  note (a profile not found, a missing stylesheet, a YAML error), and its view name is clickable; three commands
  ("pagemd: Web Layout" / "Draft" / "Create Layout File"); a confirm-then-write flow creates
  `.pagemd/layouts/<doc>.css` plus a per-document profile (`.pagemd/profiles/<doc>.doc.json`, R-129/R-130/R-138)
  when the current layout can't be changed directly; images changed on disk reload on the canvas (C9 inventory
  row). pagemd-common: `@pagemd/theme-kit`'s `defaults/` now ships every one of pagemd's bundled
  profiles/layouts/styles/templates (~700 KB, R-128), so the editor needs no pagemd install (a
  `pagemdEditor.pagemdPath` setting points at a real one instead); `@pagemd/resolver` keeps a profile's own
  relative paths working when it is inherited from a different folder (R-136). A real VS Code finding, fixed: a
  *recursive* out-of-workspace file watcher never fires, so image and new-file watching use flat, one-level
  patterns instead (verified in `test:vscode`). New Playwright checks (`style-parity.spec.ts`) prove the canvas's
  computed styles and look match pagemd's own HTML output for the same profile (R-133 checks 2–3), with a stated
  pixel tolerance and a control. Tests: editor `npm test` 1328, `test:e2e` 30, `test:vscode` passed, `npm run
  check` clean; pagemd-common 1047; pagemd 1264 (no snapshot changed). New open questions OQ-36 (a profile's `id`
  as a "common name") and OQ-37 (pagemd's `bundle` command misses a parent profile's own files for a per-document
  profile).
- Session 21: phase P6 Part 1 built (branch `phase/p6-print-layout` in pagemd-editor and pagemd-common; not
  committed yet). New package `components/pagination`: Print Layout's paper pages, measured from the rendered canvas
  (a pure layout function plus a measuring layer; page gaps drawn as widgets; the profile's own `break-*` CSS,
  PAGEBREAK, SECTION/COVER wrappers, LAYOUT named pages, orphans/widows, keep-with-next, avoid groups, very tall
  images; re-measures from the edited page on). The `print` view recipe (not yet the default). Profile print rules
  now apply under `.pmd-print` and screen rules outside it (style-pagemd scoping, zero added specificity).
  `ViewState` grows `pageArrangement`/`fit`; protocol v3 (`pagemd.printLayout`/`read`/`switchView` commands);
  `ResolvedStyles.strings` and the `:::STRING(name)` token: header/footer text written in a layout's margin boxes
  (book-wiki) is read by `@pagemd/theme-kit` (pagemd-common, `layoutRunningContent`) and shown read-only (R-141).
  `scripts/pagination-reference.mjs` (`npm run pagination:reference`) stores pagemd's real PDF page counts; a
  Playwright benchmark checks typing speed on a 30-page document. Libraries: `@types/node` 24.19.1,
  `@types/vscode` 1.140.0 (manifest `^1.140.0`, test host VS Code 1.140.0), dependency-cruiser 18.5.0;
  pagemd-common vitest 5.0.3.
- Session 21, P6 Part 2 (same branch, not committed): Print Layout is now the default view. New views and commands:
  "pagemd: Print Layout", "pagemd: Read" (a read-only page or two-page spread, flipped by keys or clicks) and "pagemd:
  Switch View" (a list; the status bar's view name opens it). Print Layout draws each page's running header and footer
  (page numbers, running strings, first-page rules, left/right pages) read-only, and has rulers with margin, header and
  footer guides: dragging a margin creates the document's layout file, or rewrites its own one without a question (the
  status bar says so). The status bar shows "Page N of M" and zoom/fit and page-arrangement controls (pages can sit
  side by side). New packages `components/ruler` and `components/read-view`; `components/pagination` gained headers,
  side-by-side columns and zoom helpers (its measuring is unchanged).
- Session 21, P6 final review: the live TOC follows pagemd's own rules (R-148: deepest level from the directive or
  `toc_levels`, shallowest from the directive or `toc_min_level`, default 2; section scope; no frontmatter entries);
  `tocFields`/`tocPluginWith` in preset-pagemd; the benchmark runs in both page arrangements. Committed on
  `phase/p6-print-layout` (pagemd-editor, pagemd-common), not merged. Tests: editor 1390, e2e 72 (+5 parked),
  `test:vscode` passed, pagemd-common 1068, pagemd 1264.

### Fixed
- The table item's outline entry no longer fails on table rows and cells (found by P9's corpus test).

### Changed
- P10: the webview's CSP allows inline styles (Paged.js and mermaid need them; scripts stay nonce-only); postcss 8.5.29.
- C6: a ```` ```mermaid ```` example inside another code fence is no longer drawn by pagemd; pagemd's renderer registers its
  signal handlers only when it keeps a browser (`PAGEMD_KEEP_CHROME`).
- ADR-0003 Accepted (layered editor, ProseMirror core); ADR-0004 superseded by ADR-0010 (editor independent of pagemd).
- Session 3: rewrote `layered-architecture.md` and `roadmap.md` (track C + track P); resolved OQ-2, OQ-3,
  OQ-4 and OQ-7; opened OQ-8; marked `overview.md` §2/§4/§5 superseded.
- Session 4: ADR-0013 Accepted with changes (small host services, ribbon layout file); ADR-0011 amended to 5
  shared packages; OQ-8 resolved (the code's search order is the spec); OQ-9–11 opened.
- Session 5: phase plans C0, C1, C7, P0 and P1 approved, with corrections found by checking them against
  pagemd's code; ADR-0011 and ADR-0016 amended; ADR-0005 updated (pagemd-vscode maintenance-only, OQ-5
  resolved); P4 now adds the first pagemd-common link.
- Session 6: C0 marked Done with its acceptance and checkpoint results; C0's "move the old tests" step became
  "delete" (R-50); roadmap's run-order wording fixed to match R-49; dialect inventory notes how include paths resolve.
- Session 7: C1 marked Done with its acceptance and checkpoint results. The roadmap's progress line was
  updated. The `pagemd-common.md` item-module signature now reads `read(md, mode, options)` with `gate?`.
- Session 8: C7 marked Done. OQ-13 was resolved (R-56: profile defaults now beat built-in defaults), and
  pagemd's `build -p` is fixed (R-57). ADR-0016 is amended, the pagemd-common card is updated (`js` removed,
  new `layer()` order, gate cross-check), and C2 and C8 carry the C7 follow-ups (R-58, R-60).
- Session 9: P0 marked Done. The toolchain moved to Node 24 LTS (R-66; ADR-0012 amended). README and
  `.agents/rules.md` status now say "scaffold"; the rules file lists the commands and no longer points to
  the superseded `createDialect` convention.
- Session 10: markdown-it 14 → 15 across the project (R-70, supersedes R-47's 14.x pin); P1 amended (R-74,
  R-75; depends on U1); `.agents/rules.md` gains the newest-libraries rule, `deps:check`, Node 24 in all repos
  and the dev-branch model; ADR-0012 amended (U1 toolchain); roadmap, cohesion matrix, dialect inventory and
  14 phase plans updated for C9/P15 and the image-editor inventory; C6 now owns the real diagram fix (R-81).
- Session 11: U1 merged into `dev` (all three repos). P1 marked Done; ADR-0013 amended (final TypeScript,
  R-84) and ADR-0007 amended (as built, R-85); layered-architecture §4 points to the code; the cohesion
  matrix names the P1 items; P0's webview `require(` check ignores comments; README and `.agents/rules.md`
  status now say "headless core".
- Session 12: P1 merged into `dev`. The P0 `packageName` stub exports are removed; the layer rules cover
  `apps/vscode/shared`; a third TypeScript config (`tsconfig.web-tests.json`) types browser-code tests; the
  `vscode` test stand-in grew (documents, edits, webview panels); `test:vscode` passes `PMD_TEST=1`.
- Session 12: `.agents/orchestrator.md`, the orchestrator's standing prompt and an example worker brief (R-93);
  linked from `.agents/rules.md` and the docs index.
- Session 13/14: P3 approved (R-96) and marked Done (committed on `phase/p3-gfm`; merge into `dev` awaits the
  user's approval, R-98). `SyntaxItem.inputRules` changed from
  `InputRule[]` to `(schema) => InputRule[]` (ADR-0013 amendment; the field had no users since P1, so nothing
  else changed). `components/canvas` gained `pmPlugins` and `nodeViews` options. The frontmatter node moves to
  P8 (R-85 D unchanged); `yaml` 2.9.1 recorded there. The orchestrator may now group small phases into one
  worker run (R-97); a worker commits its own phase branch at the end of a phase (R-98).
- Session 15: C9 approved with amendments A-1 to A-12 (R-104) and built; the snapshot rule for C9 became "text
  identical, one style change" (R-103); figure numbering follows the wiki (R-101); the cover class stays `cover`
  (R-102). The session-14 handoff's "Next" (P4) is corrected: C9 → C2 + C3 → P4. P3 is merged into `dev`.
- Session 16: C9 marked Done and merged (R-105); its 6 additions kept (R-106; the "7" was a miscount). BREAK is
  treated as the code treats it, an unknown directive (R-107; OQ-28 opened); the dialect inventory and cohesion
  matrix no longer list BREAK, bare SECTION or bare COVER. C2 and C3 approved with amendments (R-108, R-109); R-58
  deferred to C4, the mermaid helpers to C6, the FIGURE pixels-to-crop conversion to P15.
- Session 17: P4 approved with amendments 1–14 (R-112) plus R-113–R-120; its 8 additions kept (R-119). Fixed: a
  document starting with a `---` rule (frontmatter) opened with the rule selected, so typing replaced it (R-120); the
  clipboard plugin failed to start with a preset that overrides an item. OQ-29 and OQ-30 opened. The transformer
  accepts an item list whose overrides are already applied; the webview bundle carries one markdown-it.
- Session 18: P4 merged into `dev` (R-121); C4 + C5 grouped (R-122) and approved as recommended (R-123, R-125); a
  profile may set `fancy_lists`/`highlight_theme` (R-124, revisits R-58). ADR-0014 amended (the default layout is
  pagemd's `letter.css`; pagemd's own layouts are never written), ADR-0011 and ADR-0016 notes. Opened OQ-31 (project
  config never read), OQ-32 (template fallback), OQ-33 (layouts searched as stylesheets).
- Session 19: C4 + C5 merged into `dev` in all three repos (R-126). P5's plan re-checked against the code and
  against C4/C5 as built (12 findings) and approved with amendments 1–13 (R-127–R-135, docs only, no code in any
  repo): a structured `RunningContent` header/footer and layout metadata on `ResolvedStyles` (ADR-0013 amendment);
  pagemd's bundled profiles/layouts/styles/templates mirrored into `@pagemd/theme-kit`'s `defaults/` (a
  pagemd-common change, R-128, so P5 now touches pagemd-common too); a per-document profile links a new layout file
  (resolves OQ-33, R-129/R-130); Web Layout light like the PDF and the default view from P5 (R-131/R-132);
  acceptance criteria replaced (R-133); book-wiki's `book.css` confirmed bundled, ADR-0014/C5.md corrected (R-134).
  New open questions OQ-34 (per-document colour scheme) and OQ-35 (header/footer written directly in a layout file,
  for P6).
- Session 20: P5 marked Built (not yet merged; needs the user's approval, R-68/R-98). ADR-0013's `onChange`/
  `stylesChanged` wording corrected to match what was built (no re-fetch, R-139); ADR-0014 amended again (the
  per-document profile is named `<doc>.doc`, R-138, correcting the session-19 amendment's `<doc>`); the
  pagemd-common package cards (resolver, theme-kit) updated for R-136 and R-128. `docs/product/vision.md`'s View
  model section needed no change (session 19 had already written it to match). New open questions OQ-36, OQ-37.
