// @pagemd-editor/preset-pagemd: every pagemd syntax item as a SyntaxItem (P4, layered-architecture.md §3).
// Reading and writing come from @pagemd/syntax (one dialect, I1); document properties and gates from
// @pagemd/meta (amendment 1). This package adds the editor half: nodes, the canvas look (I3), labels, slash
// keywords and outline entries. Used on top of preset-commonmark and preset-gfm (it replaces GFM's table and
// alert items).
import { ANNOTATED_IMAGE_STRUCTURAL_CSS, FOOTNOTES_STRUCTURAL_CSS, MARKER_LABEL_STRUCTURAL_CSS, MARKER_SCALE_STRUCTURAL_CSS, TASK_LISTS_STRUCTURAL_CSS } from '@pagemd/syntax';
import { CATALOGUE, catalogue, layer, normalizeMetadata } from '@pagemd/meta';
import type { MetaCatalogue, Preset, SyntaxItem } from '@pagemd-editor/core';
import { CANVAS_CSS } from './canvas-css.ts';
import { DIALECT_ID, dialectItem } from './dialect.ts';
import { attributes } from './text/attributes.ts';
import { inlineItems } from './text/inline.ts';
import { fancyLists } from './lists/fancy-lists.ts';
import { taskLists } from './lists/task-lists.ts';
import { footnotes } from './text/footnotes.ts';
import { table } from './tables/table.ts';
import { blockItems } from './blocks/wrappers.ts';
import { mediaItemsWith } from './media/media.ts';
import type { DiagramDrawer } from './media/diagram-view.ts';
import { pageItems } from './page/directives.ts';
import { include } from './document/include.ts';
import { frontmatter, frontmatterProperties, frontmatterYaml, readProperties } from './document/frontmatter.ts';
import { withFields } from './fields.ts';
import { SHAPE_EDITING_CSS } from './media/image-tools/annotation-view.ts';
import { CROP_MODE_CSS } from './media/image-tools/crop-mode.ts';
import { DRAW_MODE_CSS } from './media/image-tools/draw-mode.ts';
import { FIRST_HEADING_CSS } from './document/first-heading.ts';

export { DIALECT_ID } from './dialect.ts';
export { ATTRS, attributeDom } from './text/attributes.ts';
export { FANCY, fancyListDom } from './lists/fancy-lists.ts';
export { codeBlockDom, insertFigures, isDiagram, redactedPictures } from './media/media.ts';
export { diagramCss, diagramEditingPlugin, DIAGRAM_CLASS, DIAGRAM_EDITING, type DiagramDrawer } from './media/diagram-view.ts';
// P10 (R-167): the mermaid version and settings pagemd draws with (@pagemd/syntax), for the webview's drawings.
export { MERMAID_CONFIG, MERMAID_VERSION } from '@pagemd/syntax';
export { tocPlugin, tocPluginWith, tocHeadings, tocDecorations, tocDecorationsWith, type TocSettings } from './page/toc-view.ts';
export { pageMarkerOf, SECTION_BOX, type PagemdPageMarker } from './page/directives.ts';
export { COMMENT_NODE, commentAnchorId, commentAnchors, commentedBlock, insertCommentAnchor, removeCommentAnchor, removeCommentAnchorAt, type CommentAnchor } from './page/comment-anchor.ts';
export { escapeFancyMarkers } from './lists/fancy-lists.ts';
// P26: footnotes and task lists (the canvas's numbers and boxes are ProseMirror plugins the app adds).
export { footnotesPlugin, footnoteNumbers, insertFootnoteTransaction, nextLabel, FOOTNOTE, FOOTNOTE_REF, type FootnoteMark } from './text/footnotes.ts';
export { taskListsPlugin, toggleTaskTransaction, toggled, TASK, NEW_TASK, type TaskData } from './lists/task-lists.ts';
export { useLayoutNames, attributePairs, paramFields } from './fields.ts';
export { figureNumbers, numberedOutline, outlineLabel } from './media/figure-numbers.ts';
// P15 (ADR-0018) and P27 (ADR-0019): the image tools' document side (shapes, the picture keys: crop, rotate, flip, Reset picture,
// redactions; a plain picture or a FIGURE made a block of the right kind inside each tool's own step).
export {
  CROP_KEYS,
  cropKeysFor,
  cropRectOf,
  mapPoint,
  mapRect,
  readFlip,
  readRotate,
  refOfField,
  remapAnnotations,
  renumberMarkers,
  RESET_KEYS,
  turnedKeys,
  undoSteps,
  wholePicture,
  withCrop,
  type Flip,
  type Geometry,
  type Rect,
  type ShapeList,
  type ShapeRef,
  type Turn,
} from './media/image-tools/geometry.ts';
export {
  addShapeTransaction,
  annotatedTarget,
  asBlock,
  blockReason,
  canAnnotate,
  canFocusPictureField,
  canRedact,
  captionFigure,
  cropTransaction,
  editableTarget,
  FIGURE_ONLY_REASON,
  figureFits,
  hasPictureEdits,
  PICTURE_WIDTHS,
  pictureCaption,
  pictureCrop,
  pictureField,
  pictureSelected,
  pictureSizeCommands,
  pictureTarget,
  pictureWidth,
  redactReason,
  resetTransaction,
  selectNodeTransaction,
  setPictureOption,
  sourceOf,
  toAnnotated,
  toFigure,
  turnTransaction,
  liftPicture,
  type Change,
  type PictureKind,
  type PictureTarget,
  type PictureWidth,
} from './media/image-tools/target.ts';
export { drawModeKey, requestDraw, requestShape, shapeEditingKey, shapeEditingPlugin, stopShapeEditing } from './media/image-tools/plugin.ts';
export { figureStyle, makeFiguresReadable, setFigureStyle, type FigureStyle } from './media/figure-style.ts';
export { firstHeadingPlugin, hideFirstH1 } from './document/first-heading.ts';
export { DRAW_MODE_CSS, drawModeOn, drawModePlugin, drawnEntry } from './media/image-tools/draw-mode.ts';
export { FLUSH_EVENT, hiddenShapes, SHAPE_ADDED_EVENT, SHAPE_SELECT_EVENT } from './media/image-tools/annotation-view.ts';
// P27: crop mode on the canvas (Word's crop: handles, shift, Enter keeps, Esc cancels), picture sizes for quarter turns.
export { cropModeKey, cropModeOn, cropModePlugin, cropRect, dragEdge, measure, requestCrop, shiftPicture } from './media/image-tools/crop-mode.ts';
export { forgetPictureSizes, pictureSize } from './media/picture-sizes.ts';
// P16: the table editing plugins (cell selection, tidy step, Tab/Enter) the app adds.
export { cursorInTransaction, tableEditingPlugins, tableTidyKey } from './tables/editing.ts';
export { tidyTable, tidyGroups } from './tables/tidy.ts';
export { tableAt, type TableContext } from './tables/context.ts';
// P19: table column widths (the `{…}` line's data-col-widths and .fixed-layout; the border drag).
export { completeWidths, layoutOf, moveBorder, roundTo100, setLayout, withLayout, MIN_WIDTH, STEP, type TableLayout } from './tables/widths.ts';
export { HEAD_ROW_CLASS } from './tables/table.ts';
export { fixTableTransaction, tableShape, type TableShape } from './tables/shape.ts';
export { ANNOUNCE_EVENT, columnResizeKey, columnResizePlugin, DRAG_STEP, fitColumnWidthsIn, measureColumnsIn, HANDLE_PX } from './tables/resize.ts';
export { FRONTMATTER_NODE, frontmatterBlock, frontmatterProperties, readProperties, canonical, type FrontmatterBlock } from './document/frontmatter.ts';

/** Document property values that switch gated items on, e.g. `{ fancy_lists: true }` (ADR-0016). */
export type GateFields = Record<string, unknown>;

export interface PagemdPresetOptions {
  /** The document's gate values (`gateFields(text)`); gated items are off without them, as in pagemd. */
  fields?: GateFields;
  /** Draws ```mermaid fences on the canvas (P10); without it they stay code blocks. */
  diagrams?: DiagramDrawer;
}

/** Every item, in the order they are registered (the dialect first: it adds the reading rules). */
export function pagemdItems(options: PagemdPresetOptions = {}): SyntaxItem[] {
  return withFields([dialectItem(options.fields), frontmatter, attributes, ...inlineItems, footnotes, fancyLists, taskLists, table, ...blockItems, ...mediaItemsWith(options.diagrams), ...pageItems, include]);
}

export function pagemdPreset(options: PagemdPresetOptions = {}): Preset {
  // The catalogue with each field's aliases filled in (catalogue(), not the raw JSON: P8 found the raw fields have none).
  return { id: 'pagemd', items: pagemdItems(options), meta: META, properties: frontmatterProperties };
}

const META: MetaCatalogue = { ...(CATALOGUE as unknown as MetaCatalogue), fields: catalogue() as MetaCatalogue['fields'] };

/** The written frontmatter, normalized without defaults ({} for none, undefined when unreadable), for the gate and TOC readers. */
function writtenOf(text: string): Record<string, unknown> | undefined {
  const yaml = frontmatterYaml(text);
  if (yaml === null) return {};
  const read = readProperties(yaml);
  return 'data' in read ? normalizeMetadata(read.data, { applyDefaults: false }) : undefined;
}

/** The same items with other gate values: only the dialect item changes, so the schema stays the same. */
export function withGateFields(items: readonly SyntaxItem[], fields: GateFields): SyntaxItem[] {
  return items.map((item) => (item.id === DIALECT_ID ? dialectItem(fields) : item));
}

/**
 * The gate values a document switches on, the way pagemd decides them before parsing (R-124, P5 amendment 2): the
 * frontmatter normalized by @pagemd/meta without built-in defaults (aliases, value rules; pagemd's
 * `writtenMetadataOf`), layered over the profile's defaults with @pagemd/meta's `layer()` (built-in → profile →
 * frontmatter), then `Boolean(value)` for every gate field (pagemd's `isFancyListsEnabled`). `profileDefaults`
 * are the profile's gate defaults from the host (`StylesPayload.gateDefaults`); without them only the frontmatter
 * counts. Unreadable YAML switches nothing on (pagemd itself stops with an error there).
 */
export function gateFields(text: string, profileDefaults: Record<string, unknown> = {}): GateFields {
  const fields: GateFields = {};
  let values: Record<string, unknown> = {};
  const written = writtenOf(text);
  if (written) values = layer(profileDefaults, written);
  for (const gate of Object.values(CATALOGUE.gates)) fields[gate.field] = Boolean(values[gate.field]);
  return fields;
}

/**
 * The document's TOC settings (R-148): `toc_levels` and `toc_min_level` from its frontmatter, normalized by
 * @pagemd/meta like the gates (aliases, value rules), layered over `profileDefaults`. Missing or unreadable: none.
 */
export function tocFields(text: string, profileDefaults: Record<string, unknown> = {}): { levels?: number; minLevel?: number } {
  const values = layer(profileDefaults, writtenOf(text) ?? {});
  const out: { levels?: number; minLevel?: number } = {};
  const levels = Number(values['toc_levels']);
  const minLevel = Number(values['toc_min_level']);
  if (Number.isFinite(levels) && levels > 0) out.levels = levels;
  if (values['toc_min_level'] !== undefined && Number.isFinite(minLevel)) out.minLevel = minLevel;
  return out;
}

/** A key for caching one transformer per set of gate values. */
export const gateKey = (fields: GateFields): string => JSON.stringify(Object.entries(fields).sort(([a], [b]) => a.localeCompare(b)));

/**
 * CSS the canvas needs for pagemd content in every view (D18): @pagemd/syntax's structural CSS (markers placed
 * on annotated images; R-116), scoped to the canvas, plus the editor's chips and labels for directives (editor
 * UI: VS Code colors).
 */
export const pagemdCanvasCss =
  scope(ANNOTATED_IMAGE_STRUCTURAL_CSS, '.pmd-canvas') +
  // P26: what pagemd adds to a document with footnotes, in the lowest layer, so the profile's CSS still wins (as in the PDF). FIX-ADT: and
  // what it adds to a document with task lists (GitHub's layout), in a layer after the profile's, so every profile gets the same look; nothing is
  // `!important` (AD-FIX-ADT-09), so a document's own `styles:` file can change the indent, and a profile can with an `!important` (the earlier layer
  // wins for those). The layer statement comes first, so the order is the one pagemd declares (`structural` last of the named layers, `frontmatter` after it).
  `\n@layer base, primary, layout, syntax, profile, structural;\n` +
  `@layer base {\n${scope(FOOTNOTES_STRUCTURAL_CSS, '.pmd-canvas')}\n}\n` +
  // P27 (R-250, C13): a marker's size and its label on the picture, in the same layer pagemd puts them in (inert until a marker uses them).
  `@layer base {\n${scope(MARKER_LABEL_STRUCTURAL_CSS, '.pmd-canvas')}\n}\n` +
  `@layer structural {\n${scope(TASK_LISTS_STRUCTURAL_CSS, '.pmd-canvas')}\n}\n` +
  // FIX-S50 (AD-FIX-S50-04): the marker's size must NOT be in a layer on the canvas: the unlayered `.pmd-canvas .marker { transform }` from
  // ANNOTATED_IMAGE_STRUCTURAL_CSS beats every layered rule, so the size never showed. Unlayered, its higher specificity wins.
  scope(MARKER_SCALE_STRUCTURAL_CSS, '.pmd-canvas') +
  CANVAS_CSS +
  SHAPE_EDITING_CSS +
  CROP_MODE_CSS +
  DRAW_MODE_CSS +
  FIRST_HEADING_CSS;

/** Puts `prefix` before every selector of simple top-level rules. */
export function scope(css: string, prefix: string): string {
  return css.replace(/(^|\})\s*([^{}@]+)\{/g, (_all, end: string, selectors: string) => {
    const scoped = selectors.split(',').map((s) => `${prefix} ${s.trim()}`).join(', ');
    return `${end}\n${scoped} {`;
  });
}
