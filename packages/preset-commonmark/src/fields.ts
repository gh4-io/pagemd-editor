// The Inspector's Element fields for CommonMark's items (P8, R-161; cohesion matrix §1). Each reads and writes the
// node's (or the link mark's) own attributes; the item's writer turns a change into markdown for that block only.
import type { FieldBinding, FieldOwner, SyntaxItem } from '@pagemd-editor/core';

const str = (value: unknown): string => (typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value));
const orNull = (value: unknown): string | null => (str(value) === '' ? null : str(value));

const heading: FieldBinding = {
  fields: [{ key: 'level', type: 'enum', label: 'Level', values: ['1', '2', '3', '4', '5', '6'], required: true }],
  values: (owner) => ({ level: String(owner.attrs['level']) }),
  // An underlined (setext) heading exists for levels 1 and 2 only; deeper ones are written with #.
  apply: (owner, values) => {
    const level = Math.min(6, Math.max(1, Number(values['level']) || 1));
    return { level, setext: owner.attrs['setext'] === true && level <= 2 };
  },
};

const link: FieldBinding = {
  fields: [
    { key: 'href', type: 'string', label: 'Address', required: true, help: 'A web address, a file, or #id' },
    { key: 'title', type: 'string', label: 'Tooltip' },
  ],
  values: (owner) => ({ href: str(owner.attrs['href']), title: str(owner.attrs['title']) }),
  apply: (owner, values) => ({ href: str(values['href']) || str(owner.attrs['href']), title: orNull(values['title']) }),
};

const image: FieldBinding = {
  fields: [
    { key: 'src', type: 'path', label: 'Image', required: true, extensions: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'] },
    { key: 'alt', type: 'string', label: 'Alt text', help: 'Read out instead of the picture' },
    { key: 'title', type: 'string', label: 'Tooltip' },
  ],
  values: (owner) => ({ src: str(owner.attrs['src']), alt: str(owner.attrs['alt']), title: str(owner.attrs['title']) }),
  apply: (owner, values) => ({ src: str(values['src']) || str(owner.attrs['src']), alt: orNull(values['alt']), title: orNull(values['title']) }),
};

const tight = { key: 'tight', type: 'boolean', label: 'Compact (no space between items)' } as const;

const bulletList: FieldBinding = {
  fields: [{ key: 'bullet', type: 'enum', label: 'Bullet', values: ['-', '*', '+'], required: true }, tight],
  values: (owner) => ({ bullet: str(owner.attrs['bullet']), tight: owner.attrs['tight'] === true }),
  apply: (_owner, values) => ({ bullet: ['-', '*', '+'].includes(str(values['bullet'])) ? values['bullet'] : '-', tight: values['tight'] === true }),
};

const orderedList: FieldBinding = {
  fields: [{ key: 'start', type: 'number', label: 'Start at', min: 0 }, tight],
  values: (owner) => ({ start: owner.attrs['order'], tight: owner.attrs['tight'] === true }),
  apply: (owner, values) => {
    const start = Number(values['start']);
    return { order: Number.isInteger(start) && start >= 0 ? start : owner.attrs['order'], tight: values['tight'] === true };
  },
};

/** The fence's info string is "language + more": the language is its first word. */
const codeBlock: FieldBinding = {
  fields: [{ key: 'language', type: 'string', label: 'Language', help: 'e.g. js, python, mermaid (a diagram)' }],
  values: (owner: FieldOwner) => ({ language: str(owner.attrs['params']).trim().split(/\s+/)[0] ?? '' }),
  apply: (owner, values) => {
    const params = str(owner.attrs['params']);
    const rest = params.trim().split(/\s+/).slice(1).join(' ');
    const language = str(values['language']).trim().split(/\s+/)[0] ?? '';
    const next = [language, rest].filter(Boolean).join(' ');
    // A language needs a fence: indented code becomes fenced.
    return { params: next, ...(next && owner.attrs['fence'] === null ? { fence: '```' } : {}) };
  },
};

const html: FieldBinding = {
  fields: [{ key: 'source', type: 'string', label: 'HTML', readOnly: true, help: 'Kept exactly as written' }],
  values: (owner) => ({ source: str(owner.attrs['html']) }),
  apply: () => ({}),
};

const BINDINGS: Record<string, Record<string, FieldBinding>> = {
  heading: { heading: heading },
  link: { link },
  image: { image },
  lists: { bullet_list: bulletList, ordered_list: orderedList },
  code_block: { code_block: codeBlock },
  html: { html_inline: html }, // an HTML block is edited on the canvas itself
};

/** The items with their Inspector fields (the editor part). */
export function withFields(items: readonly SyntaxItem[]): SyntaxItem[] {
  return items.map((item) => {
    const own = BINDINGS[item.id];
    if (!own) return item;
    const names = new Set([...Object.keys(item.schema.nodes ?? {}), ...Object.keys(item.schema.marks ?? {})]);
    return { ...item, fields: { ...item.fields, ...Object.fromEntries(Object.entries(own).filter(([name]) => names.has(name))) } };
  });
}
