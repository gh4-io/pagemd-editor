# pagemd Editor

A Word-like, page-accurate visual editor for [pagemd](https://github.com/gh4-io/pagemd) documents inside VS Code. You write
on pages that already look like the final PDF, with no raw syntax required. Every save changes only what you edited: the rest of
the file is written back byte for byte, so a `git diff` shows just your edit.

This is a test build (release candidate `0.0.1-rc.N`), installed from a local `.vsix` file (it is not on the Marketplace). To see which build you have, look at the version in the Extensions view, run **pagemd: About this build**, or read the small `pagemd 0.2.0-rc.N` item in the status bar while a pagemd editor is open.

## Install
1. In VS Code 1.140 or newer: Extensions view, the `...` menu, **Install from VSIX...**, and pick `pagemd-editor-<version>.vsix`.
   (Or run `code --install-extension pagemd-editor-<version>.vsix`.)
2. Reload VS Code if it asks.

## Open a document
- Right-click a `.md` file, **Open With...**, **pagemd Editor**. Or run **pagemd: Reopen with pagemd Editor** for the file you
  have open.
- VS Code can choose an editor only by file name, not by what is inside a file. To open some files in pagemd Editor by themselves,
  list their patterns (for example `*.pagemd.md` or `docs/**/*.md`) in the setting `pagemdEditor.openByDefault`.

## What you can do
- **Views** (the View tab, the status bar, or the commands "pagemd: Print Layout / Web Layout / Draft / Read / Code / Split"):
  Print Layout (paper pages with a ruler, the default), Web Layout, Draft (plain editing in your VS Code theme), Read (a
  read-only page-flip view), Code (the source, colored by block) and Split (code and page side by side). **pagemd: Print Preview**
  shows the exact rendering.
- **Ribbon** (Home, Insert, Table, Layout, Document, Review, View), the **`/` slash menu** (type `/` to insert anything) and the
  floating bar when you select text. Keys: Ctrl/Cmd+B bold, I italic, E code, K link, Alt+0 to 6 text and headings.
- **Panels:** Outline (drag a heading to move its section), Inspector (the selected item's attributes and the document's
  frontmatter form), Comments (review threads kept in `.pagemd/comments/`).
- **Pictures:** paste or drop an image to save it into the image folder (`pagemdEditor.imageFolder`) and insert a figure. Select a picture
  and the **Image** tab appears: **Shapes** (markers, arrows, boxes, notes, lines, ellipses, highlights) mark up a screenshot; **Edit picture** crops
  (drag the handles, or drag the picture under the crop; Enter keeps, Escape cancels), rotates, flips, redacts and **Reset picture** puts it back. None of
  these change your picture file: they are written into the markdown (`crop-x`, `rotate`, `flip`, `redact:` …), and one Ctrl+Z undoes each one. A plain
  picture becomes a figure (or a picture with shapes) by itself when a tool needs it.
- **Redaction (provisional):** Redact draws a black box you drag over what must be hidden. It is covered on the page and in Print Preview, and blacked out
  in exported HTML, PDF and pictures: pagemd bakes a covered copy when it builds. It is **not removed** from your picture file, git history, `pagemd archive`,
  or markdown viewers such as GitHub. To remove it for good, edit or replace the original file. Without pagemd's renderer the editor will not show or export
  a document with redactions.
- **Tables:** the Table tab and Tab / Shift+Tab to move between cells.
- **Problems:** when the document's profile asks for checks, they appear in VS Code's Problems panel and on the page.
- **Profile packs:** the command **pagemd: Get Profile Packs...** (also the last entry of Document ▸ Profile, "Get more profile packs...") lists the packs of
  the pagemd library with their state (not installed, installed 0.1.0, update to 0.2.0, changed by hand), and installs, updates or removes the ones you
  tick. Packs go into pagemd's shared profiles folder, so a document can name one by its name alone (`profile: pml-sop-ink`) in the editor and on the command line.
  The packs come from the place in `pagemdEditor.profilePacks.source`: a folder (a Nextcloud folder works), an `https://` address, or the library's GitHub
  releases (a private repository asks for your GitHub sign-in through VS Code; the editor never sees or keeps a password). The sign-in asks GitHub for the
  `repo` permission, which also allows writing to your repositories: GitHub offers no read-only permission for private repositories, and the editor only reads
  the release. **Nothing is fetched except when you run that command**; opening, previewing and exporting a document never go online, and offline you can
  still use and remove what is installed. Every pack is checked (its checksum, then its contents: stylesheets, the template and pictures read the way a
  browser reads them, nothing that runs code or reaches outside the pack, and only the profile settings a pack may set) before one file is written, a
  network share (`\\server\share`) is not accepted as a source, and pagemd's export reads only the document's own files and folders.
- **Export:** PDF, HTML and PNG from the Document tab or the commands "pagemd: Export ...", made by pagemd itself.

## Keyboard
- **F6 / Shift+F6** move between the ribbon, the Outline, the page, the Comments panel, the Inspector and the status bar. From the last (or first) one VS Code
  takes the key as it does everywhere. Shift+F6 from the page reaches the ribbon.
- In the ribbon, **Tab** goes to the tab names, then once to the buttons; the **arrow keys** (and Home, End) move between them, **Enter** presses one and
  puts you back in the text; **Escape** goes back to the text.
- Arrow keys reach a picture from the text (press an arrow key once so no text is selected); **Enter** edits its shapes, **Tab** moves between them, the arrow keys
  nudge, **Delete** removes, **Escape** goes back to the text. Its alt text and caption are in the Inspector.

## Settings
| Setting | What it does |
|---|---|
| `pagemdEditor.openByDefault` | File patterns that open in pagemd Editor by themselves |
| `pagemdEditor.imageFolder` | Where pasted or dropped pictures are saved (default `.pagemd/assets/img`) |
| `pagemdEditor.gatedInsert` | What happens when you insert an item whose syntax is switched off in the document: `ask`, `auto` or `warn` |
| `pagemdEditor.showProblems` | Show profile checks in the Problems panel and on the page |
| `pagemdEditor.commentAuthor` | The name your review comments carry |
| `pagemdEditor.browserPath` | A Chrome, Edge or Chromium for PDF and PNG export (none is ever downloaded) |
| `pagemdEditor.profilePacks.source` | Where "Get Profile Packs" gets packs: a folder, an `https://` address of an `index.json`, or a GitHub repository such as `https://github.com/gh4-io/pagemd-library` (empty: the command asks). Only your own user settings count; a workspace cannot set it |
| `pagemdEditor.pagemdPath` | A pagemd install folder, to use all of its profiles and layouts instead of the copy that ships |

## Known limits
- Five of pagemd's own example documents do not paginate within one page of the PDF in Print Layout, and are not yet covered by
  the page-count test: two that start a list item with an INDEX marker, two that rely on a template's own style rules, and one that
  includes other files (included files are shown as a marker, not expanded on the page). Print Preview is exact.
- PDF and PNG export need Chrome or Microsoft Edge (or the browser named in `pagemdEditor.browserPath`).
- A table is written whole in pagemd's canonical form once you edit it; a table cell holding a list, or a row the editor could not
  read without losing words, opens as raw text.
- Screen-reader support is new (version 0.1.0 is its first release): the page, the ribbon and the panels have names and landmarks and the
  window's colors follow your VS Code theme, but it has not been tried with every screen reader. Please say what is missing.
- A picture over 4000 pixels on a side is shown from a smaller copy made in the page (the file is never changed); a picture over 50 MB is shown
  as it is.
- The extension has no icon yet. It is licensed under the Apache License 2.0 (`LICENSE`, `NOTICE`); it bundles
  third-party code and the Inter font (SIL Open Font License 1.1), each listed with its licence in `ThirdPartyNotices.txt`.

See `CHANGELOG.md` for what changed.
