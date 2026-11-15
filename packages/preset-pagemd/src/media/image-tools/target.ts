// The picture the image tools act on, and the edits they make to the document (P15, ADR-0018; P27, ADR-0019). Every edit here
// is one transaction (one undo step, R-94): a plain picture or a FIGURE made a FIGURE or an annotated image inside the tool's own
// step (R-248: no Convert buttons), the crop, the turn and the flip as keys (R-249: never pixels, no file written), Reset picture,
// redactions (R-251) and the shape commands (D4, D5, D7). The YAML and the FIGURE line are written by @pagemd/syntax's write rules from the node's data (C3): nothing here
// writes markdown.
import type { Node, Schema } from 'prosemirror-model';
import { EditorState, NodeSelection, type Transaction } from 'prosemirror-state';
import type { CommandSpec } from '@pagemd-editor/core';
import { ATTRS } from '../../text/attributes.ts';
import {
  addShape,
  cropRectOf,
  entryOf,
  listOf,
  mapRect,
  readFlip,
  readRotate,
  remapAnnotations,
  renumberMarkers,
  RESET_KEYS,
  SHAPE_NAME,
  turnedKeys,
  undoSteps,
  wholePicture,
  withCrop,
  withEntry,
  type AnnotationData,
  type Entry,
  type Flip,
  type Geometry,
  type Rect,
  type ShapeList,
  type ShapeRef,
  type Turn,
} from './geometry.ts';
import { requestDraw, requestShape } from './plugin.ts';
import { newFigureData } from '../figure-style.ts';

type Data = Record<string, unknown>;

/** The four ways a picture is written: `<!-- ::FIGURE -->`, `::: annotated-image`, `![](…)` and `![[…]]`. */
export type PictureKind = 'figure' | 'annotated' | 'image' | 'embed';

export interface PictureTarget {
  kind: PictureKind;
  /** The node's position (a block for figure/annotated, the inline node for image/embed). */
  pos: number;
  node: Node;
  /** The picture's path or address as written ('' for a legacy FIGURE, whose picture is on the next line). */
  src: string;
  /** A plain image or embed that is the only thing in its paragraph (it can become a FIGURE in place). Blocks: true. */
  alone: boolean;
}

/** pagemd's size classes for a plain image (`base.css`: `.width-full` 100 %, `.width-half` 50 %, `.width-third` 33 %, `.width-quarter` 25 %). */
const WIDTH_CLASS = /^width-(full|half|third|quarter)$/;

const NODE_KIND: Readonly<Record<string, PictureKind>> = { pmd_figure: 'figure', pmd_annotated_image: 'annotated', image: 'image', pmd_embed: 'embed' };

const dataOf = (node: Node): Data => (node.attrs['data'] as Data | undefined) ?? {};
const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** The picture's path as its node holds it. */
export function sourceOf(node: Node): string {
  switch (NODE_KIND[node.type.name]) {
    case 'figure': {
      const data = dataOf(node);
      return str((data['attrs'] as Data | undefined)?.['src']);
    }
    case 'annotated':
      return str(dataOf(node)['imagePath']);
    case 'image':
      return str(node.attrs['src']);
    case 'embed':
      return str(dataOf(node)['path']);
    default:
      return '';
  }
}

/**
 * The picture the selection is on: a selected picture node, or the cursor in a paragraph that holds only one picture
 * (keyboard users reach a picture that way). Null otherwise.
 */
export function pictureTarget(state: EditorState): PictureTarget | null {
  const sel = state.selection;
  if (sel instanceof NodeSelection) {
    const kind = NODE_KIND[sel.node.type.name];
    if (!kind) return null;
    const inline = kind === 'image' || kind === 'embed';
    return { kind, pos: sel.from, node: sel.node, src: sourceOf(sel.node), alone: !inline || sel.$from.parent.childCount === 1 };
  }
  const { $from } = sel;
  const parent = $from.parent;
  if (parent.type.name !== 'paragraph' || parent.childCount !== 1) return null;
  const only = parent.firstChild!;
  const kind = NODE_KIND[only.type.name];
  if (kind !== 'image' && kind !== 'embed') return null;
  return { kind, pos: $from.start(), node: only, src: sourceOf(only), alone: true };
}

/** A transaction that selects the node at `pos` (a picture), or null when it can't be selected. */
export function selectNodeTransaction(state: EditorState, pos: number): Transaction | null {
  const node = state.doc.nodeAt(pos);
  return node && NodeSelection.isSelectable(node) ? state.tr.setSelection(NodeSelection.create(state.doc, pos)) : null;
}

/** The range a picture occupies as a block: the block itself, or the paragraph a lone inline picture sits in. */
function blockRange(state: EditorState, target: PictureTarget): { from: number; to: number } {
  if (target.kind === 'figure' || target.kind === 'annotated') return { from: target.pos, to: target.pos + target.node.nodeSize };
  const $pos = state.doc.resolve(target.pos);
  return { from: $pos.before(), to: $pos.after() };
}

/** Can the picture's paragraph become a FIGURE where it stands (not in a table cell, which holds text only)? */
export function figureFits(state: EditorState, target: PictureTarget): boolean {
  if (!target.alone || !target.src || (target.kind !== 'image' && target.kind !== 'embed')) return false;
  const { from, to } = blockRange(state, target);
  const $from = state.doc.resolve(from);
  return $from.parent.canReplaceWith($from.index(), $from.index() + (to > from ? 1 : 0), state.schema.nodes['pmd_figure']!);
}

/**
 * A picture in the middle of a sentence, put on a paragraph of its own (FIX-PGF, AD-FIX-PGF-08): Word's "Top and bottom" wrapping,
 * the text before it and the text after it each its own paragraph. One transaction (it becomes part of the conversion's single undo
 * step); the space at the cut is taken away. The paragraph's own `{…}` attributes stay on the text before (an `#id` only there, as an
 * id names one block). Null when the picture is not inside a paragraph's text (a heading, a table cell: there a figure can't go).
 */
export function liftPicture(state: EditorState, target: PictureTarget): { tr: Transaction; state: EditorState; target: PictureTarget } | null {
  if (target.alone || !target.src || (target.kind !== 'image' && target.kind !== 'embed')) return null;
  const $pos = state.doc.resolve(target.pos);
  const para = $pos.parent;
  if (para.type.name !== 'paragraph') return null;
  const tr = state.tr;
  const spaces = (text: string | undefined, end: boolean): number => (text ? (end ? /[ \t]*$/ : /^[ \t]*/).exec(text)![0].length : 0);
  const after = state.doc.resolve(target.pos + target.node.nodeSize).nodeAfter;
  const lead = after?.isText ? spaces(after.text, false) : 0;
  const before = $pos.nodeBefore;
  const trail = before?.isText ? spaces(before.text, true) : 0;
  if (lead) tr.delete(target.pos + target.node.nodeSize, target.pos + target.node.nodeSize + lead);
  if (trail) tr.delete(target.pos - trail, target.pos);
  let pos = target.pos - trail;
  const $now = tr.doc.resolve(pos);
  const hasBefore = pos > $now.start();
  const hasAfter = pos + target.node.nodeSize < $now.end();
  const pairs = (para.attrs[ATTRS] as [string, string][] | null) ?? null;
  const withoutId = pairs ? pairs.filter(([key]) => key !== 'id') : null;
  if (hasAfter) tr.split(pos + target.node.nodeSize, 1, [{ type: para.type, attrs: { ...para.attrs, [ATTRS]: withoutId?.length ? withoutId : null } }]);
  if (hasBefore) {
    tr.split(pos, 1, [{ type: para.type, attrs: { ...para.attrs, [ATTRS]: null } }]);
    pos += 2; // past the end of the text before and the start of the picture's own paragraph
  }
  // (The document alone: the page's own plugins must not run on this in-between state; only the steps are kept, in `tr`.)
  const next = EditorState.create({ schema: state.schema, doc: tr.doc });
  const node = next.doc.nodeAt(pos);
  if (!node || node.type !== target.node.type) return null;
  return { tr, state: next, target: { ...target, pos, node, alone: true } };
}

/** `change`, made on the state `lifted.state`, added to the lift's own transaction: one transaction, one undo step. */
function afterLift(lifted: { tr: Transaction }, change: Change): Change {
  const tr = lifted.tr;
  for (const step of change.tr.steps) tr.step(step);
  tr.setSelection(change.tr.selection.map(tr.doc, tr.mapping.slice(tr.mapping.maps.length)));
  return { tr: tr.scrollIntoView(), notes: change.notes };
}

/** Can a block of `type` stand where the picture's block is (a FIGURE or an annotated image: not in a table cell)? */
function blockFits(state: EditorState, target: PictureTarget, type: 'pmd_figure' | 'pmd_annotated_image'): boolean {
  const { from, to } = blockRange(state, target);
  const $from = state.doc.resolve(from);
  return $from.parent.canReplaceWith($from.index(), $from.index() + (to > from ? 1 : 0), state.schema.nodes[type]!);
}

/**
 * `make` on the picture as a block of its own: a plain picture or embed on a line of its own as it is; one in the middle of a
 * sentence put on a paragraph of its own first (AD-FIX-PGF-08, P27 amendment 1: the lift is part of every tool that makes a
 * block of a plain picture), in the same transaction (one undo step). Null where the block can't go (a table cell, a heading).
 */
export function asBlock(state: EditorState, target: PictureTarget, type: 'pmd_figure' | 'pmd_annotated_image', make: (state: EditorState, target: PictureTarget) => Change | null): Change | null {
  if (target.kind === 'figure' || target.kind === 'annotated' || target.alone) return target.kind === 'image' || target.kind === 'embed' ? (blockFits(state, target, type) ? make(state, target) : null) : make(state, target);
  const lifted = liftPicture(state, target);
  if (!lifted || !blockFits(lifted.state, lifted.target, type)) return null;
  const change = make(lifted.state, lifted.target);
  return change ? afterLift(lifted, change) : null;
}

/** Can the picture be a block of `type` (it is one, or it can become one where it stands, lifted out of its sentence if need be)? */
function canBeBlock(state: EditorState, target: PictureTarget | null, type: 'pmd_figure' | 'pmd_annotated_image'): target is PictureTarget {
  if (!target || !target.src) return false;
  if (target.kind === 'annotated') return !target.node.attrs['yamlError'];
  if (target.kind === 'figure') return true;
  if (target.alone) return blockFits(state, target, type);
  const lifted = liftPicture(state, target);
  return !!lifted && blockFits(lifted.state, lifted.target, type);
}

/**
 * Why a picture tool that makes a block of a plain picture (Add shape, Crop, Rotate, Flip, Redact) is off for the selected
 * picture: it is in a table cell or a heading (P27 amendment 1: a reason, not a silent grey-out). Null otherwise.
 */
export function blockReason(state: EditorState): string | null {
  const target = pictureTarget(state);
  if (!target || target.kind === 'figure' || target.kind === 'annotated') return null;
  const $pos = state.doc.resolve(target.pos);
  for (let d = $pos.depth; d > 0; d--) {
    const role = $pos.node(d).type.spec.tableRole;
    if (role === 'cell' || role === 'header_cell')
      return 'The picture is in a table cell, which holds text only: shapes, a crop, a turn or a flip make it a figure of its own, so move it out of the table first';
  }
  if ($pos.parent.type.name !== 'paragraph') return 'The picture is in a heading: shapes, a crop, a turn or a flip make it a figure of its own, which can\'t sit inside a heading';
  return null;
}

/** Parameters a plain image or embed carries over to a FIGURE, and what had no place. */
function figureAttrsOf(target: PictureTarget): { attrs: Data; dropped: string[] } {
  const attrs: Data = { src: target.src };
  const dropped: string[] = [];
  if (target.kind === 'embed') {
    const alt = str(dataOf(target.node)['alt']);
    if (alt) attrs['alt'] = alt;
    return { attrs, dropped };
  }
  const node = target.node;
  if (str(node.attrs['title'])) attrs['caption'] = str(node.attrs['title']);
  if (str(node.attrs['alt'])) attrs['alt'] = str(node.attrs['alt']);
  for (const [key, value] of (node.attrs[ATTRS] as [string, string][] | null) ?? []) {
    if (key === 'id' || key === 'width' || key === 'height') attrs[key] = value;
    else if (key === 'class') {
      // `.width-half` is pagemd's class for a plain image's size; a FIGURE writes the same size as `width="half"`.
      const rest: string[] = [];
      for (const name of value.split(/\s+/).filter(Boolean)) {
        const size = WIDTH_CLASS.exec(name);
        if (size) attrs['width'] = size[1]!;
        else rest.push(`.${name}`);
      }
      dropped.push(...rest);
    } else dropped.push(`${key}=${value}`);
  }
  const link = node.marks.find((m) => m.type.name === 'link');
  if (link && str(link.attrs['href'])) attrs['link'] = str(link.attrs['href']);
  return { attrs, dropped };
}

function figureNodeOf(schema: Schema, attrs: Data): Node {
  return schema.nodes['pmd_figure']!.create({ data: newFigureData(attrs) });
}

export interface Change {
  tr: Transaction;
  /** What the author should know (a parameter with no place, a crop in px that was not turned). */
  notes: string[];
}

/** A plain image or embed alone in its paragraph → a FIGURE in its place (D8), selected; `crop` and `extra` parameters added. */
export function toFigure(state: EditorState, target: PictureTarget, crop?: Rect | null, extra: Data = {}): Change | null {
  if ((target.kind !== 'image' && target.kind !== 'embed') || !figureFits(state, target)) return null;
  const { attrs: carried, dropped } = figureAttrsOf(target);
  const attrs = { ...carried, ...extra };
  const node = figureNodeOf(state.schema, crop ? withCrop(attrs, crop, 'figure') : attrs);
  const range = blockRange(state, target);
  const tr = state.tr.replaceWith(range.from, range.to, node);
  tr.setSelection(NodeSelection.create(tr.doc, range.from));
  return { tr: tr.scrollIntoView(), notes: dropped.length ? [`Not carried over to the figure: ${dropped.join(' ')}.`] : [] };
}

/**
 * The FIGURE parameters an annotated image has a place for (R-248, C13: one unified picture): caption, id, alt, width, link and
 * every picture key. Height and loading have none (a note says so).
 */
const ANNOTATED_OPTIONS = ['caption', 'id', 'alt', 'width', 'link', 'class', 'crop-x', 'crop-y', 'pos-x', 'pos-y', 'crop-fit', 'rotate', 'flip'] as const;

/**
 * A FIGURE's text value as the YAML writes it (AD-P27-04): a % crop or shift and a turn become numbers (`crop-x: 50`, `pos-x: -10`,
 * `rotate: 90`; a bare number is % in the YAML, C13 AD-C13-04); a CSS length (`300px`) stays text, as written.
 */
function yamlValue(key: string, value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if ((key === 'crop-x' || key === 'crop-y') && /^\d+(\.\d+)?%?$/.test(text)) return Number(text.replace('%', ''));
  if ((key === 'pos-x' || key === 'pos-y') && /^-?\d+(\.\d+)?%?$/.test(text)) return Number(text.replace('%', ''));
  if (key === 'rotate' && /^\d+$/.test(text)) return Number(text);
  return value;
}

function annotatedNodeOf(schema: Schema, src: string, options: Data, shapes: AnnotationData = {}): Node {
  return schema.nodes['pmd_annotated_image']!.create({ data: { imagePath: src, data: { options, ...shapes } } });
}

/**
 * A FIGURE, or a plain image or embed alone in its paragraph → an annotated image in its place (D8, D24), selected. Every
 * key the FIGURE has a place for in the annotated image's options is carried over, the crop, turn and flip included (R-248:
 * a cropped figure keeps its crop); height and loading have none (a note says so).
 */
export function toAnnotated(state: EditorState, target: PictureTarget, options: { shapes?: AnnotationData } = {}): Change | null {
  if (target.kind === 'annotated' || !target.src || !target.alone) return null;
  if ((target.kind === 'image' || target.kind === 'embed') && !blockFits(state, target, 'pmd_annotated_image')) return null;
  let attrs: Data;
  const notes: string[] = [];
  if (target.kind === 'figure') {
    attrs = (dataOf(target.node)['attrs'] as Data | undefined) ?? {};
  } else {
    const made = figureAttrsOf(target);
    attrs = made.attrs;
    if (made.dropped.length) notes.push(`Not carried over: ${made.dropped.join(' ')}.`);
  }
  const opts: Data = {};
  // In the FIGURE's own order, so the YAML reads as the line did.
  // FIX-CF (AD-FIX-CF-05): `height` is the picture's box when there is a crop, so it goes along then; without a crop it has no place
  const boxed = ['crop-x', 'crop-y', 'crop-fit'].some((k) => attrs[k] !== undefined && attrs[k] !== '');
  const carried = (k: string): boolean => (ANNOTATED_OPTIONS as readonly string[]).includes(k) || (k === 'height' && boxed);
  for (const [key, value] of Object.entries(attrs)) if (carried(key) && value !== undefined && value !== '') opts[key] = yamlValue(key, value);
  const lost = Object.keys(attrs).filter((k) => k !== 'src' && !carried(k));
  if (lost.length) notes.push(`An annotated image has no place for: ${lost.join(', ')}.`);
  const range = blockRange(state, target);
  const tr = state.tr.replaceWith(range.from, range.to, annotatedNodeOf(state.schema, target.src, opts, options.shapes));
  tr.setSelection(NodeSelection.create(tr.doc, range.from));
  return { tr: tr.scrollIntoView(), notes };
}

// ── the picture keys: crop, rotate, flip, reset (P27, R-249, R-252; ADR-0019: keys in the markdown, no file is written) ──

/** The picture keys of a FIGURE (its parameters) or an annotated image (its YAML options); null for a plain picture. */
function keysOf(target: PictureTarget): Data | null {
  const data = dataOf(target.node);
  if (target.kind === 'figure') return (data['attrs'] as Data | undefined) ?? {};
  if (target.kind === 'annotated') return target.node.attrs['yamlError'] ? null : (((data['data'] as Data | undefined)?.['options'] as Data | undefined) ?? {});
  return null;
}

/** `keys` with `key` set (in place when it is there, else at the end) or removed (undefined). */
function setKey(keys: Data, key: string, value: unknown): Data {
  const out: Data = { ...keys };
  if (value === undefined) delete out[key];
  else out[key] = value;
  return out;
}

/** The block at `target` with new keys (and, for an annotated image, new shapes), selected: one transaction. */
function withKeys(state: EditorState, target: PictureTarget, keys: Data, shapes?: AnnotationData): Transaction {
  const data = dataOf(target.node);
  const next = target.kind === 'figure' ? { ...data, attrs: keys } : { ...data, data: { ...(shapes ?? ((data['data'] as Data | undefined) ?? {})), options: keys } };
  const tr = state.tr.setNodeMarkup(target.pos, undefined, { ...target.node.attrs, data: next });
  return tr.setSelection(NodeSelection.create(tr.doc, target.pos));
}

/** The picture the Edit picture tools act on: any picture with a path that is, or can become, a FIGURE where it stands. */
export function editableTarget(state: EditorState): PictureTarget | null {
  const target = pictureTarget(state);
  return canBeBlock(state, target, 'pmd_figure') ? target : null;
}

/**
 * Crop (P27 amendment 2): the picture shows only `rect` (% of the picture as shown; null or the whole picture: no crop). Written
 * as crop-x/crop-y/pos-x/pos-y in % on either form (R-249: never pixels); a plain picture becomes a FIGURE with the crop (lifted
 * out of its sentence first). One transaction. Null when nothing changes.
 */
export function cropTransaction(state: EditorState, target: PictureTarget, rect: Rect | null): Change | null {
  if (target.kind === 'image' || target.kind === 'embed') return rect && !wholePicture(rect) ? asBlock(state, target, 'pmd_figure', (s, t) => toFigure(s, t, rect)) : null;
  const keys = keysOf(target);
  if (!keys) return null;
  const next = withCrop(keys, rect, target.kind === 'figure' ? 'figure' : 'yaml');
  if (JSON.stringify(next) === JSON.stringify(keys)) return null;
  return { tr: withKeys(state, target, next), notes: [] };
}

/** The crop of the picture as written, as a rectangle (% of the picture as shown); null: none; 'unknown': in a CSS length. */
export function pictureCrop(target: PictureTarget): Rect | null | 'unknown' {
  const keys = keysOf(target);
  return keys ? cropRectOf(keys) : null;
}

/** `rotate` and `flip` written for a form: a FIGURE's text (`rotate="90"`), the YAML's number (`rotate: 90`); 0 and no flip leave the key out. */
function orientationKeys(keys: Data, rotate: Turn, flip: Flip, form: 'figure' | 'yaml'): Data {
  return setKey(setKey(keys, 'rotate', rotate === 0 ? undefined : form === 'figure' ? String(rotate) : rotate), 'flip', flip === '' ? undefined : flip);
}

const LENGTH_CROP_NOTE = 'The crop is in a CSS length (px, em …), so it was not turned with the picture: check it, or crop again (Image ▸ Crop writes it in %).';

/**
 * Rotate left/right, Flip horizontally/vertically (P27 amendment 2, R-249): the picture as shown is turned or flipped by writing
 * `rotate`/`flip`; every shape and redaction, and a crop in %, move with it, in ONE transaction. A plain picture becomes a FIGURE
 * (lifted out of its sentence first). Null when it can't.
 */
export function turnTransaction(state: EditorState, g: Geometry): Change | null {
  const target = editableTarget(state);
  if (!target) return null;
  if (target.kind === 'image' || target.kind === 'embed') {
    const turned = turnedKeys(0, '', g);
    return asBlock(state, target, 'pmd_figure', (s, t) => toFigure(s, t, null, orientationKeys({}, turned.rotate, turned.flip, 'figure')));
  }
  const keys = keysOf(target);
  if (!keys) return null;
  const form = target.kind === 'figure' ? 'figure' : 'yaml';
  const turned = turnedKeys(readRotate(keys['rotate']), readFlip(keys['flip']), g);
  let next = orientationKeys(keys, turned.rotate, turned.flip, form);
  const notes: string[] = [];
  const crop = cropRectOf(keys);
  if (crop === 'unknown') notes.push(LENGTH_CROP_NOTE);
  else if (crop) next = withCrop(next, mapRect(g, crop), form);
  if (target.kind === 'figure') return { tr: withKeys(state, target, next), notes };
  const shapes = (dataOf(target.node)['data'] as AnnotationData | undefined) ?? {};
  return { tr: withKeys(state, target, next, remapAnnotations(shapes, g)), notes };
}

/** Does the selected picture carry anything Reset picture removes (a crop, a turn, a flip, redactions)? */
export function hasPictureEdits(state: EditorState): boolean {
  const target = pictureTarget(state);
  const keys = target ? keysOf(target) : null;
  if (!target || !keys) return false;
  if (RESET_KEYS.some((key) => keys[key] !== undefined && keys[key] !== '')) return true;
  return target.kind === 'annotated' && listOf((dataOf(target.node)['data'] as AnnotationData | undefined) ?? {}, 'redact').length > 0;
}

/**
 * Reset picture (Word's name; R-249, P27 amendment 2): removes the crop, the shift, the turn, the flip and the redactions in ONE
 * transaction; the shapes go back to where they were on the unturned picture exactly (the keys say what was done). Null when
 * there is nothing to reset.
 */
export function resetTransaction(state: EditorState): Change | null {
  if (!hasPictureEdits(state)) return null;
  const target = pictureTarget(state)!;
  const keys = keysOf(target)!;
  let next: Data = { ...keys };
  // FIX-CF (AD-FIX-CF-06): with a crop, `height` is the picture's box (the crop's own key): it goes with the crop; a figure's
  // plain height (no crop, no crop-fit) stays
  if (['crop-x', 'crop-y', 'crop-fit'].some((k) => keys[k] !== undefined && keys[k] !== '')) delete next['height'];
  for (const key of RESET_KEYS) delete next[key];
  if (target.kind === 'figure') return { tr: withKeys(state, target, next), notes: [] };
  let shapes: AnnotationData = { ...((dataOf(target.node)['data'] as AnnotationData | undefined) ?? {}) };
  delete shapes['redact'];
  for (const step of undoSteps(readRotate(keys['rotate']), readFlip(keys['flip']))) shapes = remapAnnotations(shapes, step);
  return { tr: withKeys(state, target, next, shapes), notes: [] };
}

// ── the shape commands (D4, D5, D7) ──

/** The annotated image the selection is on (NodeSelection), or null. */
export function annotatedTarget(state: EditorState): PictureTarget | null {
  const target = pictureTarget(state);
  return target?.kind === 'annotated' && !target.node.attrs['yamlError'] ? target : null;
}

/**
 * Can "Add <shape>" or Redact run: an annotated image, or any picture that can become one where it stands (R-248: a plain picture,
 * one in a sentence, a FIGURE, a cropped FIGURE: the crop is kept).
 */
export function canAnnotate(state: EditorState): boolean {
  return canBeBlock(state, pictureTarget(state), 'pmd_annotated_image');
}

/**
 * Adds a shape of `list` (or a redaction) to the selected annotated image, selected for editing; any other picture is made an
 * annotated image first, in the SAME transaction (R-248: one undo step; a picture in a sentence is put on its own line first).
 */
export function addShapeTransaction(state: EditorState, list: ShapeList, place?: (entry: Entry) => Entry): Transaction | null {
  const target = pictureTarget(state);
  if (!target || !canAnnotate(state)) return null;
  let tr: Transaction;
  let pos: number;
  let ref: ShapeRef;
  if (target.kind === 'annotated') {
    const data = dataOf(target.node);
    const added = placed(addShape((data['data'] as AnnotationData | undefined) ?? {}, list), place);
    ref = added.ref;
    pos = target.pos;
    tr = state.tr.setNodeMarkup(pos, undefined, { ...target.node.attrs, data: { ...data, data: added.data } });
    tr.setSelection(NodeSelection.create(tr.doc, pos));
  } else {
    const added = placed(addShape({}, list), place);
    const made = target.kind === 'figure' ? toAnnotated(state, target, { shapes: added.data }) : asBlock(state, target, 'pmd_annotated_image', (s, t) => toAnnotated(s, t, { shapes: added.data }));
    if (!made) return null;
    tr = made.tr;
    pos = tr.selection.from;
    ref = added.ref;
  }
  return requestShape(tr, pos, ref, true, true);
}

/** The new shape moved or resized by `place` (the draw mode's drag), if given. */
function placed(added: { data: AnnotationData; ref: ShapeRef }, place: ((entry: Entry) => Entry) | undefined): { data: AnnotationData; ref: ShapeRef } {
  const entry = place ? entryOf(added.data, added.ref) : undefined;
  return entry && place ? { ...added, data: withEntry(added.data, added.ref, place(entry)) } : added;
}

/** Can the selected picture be redacted: it can be (or is) an annotated image, and pagemd can bake it (a file, not a web or data: address). */
export function canRedact(state: EditorState): boolean {
  const target = pictureTarget(state);
  return canAnnotate(state) && !!target && !/^[a-z][a-z0-9+.-]*:/i.test(target.src);
}

/** Why Redact is off: the table-cell or heading reason, or a picture pagemd can't bake. */
export function redactReason(state: EditorState): string | null {
  const target = pictureTarget(state);
  if (target && target.src && /^[a-z][a-z0-9+.-]*:/i.test(target.src))
    return "A picture from a web or data: address can't be redacted: pagemd bakes a covered copy from a file next to the document, and stops the build otherwise";
  return blockReason(state);
}

/** Renumbers the selected annotated image's markers in reading order (D5); null when they are already in order. */
export function renumberTransaction(state: EditorState): Transaction | null {
  const target = annotatedTarget(state);
  if (!target) return null;
  const data = dataOf(target.node);
  const next = renumberMarkers((data['data'] as AnnotationData | undefined) ?? {});
  if (!next) return null;
  const tr = state.tr.setNodeMarkup(target.pos, undefined, { ...target.node.attrs, data: { ...data, data: next } });
  return tr.setSelection(NodeSelection.create(tr.doc, target.pos));
}

const SHAPE_ICONS: Readonly<Record<ShapeList, string>> = {
  markers: 'pinned',
  arrows: 'arrow-right',
  boxes: 'primitive-square',
  text: 'symbol-text',
  lines: 'dash',
  ellipses: 'circle-large',
  highlights: 'symbol-color',
  redact: 'eye-closed',
};

/** The shapes drawn by dragging (FIX-S50, OQ-63); Redact too (image-tools.ts). */
export const DRAWN: readonly ShapeList[] = ['arrows', 'lines', 'boxes', 'ellipses', 'highlights', 'redact'];

/** The order the shape commands are listed in. */
export const ADD_ORDER: readonly ShapeList[] = ['markers', 'arrows', 'boxes', 'text', 'lines', 'ellipses', 'highlights'];

export const addShapeId = (list: ShapeList): string => `annotated-image.add-${SHAPE_NAME[list].toLowerCase().replace(/ .*/, '')}`;

/** "Add marker" … "Add highlight", "Renumber markers" (on the annotated-image item; the Image tab's Shapes, P20). */
export const shapeCommands: CommandSpec[] = [
  ...ADD_ORDER.map(
    (list): CommandSpec => ({
      id: addShapeId(list),
      label: `Add ${SHAPE_NAME[list].toLowerCase()}`,
      icon: SHAPE_ICONS[list],
      slash: false,
      isEnabled: (state) => canAnnotate(state),
      // R-248 / P27 amendment 1: off only in a table cell or a heading, and then the button says why.
      reason: blockReason,
      run: (state, dispatch) => {
        // FIX-S50 (OQ-63): a line, arrow, box, ellipse or highlight is drawn: a crosshair, a drag on the picture (draw-mode.ts). A
        // marker or a text note is dropped in the middle, as before (a click place for them is not asked for).
        if (DRAWN.includes(list)) {
          const target = pictureTarget(state);
          if (!target || !canAnnotate(state)) return false;
          dispatch(requestDraw(state.tr.setSelection(NodeSelection.create(state.doc, target.pos)), target.pos, list));
          return true;
        }
        const tr = addShapeTransaction(state, list);
        if (!tr) return false;
        dispatch(tr);
        return true;
      },
    }),
  ),
  {
    id: 'annotated-image.renumber',
    label: 'Renumber markers',
    icon: 'list-ordered',
    slash: false,
    isEnabled: (state) => renumberTransaction(state) !== null,
    run: (state, dispatch) => {
      const tr = renumberTransaction(state);
      if (!tr) return false;
      dispatch(tr);
      return true;
    },
  },
];

// ── the Image tab (P20) ──

/**
 * Is a picture selected as an object (a NodeSelection on a plain image, an embed, a FIGURE or an annotated image)? The
 * Image tab shows only then (P20, AD-P20-04). Unlike `pictureTarget`, a text cursor next to a lone picture does not count:
 * arrow keys onto a picture select it as an object, so the keyboard reaches the tab that way.
 */
export function pictureSelected(state: EditorState): boolean {
  const sel = state.selection;
  return sel instanceof NodeSelection && NODE_KIND[sel.node.type.name] !== undefined;
}

/** pagemd's own figure widths (`width="half"`, FIGURE and annotated image; `base.css`'s `.width-*`). */
export const PICTURE_WIDTHS = ['full', 'half', 'third', 'quarter'] as const;
export type PictureWidth = (typeof PICTURE_WIDTHS)[number];

/** Why Size is off for an embedded image inside a sentence (it can only be sized as a figure on a line of its own). */
export const FIGURE_ONLY_REASON = 'An embedded image inside a sentence can\'t be sized: put it on a line of its own first';

/** The FIGURE parameters (figure) or the YAML options (annotated image) of the selected picture: what Size and Caption change. */
function pictureOptions(target: PictureTarget): Data | null {
  const data = dataOf(target.node);
  if (target.kind === 'figure') return (data['attrs'] as Data | undefined) ?? {};
  if (target.kind === 'annotated') return target.node.attrs['yamlError'] ? null : (((data['data'] as Data | undefined)?.['options'] as Data | undefined) ?? {});
  return null;
}

/** The picture selected as an object whose size and caption can change (a FIGURE or an annotated image), else null. */
function sizedTarget(state: EditorState): PictureTarget | null {
  if (!pictureSelected(state)) return null;
  const target = pictureTarget(state);
  return target && pictureOptions(target) ? target : null;
}

/**
 * The picture selected as an object that Size works on: any picture, as in Word (user rule 2026-10-23, R-236, AD-FIX-WS-03). A
 * FIGURE or annotated image takes `width`; a plain image takes pagemd's class `.width-half`; an embed on a line of its own
 * becomes a FIGURE with the width (embeds have no place for attributes).
 */
function sizeTarget(state: EditorState): PictureTarget | null {
  if (!pictureSelected(state)) return null;
  const target = pictureTarget(state);
  if (!target) return null;
  if (target.kind === 'embed') return figureFits(state, target) ? target : null;
  if (target.kind === 'annotated' && target.node.attrs['yamlError']) return null;
  return target;
}

/** A plain image's `[key, value]` attribute pairs with every size taken out (the `.width-*` class, `width`, `height`), then `width` put in as the class. */
function sizedPairs(node: Node, width: PictureWidth | null): [string, string][] | null {
  const out: [string, string][] = [];
  const classes: string[] = [];
  let classAt = -1;
  for (const [key, value] of (node.attrs[ATTRS] as [string, string][] | null) ?? []) {
    if (key === 'width' || key === 'height') continue;
    if (key === 'class') {
      if (classAt < 0) classAt = out.length;
      classes.push(...value.split(/\s+/).filter((name) => name && !WIDTH_CLASS.test(name)));
    } else out.push([key, value]);
  }
  if (width) classes.push(`width-${width}`);
  if (classes.length) out.splice(classAt < 0 ? out.length : classAt, 0, ['class', classes.join(' ')]);
  return out.length ? out : null;
}

/** The selected picture's options with `key` set (or removed, for null): one transaction, the picture stays selected. Null when nothing changes. */
export function setPictureOption(state: EditorState, key: 'width' | 'caption', value: string | null): Transaction | null {
  if (key === 'width') return setPictureWidth(state, value as PictureWidth | null);
  const target = sizedTarget(state);
  if (!target) return null;
  const current = pictureOptions(target)!;
  if ((value === null && current[key] === undefined) || current[key] === value) return null;
  const options: Data = { ...current };
  if (value === null) delete options[key];
  else options[key] = value;
  const data = dataOf(target.node);
  const next = target.kind === 'figure' ? { ...data, attrs: options } : { ...data, data: { ...((data['data'] as Data | undefined) ?? {}), options } };
  const tr = state.tr.setNodeMarkup(target.pos, undefined, { ...target.node.attrs, data: next });
  return tr.setSelection(NodeSelection.create(tr.doc, target.pos));
}

/** Size, for any picture (see `sizeTarget`); one transaction (one undo step), the picture stays selected. Null when nothing changes. */
function setPictureWidth(state: EditorState, width: PictureWidth | null): Transaction | null {
  const target = sizeTarget(state);
  if (!target) return null;
  if (target.kind === 'embed') return width ? (toFigure(state, target, null, { width })?.tr ?? null) : null;
  if (target.kind === 'image') {
    const pairs = sizedPairs(target.node, width);
    if (JSON.stringify(pairs) === JSON.stringify(target.node.attrs[ATTRS] ?? null)) return null;
    const tr = state.tr.setNodeMarkup(target.pos, undefined, { ...target.node.attrs, [ATTRS]: pairs });
    return tr.setSelection(NodeSelection.create(tr.doc, target.pos));
  }
  return setFigureOption(state, target, 'width', width);
}

function setFigureOption(state: EditorState, target: PictureTarget, key: 'width', value: string | null): Transaction | null {
  const current = pictureOptions(target)!;
  if ((value === null && current[key] === undefined) || current[key] === value) return null;
  const options: Data = { ...current };
  if (value === null) delete options[key];
  else options[key] = value;
  const data = dataOf(target.node);
  const next = target.kind === 'figure' ? { ...data, attrs: options } : { ...data, data: { ...((data['data'] as Data | undefined) ?? {}), options } };
  const tr = state.tr.setNodeMarkup(target.pos, undefined, { ...target.node.attrs, data: next });
  return tr.setSelection(NodeSelection.create(tr.doc, target.pos));
}

/** The selected picture's width as written ('' when none). */
export function pictureWidth(state: EditorState): string {
  const target = sizeTarget(state);
  if (!target) return '';
  if (target.kind === 'image') {
    for (const [key, value] of (target.node.attrs[ATTRS] as [string, string][] | null) ?? []) {
      if (key !== 'class') continue;
      for (const name of value.split(/\s+/)) {
        const size = WIDTH_CLASS.exec(name);
        if (size) return size[1]!;
      }
    }
    return '';
  }
  return target.kind === 'embed' ? '' : str(pictureOptions(target)!['width']);
}

/** Does the selected picture carry any size of its own (Original size has something to remove)? */
function hasSize(state: EditorState): boolean {
  const target = sizeTarget(state);
  if (!target) return false;
  if (target.kind === 'image') return ((target.node.attrs[ATTRS] as [string, string][] | null) ?? []).some(([key, value]) => key === 'width' || key === 'height' || (key === 'class' && value.split(/\s+/).some((n) => WIDTH_CLASS.test(n))));
  return pictureWidth(state) !== '';
}

/** The selected picture's caption as written ('' when none, or for a plain image or embed). */
export function pictureCaption(state: EditorState): string {
  const target = sizedTarget(state);
  return target ? str(pictureOptions(target)!['caption']) : '';
}

/** The off reason for Size: an embed inside a sentence is selected. */
const figureOnly = (state: EditorState): string | null => (pictureSelected(state) && !sizeTarget(state) && pictureTarget(state)?.kind === 'embed' ? FIGURE_ONLY_REASON : null);

const WIDTH_LABELS: Readonly<Record<PictureWidth, string>> = { full: 'Full width', half: 'Half width', third: 'Third width', quarter: 'Quarter width' };

/**
 * Image tab > Size (P20, AD-P20-05; every picture since AD-FIX-WS-03): pagemd's own `width` on a FIGURE or an annotated image, `.width-*` on a plain image, one edit and one undo step
 * each; "Original size" removes it. Nothing new is written: the FIGURE line and the YAML come from @pagemd/syntax's write rules.
 */
export const pictureSizeCommands: CommandSpec[] = [
  ...PICTURE_WIDTHS.map(
    (width): CommandSpec => ({
      id: `picture.width-${width}`,
      label: WIDTH_LABELS[width],
      icon: width === 'full' ? 'screen-full' : 'screen-normal',
      slash: false,
      isEnabled: (state) => sizeTarget(state) !== null,
      isActive: (state) => pictureWidth(state) === width,
      reason: figureOnly,
      run: (state, dispatch) => {
        const tr = setPictureOption(state, 'width', width);
        if (!tr) return false;
        dispatch(tr);
        return true;
      },
    }),
  ),
  {
    id: 'picture.width-original',
    label: 'Original size',
    icon: 'discard',
    slash: false,
    isEnabled: (state) => hasSize(state),
    reason: figureOnly,
    run: (state, dispatch) => {
      const tr = setPictureOption(state, 'width', null);
      if (!tr) return false;
      dispatch(tr);
      return true;
    },
  },
  {
    id: 'picture.caption-remove',
    label: 'Remove caption',
    icon: 'close',
    slash: false,
    isEnabled: (state) => pictureCaption(state) !== '',
    run: (state, dispatch) => {
      const tr = setPictureOption(state, 'caption', null);
      if (!tr) return false;
      dispatch(tr);
      return true;
    },
  },
];

/** Which Inspector box holds the selected picture's caption, alt text or path (its `data-field`), or null. */
export function pictureField(state: EditorState, what: 'caption' | 'alt' | 'path'): string | null {
  if (!pictureSelected(state)) return null;
  const target = pictureTarget(state);
  if (!target) return null;
  // FIX-S50 (AD-FIX-S50-07): a picture in the middle of a sentence gets a caption too, as Word's Insert Caption does: it is put on a line of its own first.
  if (what === 'caption' && (target.kind === 'image' || target.kind === 'embed')) return canBeBlock(state, target, 'pmd_figure') ? 'caption' : null;
  if (target.kind === 'annotated') return target.node.attrs['yamlError'] ? null : what === 'path' ? 'src' : `options.${what}`;
  // A plain image or embed on its own gets its caption as Word's Insert Caption does: it becomes a figure first (captionFigure).
  if (what === 'caption') return target.kind === 'figure' ? 'caption' : null;
  if (what === 'path') return target.kind === 'embed' ? 'path' : 'src';
  return 'alt';
}

/** Caption on a plain image or an embed (AD-FIX-WS-04): it becomes a FIGURE in one transaction, so the caption box exists; null for any other picture. */
export function captionFigure(state: EditorState): Change | null {
  const target = pictureTarget(state);
  return target && (target.kind === 'image' || target.kind === 'embed') ? asBlock(state, target, 'pmd_figure', toFigure) : null;
}

/** Is `(what)` reachable for the selection (the Image tab's Caption and Details buttons)? */
export const canFocusPictureField = (state: EditorState, what: 'caption' | 'alt' | 'path'): boolean => pictureField(state, what) !== null;
