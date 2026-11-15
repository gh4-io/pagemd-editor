// Bullet and numbered lists. The author's markers are kept: `-` / `*` / `+`, `1.` / `1)`, the start number.
import { wrappingInputRule } from 'prosemirror-inputrules';
import type { Node } from 'prosemirror-model';
import { listCommand, type NodeWriter, type SyntaxItem, type TokenSpec } from '@pagemd-editor/core';

interface ListToken {
  type: string;
  level: number;
  hidden: boolean;
}

/** Tight = markdown-it hid the list's paragraphs (no blank lines between items). */
function isTight(tokens: readonly ListToken[], i: number): boolean {
  const level = tokens[i]!.level;
  for (let k = i + 1; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (t.level <= level) break;
    if (t.type === 'paragraph_open' && t.level === level + 2) return t.hidden;
  }
  return true;
}

const bulletSpec: TokenSpec = { block: 'bullet_list', getAttrs: (tok, tokens, i) => ({ bullet: tok.markup, tight: isTight(tokens as ListToken[], i) }) };
const orderedSpec: TokenSpec = {
  block: 'ordered_list',
  getAttrs: (tok, tokens, i) => {
    const start = tok.attrGet('start');
    return { order: start === null ? 1 : Number(start), delim: tok.markup, tight: isTight(tokens as ListToken[], i) };
  },
};

/**
 * Can `next` follow `prev` on the very next line inside a tight list item, without either merging into
 * the other? True when `next` can interrupt a paragraph, or `prev` can't be continued by a following line.
 */
function canTouch(prev: Node, next: Node): boolean {
  const name = next.type.name;
  const interrupts =
    (name === 'code_block' && next.attrs['fence'] !== null) ||
    (name === 'heading' && !(next.attrs['setext'] && (next.attrs['level'] as number) <= 2)) ||
    name === 'blockquote' ||
    name === 'html_block' ||
    name === 'bullet_list' ||
    (name === 'ordered_list' && next.attrs['order'] === 1) ||
    (name === 'horizontal_rule' && !(next.attrs['markup'] as string).startsWith('-'));
  // An HTML block runs until a blank line, so nothing may touch it from below; a quote or list directly
  // above another of its kind would absorb it.
  if (prev.type.name === 'html_block' || (prev.type === next.type && /^(blockquote|bullet_list|ordered_list)$/.test(name))) return false;
  const closed = (prev.type.name === 'code_block' && prev.attrs['fence'] !== null) || prev.type.name === 'heading' || prev.type.name === 'horizontal_rule';
  return interrupts || (closed && name !== 'code_block');
}

interface CloseState {
  flushClose(size: number): void;
}

/**
 * prosemirror-markdown always puts a blank line between the blocks of a list item, which turns a tight
 * list loose. In a tight list we write them on consecutive lines wherever markdown allows it.
 */
const writeListItem: NodeWriter = (state, node, parent) => {
  const tight = parent.attrs['tight'] === true;
  node.forEach((child, _offset, i) => {
    // Explicit both ways: a nested list inside a tight list would otherwise always get a single newline.
    if (i > 0 && tight) (state as unknown as CloseState).flushClose(canTouch(node.child(i - 1), child) ? 1 : 2);
    state.render(child, node, i);
  });
};

export const lists: SyntaxItem = {
  id: 'lists',
  group: 'lists',
  schema: {
    nodes: {
      bullet_list: {
        content: 'list_item+',
        group: 'block',
        attrs: { bullet: { default: '-' }, tight: { default: true } },
        parseDOM: [{ tag: 'ul' }],
        toDOM: () => ['ul', 0],
      },
      ordered_list: {
        content: 'list_item+',
        group: 'block',
        attrs: { order: { default: 1 }, delim: { default: '.' }, tight: { default: true } },
        parseDOM: [{ tag: 'ol', getAttrs: (dom) => ({ order: dom.hasAttribute('start') ? Number(dom.getAttribute('start')) : 1 }) }],
        toDOM: (node) => ['ol', node.attrs['order'] === 1 ? {} : { start: node.attrs['order'] }, 0],
      },
      list_item: { content: 'block+', defining: true, parseDOM: [{ tag: 'li' }], toDOM: () => ['li', 0] },
    },
  },
  fromTokens: { bullet_list: bulletSpec, ordered_list: orderedSpec, list_item: { block: 'list_item' } },
  toMarkdown: {
    nodes: {
      bullet_list: (state, node) => {
        const bullet = node.attrs['bullet'] as string;
        state.renderList(node, '  ', () => `${bullet} `);
      },
      ordered_list: (state, node) => {
        const start = node.attrs['order'] as number;
        const delim = node.attrs['delim'] as string;
        // Numbers are padded AFTER the marker ("9)  a" / "10) b"), so every item's content starts in the
        // same column; padding in front (" 9)") would change how nested lists are read.
        const width = String(start + node.childCount - 1).length;
        state.renderList(node, ' '.repeat(width + 2), (i) => `${start + i}${delim}`.padEnd(width + 2));
      },
      list_item: writeListItem,
    },
  },
  label: 'List',
  icon: 'list-unordered',
  slash: { keywords: ['list', 'bullet', 'numbered', 'ordered'] },
  // `- `/`* `/`+ ` or `1. `/`1) ` at a block's start starts a list (OQ-24, P3).
  inputRules: (schema) => [
    wrappingInputRule(/^\s*([-+*])\s$/, schema.nodes['bullet_list']!, (match) => ({ bullet: match[1], tight: true })),
    wrappingInputRule(
      /^(\d+)([.)])\s$/,
      schema.nodes['ordered_list']!,
      (match) => ({ order: Number(match[1]), delim: match[2], tight: true }),
      (match, node) => node.childCount + (node.attrs['order'] as number) === Number(match[1]),
    ),
  ],
  commands: [
    listCommand({ id: 'lists.bullet', label: 'Bulleted list', icon: 'list-unordered', keybinding: 'Mod-Shift-8', toolbar: true, keywords: ['list', 'bullet', 'bulleted', 'unordered'] }, 'bullet_list', { bullet: '-' }, () => true),
    listCommand(
      { id: 'lists.ordered', label: 'Numbered list', icon: 'list-ordered', keybinding: 'Mod-Shift-7', toolbar: true, keywords: ['list', 'numbered', 'ordered', '1.'] },
      'ordered_list',
      { order: 1, delim: '.', pmdFancy: null },
      (node) => !node.attrs['pmdFancy'],
    ),
  ],
};
