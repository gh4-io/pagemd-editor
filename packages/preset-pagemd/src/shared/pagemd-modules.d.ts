// Types for the pagemd-common packages this preset uses (plain JavaScript, no type files of their own).
// Only what preset-pagemd calls is declared. Source: pagemd-common packages/syntax/src/index.js and
// packages/meta/src/index.js, packages/resolver/src/yaml.js (phases C1–C4, C7, P4, P8).

declare module '@pagemd/syntax' {
  import type { MarkdownIt } from 'markdown-it';

  /** The one mermaid version pagemd and the editor pin (C6, R-167). */
  export const MERMAID_VERSION: string;
  /** The settings both draw diagrams with (`mermaid.initialize`). */
  export const MERMAID_CONFIG: Readonly<Record<string, unknown>>;

  export interface SyntaxItemDef {
    id: string;
    group: string;
    read(md: MarkdownIt, mode: string, options: object): void;
    gate?: { field: string; value: unknown };
    htmlContract: string[];
    params: unknown[];
    /** CSS the item's HTML needs whatever the theme (P4, D18). */
    structuralCss?: string;
    write?(data: Record<string, unknown>, content?: string): string;
  }

  export interface DialectOptions {
    mode?: 'render' | 'editor';
    groups?: string[];
    options?: { fields?: Record<string, unknown>; markdownIt?: object };
  }

  /** One item in editor-mode tokens with the data its write rule takes (C3). */
  export interface Occurrence {
    item: string;
    data: Record<string, unknown>;
    token: { type: string; meta: Record<string, unknown> | null };
    index: number;
    inline: boolean;
  }

  export const items: readonly SyntaxItemDef[];
  export const CONTAINER_TYPES: readonly string[];
  export const ANNOTATED_IMAGE_STRUCTURAL_CSS: string;
  /** P26: the CSS footnotes and task lists need (pagemd adds it only to documents that use them). */
  export const FOOTNOTES_STRUCTURAL_CSS: string;
  export const TASK_LISTS_STRUCTURAL_CSS: string;
  /** C13 (R-250): a marker's size and its label on the picture (pagemd adds them in the base layer to documents that use them). */
  export const MARKER_SCALE_STRUCTURAL_CSS: string;
  export const MARKER_LABEL_STRUCTURAL_CSS: string;
  export function lateStructuralCssFor(html: string): string;
  export function structuralCssFor(html: string): string;
  export function writeFootnote(data: { form: string; label?: string; content?: string }, content?: string): string;
  export function writeTaskMarker(data: { checked: boolean; mark?: string; gap?: string }): string;
  export function applyDialect(md: MarkdownIt, opts?: DialectOptions): MarkdownIt;
  export function createDialect(opts?: DialectOptions): MarkdownIt;
  export function itemOccurrences(tokens: readonly unknown[]): Occurrence[];
  export function writeDirective(data: Record<string, unknown>, order?: string[]): string;
  export function writeAttributes(attrs: readonly (readonly [string, string])[]): string;
  export function listMarker(data: { type: string; start: number; delimiter: string }, index?: number): string;
  export function markerGap(marker: string): string;
  export function writeTable(model: Record<string, unknown>): string;
  export function writeTableCaption(caption: Record<string, unknown>): string;
  /** P19: the `{…}` attribute that holds a table's column widths, and the class for the fixed layout. */
  export const COLUMN_WIDTHS_ATTR: string;
  export const FIXED_LAYOUT_CLASS: string;
  /** P19: the widths an attribute value sets (a percentage, or null for "not set"), one per column written. */
  export function parseColumnWidths(value: string | null | undefined): (number | null)[];
  /** P19: the attribute value for widths ('' when no column is set). */
  export function writeColumnWidths(widths: readonly (number | null | undefined)[]): string;
  /** P19: whether a table's class and widths attributes ask for the fixed layout, and its widths ([] when none is set). */
  export function tableLayoutOf(classAttr: string | null, widthsAttr: string | null, directiveWidths?: string | null): { fixed: boolean; widths: (number | null)[] };
  /** P19 round 3: the hidden comment under a table, `<!-- ::TABLE widths="…" -->`: its keyword, `widths="equal"`, its writer. */
  export const TABLE_DIRECTIVE: string;
  export const EQUAL_WIDTHS: string;
  export function writeTableDirective(data: Record<string, unknown>): string;
  /** C3: the YAML text changed from oldData to newData only where they differ; null when that can't be done in place. */
  export function updateYaml(text: string, oldData: unknown, newData: unknown): string | null;
  export function sameData(a: unknown, b: unknown): boolean;
  /** One value as YAML text; `style` is the replaced scalar's (PLAIN, QUOTE_SINGLE, QUOTE_DOUBLE). */
  export function formatYamlValue(value: unknown, style?: string): string;
  /** C13: the shapes a % crop hides entirely (`{ list, index }`); null when there is no crop or it is not in %. */
  export function shapesHiddenByCrop(data: unknown): { list: string; index: number }[] | null;
  /** C13: a rectangle in % of the displayed (turned, then flipped) picture, mapped back to % of the picture file as shown upright. */
  export function displayedRectToNatural(rect: { x: number; y: number; width: number; height: number }, rotate: number, flip: string): { x: number; y: number; width: number; height: number };
  /** C13: redaction rectangles (`redact:`), checked; an error means the picture must not be shown as it is (fail closed). */
  export function readRedactions(value: unknown): { rects: { x: number; y: number; width: number; height: number }[]; error: string | null };
}

declare module '@pagemd/resolver' {
  /** One YAML document with js-yaml 4's rules (pagemd's reader); undefined for an empty or comments-only text. */
  export function loadYaml(text: string): unknown;
}

declare module '@pagemd/meta' {
  /** Alias → canonical key. */
  export const FIELD_ALIASES: Record<string, string>;
  /** camelCase, dashes and spaces → snake_case. */
  export function normalizeKey(key: string): string;
  /** The field for a key or alias (snake_cased first), or undefined. */
  export function fieldFor(keyOrAlias: string): { key: string; type: string } | undefined;
  /** The catalogue as FieldSpec[] (aliases filled in), extended by a profile's own fields. */
  export function catalogue(profile?: object): { key: string; items?: string[]; sources: string[] }[];
  export const CATALOGUE: {
    version: string;
    fields: unknown[];
    aliases: Record<string, string>;
    gates: Record<string, { field: string; value: unknown }>;
  };
  export function normalizeMetadata(raw: Record<string, unknown>, options?: object): Record<string, unknown>;
  /** built-in defaults → profile defaults → the document's (normalized without defaults) → overrides (OQ-13). */
  export function layer(profileDefaults?: Record<string, unknown>, documentMetadata?: Record<string, unknown>, overrides?: Record<string, unknown>): Record<string, unknown>;
  export function gateFor(itemId: string): { field: string; value: unknown } | null;
}
