// The Inspector's Element fields for every pagemd item (P8, R-161; cohesion matrix §1's "Inspector fields" column).
// The fields are @pagemd/syntax's own `params` (imported, never copied: I1), with the editor's labels; the values are
// the item's write data (`attrs.data`, P4), and a changed value goes back into that data, so the item's own write rule
// writes only what changed (C3: a FIGURE caption edit changes only that directive line).
import type { Node } from 'prosemirror-model';
import { TableMap } from 'prosemirror-tables';
import { writeAttributes, writeColumnWidths, writeDirective } from '@pagemd/syntax';
import type { FieldBinding, FieldOwner, ItemField, SyntaxItem } from '@pagemd-editor/core';
import { ATTRS } from './text/attributes.ts';
import { FANCY } from './lists/fancy-lists.ts';
import { TASK, toggled, type TaskData } from './lists/task-lists.ts';
import { syntaxItem } from './shared/write.ts';
import { COLUMN_WIDTHS_ATTR, layoutOf, withDirectiveWidths, type TableDirective } from './tables/widths.ts';
import { tableShape } from './tables/shape.ts';
import { hiddenShapes } from './media/image-tools/annotation-view.ts';

type Data = Record<string, unknown>;
type Pairs = [string, string][];

const dataOf = (owner: FieldOwner): Data => (owner.attrs['data'] as Data | undefined) ?? {};
const str = (value: unknown): string => (typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value));

/** "crop-fit" → "Crop fit", "pageLevels" → "Page levels". */
const labelOf = (key: string): string => {
  const words = key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

interface Param {
  key: string;
  type: string;
  label?: string;
  help?: string;
  values?: string[];
  fields?: Param[];
  min?: number;
  max?: number;
  default?: unknown;
  required?: boolean;
}

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'] as const;

function toField(param: Param): ItemField {
  return {
    key: param.key,
    type: param.type as ItemField['type'],
    label: param.label ?? labelOf(param.key),
    ...(param.help ? { help: param.help } : {}),
    ...(param.values ? { values: param.values } : {}),
    ...(param.fields ? { fields: param.fields.map(toField) } : {}),
    ...(param.min !== undefined ? { min: param.min } : {}),
    ...(param.max !== undefined ? { max: param.max } : {}),
    ...(param.default !== undefined ? { default: param.default } : {}),
    ...(param.required ? { required: true } : {}),
  };
}

/** An item's fields from @pagemd/syntax's params, with editor-side changes by key (a path's file kinds, a label). */
export function paramFields(itemId: string, tweak: Record<string, Partial<ItemField>> = {}): ItemField[] {
  return (syntaxItem(itemId).params as Param[]).map((param) => ({ ...toField(param), ...(param.type === 'path' && /image/i.test(param.help ?? param.label ?? '') ? { extensions: IMAGE_EXTENSIONS } : {}), ...tweak[param.key] }));
}

/** A value as directive and FIGURE data holds it: text; an empty value leaves the parameter out. */
const asParam = (value: unknown): unknown => (value === undefined || value === null || value === '' || value === false ? undefined : value === true ? true : String(value));

/** `attrs` with `values` written in (removed when empty), keeping the order the author wrote them in. */
function mergeAttrs(attrs: Data, values: Data, keys: readonly string[]): Data {
  const out: Data = { ...attrs };
  for (const key of keys) {
    const value = asParam(values[key]);
    if (value === undefined) delete out[key];
    else out[key] = value;
  }
  return out;
}

/** Fields held in `data.attrs` (FIGURE, directives, index terms). */
function dataAttrs(fields: readonly ItemField[], read: (data: Data, key: string) => unknown = (data, key) => (data['attrs'] as Data | undefined)?.[key]): FieldBinding {
  return {
    fields,
    values: (owner) => Object.fromEntries(fields.map((f) => [f.key, read(dataOf(owner), f.key)])),
    apply: (owner, values) => {
      const data = dataOf(owner);
      // Only the fields whose value changed are written: the others keep the data exactly as read.
      const changed = fields.map((f) => f.key).filter((key) => str(asParam(values[key])) !== str(asParam(read(data, key))));
      if (changed.length === 0) return {};
      return { data: { ...data, attrs: mergeAttrs((data['attrs'] as Data | undefined) ?? {}, values, changed) } };
    },
  };
}

/** Fields held directly in `data` (wikilinks, embeds, includes, callouts). `map` renames a field's key in the data. */
function dataFields(fields: readonly ItemField[], map: Record<string, { read(data: Data): unknown; write(data: Data, value: unknown): Data }> = {}): FieldBinding {
  return {
    fields,
    values: (owner) => Object.fromEntries(fields.map((f) => [f.key, map[f.key] ? map[f.key]!.read(dataOf(owner)) : dataOf(owner)[f.key]])),
    apply: (owner, values) => {
      const original = dataOf(owner);
      let data = { ...original };
      for (const f of fields) {
        if (f.readOnly) continue;
        const value = values[f.key];
        const current = map[f.key] ? map[f.key]!.read(original) : original[f.key];
        if (str(value) === str(current)) continue; // unchanged: the data stays as read
        if (map[f.key]) data = map[f.key]!.write(data, value);
        else if (value === undefined || value === '') delete data[f.key];
        else data[f.key] = value;
      }
      return { data };
    },
  };
}

/** Upper case for the form, the author's case kept in the data when the kind didn't change. */
const caseKept = (key: string): { read(data: Data): unknown; write(data: Data, value: unknown): Data } => ({
  read: (data) => str(data[key]).toUpperCase(),
  write: (data, value) => (str(value).toUpperCase() === str(data[key]).toUpperCase() ? data : { ...data, [key]: str(value).toLowerCase() }),
});

// ── the `{.class #id key=value}` attributes (an extension on other items' nodes, R-114) ──

const ATTRIBUTE_FIELDS: readonly ItemField[] = [
  { key: 'id', type: 'string', label: 'ID', help: 'For links and cross-references (#id)' },
  { key: 'classes', type: 'string', label: 'CSS classes', help: 'Space-separated (.class)' },
  {
    key: 'other',
    type: 'list',
    label: 'Other attributes',
    help: 'key=value pairs',
    fields: [
      { key: 'key', type: 'string', label: 'Name' },
      { key: 'value', type: 'string', label: 'Value' },
    ],
  },
];

function attributeValues(pairs: Pairs | null): Data {
  const list = pairs ?? [];
  return {
    id: list.find(([k]) => k === 'id')?.[1] ?? '',
    classes: list.filter(([k]) => k === 'class').map(([, v]) => v).join(' '),
    other: list.filter(([k]) => k !== 'id' && k !== 'class').map(([key, value]) => ({ key, value })),
  };
}

/** The pairs for `values`, in the order the author wrote them; new ones at the end. */
export function attributePairs(pairs: Pairs | null, values: Data): Pairs | null {
  const id = str(values['id']).trim();
  const classes = str(values['classes']).trim().split(/\s+/).filter(Boolean);
  const other = ((values['other'] as { key?: unknown; value?: unknown }[] | undefined) ?? []).map((row) => [str(row?.key).trim(), str(row?.value)] as [string, string]).filter(([k]) => k !== '' && k !== 'id' && k !== 'class');
  const out: Pairs = [];
  let idDone = false;
  let classDone = false;
  let otherAt = 0;
  for (const [key] of pairs ?? []) {
    if (key === 'id') {
      if (!idDone && id) out.push(['id', id]);
      idDone = true;
    } else if (key === 'class') {
      if (!classDone) for (const c of classes) out.push(['class', c]);
      classDone = true;
    } else if (otherAt < other.length) {
      out.push(other[otherAt++]!);
    }
  }
  if (!idDone && id) out.push(['id', id]);
  if (!classDone) for (const c of classes) out.push(['class', c]);
  while (otherAt < other.length) out.push(other[otherAt++]!);
  return out.length > 0 ? out : null;
}

/**
 * Where `{…}` can't be added safely, no fields: indented code has no fence line to carry them (they would become code),
 * and a paragraph that is only `:::` would turn into a box's opening line.
 */
const attributesAllowed = (owner: FieldOwner): boolean => {
  if (owner.type.name === 'code_block' && owner.attrs['fence'] === null) return false;
  if (owner.type.name === 'paragraph' && 'textContent' in owner && /^:{3,}/.test((owner as { textContent: string }).textContent.trim()) && !owner.attrs[ATTRS]) return false;
  return true;
};

const attributesBinding: FieldBinding = {
  label: 'Attributes {…}',
  fields: (owner) => (attributesAllowed(owner) ? ATTRIBUTE_FIELDS : []),
  values: (owner) => attributeValues(owner.attrs[ATTRS] as Pairs | null),
  apply: (owner, values) => {
    const before = owner.attrs[ATTRS] as Pairs | null;
    const after = attributePairs(before, values);
    // As written when nothing changed (a key written twice, a value's quoting).
    return JSON.stringify(attributeValues(after)) === JSON.stringify(attributeValues(before)) ? {} : { [ATTRS]: after };
  },
};

// ── fancy lists (an extension on CommonMark's ordered list; its start is the list's own) ──

const fancyBinding: FieldBinding = {
  label: 'Lettered or Roman list',
  fields: (owner) =>
    owner.attrs[FANCY]
      ? [
          { key: 'type', type: 'enum', label: 'Markers', values: ['a', 'A', 'i', 'I'], required: true, help: 'a. b. c. · A. B. C. · i. ii. iii. · I. II. III.' },
          { key: 'delimiter', type: 'enum', label: 'After the marker', values: ['.', ')'], required: true },
        ]
      : [],
  values: (owner) => {
    const fancy = owner.attrs[FANCY] as Data | null;
    return fancy ? { type: fancy['type'], delimiter: fancy['delimiter'] } : {};
  },
  apply: (owner, values) => {
    const fancy = owner.attrs[FANCY] as Data | null;
    if (!fancy) return {};
    const delimiter = values['delimiter'] === ')' ? ')' : '.';
    return { [FANCY]: { ...fancy, type: str(values['type']) || fancy['type'], delimiter } };
  },
};

// ── the items ──

const directiveSource: FieldBinding = {
  fields: [{ key: 'source', type: 'string', label: 'Source', readOnly: true, help: 'pagemd has no item for this directive; it is kept exactly as written.' }],
  values: (owner) => ({ source: writeDirective(dataOf(owner)) }),
  apply: () => ({}),
};

/** The named pages a LAYOUT can switch to (the document's layout: default, landscape and its own names). */
let layoutNames: () => readonly string[] = () => ['default', 'landscape'];
export function useLayoutNames(names: () => readonly string[]): void {
  layoutNames = names;
}

const layoutBinding: FieldBinding = {
  fields: () => [{ key: 'name', type: 'enum', free: true, label: 'Page layout', values: [...new Set(['default', 'landscape', ...layoutNames()])], help: 'A named page of the layout (its @page name); "default" goes back to the usual pages' }],
  values: (owner) => {
    const data = dataOf(owner);
    return { name: data['parenParams'] !== null && data['parenParams'] !== undefined ? str(data['parenParams']) : str((data['attrs'] as Data | undefined)?.['name']) };
  },
  apply: (owner, values) => {
    const data = dataOf(owner);
    const name = str(values['name']).trim() || 'default';
    if (data['parenParams'] !== null && data['parenParams'] !== undefined) return { data: { ...data, parenParams: name } };
    return { data: { ...data, attrs: { ...((data['attrs'] as Data | undefined) ?? {}), name } } };
  },
};

const annotatedFields = paramFields('annotated-image');
const SHAPES = annotatedFields.filter((f) => f.type === 'list').map((f) => f.key);

const annotatedBinding: FieldBinding = {
  fields: (owner) => (owner.attrs['yamlError'] ? [{ key: 'error', type: 'string', label: 'YAML error', readOnly: true }] : annotatedFields),
  values: (owner) => {
    if (owner.attrs['yamlError']) return { error: str(owner.attrs['yamlError']) };
    const data = dataOf(owner);
    const yaml = (data['data'] as Data | undefined) ?? {};
    return { src: data['imagePath'], options: yaml['options'] ?? {}, ...Object.fromEntries(SHAPES.map((k) => [k, yaml[k] ?? []])) };
  },
  apply: (owner, values) => {
    if (owner.attrs['yamlError']) return {};
    const data = dataOf(owner);
    const yaml: Data = { ...((data['data'] as Data | undefined) ?? {}) };
    const options = Object.fromEntries(Object.entries((values['options'] as Data | undefined) ?? {}).filter(([, v]) => v !== undefined && v !== ''));
    // P27: the Rotate box's choice is text ("90"); the YAML holds the turn as a number, and no turn (0) as no key (as Rotate writes it).
    if (typeof options['rotate'] === 'string' && /^\d+$/.test(options['rotate'])) {
      if (Number(options['rotate']) === 0) delete options['rotate'];
      else options['rotate'] = Number(options['rotate']);
    }
    if (Object.keys(options).length > 0 || 'options' in yaml) yaml['options'] = options;
    for (const key of SHAPES) {
      const rows = (values[key] as unknown[] | undefined) ?? [];
      if (rows.length > 0 || key in yaml) yaml[key] = rows;
    }
    return { data: { ...data, imagePath: str(values['src']) || data['imagePath'], data: yaml } };
  },
  // P27 amendment 4 (R-249): shapes a % crop hides stay in the YAML; their rows say so.
  rowNotes: (owner) => (owner.attrs['yamlError'] ? {} : Object.fromEntries(hiddenShapes((dataOf(owner)['data'] as Data | undefined) ?? {}).map((ref) => [`${ref.list}.${ref.index}`, 'Hidden by the crop']))),
};

// ── tables (P16, amendment 10) ──

interface Caption {
  text: string;
  position: string;
  label?: string | null;
  form?: string;
}
interface TableModelData extends Data {
  columns: { align: string; wrap: boolean }[];
  caption: Caption | null;
  tableCaption: Caption | null;
}

const CAPTION_KINDS = ['Table: paragraph', '[text] line'] as const;
const ALIGNMENTS = ['none', 'left', 'center', 'right'] as const;
const TABLE_CLASSES = 'pagemd\'s table classes: compact, striped, no-border, auto-width, fixed-layout (equal columns) (space-separated)';

/** The caption the Inspector shows: the `[text]` line, else the `Table:` paragraph (a table can have both; the first is shown). */
const captionOf = (owner: FieldOwner): { key: 'caption' | 'tableCaption'; caption: Caption } | null => {
  const model = owner.attrs['model'] as TableModelData | undefined;
  if (model?.caption) return { key: 'caption', caption: model.caption };
  if (model?.tableCaption) return { key: 'tableCaption', caption: model.tableCaption };
  return null;
};

const bothCaptions = (owner: FieldOwner): boolean => {
  const model = owner.attrs['model'] as TableModelData | undefined;
  return !!model?.caption && !!model?.tableCaption;
};

/** The `{…}` pairs without the widths (P19: the Columns list shows them, not "Other attributes"), and where they were. */
function withoutWidths(pairs: Pairs | null): { rest: Pairs | null; at: number; value: string | null } {
  const list = pairs ?? [];
  const at = list.findIndex(([k]) => k === COLUMN_WIDTHS_ATTR);
  const rest = list.filter(([k]) => k !== COLUMN_WIDTHS_ATTR);
  return { rest: rest.length > 0 ? rest : null, at, value: at >= 0 ? list[at]![1] : null };
}

/**
 * A table whose cells overlap (a `^^` or `||` reaching into another cell): its tools are off (AD-P16-04). A table that only has
 * short rows is evened out by its first change (FIX-FT, AD-FIX-FT-05), so its fields work.
 */
const isRagged = (owner: FieldOwner): boolean => 'content' in owner && !!TableMap.get(owner as Node).problems && tableShape(owner as Node).kind === 'broken';

const TABLE_FIELDS: readonly ItemField[] = [
  { key: 'caption', type: 'string', label: 'Caption', help: 'Leave empty for no caption' },
  { key: 'captionKind', type: 'enum', label: 'Caption written as', values: CAPTION_KINDS, help: 'A "Table:" paragraph (pagemd\'s usual form) or a [text] line right by the table' },
  { key: 'captionPosition', type: 'enum', label: 'Caption', values: ['below', 'above'] },
  {
    key: 'columns',
    type: 'list',
    label: 'Columns',
    help: 'One row per column, left to right: alignment, whether the column wraps (+), and its width in percent of the table (empty: it shares what the others leave; keep the total at 100 or less). Add and delete columns with the Table tab',
    fields: [
      { key: 'align', type: 'enum', label: 'Align', values: ALIGNMENTS },
      { key: 'wrap', type: 'boolean', label: 'Wrap' },
      { key: 'width', type: 'number', label: 'Width (%)', min: 1, max: 100 },
    ],
  },
  ...ATTRIBUTE_FIELDS.map((field) => (field.key === 'classes' ? { ...field, help: TABLE_CLASSES } : field)),
];

const tableBinding: FieldBinding = {
  fields: (owner) => [
    ...(isRagged(owner) ? [{ key: 'tools', type: 'string' as const, label: 'Table tools', readOnly: true, help: 'Some of this table\'s cells overlap (a ^^ or || reaches into another cell), so the Table tab is off. Its text can still be edited.' }] : []),
    ...TABLE_FIELDS.map((f) => (f.key === 'captionKind' && bothCaptions(owner) ? { ...f, readOnly: true, help: 'This table has both a [text] line and a "Table:" paragraph; the kind stays as written' } : f)),
  ],
  values: (owner) => {
    const model = owner.attrs['model'] as TableModelData;
    const caption = captionOf(owner);
    return {
      ...(isRagged(owner) ? { tools: 'Off: some cells overlap' } : {}),
      caption: caption?.caption.text ?? '',
      captionKind: caption?.key === 'caption' ? CAPTION_KINDS[1] : CAPTION_KINDS[0],
      captionPosition: caption?.caption.position === 'top' ? 'above' : 'below',
      columns: (model.columns ?? []).map((c, k) => ({ align: c.align || 'none', wrap: !!c.wrap, width: widthsOf(owner)[k] ?? undefined })),
      ...attributeValues(withoutWidths(owner.attrs[ATTRS] as Pairs | null).rest),
    };
  },
  apply: (owner, values) => {
    const model = owner.attrs['model'] as TableModelData;
    const next: TableModelData = { ...model };
    // The caption: text, kind and place. Empty text removes it; text on a table with none adds a "Table:" paragraph below.
    const found = captionOf(owner);
    const text = str(values['caption']).trim();
    // With both kinds present the kind can't be switched (one would overwrite the other): it stays as it is.
    const kind = found && model.caption && model.tableCaption ? found.key : str(values['captionKind']) === CAPTION_KINDS[1] ? 'caption' : 'tableCaption';
    const position = str(values['captionPosition']) === 'above' ? 'top' : 'bottom';
    if (found && !text) next[found.key] = null;
    else if (text && (!found || text !== found.caption.text || kind !== found.key || position !== found.caption.position)) {
      const was = found?.caption;
      if (found) next[found.key] = null;
      next[kind] = kind === 'caption' ? { text, position, label: was?.label ?? null } : { text, position, form: was?.form ?? 'table' };
    }
    // The columns: by index (rows can't be added or removed here: the Table tab does that).
    const rows = (values['columns'] as { align?: unknown; wrap?: unknown; width?: unknown }[] | undefined) ?? [];
    const columns = (model.columns ?? []).map((column, k) => {
      const row = rows[k];
      if (!row) return column;
      const align = str(row.align) === 'none' ? '' : ALIGNMENTS.includes(str(row.align) as (typeof ALIGNMENTS)[number]) ? str(row.align) : column.align;
      return align === column.align && !!row.wrap === !!column.wrap ? column : { align, wrap: !!row.wrap };
    });
    if (JSON.stringify(columns) !== JSON.stringify(model.columns)) next.columns = columns;
    // The widths (P19): a row's Width box; an empty box is "not set"; a column without a row keeps its width.
    const oldWidths = widthsOf(owner);
    const newWidths = oldWidths.map((w, k) => {
      const row = rows[k];
      if (!row) return w;
      const v = row.width;
      return typeof v === 'number' && v > 0 && v <= 100 ? v : typeof v === 'number' ? w : null;
    });
    const widthsChanged = JSON.stringify(newWidths) !== JSON.stringify(oldWidths);
    const before = owner.attrs[ATTRS] as Pairs | null;
    const split = withoutWidths(before);
    const others = attributePairs(split.rest, values);
    const othersChanged = JSON.stringify(attributeValues(others)) !== JSON.stringify(attributeValues(split.rest));
    // Changed widths go into the hidden comment under the table and the older `data-col-widths` pair goes (AD-P19-22);
    // unchanged ones stay where and how they were written.
    const after: Pairs = [...(others ?? [])];
    if (!widthsChanged && split.value) after.splice(split.at >= 0 ? Math.min(split.at, after.length) : after.length, 0, [COLUMN_WIDTHS_ATTR, split.value]);
    const directive = (owner.attrs['tableDirective'] as TableDirective | null) ?? null;
    const nextDirective = widthsChanged ? withDirectiveWidths(directive, writeColumnWidths(newWidths) || null) : directive;
    const changed = othersChanged || widthsChanged;
    // pagemd doesn't read a "Table:" paragraph below the `{…}` line as the table's caption (checked by running its
    // reader): a table with attributes has its new "Table:" caption above (AD-P16-06).
    const hasPairs = changed ? after.length > 0 : !!before;
    if ((hasPairs || nextDirective) && next.tableCaption?.position === 'bottom') next.tableCaption = { ...next.tableCaption, position: 'top' };
    const out: Data = {};
    if (JSON.stringify(next) !== JSON.stringify(model)) out['model'] = next;
    if (changed) out[ATTRS] = after.length > 0 ? after : null;
    if (widthsChanged) out['tableDirective'] = nextDirective;
    return out;
  },
};

/** The widths written for each column of the table (null: not set); none when the owner isn't a table node. */
function widthsOf(owner: FieldOwner): (number | null)[] {
  if (!('content' in owner)) return [];
  const layout = layoutOf(owner as Node);
  return layout.hasWidths ? layout.widths : layout.widths.map(() => null);
}

/**
 * A table the editor keeps as markdown text (a raw block: a multi-line cell with a list or several paragraphs, a table
 * the reader can't show whole): the Table tab and the width tools are off there, and the Inspector says why (P19).
 */
const RAW_TABLE = /^\s*(?:(?:Table:|:)[^\n]*\n\s*\n\s*)?\|/;
const rawTableNote: FieldBinding = {
  fields: (owner) =>
    'content' in owner && RAW_TABLE.test((owner as Node).textContent)
      ? [
          {
            key: 'tools',
            type: 'string',
            label: 'Table tools',
            readOnly: true,
            help: 'This table is kept as markdown text (a cell holds a list or several paragraphs, or the reader cannot show every cell), so the Table tab and the column width tools are off. Widths can still be typed in its {…} line: {data-col-widths="30% 20% 50%"}',
          },
        ]
      : [],
  values: () => ({ tools: 'Off: this table is kept as markdown text' }),
  apply: () => ({}),
};

const pathOf = (data: Data): string => str((data['attrs'] as Data | undefined)?.['path'] ?? (data['attrs'] as Data | undefined)?.['src']);

// ── footnotes and task lists (P26) ──

/** A reference: its label (the name between [^ and ]); an inline note: its text. A note: its label. */
const footnoteBinding: FieldBinding = {
  fields: (owner) =>
    dataOf(owner)['form'] === 'inline'
      ? [{ key: 'content', type: 'string', label: 'Note', help: 'The note\'s text (written ^[…] in the line); pagemd prints it with the other notes at the end of the document' }]
      : [{ key: 'label', type: 'string', label: 'Label', required: true, help: 'The name between [^ and ]; the number printed follows the order of the first references' }],
  values: (owner) => (dataOf(owner)['form'] === 'inline' ? { content: str(dataOf(owner)['content']) } : { label: str(dataOf(owner)['label']) }),
  apply: (owner, values) => {
    const data = dataOf(owner);
    const key = data['form'] === 'inline' ? 'content' : 'label';
    const value = key === 'label' ? str(values[key]).replace(/[\s\]]/g, '') : str(values[key]).replace(/\n+/g, ' ');
    if (value === str(data[key]) || (key === 'label' && value === '')) return {};
    return { data: { ...data, [key]: value } };
  },
};

/** A task: ticked or not (the box on the canvas does the same; this is the keyboard's way). */
const taskBinding: FieldBinding = {
  label: 'Checklist',
  fields: (owner) => (owner.attrs[TASK] ? [{ key: 'checked', type: 'boolean', label: 'Done', help: 'The box in front of the item: [x] when done, [ ] when not' }] : []),
  values: (owner) => (owner.attrs[TASK] ? { checked: !!(owner.attrs[TASK] as TaskData).checked } : {}),
  apply: (owner, values) => {
    const task = owner.attrs[TASK] as TaskData | null;
    if (!task || !!values['checked'] === task.checked) return {};
    return { [TASK]: toggled(task) };
  },
};

/** Item id → node name → binding. */
const BINDINGS: Record<string, Record<string, FieldBinding>> = {
  figure: { pmd_figure: dataAttrs(paramFields('figure', { caption: { label: 'Caption' }, id: { label: 'ID' }, alt: { label: 'Alt text' } })) },
  'annotated-image': { pmd_annotated_image: annotatedBinding },
  embeds: { pmd_embed: dataFields(paramFields('embeds')) },
  wikilinks: { pmd_wikilink: dataFields(paramFields('wikilinks', { target: { label: 'Target', required: true }, display: { label: 'Shown as' } })) },
  'inline-callout': { pmd_inline_callout: dataFields(paramFields('inline-callout', { type: { label: 'Kind', required: true } }), { type: { read: (d) => str(d['type']).toUpperCase(), write: (d, v) => ({ ...d, type: str(v).toUpperCase() }) } }) },
  callouts: { pmd_callout: dataFields(paramFields('callouts', { type: { label: 'Kind', required: true } }), { type: { read: (d) => str(d['type']).toUpperCase(), write: (d, v) => (str(v).toUpperCase() === str(d['type']).toUpperCase() ? d : { ...d, type: str(v).toUpperCase(), typeText: str(v).toUpperCase() }) } }) },
  'github-alerts': {
    alert: dataFields([...paramFields('github-alerts', { type: { label: 'Kind', required: true } }), { key: 'title', type: 'string', label: 'Title', help: 'Shown instead of the kind' }], { type: caseKept('type') }),
  },
  containers: { pmd_container: dataFields(paramFields('containers', { name: { label: 'Kind', required: true }, title: { label: 'Title' } })) },
  'attribute-container': {
    pmd_div: {
      fields: ATTRIBUTE_FIELDS,
      values: (owner) => attributeValues((dataOf(owner)['attrs'] as Pairs | undefined) ?? null),
      apply: (owner, values) => {
        const data = dataOf(owner);
        const before = (data['attrs'] as Pairs | undefined) ?? null;
        const pairs = attributePairs(before, values) ?? [];
        if (JSON.stringify(attributeValues(pairs)) === JSON.stringify(attributeValues(before))) return {};
        return { data: { ...data, attrs: pairs, attributes: writeAttributes(pairs) } };
      },
    },
  },
  toc: { pmd_toc: dataAttrs(paramFields('toc', { levels: { label: 'Deepest level' }, min: { label: 'First level' }, pages: { type: 'enum', free: true, values: ['true', 'false'], label: 'Page numbers' }, pageLevels: { label: 'Page numbers down to level' }, section: { label: 'This section only' } })) },
  section: { pmd_section: dataAttrs(paramFields('section', { class: { label: 'CSS class' }, id: { label: 'ID' } })) },
  layout: { pmd_layout: layoutBinding },
  'include-directive': {
    pmd_include_directive: dataFields([{ ...paramFields('include-directive')[0]!, label: 'File', extensions: ['md'] }], {
      path: {
        read: pathOf,
        write: (d, v) => {
          const attrs = { ...((d['attrs'] as Data | undefined) ?? {}) };
          const key = 'src' in attrs && !('path' in attrs) ? 'src' : 'path';
          if (str(v)) attrs[key] = str(v);
          else delete attrs[key];
          return { ...d, attrs };
        },
      },
    }),
  },
  include: { pmd_include: dataFields([{ ...paramFields('include')[0]!, extensions: ['md'] }]) },
  'index-marker': { pmd_index_marker: dataAttrs(paramFields('index-marker', { term: { label: 'Term', required: true }, sort: { label: 'Sort as' } })) },
  'unknown-directive': { pmd_directive: directiveSource },
  'inline-directive': { pmd_directive_inline: directiveSource },
  'multimd-table': { table: tableBinding },
  footnotes: { pmd_footnote_ref: footnoteBinding, pmd_footnote: footnoteBinding },
};

/** The items with their Inspector fields (the editor part, ADR-0013 DQ-1). */
export function withFields(items: readonly SyntaxItem[]): SyntaxItem[] {
  return items.map((item) => {
    let next = item;
    const own = BINDINGS[item.id];
    if (own) next = { ...next, fields: { ...next.fields, ...own } };
    // P19: a table kept as raw text says why its tools are off (an Inspector note on the raw block, no attributes).
    if (item.id === 'multimd-table') next = { ...next, extend: { ...next.extend, nodes: { ...next.extend?.nodes, raw_block: { attrs: {}, fields: rawTableNote } } } };
    if (item.id === 'attributes' && item.extend) {
      next = {
        ...next,
        extend: {
          nodes: Object.fromEntries(Object.entries(item.extend.nodes ?? {}).map(([name, ext]) => [name, { ...ext, fields: attributesBinding }])),
          marks: Object.fromEntries(Object.entries(item.extend.marks ?? {}).map(([name, ext]) => [name, { ...ext, fields: attributesBinding }])),
        },
      };
    }
    if (item.id === 'task-lists' && item.extend?.nodes?.['list_item']) {
      next = { ...next, extend: { ...item.extend, nodes: { ...item.extend.nodes, list_item: { ...item.extend.nodes['list_item'], fields: taskBinding } } } };
    }
    if (item.id === 'fancy-lists' && item.extend?.nodes?.['ordered_list']) {
      next = { ...next, extend: { ...item.extend, nodes: { ...item.extend.nodes, ordered_list: { ...item.extend.nodes['ordered_list'], fields: fancyBinding } } } };
    }
    return next;
  });
}
