# Cohesion Matrix: Every Item × Every View and Control

> **Status:** Draft v1 (session 3, 2026-09-26); pagemd rows as built in P4 (session 17, 2026-09-29); Print Layout and Read columns as built in P6 (session 21, 2026-10-03); Ribbon, Slash and Toolbar columns and §3/§4 as built in P7 (session 22, 2026-10-04); Code and Split columns, the Outline panel and the native Outline as built in P9 (session 24, 2026-10-04); footnote and task-list rows as built in P26 (session 45, 2026-10-24); FIX-PGF's Word-style table and picture tools (session 46, 2026-10-25); picture rows, the Image tab and its commands as built in **P27** (session 49, 2026-10-25). Update it whenever an item, view or control is added ·
> **Index:** docs/README.md · **Moved here** from `docs/architecture/` in SAN-0b (2026-11-02): two tests read it, so it lives with the tests and a public copy of the repo can run them · **Related:** layered-architecture.md,
> dialect inventory, vision

This is the "nothing is missed" checklist. **Every syntax item needs a row.** A new item without a row
fails the cohesion checkpoint at the end of a phase.

**How to read it:**
- **Canvas** = how it looks in Print Layout, Web Layout, Draft and Read. They share one node view, and
  only the styles differ. Differences are noted.
- **Code** = Code view and the code half of Split. It always shows raw text colored from token ranges.
- **Preview** = Print Preview/Export (exact pagemd render).
- **Ribbon** tab abbreviations: **H**ome, **I**nsert, **L**ayout, **D**ocument, **R**eview, **V**iew.
- ✓ = present; — = not applicable.

## 1. Items

### CommonMark (`preset-commonmark`, group `core`), phase P1
**Built in P1** as 13 items (`packages/preset-commonmark/src/items/`): `paragraph`, `heading`, `emphasis` +
`strong` + `code` (the marks row), `link`, `image`, `blockquote`, `lists` (bullet and numbered), `code_block`
(fenced and indented rows), `horizontal_rule`, `hard_break`, `html` (block and inline). P1 items carry labels, icons,
slash keywords and the heading outline; **P7 gave them commands**, so the Ribbon, Slash and Toolbar columns are real
(the exact command ids are in §4, checked by `apps/vscode/test/cohesion-surfaces.test.ts`). **P8** gave the Inspector column fields (heading level, link address and tooltip, image, list start/bullet/compact, code-block language, inline HTML read-only; `{…}` attributes come from pagemd's `attributes` item), tested in `packages/preset-pagemd/test/fields.test.ts`.
| Item | Node/mark | Canvas | Ribbon | Slash | Toolbar | Inspector fields | Outline |
|---|---|---|---|---|---|---|---|
| Paragraph | node | text | H: Styles ▾ | ✓ "Text" | — | attrs `{}` | — |
| Heading 1–6 | node | profile heading | H: Styles ▾ | ✓ "Heading 1…6" | ✓ H▾ | level, id, attrs | ✓ tree |
| Bold / italic / inline code | marks | styled | H: Bold, Italic, Code | — | ✓ | — | — |
| Link | mark | link | I: Link | ✓ | ✓ | href, title | — |
| Image (plain `![]()`) | node | image | I: Image · Image tab (P20; **P27**: Shapes and Redact make it an annotated image, Crop/Rotate/Flip/Size/Caption a FIGURE, inside their own undo step; a picture in a sentence is put on its own line first; in a table cell or heading they are off with the reason) | ✓ | — | src, alt, title | — |
| Blockquote | node | quote | H: Quote | ✓ | ✓ | attrs | — |
| Bullet / ordered list | node | list | H: Bulleted list, Numbered list | ✓ | ✓ | start, tight | — |
| Code fence | node | code block (CodeMirror inside) | I: Code block | ✓ | — | language | — |
| Indented code block (4 spaces) | node | code block (CodeMirror inside) | — (insert as a fence) | — | — | — | — |
| Horizontal rule | node | rule | I: Horizontal line | ✓ | — | — | — |
| Hard break | node | line break | — | — | — | — | — |
| HTML block / inline | node | raw chip | — | — | — | raw source | — |

### GFM (`preset-gfm`), phase P3
| Item | Node/mark | Canvas | Ribbon | Slash | Toolbar | Inspector fields | Outline |
|---|---|---|---|---|---|---|---|
| Table (basic) | node | table | I: Table (Insert Table only: GFM's table gets no tools, AD-P16-01; the app always uses the pagemd table below) | ✓ | — | align per column | ✓ |
| Strikethrough | mark | struck | H: Strikethrough | — | ✓ | — | — |
| Autolink | mark | link | — | — | — | href | — |
| Alert `> [!NOTE]` etc. (with pagemd: read by `@pagemd/syntax`'s `github-alerts` item, which replaces this one, P4; both give the same `alert.<kind>` commands) | node | colored box | I: Callout ▾ | ✓ | — | kind | ✓ |

### pagemd (`preset-pagemd`, from `@pagemd/syntax`), phase P4
**Built in P4** (session 17): one item per row, named in the last column (`packages/preset-pagemd/test/cohesion.test.ts`
checks this table against the registry: every item has a row, every named item exists, and a ✓ under Slash or Outline
means the item has slash keywords or an outline entry). **P7** added the commands: `apps/vscode/test/cohesion-surfaces.test.ts`
checks the Ribbon (the tab letter), Slash and Toolbar columns of this table against the registry and the shipped layout
file. **P8** built the Inspector column: `apps/vscode/test/cohesion-surfaces.test.ts` checks it item by item (a cell that starts with "—" means the item has no Element fields, any other cell means it has some; the frontmatter's are the Document tab's). P4 gave each item its node, canvas look (the renderer's classes, I3),
writer, label, icon, slash keywords and outline entry.
| Item | Group | Node/mark | Canvas (Print/Web/Draft/Read) | Ribbon | Slash | Toolbar | Inspector fields | Outline | Item id |
|---|---|---|---|---|---|---|---|---|---|
| Attributes `{.class #id k=v}` | text | attrs on other items' nodes (ADR-0013 amendment, R-114): heading, paragraph, fence, image, link; anywhere else the block stays raw | invisible; class, id and an image's size applied | — | — | — | Element tab: classes, id, key/values | — | `attributes` |
| Wikilink `[[Page]]` | text | node (inline atom, R-117; not a mark: escapes don't read back inside `[[…]]`) | link styled `.wikilink` | I: Wikilink | ✓ | ✓ | target, display | — | `wikilinks` |
| Footnote `text[^1]`, `^[inline note]`, `[^1]: note` (**P26**, R-245; markdown-it-footnote 4.0.0 in `@pagemd/syntax`) | text | reference: node (inline atom, `pmd_footnote_ref`); note: node (block wrapper, `pmd_footnote`), kept where it is written | reference: pagemd's raised `[1]` (`.footnote-ref`), numbered by first reference as pagemd numbers them (`[2:1]` for a second reference), a click goes to the note; note: its number, its text (editable) and the back-link `↩︎` to the first reference, drawn where it is written (pagemd's PDF prints the notes at the end of the document; Word at the page bottom, not built). A reference with no note or a note nothing refers to is underlined in the warning color with the reason as its tooltip. Deleting a reference deletes its note in the same change (Word; a cut keeps it) | I: Footnote (no shortcut: Word's Ctrl+Alt+F is a VS Code default, OQ-59): a reference at the cursor and a numbered note at the end of the document, one change, the cursor in the note | ✓ | — | reference: label; inline note: its text; note: label | — | `footnotes` |
| Inline badge callout | text | node (inline) | badge | I: Callout ▾ (badges) | ✓ | — | kind | — | `inline-callout` |
| Inline `INDEX` term | text | node (inline, atom) | small chip | R: Mark index entry | ✓ | ✓ | term, sort as | — | `index-marker` |
| Fancy list `a.` `A.` `i.` `I.` | lists | attrs on CommonMark's ordered list | lettered/roman list. **Gate:** needs `fancy_lists: true` in the frontmatter (R-58); inserting follows the ask/auto/warn setting; without it, a hint says "will print as numbers" | H: list ▾ | ✓ | — | marker type, delimiter (the start is the list's own field, CommonMark's) | — | `fancy-lists` |
| Task list `- [ ]` / `- [x]` (**P26**; our own rule in `@pagemd/syntax`, markdown-it-task-lists 2.1.1's HTML) | lists | attrs on CommonMark's list item (`pmdTask`: the box as written) | pagemd's classes (`task-list-item`, `contains-task-list`: no bullet) and a checkbox in front of the text; a click ticks or clears it (one change: one character of the file, the rest of the list as written, through the item's `patch` rule); off in Read and wherever the canvas can't be edited; the box's accessible name is the item's text. `[ ] ` typed at the start of a list item makes it a task | H: Checklist (its own Tasks group: the Lists group would pass six buttons and fold into a menu) | ✓ | — | Done (the keyboard's way to tick a box) | — | `task-lists` |
| Multimd table (colspan, rowspan, multiline, headerless) | tables | node (overrides GFM table; prosemirror-tables names and cell roles). Multi-line rows (**P16**): held when each multi-line cell is one paragraph, any other multi-line cell or a row the reader misreads (text-loss check) stays raw | table, with cell selection (P16) | I: Table · T: Table tab (rows, columns, cells, align, width, delete; 24 commands; column borders dragged or double-clicked on the canvas, P19) | ✓ (Insert only) | — | caption (add, remove, kind, above/below), columns (alignment, wrap; width, **P19**, written in the hidden `<!-- ::TABLE -->` comment), **P24**: Split on a plain cell adds a column (the other rows get a double-pipe span, the column's width is halved), `{…}` id, classes, other attributes (**P16**); a table kept raw says why its tools are off (**P19**); a table not in standard form: **FIX-FT** (session 44, Word's way): short rows are drawn as pagemd draws them and kept byte for byte until the table is edited; every tool, the Inspector and a border drag work, and the first edit adds the missing empty cells in the same undo step (the P19 round-3 Fix / Dismiss bar is gone); only a table whose cells overlap keeps its tools off, with the reason in the tooltips | ✓ | `multimd-table` |
| Table caption | tables | part of the table (the table model) | caption | — (the caption is edited in the Inspector, P16) | — | — | caption text, kind, above/below (**P16**) | ✓ | `multimd-table` |
| `:::` containers ×15: details, summary, aside, columns, spoiler, warning, caution, note, important, tip, document-header, title-block, applicability-box, approval-block, footer-notice | blocks | one node (`name` attribute) | styled box by profile | I: Box ▾ (all 15) | ✓ each | — | kind, title | ✓ boxes | `containers` |
| `::: {attrs}` attribute container | blocks | node | styled div | I: Box ▾ "Custom" | ✓ | — | classes, id, attrs | — | `attribute-container` |
| GitHub alert `> [!NOTE]` … `[!CAUTION]` (replaces preset-gfm's `alert`, amendment 6) | blocks | node | pagemd's `markdown-alert` box | I: Callout ▾ | ✓ | — | kind, title | ✓ | `github-alerts` |
| `[[WARNING]]` / `[[DANGER]]` callout | blocks | node | callout box | I: Callout ▾ | ✓ | — | kind | ✓ | `callouts` |
| `<!-- ::FIGURE -->` | media | node (atom; caption in its data) | pagemd's own figure HTML; "Figure N:" numbered live (no caption: no number, C9); **P27**: the crop in any unit, `rotate`, `flip` drawn as pagemd draws them (a quarter turn sized from the picture as the browser shows it) | I: Figure · Img: Image tab (P20: Size, Remove caption; P27: Edit picture; Add shape and Redact make it an annotated image keeping every key) | ✓ | — | src (Browse…), caption, id, width, crop-x/crop-y/pos-x/pos-y, rotate, flip and every other FIGURE parameter | ✓ figures | `figure` |
| Annotated image | media | node (atom) | pagemd's own renderer (D1) with its structural CSS (D18, R-116): image + markers, arrows, boxes, text; **lines, ellipses, highlights (C9, R-80)**; P15 (ADR-0018, R-194): shape editing on its own overlay (double-click or Enter; drag, handles, Tab, arrow keys, Delete, Esc), one change and one undo step per drag or nudge. **P27** (one unified picture, R-248): the crop (a window, any unit), `rotate`, `flip`, marker `size`/`showLabel` drawn as pagemd draws them; `redact:` drawn as **opaque black boxes** (editor mode, never the picture uncovered; dragged like a shape); "N shapes hidden by the crop" under the picture | I: Figure ▾ · Img: Image tab (P20: Shapes, Size, Caption; P27: Edit picture) | ✓ | — | markers (with Size and Show label), arrows, boxes, text, lines, ellipses, highlights, redact (Redactions), options (caption, id, alt, width, link, class, markerColor, legendColumns, crop-x/crop-y/pos-x/pos-y/crop-fit, rotate, flip, showLabels); shape fields per `params` (A6, with a `color` type); rows hidden by a crop marked "Hidden by the crop" | ✓ numbered only with a caption, one counter with FIGURE (C9) | `annotated-image` |
| Image editor commands (P15; **P27**) | media | commands on image items | **P27** (ADR-0019, keys in the markdown, no file written): Crop (Word's crop mode: handles, drag the picture, Enter or a click away keeps, Esc cancels; `crop-*`/`pos-*` in %) · Rotate left/right · Flip H/V (`rotate`/`flip`; shapes, redactions and a % crop move in the same step) · Redact (a rectangle in `redact:`; the note on the first one) · Reset picture; Shapes (Add marker … Add highlight, Renumber markers; any picture converts automatically, R-248). No Convert | Img: the Image tab (P20; P27: Shapes, Edit picture as buttons, folded only when narrow) | — | — | the selected shape's list row is marked in step with the canvas | — | — (P15: the app and `annotated-image`) |
| `![[image.png]]` embed | media | node (inline atom) | image | I: Image · Image tab (P20: Alt text, Change picture; **P27**: Edit picture and Shapes make it a FIGURE or an annotated image in their own step) | ✓ | — | path (Browse…), alt text | — | `embeds` |
| Mermaid fence | media | CommonMark's code block | code block labelled "Diagram"; drawn (P10) in Print Layout, Web Layout and Read, the source shown while the cursor is in it | I: Diagram | ✓ | — | — (the code block's language, CommonMark's; the source is edited on the canvas) | — (P9: a code block gives no outline entry) | `mermaid` |
| `PAGEBREAK` | page | node (atom) | **Print/Read:** real page break (P6); **Web/Draft:** dashed line chip | L: Break | ✓ | — | — | — | `pagebreak` |
| Unknown directive (e.g. `<!-- ::BREAK -->`, R-107), or a directive written where its item has no node | page / text | node (atom, block or inline) | chip showing the directive; written back as written | — | — | — | raw source | — | `unknown-directive`, `inline-directive` |
| `<!-- ::COMMENT id="c7" -->` review-comment anchor (**P12**, R-179) | page | node (atom, block form; written in a line of text it is a generic directive that is read, listed and tinted but never made) | takes no room on the page (a hidden marker with a small flag at the block's corner); the block below it is tinted; saved as one tight line above the block | — (the app's Review ▸ Comments buttons, §4) | — | — | — (the thread is edited in the Comments panel) | — | `comment-anchor` |
| `SECTION_START/END` | page | start and end markers (atoms; not a wrapper, P4 amendment 8) | section chips; the band and "starts a page" in Print (P6) | L: Section | ✓ | — | CSS class, id | ✓ sections | `section` |
| `COVER_START/END` | page | start and end markers (atoms) | cover chips (Print/Read: own page, P6) | L: Cover | ✓ | — | — (@pagemd/syntax gives COVER no parameters) | ✓ | `cover` |
| `TOC` | page | node (atom) | live heading list, page numbers "…" until Preview | D: Table of contents | ✓ | — | levels, min, page numbers, page-number levels, section | ✓ | `toc` |
| Block `INDEX` | page | node (atom) | index placeholder | D: Index | ✓ | — | — (@pagemd/syntax gives the block INDEX no parameters) | ✓ | `index` |
| `LAYOUT` | page | node (atom) | chip; Print: switches page geometry from here | L: Page layout ▾ | ✓ | — | name (the layout's named pages offered, AD-P7-10) | — | `layout` |
| `<!-- ::INCLUDE path -->` placeholder | document | node (atom) | include placeholder chip | I: Include | ✓ | — | path (Browse…) | — | `include-directive` |
| Frontmatter | document | `pmd_frontmatter` node (preset-pagemd, P8: only pagemd's packages may use `@pagemd/*`); fields from `@pagemd/meta` | document-properties card: required (profile) vs "shown on page" (template) hints; nicknames kept | — (the app's Properties button on the Document tab, `document.properties`, §4) | — | — | **Document tab** form + raw YAML | title as root | `frontmatter` |
| `!!!include(path)!!!` | document | node (atom) | box showing the path, "Open" (Ctrl/Cmd+click); the included file's text needs a host service (later, ADR-0013 change; P22). Since C12 the renderer expands exactly what the editor makes an atom (a line that is only the include, outside code), with the included file's frontmatter removed, its image paths rebased, a page type it leaves open closed, and a visible note for a missing or circular include; the rules are `@pagemd/syntax`'s `include-rules.js`, for the canvas to reuse | I: Include file | ✓ | — | path (Browse…) | ✓ | `include` |

### Core safety net, phase P3
| Item | Node | Canvas | Controls |
|---|---|---|---|
| Anything unmodelled | `raw_block` | raw-block-editor (inline CodeMirror), written back verbatim | Inspector shows raw source |

### Picture rows after C13 + P27 (built in session 49)
The rows above are as built since P27 (ADR-0019, R-248–R-252). Redaction stays
**provisional** (OQ-61). The editor's own HTML fallback (`output-html`) refuses a document with redactions; Print Preview and Export use pagemd's bake (C13).

### Later
Nothing is left here: the review-comment anchor was built in **P12** (its row is in the pagemd table above; the Comments panel is in §2 and
the Review tab's buttons in §3 and §4).

**Every row:** Code view shows the raw source; Print Preview/Export shows pagemd's exact render (when
`output-pagemd` is present; otherwise plain HTML).

## 2. Views × panels and controls

| | Print Layout | Web Layout | Draft | Read | Code | Split | Print Preview |
|---|---|---|---|---|---|---|---|
| Styles | profile | profile | VS Code theme | profile | VS Code theme (**P9**: colored by block, from the canvas's block ranges) | both (**P9**: the canvas half styled like Web Layout) | exact |
| Paper pages | ✓ approx. (**P6**: measured from the canvas, page count within ±1 of pagemd's body pages for 9 of 15 corpus examples) | — | — | ✓ approx. (**P6**: one page or a two-page spread at a time) | — | — (**P9**: the canvas half has no pages, AD-P9-05) | ✓ exact |
| Editable | ✓ | ✓ | ✓ | — (**P6**: `Canvas.setEditable(false)`; text stays selectable) | ✓ text (**P9**: sent after a pause, VS Code's undo) | ✓ (**P9**: both sides; cursors kept in the same block) | — |
| Ribbon | ✓ | ✓ | ✓ | View tab only | View + Document tabs | ✓ | View + Document tabs |
| Slash menu / selection toolbar | ✓ | ✓ | ✓ | — | — | canvas half | — |
| Inspector | ✓ | ✓ | ✓ | read-only | ✓ Document tab | ✓ | — |
| Outline panel | ✓ | ✓ | ✓ | ✓ (jump, **P9**: turns to the entry's page) | ✓ (jump) | ✓ | ✓ (jump) |
| Ruler + guides | ✓ (**P6**: horizontal + vertical rulers, margin handles, margin/header/footer guides on the paper; a drag ends in a layout file) | — | — | — (**P6**: none, the page is the view) | — | — | — |
| Running headers and footers | ✓ (**P6**, read-only, from each page's layout data) | — | — | ✓ (**P6**, same drawing) | — | canvas half | ✓ exact |
| Zoom / fit / page arrangement | ✓ (**P6**: status bar; vertical or side by side) | — | — | fit always (**P6**: vertical = one page, side by side = a spread) | — | — | — |
| "Page N of M" | ✓ (**P6**) | — | — | ✓ (**P6**, the left page of the spread) | — | — | — |
| "Using default layout" note | ✓ | ✓ | — | ✓ | — | — | ✓ |
| Comments panel (**P12**, R-181) | ✓ | ✓ | ✓ | ✓ (reads only: no new comment, reply, resolve or delete) | — | canvas half | — |
| Files in Use panel (**P25**, R-242) | ✓ | ✓ | ✓ (files; "where from" off: Draft has no profile look) | ✓ | ✓ (files; "where from" off) | ✓ | ✓ (files; "where from" off) |
| Native VS Code Outline | pagemd's items (title, figures, tables, boxes, TOC, includes) from the host's `DocumentSymbolProvider` (**P9**); VS Code shows its Outline view for text editors only, so it fills when the file is open in the text editor (AD-P9-03) |||||||
| Find and replace bar (**P11**) | ✓ | ✓ | ✓ | find only (the canvas pane takes the key; no replace row) | VS Code's own find (the bar closes when Code shows) | canvas half | VS Code's own find |
| Paste / drop a picture (**P11**) | ✓ | ✓ | ✓ | — (nothing is delivered to a read-only canvas) | — | canvas half | — |
| Status bar | ✓ in every mode |||||||
| Problems panel (`plugin-diagnostics`, **P14**, R-189) | ✓ in every mode, **only when the profile has a `validation` block** (ADR-0017); `pagemdEditor.showProblems` can only hide |||||||
| Problem hints on the canvas (**P14**) | ✓ | ✓ | ✓ | ✓ | — (VS Code's Problems panel only) | canvas half | — |

### Print Layout and Read, item by item (P6, as built)
Every item not listed here looks and edits the same in Print Layout and Web Layout, styled by the profile CSS (print
rules under `.pmd-print`); in Read it looks the same and cannot be edited. The page-related items are different:

| Item | Print Layout | Read |
|---|---|---|
| `PAGEBREAK` | an exact new page (the chip takes no height) | the same page break |
| `SECTION_START/END` | starts a page when the profile's section class says so (a probe element decides); chips take no height | the same |
| `COVER_START/END` | its own page when the profile says so | the same |
| `LAYOUT(name)` | the pages after it use the named page's size and margins (named-page width on the canvas) | the same (side by side: every page uses the base page's size) |
| `TOC` | live heading list (its own height decides the pages; an over-tall one is one flagged page) | the same |
| Frontmatter | shown at the top of page 1, outside the page's own height | hidden (also hidden while pages are side by side) |
| Header, footer, `first_page`, `page_numbers` | drawn read-only in each page's top and bottom margin: `:::PAGE`, `:::PAGES`, `:::STRING(name)`, first-page rules, inside/outside by page side; a layout's own box text wins (R-147) | the same |
| Named-page headers and footers (P21) | a page type's own boxes (`@page wide { @top-left … }`) over the plain page's, box by box; `@page wide:first` on the first page of each run of the type; `none` clears, `var()` takes the document's property; a note (status bar) and a tag above each sheet whose size pagemd's PDF does not print (until C11) | the same boxes and the note, no tag |
| Index-marker chips and other inline directives with no output | take no width | the same |
| Images | the page waits for them to load; a very tall one gets a page of its own, flagged | the same |

## 3. Ribbon tabs → where their buttons come from
Items declare **commands**; the app's `apps/vscode/webview/ribbon.layout.json` places them
(ADR-0013, P7). A command the layout doesn't place appears in a **More**
tab, so nothing is unreachable (with all three presets nothing lands there; a test checks it). A button whose command
doesn't exist (its preset is absent) is simply not drawn, and a group or tab left empty disappears. A group with more
than six commands is drawn as one drop-down button.

| Tab | Groups, as built in P7 | Commands come from | Still to come |
|---|---|---|---|
| Home | Text (bold, italic, code, strikethrough) · Styles ▾ (text, headings 1–6) · Lists (bulleted, numbered, lettered and Roman) · **Tasks (Checklist, P26)** · Blocks (quote) · **Editing** (Find, Replace: P11, `kind: 'view'`, Ctrl/Cmd+F and Ctrl/Cmd+H) | presets, the app (`findActions`) | |
| Insert | Basics (table, link, wikilink, code block, diagram, line) · **Notes (Footnote, P26)** · Pictures (image, embedded image, figure, annotated image) · Box ▾ (15 boxes + custom) · Callout ▾ (alerts, block and badge callouts) · Include. (P15's Image tools, Shapes and Convert were here until **P20** moved them to the Image tab) | presets | |
| Table | **P16**: Rows (add above/below, delete, move up/down) · Columns (add left/right, delete, move left/right) · Cells (merge, split, header row; **P24**: Split on a plain cell adds a column, on a merged cell takes it apart) · Align (left, centre, right, none) · **Width (P19: wider, narrower, equal, automatic, fit)** · Table (even out rows, P19; delete). Always shown; its buttons are off outside a pagemd table (and in one whose cells overlap; a table with short rows has them on, FIX-FT), as P15's Image tools (R-201) | presets (`multimd-table`) | |
| Image | **P20**, contextual: **in the strip only while a picture is selected** on the canvas (a plain image, an embed, a figure, an annotated image), brought forward then; the earlier tab comes back when the picture is unselected (a tab picked by hand is kept); never in Read, Print Preview or Code. **P27** (R-252): Shapes (add marker … highlight, renumber; buttons) · Edit picture (crop, rotate left/right, flip H/V, redact, reset picture; buttons) · Size (full, half, third, quarter, original: pagemd's own `width`) · Caption (edit: the Inspector's caption box; remove) · Details (alt text, change picture: the Inspector's boxes; properties). Shapes and Edit picture have `"menu": false` (more than six commands, still buttons); P17's fold folds them into a drop-down only when the ribbon is too narrow (Details first, then Caption, Size, Shapes, Edit picture). No Convert (R-248) | the app (`image-tools.ts`), presets (`figure`: Size, Remove caption; `annotated-image`: Shapes) | |
| Layout | Break · Section · Cover · Page layout | presets | margins stay on the ruler (P6) |
| Document | Properties (P8: opens the Inspector's Document tab) · Contents (table of contents, index) · **Files: Files in Use (P25, the `link` icon; the panel on the right)** | the app (Properties, Files in Use), presets | Output: Print Preview, Export PDF/HTML/PNG (built P10) · Profile (built P10) · Check: Check Document (built P14, `pagemd.checkDocument`) |
| Review | **Comments** (P12: New comment, Reply, Resolve, Previous, Next) · Index (mark index entry) | the app (`comments.*`, `view-actions.ts`), presets | |
| View | View (Print Layout, Web Layout, Draft, Read) · Pages (vertical, side by side) · Zoom (fit, zoom in/out, 100 %) · Show (outline, ruler, Inspector, Comments) | the app's view commands (`view-actions.ts`) | Code, Split, Print Preview, panels (P9, P10) |
| More | anything not placed in the layout file | automatic | |

In Read the ribbon shows the View tab only; the `/` menu and the floating toolbar work in the editing views only.

## 4. Commands by surface (P7, as built)
Every command the three presets and the app declare, with the surface each one appears on. **Checked by
`apps/vscode/test/cohesion-surfaces.test.ts`**: the table names exactly the commands that exist (`name.*` means every
command starting `name.`), the Ribbon column is the tab the shipped layout puts it in, and a ✓ is exactly what the
registry gives the slash menu and the selection toolbar. Shortcuts are in the commands themselves (`keybinding`); a
test checks that no two commands share one.

**Keys that are not commands (P13b, R-208):** F6 / Shift+F6 (`apps/vscode/webview/regions.ts`) move the focus between the ribbon, Outline, page (or Code view, or
Print Preview), Comments, Inspector, Files in use (P25) and status bar, in screen order, and are left to VS Code past the first and last region. They shadow VS Code's
`workbench.action.focusNextPart` / `focusPreviousPart` while the focus is in the editor; `test:vscode` checks that those two defaults still exist. The Tab order
is the DOM order (ribbon, Outline, page, Comments, Inspector, status bar); the ribbon's buttons are one Tab stop with arrow keys.

| Command | Item | Ribbon tab | Slash | Toolbar |
|---|---|---|---|---|
| `paragraph.set` | `paragraph` | home | ✓ | — |
| `heading.h1` · `heading.h2` · `heading.h3` | `heading` | home | ✓ | ✓ |
| `heading.h4` · `heading.h5` · `heading.h6` | `heading` | home | ✓ | — |
| `strong.toggle` · `emphasis.toggle` · `code.toggle` | `strong` · `emphasis` · `code` | home | — | ✓ |
| `strikethrough.toggle` | `strikethrough` | home | — | ✓ |
| `blockquote.toggle` | `blockquote` | home | ✓ | ✓ |
| `lists.bullet` · `lists.ordered` | `lists` | home | ✓ | ✓ |
| `fancy-lists.*` | `fancy-lists` (gated: `fancy_lists`) | home | ✓ | — |
| `code_block.toggle` | `code_block` | insert | ✓ | — |
| `rule.insert` | `horizontal_rule` | insert | ✓ | — |
| `link.insert` | `link` | insert | ✓ | ✓ |
| `image.insert` | `image` | insert | ✓ | — |
| `table.insert` | `table` (GFM) / `multimd-table` | insert | ✓ | — |
| `table.add-row-above` · `table.add-row-below` · `table.delete-row` · `table.move-row-up` · `table.move-row-down` · `table.add-column-left` · `table.add-column-right` · `table.delete-column` · `table.move-column-left` · `table.move-column-right` · `table.merge-cells` · `table.split-cell` · `table.header-row` · `table.align-left` · `table.align-center` · `table.align-right` · `table.align-none` · `table.delete` | `multimd-table` (P16: the Table tab; keys Tab, Shift+Tab, Enter are the table plugin's, not registry keybindings). **FIX-PGF** (Word's way): Move row / column next to a merged cell moves the rows (columns) the cell ties together as one block; Header row works on a one-row table too (a header row and no body, or headerless: both read back) | table | — | — |
| `table.column-wider` · `table.column-narrower` · `table.equal-widths` · `table.reset-widths` · `table.fit-column` · `table.fill-rows` · `table.fill-rows-split` | `multimd-table` (**P19**: the Table tab's Width group, and Even out rows in its Table group; a column border can also be dragged on the canvas, or double-clicked to fit, and the Inspector's Columns list has Width (%)). **FIX-PGF**: in a merged cell or a selection of columns, Wider / Narrower / Fit change the first column it covers, traded with the column just outside it; off with the reason in a one-column table and with every column selected | table | — | — |
| `wikilinks.insert` | `wikilinks` | insert | ✓ | ✓ |
| `footnotes.insert` | `footnotes` (**P26**) | insert | ✓ | — |
| `task-lists.toggle` | `task-lists` (**P26**) | home | ✓ | — |
| `mermaid.insert` | `mermaid` | insert | ✓ | — |
| `embeds.insert` | `embeds` | insert | ✓ | — |
| `figure.insert` · `annotated-image.insert` | `figure` · `annotated-image` | insert | ✓ | — |
| `figure.make-readable` | `figure` (readable figures, R-255: every FIGURE in the document written as `![alt](src "caption")` plus at most one comment line; one undo step) | insert | ✓ | — |
| `annotated-image.add-marker` · `annotated-image.add-arrow` · `annotated-image.add-box` · `annotated-image.add-text` · `annotated-image.add-line` · `annotated-image.add-ellipse` · `annotated-image.add-highlight` · `annotated-image.renumber` | `annotated-image` (P15; P20: Image ▸ Shapes; **P27**: buttons; on any picture, converting it in the same undo step, R-248; off with the reason in a table cell or heading) | image | — | — |
| `image.crop` · `image.rotate-left` · `image.rotate-right` · `image.flip-horizontal` · `image.flip-vertical` · `image.redact` · `image.reset` | (the app, **P27**: Image ▸ Edit picture; keys in the markdown, one undo step each, **no file written** (R-249; P15's pixel edits are gone); Crop is Word's crop mode; Redact adds a rectangle to `redact:` with the note on the first one; Reset picture removes the crop, turn, flip and redactions, shapes back exactly. A plain picture becomes a FIGURE (an annotated image for Redact); one in a sentence is put on its own line first (FIX-PGF's split, moved here); off with the reason in a table cell or a heading) | image | — | — |
| `picture.width-full` · `picture.width-half` · `picture.width-third` · `picture.width-quarter` · `picture.width-original` · `picture.caption-remove` | `figure` (**P20**: Image ▸ Size and Caption; pagemd's own `width` and `caption` on a FIGURE or an annotated image, one edit each; off for a plain image or an embed) | image | — | — |
| `picture.caption` · `picture.alt` · `picture.path` · `picture.properties` | (the app, **P20**: Image ▸ Caption and Details; they open the Inspector on the selected picture's box) | image | — | — |
| `containers.*` · `attribute-container.insert` | `containers` · `attribute-container` | insert | ✓ | — |
| `alert.*` | `alert` (GFM) / `github-alerts` | insert | ✓ | — |
| `callouts.*` · `inline-callout.*` | `callouts` · `inline-callout` | insert | ✓ | — |
| `include.insert` · `include-directive.insert` | `include` · `include-directive` | insert | ✓ | — |
| `pagebreak.insert` · `section.*` · `cover.*` · `layout.*` | `pagebreak` · `section` · `cover` · `layout` | layout | ✓ | — |
| `toc.insert` · `index.insert` | `toc` · `index` | document | ✓ | — |
| `index-marker.insert` | `index-marker` | review | ✓ | ✓ |
| `file.save` · `history.undo` · `history.redo` | (the app, **FIX-S50 / OQ-67**: Save, Undo, Redo, VS Code's own commands, first group of Home) | home | — | — |
| `document.properties` | (the app: opens the Inspector's Document tab, P8) | document | — | — |
| `document.files-in-use` | (the app, **P25**: opens and closes the Files in Use panel: every file that builds the document, in priority order, and where the block at the cursor gets its look from; read-only) | document | — | — |
| `comments.*` | (the app: New comment, Reply, Resolve, Previous, Next; P12, R-181) | review | — | — |
| `view.*` | (the app) | view | — | — |

Items without commands (by design): `attributes`, `html`, `hard_break`, `autolink`, the unknown-directive items,
`raw_block` and the `frontmatter` card (P8: its properties are the app's `document.properties` button). The image-editor commands came with P15 (R-150,
R-194: Insert ▸ Image tools, Shapes, Convert; **P20 moved them** to the Image tab and added Size, Caption and Details; **P27** removed Convert and made Edit picture keys in the markdown); table editing came with **P16** (R-198–R-202: the Table tab, 18 commands).
