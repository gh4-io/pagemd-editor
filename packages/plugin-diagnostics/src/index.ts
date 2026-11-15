// @pagemd-editor/plugin-diagnostics (P14, ADR-0017). This entry is the webview's: the hints on the canvas, with no
// @pagemd/* import (the bundle stays free of the checks). The host's entry, which runs @pagemd/validate, is
// `@pagemd-editor/plugin-diagnostics/check`.
export { diagnosticsPlugin, hintsCss, hintsFor, hintsKey, hintsOf, showHints, type Hint, type HintSeverity } from './hints.ts';
