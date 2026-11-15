// The paged canvas's structural CSS (editor UI, not document content): paper, page gaps, zero-height markers. The text area
// may sit inside a template frame (P18), so it is found anywhere in the canvas, and keeps the display the template gives it.
import { GAP_CLASS } from './measure.ts';
import { MARKER_CLASS, PAGED_CLASS } from './paginator.ts';

/**
 * The class Print Layout and Read put on the canvas so the profile's print rules apply (P6, amendment 5). The same
 * name as style-pagemd's PRINT_CLASS, which rewrites `@media print` rules to need it (checked by a test).
 */
export const PRINT_CLASS = 'pmd-print';

// P21 (AD-P21-14): the marker's chip (e.g. "Page layout: landscape") is drawn at full strength; at opacity 0.7 its text fell
// below the contrast WCAG asks for (axe, color-contrast), seen once a LAYOUT marker was on an a11y surface.
export const paginationCss = `
/* The paper (z-index 0) lies under the text area and, since P18, under the template frame's top-level elements (z-index 1; their
   own position rules, if the template has any, win: :where() adds no specificity). */
.pmd-canvas.${PAGED_CLASS} { position: relative; background: transparent !important; box-shadow: none !important; border: 0 !important; }
.pmd-canvas.${PAGED_CLASS} .ProseMirror { position: relative; z-index: 1; }
.pmd-canvas.${PAGED_CLASS} .ProseMirror:not(.pmd-frame-host) { display: flow-root; }
.pmd-canvas.${PAGED_CLASS} > :where(.pmd-frame) { position: relative; z-index: 1; }
.pmd-canvas.${PAGED_CLASS} > .pmd-pages { position: absolute; left: 0; top: 0; width: 0; height: 0; z-index: 0; pointer-events: none; }
.pmd-canvas.${PAGED_CLASS} .pmd-page { position: absolute; left: 0; background: #fff; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35); }
.pmd-canvas.${PAGED_CLASS} .pmd-page.pmd-page-overflow { outline: 2px dashed var(--vscode-editorWarning-foreground, #c90); outline-offset: -2px; }
.pmd-canvas .${GAP_CLASS} { display: block; margin: 0 !important; padding: 0 !important; border: 0 !important; user-select: none; pointer-events: none; }
.pmd-canvas.${PAGED_CLASS} .${MARKER_CLASS} { height: 0 !important; min-height: 0 !important; margin: 0 !important; padding: 0 !important;
  border: 0 !important; overflow: visible; position: relative; }
.pmd-canvas.${PAGED_CLASS} .${MARKER_CLASS} > * { position: absolute; right: 0; top: -0.6em; font-size: 8pt; line-height: 1.2; z-index: 2; }
.pmd-canvas > .pmd-page-probes { position: absolute; visibility: hidden; height: 0; width: 0; overflow: hidden; }
`;
