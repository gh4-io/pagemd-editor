// The editor's own look for pagemd items on the canvas (editor UI, so VS Code's colors): chips for directives
// and includes, the "Diagram" label on mermaid fences, the table caption, and the live figure numbers (one
// counter over every captioned FIGURE and annotated image, C9). Document styles come from the profile (P5).
// Print Layout (`.pmd-paged`, P6, R-146): inline markers with no output in pagemd's HTML (INDEX terms, other inline
// directives) take no width, so lines wrap as in the PDF; their chip floats small above the line.
// P26: a footnote's note is drawn where it is written, its number in front and the back-link after (pagemd prints the notes as
// a numbered list at the end of the document); a reference or note pagemd can't number is underlined in VS Code's warning color.
export const CANVAS_CSS = `
.pmd-canvas .ProseMirror { counter-reset: pmd-figure; }
.pmd-canvas .fig-num { counter-increment: pmd-figure; }
.pmd-canvas .fig-num:empty::before { content: counter(pmd-figure); }
.pmd-canvas .pmd-directive { margin: 0.5em 0; }
.pmd-canvas .pmd-chip { display: inline-block; padding: 0 0.5em; border: 1px dashed var(--vscode-editorWidget-border, #888);
  border-radius: 3px; font: 0.8em var(--vscode-font-family, sans-serif); white-space: nowrap; user-select: none;
  /* P13b (amendment 8b): the text color and its background both come from the editor's theme, never the page's: a chip on a
     white page in a dark theme would be pale grey on white. The same pair VS Code uses for a description on its background. */
  color: var(--vscode-descriptionForeground, #595959); background: var(--vscode-editor-background, #fff); }
.pmd-canvas span.pmd-directive { margin: 0; }
.pmd-canvas .break-page { border-top: 1px dashed var(--vscode-editorWidget-border, #888); text-align: center; }
.pmd-canvas .break-page > .pmd-chip { position: relative; top: -0.7em; }
.pmd-canvas .pmd-toc-list:empty { display: none; }
.pmd-canvas .pmd-include-open { margin-left: 0.5em; font-size: 0.8em; }
.pmd-canvas .pmd-media { margin: 1em 0; }
.pmd-canvas pre.pmd-diagram::before { content: "Diagram"; display: block; font: 0.8em var(--vscode-font-family, sans-serif);
  color: var(--vscode-descriptionForeground, #595959); background: var(--vscode-editor-background, #fff); }
.pmd-canvas .pmd-table-captioned::before { content: attr(data-caption); display: block; font-style: italic; }
/* Selected cells (P16: prosemirror-tables adds the class selectedCell; the editor's own selection colors, not the profile's). */
.pmd-canvas td.selectedCell, .pmd-canvas th.selectedCell { position: relative; }
.pmd-canvas .selectedCell::after { content: ""; position: absolute; inset: 0; pointer-events: none;
  background: var(--vscode-editor-selectionBackground, rgba(38, 79, 120, 0.5)); }
.pmd-canvas .selectedCell ::selection, .pmd-canvas .selectedCell::selection { background: transparent; }
/* Column widths (P19): the two widths by the pointer while a border is dragged (the editor's colors, not the profile's). */
.pmd-col-readout { position: fixed; z-index: 1000; pointer-events: none; padding: 1px 6px; border-radius: 3px; white-space: nowrap;
  font: 12px var(--vscode-font-family, sans-serif); color: var(--vscode-editorHoverWidget-foreground, #fff);
  background: var(--vscode-editorHoverWidget-background, #333); border: 1px solid var(--vscode-editorHoverWidget-border, #666); }
/* Column widths (P19): a resize arrow over a column border and while dragging one. */
.pmd-canvas .ProseMirror.pmd-col-resize, .pmd-canvas .ProseMirror.pmd-col-resize *, .pmd-canvas table.pmd-col-dragging, .pmd-canvas table.pmd-col-dragging * { cursor: col-resize !important; }
.pmd-canvas .pmd-yaml-error { color: var(--vscode-errorForeground, #c00); }
.pmd-canvas .callout-label, .pmd-canvas .markdown-alert-title { user-select: none; }
.pmd-canvas.pmd-paged .index-marker, .pmd-canvas.pmd-paged .pmd-directive-inline { display: inline-block; position: relative;
  width: 0; height: 1em; overflow: visible; vertical-align: baseline; }
.pmd-canvas.pmd-paged .index-marker > .pmd-chip, .pmd-canvas.pmd-paged .pmd-directive-inline > .pmd-chip { position: absolute;
  left: 0; bottom: 100%; font-size: 0.6em; pointer-events: auto; }
.pmd-canvas .pmd-comment-anchor { position: relative; height: 0; margin: 0; padding: 0; overflow: visible; user-select: none; }
.pmd-canvas .pmd-comment-flag { position: absolute; right: 0; top: 0; transform: translateY(-50%); padding: 0 0.4em; border-radius: 3px;
  font: 0.7em var(--vscode-font-family, sans-serif); line-height: 1.5; cursor: pointer; z-index: 1;
  color: var(--vscode-badge-foreground, #fff); background: var(--vscode-badge-background, #007acc); }
.pmd-canvas .pmd-comment-anchor.ProseMirror-selectednode .pmd-comment-flag { outline: 2px solid var(--vscode-focusBorder, #007acc); }
.pmd-canvas .pmd-commented { box-shadow: -3px 0 0 0 var(--vscode-editorInfo-foreground, #3794ff);
  background-color: color-mix(in srgb, var(--vscode-editorInfo-foreground, #3794ff) 10%, transparent); }
.pmd-canvas .pmd-commented-resolved { box-shadow: -3px 0 0 0 var(--vscode-disabledForeground, #999); background-color: transparent; }
.pmd-canvas .pmd-commented-active { background-color: color-mix(in srgb, var(--vscode-editorInfo-foreground, #3794ff) 22%, transparent); }
.pmd-canvas .footnote-ref a { cursor: pointer; }
.pmd-canvas .pmd-footnote { display: flex; align-items: baseline; gap: 0.4em; }
.pmd-canvas .pmd-footnote-label { flex: none; min-width: 1.6em; user-select: none; }
.pmd-canvas .pmd-footnote-body { flex: 0 1 auto; min-width: 0; }
.pmd-canvas .pmd-footnote-body > :first-child { margin-top: 0; }
.pmd-canvas .pmd-footnote-body > :last-child { margin-bottom: 0; }
.pmd-canvas .pmd-footnote .footnote-backref { flex: none; cursor: pointer; user-select: none; }
.pmd-canvas .pmd-footnote-problem .pmd-footnote-label, .pmd-canvas sup.pmd-footnote-problem a {
  text-decoration: underline wavy var(--vscode-editorWarning-foreground, #c90); }
.pmd-canvas .task-list-item-checkbox { cursor: pointer; } /* the space after the box is the widget's (task-lists.ts), as in pagemd's HTML; the box's margins are pagemd's */
.pmd-canvas .task-list-item-checkbox:disabled { cursor: default; }
`;
