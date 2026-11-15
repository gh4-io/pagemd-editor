// The view-mode recipes (layered-architecture.md §5): which components a mode shows, which styles it uses, and
// whether it can be edited. Draft (P2, R-87 amendment 7), Web Layout (P5, R-131/R-132), Print Layout and Read (P6),
// Code and Split (P9, R-164), and Print Preview (P10, R-170).
import type { ViewMode } from '@pagemd-editor/core';

export type ComponentId = 'canvas' | 'code-view' | 'preview-frame' | 'status-bar';

export interface ViewRecipe {
  mode: ViewMode;
  components: readonly ComponentId[];
  /** 'default' = style-default (the VS Code theme, ignores the profile); 'pagemd' = the document's resolved styles. */
  styles: 'default' | 'pagemd';
  editable: boolean;
  /** Paper pages (P6): pagination on, and the profile's print rules (`.pmd-print`, amendment 5) instead of screen. */
  paged: boolean;
  /** Which ribbon tabs show (P7, R-156): every tab, or only these tab ids. Read has the View tab only. */
  ribbonTabs: 'all' | readonly string[];
  /** Whether the `/` menu and the floating selection toolbar work in this view (P7). */
  slash: boolean;
  toolbar: boolean;
  /** Which panes of the frame show (P9): the canvas, the Code view, or both side by side (Split); (P10) the preview frame. */
  show: 'canvas' | 'code' | 'both' | 'preview';
  /** Whether ```mermaid fences are drawn on the canvas (P10, R-170 Q9): Print Layout, Web Layout and Read. */
  diagrams: boolean;
}

export const RECIPES: Readonly<Partial<Record<ViewMode, ViewRecipe>>> = {
  draft: { mode: 'draft', components: ['canvas', 'status-bar'], styles: 'default', editable: true, paged: false, ribbonTabs: 'all', slash: true, toolbar: true, show: 'canvas', diagrams: false },
  web: { mode: 'web', components: ['canvas', 'status-bar'], styles: 'pagemd', editable: true, paged: false, ribbonTabs: 'all', slash: true, toolbar: true, show: 'canvas', diagrams: true },
  print: { mode: 'print', components: ['canvas', 'status-bar'], styles: 'pagemd', editable: true, paged: true, ribbonTabs: 'all', slash: true, toolbar: true, show: 'canvas', diagrams: true },
  // Read (P6, amendment 10): the paginated canvas, one page or a spread at a time, not editable.
  read: { mode: 'read', components: ['canvas', 'status-bar'], styles: 'pagemd', editable: false, paged: true, ribbonTabs: ['view'], slash: false, toolbar: false, show: 'canvas', diagrams: true },
  // Code (P9, R-164): the markdown text in the Code view (VS Code's colors), edited as text. The ribbon keeps the Document
  // and View tabs (the cohesion matrix): the Inspector's Document tab still edits the properties.
  code: { mode: 'code', components: ['code-view', 'status-bar'], styles: 'default', editable: true, paged: false, ribbonTabs: ['document', 'view'], slash: false, toolbar: false, show: 'code', diagrams: false },
  // Split (P9, R-164): the Code view and the canvas side by side (or stacked), cursors kept together. The canvas side is
  // styled like Web Layout, without pages (AD-P9-05).
  split: { mode: 'split', components: ['code-view', 'canvas', 'status-bar'], styles: 'pagemd', editable: true, paged: false, ribbonTabs: 'all', slash: true, toolbar: true, show: 'both', diagrams: false },
  // Print Preview (P10, R-170 Q5): pagemd's own render with Paged.js (or plain HTML), read-only, on demand. The ribbon keeps
  // the Document tab (Export, Profile) and the View tab.
  preview: { mode: 'preview', components: ['preview-frame', 'status-bar'], styles: 'pagemd', editable: false, paged: false, ribbonTabs: ['document', 'view'], slash: false, toolbar: false, show: 'preview', diagrams: false },
};

/** Documents open in Print Layout from P6 on (amendment 2; Web Layout was the start view in P5, R-132). */
export const START_MODE: ViewMode = 'print';

/** The recipe for `mode`, or the start mode's while that mode isn't built (R-144: the code was right, the comment said Draft's). */
export function recipeFor(mode: ViewMode, nativeSplit = false): ViewRecipe {
  const recipe = RECIPES[mode] ?? RECIPES[START_MODE]!;
  // Native split (protocol v15): VS Code's own text editor is the Code side, in the next column; this page shows the canvas only.
  return nativeSplit && recipe.mode === 'split' ? { ...recipe, components: ['canvas', 'status-bar'], show: 'canvas' } : recipe;
}
