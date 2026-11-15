// Editor UI, so VS Code's theme variables only (no color of its own).
export const inspectorCss = `
.pmd-row { flex: 1; display: flex; min-height: 0; }
.pmd-main { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.pmd-inspector { flex: none; width: 300px; display: flex; flex-direction: column; min-height: 0; font-family: var(--vscode-font-family); font-size: 12px; color: var(--vscode-foreground); background: var(--vscode-sideBar-background, var(--vscode-editor-background)); border-left: 1px solid var(--vscode-panel-border, transparent); }
.pmd-inspector[hidden] { display: none; }
.pmd-insp-head { display: flex; align-items: center; justify-content: space-between; padding: 2px 4px 0 8px; border-bottom: 1px solid var(--vscode-panel-border, transparent); }
.pmd-insp-tabs { display: flex; gap: 2px; }
.pmd-insp-tab { font: inherit; color: var(--vscode-foreground); background: transparent; border: 0; border-bottom: 2px solid transparent; padding: 4px 8px; cursor: pointer; }
.pmd-insp-tab[aria-selected="true"] { border-bottom-color: var(--vscode-focusBorder); }
.pmd-insp-panel { flex: 1; overflow: auto; padding: 8px; }
.pmd-insp-panel > [hidden] { display: none; }
.pmd-insp-empty, .pmd-props-empty, .pmd-props-complex { color: var(--vscode-descriptionForeground); }
.pmd-insp-readonly-note { color: var(--vscode-descriptionForeground); border-left: 3px solid var(--vscode-focusBorder, currentColor); padding: 4px 8px; margin: 0 0 8px; }
.pmd-insp-target { margin-bottom: 12px; }
.pmd-insp-title { font-size: 12px; font-weight: 600; margin: 0 0 6px; text-transform: uppercase; color: var(--vscode-descriptionForeground); }
.pmd-insp-subtitle { font-size: 11px; font-weight: 600; margin: 8px 0 4px; color: var(--vscode-descriptionForeground); }
.pmd-insp-fields { display: flex; flex-direction: column; gap: 6px; }
.pmd-insp-field { display: flex; flex-direction: column; gap: 2px; }
.pmd-insp-label { color: var(--vscode-foreground); }
.pmd-insp-help { color: var(--vscode-descriptionForeground); font-size: 11px; }
.pmd-insp-problem { color: var(--vscode-errorForeground); font-size: 11px; }
.pmd-insp-problem[hidden] { display: none; }
.pmd-inspector input[type="text"], .pmd-inspector input:not([type]), .pmd-inspector select, .pmd-inspector textarea,
.pmd-fm-card input[type="text"], .pmd-fm-card input:not([type]), .pmd-fm-card select, .pmd-fm-card textarea {
  font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, transparent)); border-radius: 2px; padding: 2px 4px; min-width: 0; box-sizing: border-box; width: 100%;
}
.pmd-inspector [aria-invalid="true"], .pmd-fm-card [aria-invalid="true"] { border-color: var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground)); }
.pmd-inspector :focus-visible, .pmd-fm-card :focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.pmd-insp-inline { display: flex; gap: 4px; align-items: center; }
.pmd-insp-color { width: 28px; height: 22px; padding: 0; border: 0; background: transparent; flex: none; }
.pmd-insp-browse, .pmd-insp-add, .pmd-props-raw-toggle { font: inherit; color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); background: var(--vscode-button-secondaryBackground, transparent); border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px; padding: 2px 8px; cursor: pointer; white-space: nowrap; }
.pmd-insp-icon-button { font: inherit; color: var(--vscode-icon-foreground, var(--vscode-foreground)); background: transparent; border: 0; border-radius: 3px; padding: 2px; cursor: pointer; display: inline-flex; }
.pmd-insp-icon-button:hover, .pmd-insp-browse:hover, .pmd-insp-add:hover { background: var(--vscode-toolbar-hoverBackground, transparent); }
.pmd-insp-icon-button:disabled { opacity: 0.4; cursor: default; }
.pmd-insp-group { border: 1px solid var(--vscode-panel-border, transparent); border-radius: 3px; padding: 4px 6px 6px; margin: 0; display: flex; flex-direction: column; gap: 6px; }
.pmd-insp-list { display: flex; flex-direction: column; gap: 4px; }
.pmd-insp-list-row { display: flex; gap: 4px; align-items: flex-start; border-left: 2px solid var(--vscode-panel-border, transparent); padding-left: 6px; }
.pmd-insp-list-row.pmd-insp-row-flagged { border-left-style: dashed; }
.pmd-insp-row-note { font-size: 11px; color: var(--vscode-editorWarning-foreground, var(--vscode-descriptionForeground)); margin-bottom: 2px; }
.pmd-insp-list-row.pmd-insp-row-marked { border-left-color: var(--vscode-focusBorder); background: var(--vscode-list-inactiveSelectionBackground, transparent); }
.pmd-insp-list-body { flex: 1; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.pmd-insp-list-tools { display: flex; flex: none; }
.pmd-props { display: flex; flex-direction: column; gap: 8px; }
.pmd-props[hidden] { display: none; }
.pmd-props-bar { display: flex; justify-content: flex-end; }
.pmd-props-raw-toggle[aria-pressed="true"] { border-color: var(--vscode-focusBorder); }
.pmd-props-row { display: grid; grid-template-columns: 1fr auto; gap: 2px 4px; align-items: start; }
.pmd-props-row > .pmd-insp-fields, .pmd-props-row > .pmd-props-complex { grid-column: 1; }
.pmd-props-row > .pmd-props-badges { grid-column: 1; grid-row: 2; display: flex; flex-wrap: wrap; gap: 4px; }
.pmd-props-row > .pmd-insp-icon-button { grid-column: 2; grid-row: 1; margin-top: 16px; }
.pmd-props-row[data-missing="true"] .pmd-insp-label { color: var(--vscode-descriptionForeground); }
.pmd-props-badge { font-size: 10px; padding: 0 5px; border-radius: 8px; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); }
.pmd-props-badge:empty { display: none; }
.pmd-props-error { color: var(--vscode-errorForeground); }
.pmd-props-add { display: flex; gap: 4px; align-items: center; }
.pmd-props-raw { font-family: var(--vscode-editor-font-family, monospace); white-space: pre; resize: vertical; }
.pmd-canvas .pmd-fm-card { font-family: var(--vscode-font-family); font-size: 12px; line-height: 1.4; color: var(--vscode-foreground); background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); border: 1px solid var(--vscode-panel-border, transparent); border-radius: 4px; margin: 0 0 1em; padding: 4px 8px; user-select: none; }
.pmd-canvas .pmd-fm-card.ProseMirror-selectednode { outline: 1px solid var(--vscode-focusBorder); }
.pmd-fm-head { display: flex; align-items: center; gap: 8px; }
.pmd-fm-toggle { font: inherit; font-weight: 600; color: var(--vscode-foreground); background: transparent; border: 0; padding: 2px 0; cursor: pointer; display: inline-flex; align-items: center; gap: 2px; }
.pmd-fm-summary { color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pmd-fm-card .pmd-props { padding: 6px 0 2px; user-select: text; }
`;
