// The Inspector's decisions, without a DOM (P8; tested as models plus Playwright, like P7's components, AD-P7-12):
// which properties the Document tab lists and how each is marked, how typed text becomes a value, and how a value
// inside a list or group is changed.
import type { FieldSpec, ItemField, MetaCatalogue, PropertiesState } from '@pagemd-editor/core';

/** What the profile and template say about the properties (the host works it out: protocol v5's PropertiesInfo). */
export interface PropertyHints {
  /** The profile's required properties, as written there. */
  required: readonly string[];
  /** Properties the template shows on the page. */
  shownOnPage: readonly string[];
  /** Fields only this profile has. */
  profileFields: readonly FieldSpec[];
  /** The profile's own defaults. */
  defaults: Readonly<Record<string, unknown>>;
}

export const NO_HINTS: PropertyHints = Object.freeze({ required: [], shownOnPage: [], profileFields: [], defaults: {} });

/** One row of the Document tab. */
export interface PropertyRow {
  /** The catalogue's name (or the written key when the catalogue doesn't know it). */
  key: string;
  /** The key the author wrote; undefined when the property isn't in the frontmatter yet. */
  written?: string;
  label: string;
  help: string;
  /** How the value is edited. 'raw': too complex for the form (a map, a list of maps): the raw YAML view only. */
  type: ItemField['type'] | 'date' | 'raw';
  values?: readonly string[];
  value: unknown;
  /** What the property is when it is left out: the profile's default, else pagemd's own. */
  fallback?: unknown;
  required: boolean;
  shownOnPage: boolean;
  /** Filled in at render time (e.g. a timestamp): never offered to add. */
  generated: boolean;
}

export interface DocumentModel {
  rows: PropertyRow[];
  /** Properties that can be added: the rest of the catalogue and the profile's own fields, by label. */
  addable: { key: string; label: string }[];
  error?: string;
  /** The frontmatter's YAML, for the raw view. */
  yaml: string;
  exists: boolean;
}

const canonicalOf = (key: string, meta: MetaCatalogue): string => {
  const snake = key.replace(/([a-z])([A-Z])/g, '$1_$2').replace(/[-\s]+/g, '_').toLowerCase();
  return meta.aliases[snake] ?? snake;
};

/** The field for a key: the catalogue's, else the profile's own. */
export function fieldOf(key: string, meta: MetaCatalogue, hints: PropertyHints): FieldSpec | undefined {
  return meta.fields.find((f) => f.key === key) ?? hints.profileFields.find((f) => f.key === key);
}

/** A value the form can't edit as one box (a map, or a list holding maps or lists). */
const complex = (value: unknown): boolean =>
  (Array.isArray(value) && value.some((v) => v !== null && typeof v === 'object' && !(v instanceof Date))) || (value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date));

function typeOf(field: FieldSpec | undefined, value: unknown): PropertyRow['type'] {
  if (value !== undefined && complex(value)) return 'raw';
  if (field) {
    if (field.type === 'list' && value !== undefined && !Array.isArray(value)) return 'string'; // written as one text: kept as text
    return field.type === 'enum' && !field.values?.length ? 'string' : field.type;
  }
  if (Array.isArray(value)) return 'list';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (value instanceof Date) return 'date';
  return 'string';
}

/**
 * The Document tab (ADR-0016, R-160 amendment 4): the properties the document has, in written order; then the
 * required and shown-on-page ones it lacks (empty, marked); an "Add property" list with the rest. Unreadable YAML: no
 * rows, the error, and the raw view only.
 */
export function documentModel(state: PropertiesState | null, meta: MetaCatalogue, hints: PropertyHints): DocumentModel {
  const required = new Set(hints.required.map((k) => canonicalOf(k, meta)));
  const shown = new Set(hints.shownOnPage.map((k) => canonicalOf(k, meta)));
  const row = (key: string, value: unknown, written?: string): PropertyRow => {
    const field = fieldOf(key, meta, hints);
    const fallback = hints.defaults[key] ?? field?.default;
    return {
      key,
      ...(written !== undefined ? { written } : {}),
      label: field?.label ?? written ?? key,
      help: field?.help ?? '',
      type: typeOf(field, value),
      ...(field?.values?.length ? { values: field.values } : {}),
      value,
      ...(fallback !== undefined && fallback !== '' ? { fallback } : {}),
      required: required.has(key),
      shownOnPage: shown.has(key),
      generated: field?.generated === true,
    };
  };
  if (state?.error) return { rows: [], addable: [], error: state.error, yaml: state.yaml, exists: true };
  const rows: PropertyRow[] = [];
  const seen = new Set<string>();
  for (const entry of state?.entries ?? []) {
    seen.add(entry.key);
    rows.push(row(entry.key, entry.value, entry.written));
  }
  for (const key of [...required, ...shown]) {
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row(key, undefined));
  }
  const addable = [...meta.fields, ...hints.profileFields]
    .filter((f) => !seen.has(f.key) && f.generated !== true)
    .map((f) => ({ key: f.key, label: f.label }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return { rows, addable, yaml: state?.yaml ?? '', exists: state !== null };
}

/** The text a value shows as in a text box. */
export function textOf(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString().replace(/T00:00:00\.000Z$/, '');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Typed text as a value of `type`, or a problem to show (the Inspector checks the type only: R-160 amendment 5; a
 * field's limits are help text). Empty text is `undefined` (the setting is left out).
 */
export function parseInput(type: PropertyRow['type'], text: string): { value: unknown } | { problem: string } {
  const trimmed = text.trim();
  if (trimmed === '') return { value: undefined };
  switch (type) {
    case 'number': {
      const n = Number(trimmed);
      return Number.isFinite(n) ? { value: n } : { problem: 'A number is needed here.' };
    }
    case 'boolean':
      return /^(true|false)$/i.test(trimmed) ? { value: trimmed.toLowerCase() === 'true' } : { problem: 'true or false.' };
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? { value: trimmed } : { problem: 'A date like 2026-10-04 is needed here.' };
    default:
      return { value: text };
  }
}

/** Help text for a field, with its limits (shown, not enforced). */
export function helpOf(field: Pick<ItemField, 'help' | 'min' | 'max' | 'required'>): string {
  const limits = field.min !== undefined && field.max !== undefined ? `${field.min} to ${field.max}` : field.min !== undefined ? `at least ${field.min}` : field.max !== undefined ? `at most ${field.max}` : '';
  return [field.help ?? '', limits ? `(${limits})` : ''].filter(Boolean).join(' ');
}

/** A path inside a value: object keys and list indexes. */
export type ValuePath = readonly (string | number)[];

/** `values` with the value at `path` replaced (`undefined` removes an object key); the input is not changed. */
export function setIn(values: unknown, path: ValuePath, value: unknown): unknown {
  if (path.length === 0) return value;
  const [head, ...rest] = path;
  if (typeof head === 'number') {
    const list = Array.isArray(values) ? [...values] : [];
    list[head] = setIn(list[head], rest, value);
    return list;
  }
  const object = values && typeof values === 'object' && !Array.isArray(values) ? { ...(values as Record<string, unknown>) } : {};
  const next = setIn(object[head!], rest, value);
  if (next === undefined) delete object[head!];
  else object[head!] = next;
  return object;
}

/** The value at `path`. */
export function getIn(values: unknown, path: ValuePath): unknown {
  let at = values;
  for (const step of path) {
    if (at === null || typeof at !== 'object') return undefined;
    at = (at as Record<string | number, unknown>)[step];
  }
  return at;
}

/** A list with one row moved, removed or added (a new row of a list with fields is an empty group). */
export function listEdit(list: unknown, edit: { move: number; by: -1 | 1 } | { remove: number } | { add: unknown }): unknown[] {
  const rows = Array.isArray(list) ? [...list] : [];
  if ('move' in edit) {
    const to = edit.move + edit.by;
    if (to < 0 || to >= rows.length) return rows;
    [rows[edit.move], rows[to]] = [rows[to], rows[edit.move]];
  } else if ('remove' in edit) {
    rows.splice(edit.remove, 1);
  } else {
    rows.push(edit.add);
  }
  return rows;
}

const NAMED_COLORS: Record<string, string> = {
  red: '#ff0000', black: '#000000', white: '#ffffff', blue: '#0000ff', green: '#008000', yellow: '#ffff00', orange: '#ffa500',
  purple: '#800080', gray: '#808080', grey: '#808080', teal: '#008080', navy: '#000080',
};

/** The picker's value for an item's own default color (FIX-S50): #rrggbb or #rgb, or a common color name; undefined for anything else. */
export function defaultPickerColor(text: string): string | undefined {
  return pickerColor(text) ?? NAMED_COLORS[text.trim().toLowerCase()];
}

/** A color for the color picker (#rrggbb), or undefined when the text is another kind of color (a name, rgb()). */
export function pickerColor(text: string): string | undefined {
  const t = text.trim();
  if (/^#[0-9a-f]{6}$/i.test(t)) return t.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(t)) return `#${[...t.slice(1)].map((c) => c + c).join('')}`.toLowerCase();
  return undefined;
}
