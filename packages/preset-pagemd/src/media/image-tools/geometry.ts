// The annotated image's shapes as data (P15, ADR-0018 decision 1): moving, resizing, adding, deleting and renumbering
// them, and moving them with the picture when it is turned or flipped (P27, ADR-0019: the keys `rotate`/`flip`, never pixels),
// all in % of the picture as shown (0-100), as pagemd writes them. Redactions (`redact:`, R-251) are a list of rectangles too.
// Pure functions on the item's write data (`data.data`, the YAML's value as @pagemd/syntax read it, C2): an edit changes
// only the entries it touches, so the item's own write rule rewrites only those YAML lines (C3, A2). No YAML is read here
// (I1). Also the crop maths (crop-x/crop-y/pos-x/pos-y in % of the shown picture, both forms, C13), checked against
// pagemd's drawing (figure.js, picture.js): crop-x is the share of the width shown, and pos-x = -(left edge)%.
// Rules carried over from pagemd-image-tool (ADR-0018 consequences): marker renumbering in reading order (bands of 5 % of
// the height, then left to right: ImageDocument.cs RenumberMarkers), the thin-line hit width (AnnotationRenderer.cs).

export type Entry = Record<string, unknown>;

/** The shape lists of an annotated image (pagemd's keys, C9 / R-80), and its redactions (`redact`, C13, R-251: rectangles). */
export type ShapeList = 'markers' | 'arrows' | 'boxes' | 'text' | 'lines' | 'ellipses' | 'highlights' | 'redact';

/** Every list, in pagemd's drawing order bottom to top (redactions under everything, AD-C13-11; highlights under boxes and ellipses, under lines and arrows; then text notes and markers). */
export const SHAPE_LISTS: readonly ShapeList[] = ['redact', 'highlights', 'boxes', 'ellipses', 'lines', 'arrows', 'text', 'markers'];

/** Where a shape is: one point (a marker, a text note's top-left corner), two end points, or a rectangle (top-left, size). */
export type ShapeKind = 'point' | 'segment' | 'rect';

export const KIND_OF: Readonly<Record<ShapeList, ShapeKind>> = {
  markers: 'point',
  text: 'point',
  arrows: 'segment',
  lines: 'segment',
  boxes: 'rect',
  ellipses: 'rect',
  highlights: 'rect',
  redact: 'rect',
};

/** The singular name for labels ("Marker 2", "Add marker"). */
export const SHAPE_NAME: Readonly<Record<ShapeList, string>> = {
  markers: 'Marker',
  arrows: 'Arrow',
  boxes: 'Box',
  text: 'Text note',
  lines: 'Line',
  ellipses: 'Ellipse',
  highlights: 'Highlight',
  redact: 'Redaction',
};

/** Shapes that can have a numbered badge in the legend (`id` + `label`); markers always do. */
const LEGEND_LISTS: readonly ShapeList[] = ['markers', 'arrows', 'boxes', 'lines', 'ellipses'];

export interface ShapeRef {
  list: ShapeList;
  index: number;
}

/** A rectangle in % of the image. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** The annotation data an annotated image's node carries (`data.data`): options plus the shape lists. */
export type AnnotationData = Record<string, unknown>;

/** The Inspector's field path for a shape ("markers.2"), as the form names its list rows. */
export const fieldOf = (ref: ShapeRef): string => `${ref.list}.${ref.index}`;

/** The shape a field path names ("markers.2.x" → markers 2), or null. */
export function refOfField(field: string): ShapeRef | null {
  const m = /^(markers|arrows|boxes|text|lines|ellipses|highlights|redact)\.(\d+)(?:\.|$)/.exec(field);
  return m ? { list: m[1] as ShapeList, index: Number(m[2]) } : null;
}

// ── numbers ──

/** Two decimals, the way coordinates are written (0.01 % of a 4000 px image is 0.4 px); never "-0". */
export function round2(value: number): number {
  const r = Math.round(value * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
}

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);
const pct = (value: number): number => clamp(value, 0, 100);
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : NaN);

/** The smallest a rectangle may be resized to, in % (so a handle never folds it away). */
export const MIN_SIZE = 0.5;

// ── reading a shape ──

export function listOf(data: AnnotationData | undefined, list: ShapeList): Entry[] {
  const value = data?.[list];
  return Array.isArray(value) ? (value as Entry[]) : [];
}

export function entryOf(data: AnnotationData | undefined, ref: ShapeRef): Entry | undefined {
  const entry = listOf(data, ref.list)[ref.index];
  return entry && typeof entry === 'object' ? entry : undefined;
}

/** Does this entry have the numbers its kind needs (else pagemd drops it, and it can't be dragged)? */
export function isPlaced(entry: Entry | undefined, kind: ShapeKind): entry is Entry {
  if (!entry) return false;
  const keys = kind === 'point' ? ['x', 'y'] : kind === 'segment' ? ['x1', 'y1', 'x2', 'y2'] : ['x', 'y', 'width', 'height'];
  return keys.every((k) => Number.isFinite(num(entry[k])));
}

/** Every shape that can be drawn and dragged, in drawing order bottom to top. */
export function placedShapes(data: AnnotationData | undefined): ShapeRef[] {
  const out: ShapeRef[] = [];
  for (const list of SHAPE_LISTS) listOf(data, list).forEach((entry, index) => isPlaced(entry, KIND_OF[list]) && out.push({ list, index }));
  return out;
}

/** The order Tab walks the shapes in: the lists as the Inspector shows them (markers first), each in its own order. */
export function tabOrder(data: AnnotationData | undefined): ShapeRef[] {
  const order: ShapeList[] = ['markers', 'arrows', 'boxes', 'text', 'lines', 'ellipses', 'highlights', 'redact'];
  return order.flatMap((list) => listOf(data, list).flatMap((entry, index) => (isPlaced(entry, KIND_OF[list]) ? [{ list, index }] : [])));
}

/** A shape's box in % (a point has no size; a segment's box holds both ends). Clamped to the image, as pagemd draws it. */
export function boundsOf(entry: Entry, kind: ShapeKind): Rect {
  if (kind === 'point') return { x: pct(num(entry['x'])), y: pct(num(entry['y'])), width: 0, height: 0 };
  if (kind === 'segment') {
    const [x1, y1, x2, y2] = ['x1', 'y1', 'x2', 'y2'].map((k) => pct(num(entry[k]))) as [number, number, number, number];
    return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
  }
  const x = pct(num(entry['x']));
  const y = pct(num(entry['y']));
  return { x, y, width: clamp(num(entry['width']), 0, 100 - x), height: clamp(num(entry['height']), 0, 100 - y) };
}

/** A readable name for a shape, for screen readers and messages: "Marker 2", "Arrow 1", "Text note 3 (Click here)". */
export function shapeLabel(ref: ShapeRef, entry: Entry | undefined): string {
  const name = SHAPE_NAME[ref.list];
  const id = entry?.['id'];
  const label = typeof entry?.['label'] === 'string' ? (entry['label'] as string) : typeof entry?.['text'] === 'string' ? (entry['text'] as string) : '';
  const number = id !== undefined && id !== null && id !== '' ? String(id) : String(ref.index + 1);
  return label ? `${name} ${number} (${label})` : `${name} ${number}`;
}

// ── changing a shape ──

/** `entry` with these numbers written (two decimals), keeping every other key and the author's key order. */
function withNumbers(entry: Entry, values: Record<string, number>): Entry {
  const out: Entry = { ...entry };
  for (const [key, value] of Object.entries(values)) out[key] = round2(value);
  return out;
}

/** The entry moved by (dx, dy) %, kept inside the image as a whole (a box doesn't change size at an edge). */
export function moveEntry(entry: Entry, kind: ShapeKind, dx: number, dy: number): Entry {
  if (kind === 'point') return withNumbers(entry, { x: pct(num(entry['x']) + dx), y: pct(num(entry['y']) + dy) });
  if (kind === 'segment') {
    const xs = [num(entry['x1']), num(entry['x2'])];
    const ys = [num(entry['y1']), num(entry['y2'])];
    const mx = clamp(dx, -Math.min(...xs), 100 - Math.max(...xs));
    const my = clamp(dy, -Math.min(...ys), 100 - Math.max(...ys));
    return withNumbers(entry, { x1: xs[0]! + mx, y1: ys[0]! + my, x2: xs[1]! + mx, y2: ys[1]! + my });
  }
  const b = boundsOf(entry, kind);
  return withNumbers(entry, { x: clamp(b.x + dx, 0, 100 - b.width), y: clamp(b.y + dy, 0, 100 - b.height) });
}

/** The handles of a kind: a segment's two ends, a rectangle's four corners (a point only moves). */
export type Handle = 'start' | 'end' | 'nw' | 'ne' | 'sw' | 'se';

export const HANDLES: Readonly<Record<ShapeKind, readonly Handle[]>> = { point: [], segment: ['start', 'end'], rect: ['nw', 'ne', 'sw', 'se'] };

export const HANDLE_NAME: Readonly<Record<Handle, string>> = {
  start: 'Start point',
  end: 'End point',
  nw: 'Top-left corner',
  ne: 'Top-right corner',
  sw: 'Bottom-left corner',
  se: 'Bottom-right corner',
};

export function handlePoint(entry: Entry, kind: ShapeKind, handle: Handle): Point {
  if (handle === 'start') return { x: pct(num(entry['x1'])), y: pct(num(entry['y1'])) };
  if (handle === 'end') return { x: pct(num(entry['x2'])), y: pct(num(entry['y2'])) };
  const b = boundsOf(entry, kind);
  return { x: handle === 'nw' || handle === 'sw' ? b.x : b.x + b.width, y: handle === 'nw' || handle === 'ne' ? b.y : b.y + b.height };
}

/** The entry with `handle` dragged to (x, y) %: an end point moves alone; a corner moves with the opposite corner fixed. */
export function dragHandle(entry: Entry, kind: ShapeKind, handle: Handle, x: number, y: number): Entry {
  const px = pct(x);
  const py = pct(y);
  if (handle === 'start') return withNumbers(entry, { x1: px, y1: py });
  if (handle === 'end') return withNumbers(entry, { x2: px, y2: py });
  const b = boundsOf(entry, kind);
  const fixedX = handle === 'nw' || handle === 'sw' ? b.x + b.width : b.x;
  const fixedY = handle === 'nw' || handle === 'ne' ? b.y + b.height : b.y;
  const left = Math.min(px, fixedX);
  const top = Math.min(py, fixedY);
  const width = Math.max(Math.abs(px - fixedX), MIN_SIZE);
  const height = Math.max(Math.abs(py - fixedY), MIN_SIZE);
  return withNumbers(entry, { x: Math.min(left, 100 - width), y: Math.min(top, 100 - height), width, height });
}

/** `data` with the shape at `ref` replaced by `entry` (the other lists and entries are the same objects). */
export function withEntry(data: AnnotationData, ref: ShapeRef, entry: Entry): AnnotationData {
  const list = [...listOf(data, ref.list)];
  list[ref.index] = entry;
  return { ...data, [ref.list]: list };
}

/** `data` without the shape at `ref`. An emptied list stays as an empty list (the write rule then leaves the key out). */
export function withoutEntry(data: AnnotationData, ref: ShapeRef): AnnotationData {
  const list = listOf(data, ref.list).filter((_, i) => i !== ref.index);
  return { ...data, [ref.list]: list };
}

/** The next free legend number: one more than the largest number any legend shape uses. */
export function nextLegendId(data: AnnotationData | undefined): number {
  let max = 0;
  for (const list of LEGEND_LISTS) {
    for (const entry of listOf(data, list)) {
      const id = Number.parseInt(String(entry?.['id'] ?? ''), 10);
      if (Number.isFinite(id)) max = Math.max(max, id);
    }
  }
  return max + 1;
}

/** A new shape in the middle of the image (R-194 amendment 9), with what pagemd needs to draw it; defaults are left out. */
export function newShape(list: ShapeList, data: AnnotationData | undefined): Entry {
  switch (list) {
    case 'markers': {
      const id = nextLegendId(data);
      return { id, x: 50, y: 50, label: `Marker ${id}` };
    }
    case 'arrows':
      return { x1: 35, y1: 35, x2: 50, y2: 50 };
    case 'lines':
      return { x1: 35, y1: 50, x2: 65, y2: 50 };
    case 'boxes':
    case 'ellipses':
      return { x: 40, y: 40, width: 20, height: 20 };
    case 'highlights':
    case 'redact':
      return { x: 35, y: 45, width: 30, height: 10 };
    case 'text':
      return { x: 45, y: 45, text: 'Text' };
  }
}

/** `data` with a new shape of `list` at the end of that list, and where it is. */
export function addShape(data: AnnotationData, list: ShapeList): { data: AnnotationData; ref: ShapeRef } {
  const entries = [...listOf(data, list), newShape(list, data)];
  return { data: { ...data, [list]: entries }, ref: { list, index: entries.length - 1 } };
}

/**
 * Markers numbered 1…N in reading order (D5, R-194 amendment 11): top to bottom in bands of 5 % of the height, then left
 * to right. Only `id` changes, and only where it differs; the list keeps its order (the legend sorts by number). Markers
 * without a position keep their number. Null when nothing changes.
 */
export function renumberMarkers(data: AnnotationData): AnnotationData | null {
  const markers = listOf(data, 'markers');
  const placed = markers.map((entry, index) => ({ entry, index })).filter(({ entry }) => isPlaced(entry, 'point'));
  placed.sort((a, b) => Math.floor(num(a.entry['y']) / 5) - Math.floor(num(b.entry['y']) / 5) || num(a.entry['x']) - num(b.entry['x']) || a.index - b.index);
  const next = [...markers];
  let changed = false;
  placed.forEach(({ entry, index }, order) => {
    const id = order + 1;
    if (String(entry['id']) === String(id)) return;
    next[index] = { ...entry, id };
    changed = true;
  });
  return changed ? { ...data, markers: next } : null;
}


// ── turning and flipping the picture (P27, R-249, ADR-0019: render-time keys, never pixels) ──

/**
 * What Rotate or Flip does to the picture AS SHOWN (the displayed picture: turned by `rotate`, then flipped by `flip`, as
 * pagemd draws it). Shapes, redactions and a % crop are stored in % of the displayed picture, so they move through the same map.
 */
export type Geometry = { kind: 'rotate'; turn: 'left' | 'right' } | { kind: 'flip'; axis: 'horizontal' | 'vertical' };

/** Where the point (x, y) % of the displayed picture is after `g`. */
export function mapPoint(g: Geometry, x: number, y: number): Point {
  if (g.kind === 'rotate')
    // a quarter turn clockwise: the left edge becomes the top; anticlockwise: the top becomes the left edge
    return g.turn === 'right' ? { x: 100 - y, y: x } : { x: y, y: 100 - x };
  return g.axis === 'horizontal' ? { x: 100 - x, y } : { x, y: 100 - y };
}

/** A rectangle mapped through `g` (its corners, put back in order). */
export function mapRect(g: Geometry, r: Rect): Rect {
  const a = mapPoint(g, r.x, r.y);
  const b = mapPoint(g, r.x + r.width, r.y + r.height);
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
}

/**
 * Every shape and redaction moved to where its part of the picture is after `g` (every coordinate through the same map; a
 * turn or a flip keeps everything inside the picture, so nothing is cut or dropped). Entries pagemd can't draw (missing
 * numbers) are kept as written; lists that don't change stay the same objects.
 */
export function remapAnnotations(data: AnnotationData, g: Geometry): AnnotationData {
  const out: AnnotationData = { ...data };
  for (const list of SHAPE_LISTS) {
    const entries = listOf(data, list);
    if (entries.length === 0) continue;
    const kind = KIND_OF[list];
    out[list] = entries.map((entry): Entry => {
      if (!isPlaced(entry, kind)) return entry;
      if (kind === 'point') {
        const p = mapPoint(g, num(entry['x']), num(entry['y']));
        return withNumbers(entry, { x: p.x, y: p.y });
      }
      if (kind === 'segment') {
        const a = mapPoint(g, num(entry['x1']), num(entry['y1']));
        const b = mapPoint(g, num(entry['x2']), num(entry['y2']));
        return withNumbers(entry, { x1: a.x, y1: a.y, x2: b.x, y2: b.y });
      }
      const r = mapRect(g, { x: num(entry['x']), y: num(entry['y']), width: num(entry['width']), height: num(entry['height']) });
      return withNumbers(entry, { x: r.x, y: r.y, width: r.width, height: r.height });
    });
  }
  return out;
}

/** The turns `rotate` accepts (clockwise) and the flips `flip` accepts (C13). */
export type Turn = 0 | 90 | 180 | 270;
export type Flip = '' | 'h' | 'v' | 'hv';

/** `rotate` as written (a number or digits) → 0, 90, 180 or 270; anything else 0 (as pagemd reads it). */
export function readRotate(value: unknown): Turn {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\s*\d+\s*$/.test(value) ? Number(value) : NaN;
  return n === 90 || n === 180 || n === 270 ? n : 0;
}

/** `flip` as written → '', 'h', 'v' or 'hv' (as pagemd reads it). */
export function readFlip(value: unknown): Flip {
  const text = typeof value === 'string' ? value.trim() : '';
  return text === 'h' || text === 'v' || text === 'hv' ? text : '';
}

/**
 * The keys after `g` is done to the picture as shown. pagemd shows the file turned by `rotate`, THEN flipped (C13). Flipping
 * the shown picture adds a flip; turning it is a turn the same way, except over a single flip (h or v), where a quarter turn
 * of the shown picture is a quarter turn the other way under the flip (Word's behaviour: the picture on the page turns the
 * way the button says, flipped or not).
 */
export function turnedKeys(rotate: Turn, flip: Flip, g: Geometry): { rotate: Turn; flip: Flip } {
  if (g.kind === 'flip') {
    const h = (flip === 'h' || flip === 'hv') !== (g.axis === 'horizontal');
    const v = (flip === 'v' || flip === 'hv') !== (g.axis === 'vertical');
    return { rotate, flip: h && v ? 'hv' : h ? 'h' : v ? 'v' : '' };
  }
  const single = flip === 'h' || flip === 'v';
  const step = (g.turn === 'right') !== single ? 90 : 270;
  return { rotate: ((rotate + step) % 360) as Turn, flip };
}

/**
 * The steps that undo `rotate` and `flip` (Reset picture): the flip first (pagemd applies it last), then the turn back. Each
 * step is a turn or a flip of the shown picture, so the shapes move back exactly (100 - x and swapped axes only, R-249).
 */
export function undoSteps(rotate: Turn, flip: Flip): Geometry[] {
  const steps: Geometry[] = [];
  if (flip === 'h' || flip === 'hv') steps.push({ kind: 'flip', axis: 'horizontal' });
  if (flip === 'v' || flip === 'hv') steps.push({ kind: 'flip', axis: 'vertical' });
  for (let turned = rotate; turned > 0; turned -= 90) steps.push({ kind: 'rotate', turn: 'left' });
  return steps;
}

// ── the crop (R-249: keys, never pixels; written in % of the shown picture by default) ──

/** The crop keys, on a FIGURE (its parameters) and an annotated image (its options). `crop-fit` belongs to the crop too. */
export const CROP_KEYS = ['crop-x', 'crop-y', 'pos-x', 'pos-y'] as const;
/** What Reset picture removes (R-249, AD-P27-06): the crop, the shift, the turn and the flip (and an annotated image's `redact`). */
export const RESET_KEYS = [...CROP_KEYS, 'crop-fit', 'rotate', 'flip'] as const;

const fmt = (value: number): string => String(round2(value));

const PERCENT = /^\s*(\d+(?:\.\d+)?)\s*%?\s*$/;
const SHIFT = /^\s*(-?\d+(?:\.\d+)?)\s*%?\s*$/;

/** A crop value as % (a number or "50" / "50%"), undefined when it is a CSS length (px, em …) or unreadable; null when not set. */
function cropPercent(value: unknown): number | null | undefined {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  const m = typeof value === 'string' ? PERCENT.exec(value) : null;
  return m ? Number(m[1]) : undefined;
}

/** A pos-x/pos-y value as the % the window's edge is in from the picture's edge (a bare number is %, C13); undefined for another unit. */
function posPercent(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? -value : undefined;
  const text = typeof value === 'string' ? value.trim() : '';
  if (/^-?0+(\.0+)?(px|%|em|rem)?$/.test(text)) return 0;
  const m = SHIFT.exec(text);
  return m ? -Number(m[1]) : undefined;
}

/**
 * The rectangle (% of the shown picture) a crop's keys show; null without a crop; 'unknown' when a crop or a shift uses a
 * CSS length (px, em …): its place on the picture depends on the drawn size, which only the browser knows.
 */
export function cropRectOf(keys: Record<string, unknown>): Rect | null | 'unknown' {
  const has = CROP_KEYS.some((k) => keys[k] !== undefined && keys[k] !== '');
  if (!has) return null;
  const cropX = cropPercent(keys['crop-x']);
  const cropY = cropPercent(keys['crop-y']);
  const left = posPercent(keys['pos-x']);
  const top = posPercent(keys['pos-y']);
  if (cropX === undefined || cropY === undefined || left === undefined || top === undefined) return 'unknown';
  const x = pct(left);
  const y = pct(top);
  return {
    x,
    y,
    width: Math.min(cropX !== null && cropX > 0 ? cropX : 100, 100 - x),
    height: Math.min(cropY !== null && cropY > 0 ? cropY : 100, 100 - y),
  };
}

/** Is this rectangle the whole picture (nothing cropped)? */
export const wholePicture = (r: Rect): boolean => round2(r.x) <= 0 && round2(r.y) <= 0 && round2(r.width) >= 100 && round2(r.height) >= 100;

/**
 * The crop keys that show only `rect` (% of the shown picture): crop-x/crop-y are the share of the width/height shown,
 * pos-x/pos-y move the picture so the rectangle's left/top edge is at the window's edge (negative %). A side that is not cropped
 * is left out. `form` 'figure' writes FIGURE's text values (`crop-x="50" pos-x="-10%"`, as before); 'yaml' writes numbers (a
 * bare number is % in the YAML, C13 AD-C13-04: `crop-x: 50`, `pos-x: -10`).
 */
export function cropKeysFor(rect: Rect, form: 'figure' | 'yaml' = 'figure'): Partial<Record<(typeof CROP_KEYS)[number], string | number>> {
  const out: Partial<Record<(typeof CROP_KEYS)[number], string | number>> = {};
  const x = round2(pct(rect.x));
  const y = round2(pct(rect.y));
  const w = round2(clamp(rect.width, 0, 100 - x));
  const h = round2(clamp(rect.height, 0, 100 - y));
  const yaml = form === 'yaml';
  if (w < 100) out['crop-x'] = yaml ? w : fmt(w);
  if (h < 100) out['crop-y'] = yaml ? h : fmt(h);
  if (x > 0) out['pos-x'] = yaml ? -x : `-${fmt(x)}%`;
  if (y > 0) out['pos-y'] = yaml ? -y : `-${fmt(y)}%`;
  return out;
}

/**
 * `keys` with the crop set to `rect` (null or the whole picture: no crop). Every other key is kept where it was; a key that
 * stays is rewritten in place, a new one goes at the end (so the author's order is kept and only that line changes).
 */
export function withCrop(keys: Record<string, unknown>, rect: Rect | null, form: 'figure' | 'yaml' = 'figure'): Record<string, unknown> {
  const next = rect && !wholePicture(rect) ? cropKeysFor(rect, form) : {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(keys)) {
    if (!(CROP_KEYS as readonly string[]).includes(key)) out[key] = value;
    else if (key in next) out[key] = next[key as (typeof CROP_KEYS)[number]];
  }
  for (const [key, value] of Object.entries(next)) if (!(key in out)) out[key] = value;
  return out;
}
