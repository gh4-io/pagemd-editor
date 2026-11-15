// @pagemd-editor/image-editor (P15, ADR-0018; narrowed in P27, ADR-0019): the image tools' dialog. The pixel edits (crop, rotate,
// flip and redact into a new picture file) are gone: crop, rotate and flip are keys in the markdown and redaction is baked by pagemd
// (R-249, R-251). Dialogs only (D30, narrowed): it knows nothing of documents, YAML or ProseMirror.
export { askChoice, imageEditorCss, type DialogAction } from './dialog.ts';
