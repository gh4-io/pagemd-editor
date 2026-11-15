/// <reference path="./pagemd-modules.d.ts" />
// @pagemd-editor/style-pagemd: a pagemd document's styles, the way pagemd's PDF has them (P5, amendment 4;
// layered-architecture.md §3). resolve → read → build → scope:
// 1. @pagemd/resolver's resolveDocument() (async) finds the profile (with `extends`), its layout and stylesheets,
//    the `styles:` files and pagemd's own files, exactly as pagemd's CLI does (no projectRoot passed: it is found
//    the way the CLI finds it);
// 2. the files are read through the injected file system;
// 3. @pagemd/theme-kit's buildStyles() arranges them into pagemd's CSS and page, with pagemd's default layout for a
//    document that has none (`defaultLayout: DEFAULTS.layout`, ADR-0014);
// 4. the CSS is scoped to the canvas (scope.ts);
// 5. (P18) the profile's HTML template is filled with the document's properties (template.ts) and drawn around the text by
//    the webview, its own <style> CSS scoped and added after the profile's (R-228).
// Runs on the extension host, but written browser-safe: the file system and path functions are injected, nothing
// here imports Node. pagemd's own folder (R-128: the editor's copy of theme-kit's `defaults/`, or a real pagemd
// install) is both the resolver's `cliPath` and buildStyles' `defaultsPath`. Anything that stops pagemd from
// rendering (a profile not found, a YAML error, a missing stylesheet) gives plain styles (`styles: null`) plus a
// note, never an error (amendment 9).
export { frontmatterOf, frontmatterMatch } from './frontmatter.ts';
export { listProfiles, sharedProfilesFolderInfo, SHARED_FOLDER_REASONS, type ProfileChoice, type ProfileSource, type SharedFolderInfo } from './profiles.ts';
export { assetFolders, GATE_FIELDS, gateDefaultsOf, resolveStyles, toNamedRunning, toResolvedStyles, toRunningContent } from './resolve.ts';
export { templateParts, type TemplateParts } from './template.ts';
export { CASCADE_NOTE, filesInUse, foundBy, indexCss, PROFILE_SEARCH_STEPS, SEARCH_STEPS, templateStyles, whyText } from './files-in-use.ts';
export { CANVAS_SCOPE, HEAD_ROW_CLASS, lightMedia, PRINT_CLASS, printMedia, scopeCss, scopedSelectors, scopeRoot, scopeSelector, tableHeadSelector, type ScopeResult } from './scope.ts';
export { frontmatterProfileEdit, overlayFileSystem, planLayoutFile, perDocumentNames, pageCss, rewritePage, type LayoutFilePlan, type FileWrite, type FrontmatterEdit } from './layout-file.ts';
export type { AssetUse, LayoutBasis, StyleDocument, StyleEnvironment, StyleNote, StyleNoteKind, StyleResolution, TraceInput, TraceSheet } from './types.ts';
export type { FileSystem, Logger, PathFunctions } from '@pagemd/resolver';
