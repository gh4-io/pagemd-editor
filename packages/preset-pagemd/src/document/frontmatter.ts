// The frontmatter (P8, R-85 D, R-160/R-161): the YAML block between `---` lines at the very start of a document,
// which pagemd reads as the document's properties (gray-matter, then @pagemd/meta) and never prints. Until P8 it was
// read as ordinary markdown (a rule plus a heading, P3 amendment 1); now it is one atom node holding its YAML text,
// written back exactly as it is, so an untouched frontmatter never changes (ADR-0007).
//
// Which text is a frontmatter follows pagemd's reader (gray-matter): the file starts with `---` (not `----`) and the
// block ends at the first line that starts with `---`. The editor recognises only the plain form of that: the opening
// and the closing line are `---` with nothing but spaces after them. Anything else (a `---yaml` language tag, a
// closing line with more on it, no closing line at all) stays as it always was: ordinary markdown, untouched.
//
// Property edits change only the value that changed (@pagemd/syntax's `updateYaml`, phase C3: comments, key order,
// quoting and the author's own key kept, ADR-0016 M4); values are read with pagemd's own YAML rules (@pagemd/resolver's
// `loadYaml`, js-yaml 4 rules, as style-pagemd reads them on the host).
import type { Node, Schema } from 'prosemirror-model';
import type { StateBlock } from 'markdown-it';
import type { Transaction } from 'prosemirror-state';
import { formatYamlValue, sameData, updateYaml } from '@pagemd/syntax';
import { FIELD_ALIASES, fieldFor, normalizeKey } from '@pagemd/meta';
import { loadYaml } from '@pagemd/resolver';
import type { PropertiesProvider, PropertiesState, PropertyEntry, SyntaxItem } from '@pagemd-editor/core';
import { writeLines } from '../shared/write.ts';

export const FRONTMATTER_NODE = 'pmd_frontmatter';

/** Where a frontmatter sits in a text. Positions are in the text as given. */
export interface FrontmatterBlock {
  /** The opening line as written (`---` plus any trailing spaces). */
  open: string;
  /** The closing line as written. */
  close: string;
  /** The YAML between them, with the text's own line endings; null when the closing line follows the opening one. */
  yaml: string | null;
  /** Where the YAML starts and ends (equal when there is none). */
  yamlFrom: number;
  yamlTo: number;
  /** The end of the closing line (its line ending excluded). */
  end: number;
  /** How many lines the block takes. */
  lines: number;
}

const DELIMITER = /^---[ \t]*$/;

/**
 * The frontmatter at the start of `text`, as pagemd's reader finds it, or null (see the file header for the cases the
 * editor leaves as markdown). The one place the editor's webview decides this; style-pagemd's host-side copy is
 * checked against the same cases.
 */
export function frontmatterBlock(text: string): FrontmatterBlock | null {
  if (!text.startsWith('---') || text[3] === '-') return null;
  const openEnd = lineEnd(text, 0);
  const open = text.slice(0, openEnd);
  if (!DELIMITER.test(open.replace(/\r$/, ''))) return null;
  if (openEnd >= text.length) return null; // no closing line: gray-matter would take the whole file
  // gray-matter: the first "\n---" after the opening line closes it.
  const closeAt = text.indexOf('\n---', openEnd);
  if (closeAt < 0) return null;
  const closeStart = closeAt + 1;
  const closeEnd = lineEnd(text, closeStart);
  const close = text.slice(closeStart, closeEnd);
  if (!DELIMITER.test(close)) return null;
  const yamlFrom = text.startsWith('\r\n', openEnd) ? openEnd + 2 : openEnd + 1;
  // The YAML ends before the line ending of its last line.
  const yamlTo = closeAt > 0 && text[closeAt - 1] === '\r' ? closeAt - 1 : closeAt;
  const yaml = closeAt === openEnd || (text[openEnd] === '\r' && closeAt === openEnd + 1) ? null : text.slice(yamlFrom, Math.max(yamlFrom, yamlTo));
  const lines = text.slice(0, closeEnd).split('\n').length;
  return { open: open.replace(/\r$/, ''), close, yaml, yamlFrom, yamlTo: yaml === null ? yamlFrom : Math.max(yamlFrom, yamlTo), end: closeEnd, lines };
}

/** The frontmatter's YAML text in `text` ('' for none), for readers that only need the values. */
export function frontmatterYaml(text: string): string | null {
  const block = frontmatterBlock(text);
  return block ? (block.yaml ?? '') : null;
}

/** The end of the line starting at `from`, its line ending excluded (a lone \r too, as markdown-it splits). */
function lineEnd(text: string, from: number): number {
  const n = text.indexOf('\n', from);
  const end = n < 0 ? text.length : n;
  return end > from && text[end - 1] === '\r' ? end - 1 : end;
}

/** The YAML as pagemd reads it: a map of properties, or why it isn't one. */
export function readProperties(yaml: string): { data: Record<string, unknown> } | { error: string } {
  let data: unknown;
  try {
    data = loadYaml(yaml);
  } catch (error) {
    return { error: error instanceof Error ? error.message.split('\n')[0]! : String(error) };
  }
  if (data === undefined || data === null) return { data: {} };
  if (typeof data !== 'object' || Array.isArray(data) || data instanceof Date) return { error: 'The frontmatter is not a list of "key: value" properties.' };
  return { data: data as Record<string, unknown> };
}

/** The markdown-it rule: a frontmatter at line 0 of the whole document becomes one `pmd_frontmatter` token. */
function frontmatterRule(state: StateBlock, startLine: number, _endLine: number, silent: boolean): boolean {
  if (startLine !== 0 || state.level !== 0 || state.parentType !== 'root' || state.bMarks[0] !== 0) return false;
  const block = frontmatterBlock(state.src);
  if (!block) return false;
  if (silent) return true;
  const token = state.push('pmd_frontmatter', '', 0);
  token.map = [0, block.lines];
  token.block = true;
  token.meta = { open: block.open, close: block.close, yaml: block.yaml };
  state.line = block.lines;
  return true;
}

const textOf = (node: Node): string => {
  const yaml = node.attrs['yaml'] as string | null;
  return `${node.attrs['open']}\n${yaml === null ? '' : `${yaml}\n`}${node.attrs['close']}`;
};

/** The frontmatter item: the node, its reader and writer. Its card (the canvas look) comes from components/inspector. */
export const frontmatter: SyntaxItem = {
  id: 'frontmatter',
  group: 'document',
  markdownIt(md) {
    // First: before the table, code, rule and setext-heading rules that would otherwise read it.
    const first = (md.block.ruler as unknown as { __rules__: { name: string }[] }).__rules__[0]!.name;
    md.block.ruler.before(first, 'pmd_frontmatter', frontmatterRule);
  },
  schema: {
    nodes: {
      [FRONTMATTER_NODE]: {
        group: 'block',
        atom: true,
        selectable: true,
        draggable: false,
        attrs: { yaml: { default: null }, open: { default: '---' }, close: { default: '---' } },
        // Without the card (a test page), the YAML as text.
        toDOM: (node) => ['pre', { class: 'pmd-frontmatter', contenteditable: 'false' }, textOf(node)],
      },
    },
  },
  fromTokens: {
    pmd_frontmatter: {
      node: FRONTMATTER_NODE,
      getAttrs: (tok) => {
        const meta = tok.meta as { open: string; close: string; yaml: string | null };
        return { open: meta.open, close: meta.close, yaml: meta.yaml };
      },
    },
  },
  toMarkdown: {
    nodes: {
      [FRONTMATTER_NODE]: (state, node) => {
        writeLines(state, textOf(node));
        state.closeBlock(node);
      },
    },
  },
  label: 'Document properties',
  icon: 'symbol-property',
  outline: (node, pos) => {
    const read = readProperties((node.attrs['yaml'] as string | null) ?? '');
    const title = 'data' in read ? read.data['title'] : undefined;
    return typeof title === 'string' && title.trim() ? { kind: 'title', label: title.trim(), level: 0, pos } : null;
  },
};

// ── the properties (core's PropertiesProvider) ──

const frontmatterNode = (doc: Node): Node | null => (doc.firstChild?.type.name === FRONTMATTER_NODE ? doc.firstChild : null);

function stateOf(node: Node): PropertiesState {
  const yaml = (node.attrs['yaml'] as string | null) ?? '';
  const read = readProperties(yaml);
  if ('error' in read) return { pos: 0, yaml, entries: [], error: read.error };
  const entries: PropertyEntry[] = Object.entries(read.data).map(([written, value]) => ({ key: canonical(written), written, value }));
  return { pos: 0, yaml, entries };
}

/** The catalogue's name for a written key (aliases and spelling, as @pagemd/meta normalizes them). */
export function canonical(written: string): string {
  const key = normalizeKey(written);
  return FIELD_ALIASES[key] ?? key;
}

/** Dates read back as Date objects, written as calendar days: compare them as text. */
const plainOf = (value: unknown): unknown => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? String(value) : value.toISOString().replace(/T00:00:00\.000Z$/, '');
  if (Array.isArray(value)) return value.map(plainOf);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plainOf(v)]));
  return value;
};

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `yaml` changed from `oldData` to `newData`, only where they differ; null when that can't be done safely. A calendar
 * date for a date property (`2024-02-01`) is written plain, as authors write it, so pagemd reads it as a date.
 */
function edited(yaml: string, oldData: Record<string, unknown>, newData: Record<string, unknown>): string | null {
  const dates = new Map<string, string>();
  const meant = newData;
  newData = Object.fromEntries(
    Object.entries(newData).map(([key, value]) => {
      if (typeof value !== 'string' || !CALENDAR_DATE.test(value) || fieldFor(canonical(key))?.type !== 'date' || sameData(value, oldData[key])) return [key, value];
      let mark = `pmd_date_${dates.size}`;
      while (yaml.includes(mark)) mark += '_';
      dates.set(mark, value);
      return [key, mark];
    }),
  );
  let next: string | null;
  if (Object.keys(oldData).length === 0) {
    // Nothing to edit in place (empty, or comments only): the new properties go after what is there.
    const lines = Object.entries(newData).map(([key, value]) => `${key}: ${formatYamlValue(value, 'PLAIN')}`);
    next = [yaml.replace(/\s+$/, ''), ...lines].filter((part) => part !== '').join('\n');
  } else {
    next = updateYaml(yaml, oldData, newData);
  }
  if (next === null) return null;
  for (const [mark, date] of dates) next = next.replace(new RegExp(`(["']?)${mark}\\1`), date);
  // Read back: it must say exactly what was meant.
  const back = readProperties(next);
  return 'data' in back && sameData(plainOf(back.data), plainOf(meant)) ? next : null;
}

function writeYaml(tr: Transaction, yaml: string | null): void {
  const node = frontmatterNode(tr.doc);
  const schema: Schema = tr.doc.type.schema;
  if (node) tr.setNodeMarkup(0, undefined, { ...node.attrs, yaml });
  else tr.insert(0, schema.nodes[FRONTMATTER_NODE]!.create({ yaml }));
}

export const frontmatterProperties: PropertiesProvider = {
  read(doc) {
    const node = frontmatterNode(doc);
    return node ? stateOf(node) : null;
  },
  set(tr, key, value) {
    const node = frontmatterNode(tr.doc);
    const yaml = node ? ((node.attrs['yaml'] as string | null) ?? '') : '';
    const read = readProperties(yaml);
    if ('error' in read) return false;
    const written = Object.keys(read.data).filter((k) => canonical(k) === key).pop() ?? key;
    if (written in read.data && sameData(plainOf(read.data[written]), plainOf(value))) return node !== null;
    const next = edited(yaml, read.data, { ...read.data, [written]: value });
    if (next === null) return false;
    writeYaml(tr, next);
    return true;
  },
  remove(tr, key) {
    const node = frontmatterNode(tr.doc);
    if (!node) return false;
    const yaml = (node.attrs['yaml'] as string | null) ?? '';
    const read = readProperties(yaml);
    if ('error' in read) return false;
    const written = Object.keys(read.data).filter((k) => canonical(k) === key);
    if (written.length === 0) return false;
    const rest = { ...read.data };
    for (const k of written) delete rest[k];
    const next = edited(yaml, read.data, rest);
    if (next === null) return false;
    writeYaml(tr, next.trim() === '' ? null : next);
    return true;
  },
  setText(tr, yaml) {
    const text = yaml.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
    const node = frontmatterNode(tr.doc);
    const next = text === '' ? null : text;
    if (node && node.attrs['yaml'] === next) return false;
    writeYaml(tr, next);
    return true;
  },
};
