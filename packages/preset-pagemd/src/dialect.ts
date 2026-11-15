// The pagemd dialect on the editor's markdown-it (P4 amendment 2): @pagemd/syntax's applyDialect() in editor
// mode, called once (it also switches editor mode on: HTML on, curly quotes off, tables on). The other items of
// this preset only map its tokens to nodes and write them back; none of them reads markdown itself (I1).
//
// A last core rule (`pmd_editor_tokens`) then prepares the tokens for the transformer, without reading any
// markdown itself:
// - every pagemd item's write data (itemOccurrences, C3) goes on its token as `meta.pmd`;
// - token types that ordinary markdown shares are renamed, because the transformer picks a node by token type
//   (amendment 9): wikilinks and `![[…]]` embeds, and each directive by the item that owns it;
// - several-token constructs whose parts aren't edited one by one become one token (FIGURE; a callout's label
//   and content wrapper; a table's caption, which the table model holds);
// - what can't be edited safely is given a type no item reads, so the block stays a raw_block with its exact
//   text (I4): tables with multi-line rows or without a model (amendment 7), and `{…}` attributes on a node
//   that can't keep them (amendment 4, the safety net).
import type { MarkdownIt, StateCore, Token } from 'markdown-it';
import { applyDialect, itemOccurrences } from '@pagemd/syntax';
import type { SyntaxItem } from '@pagemd-editor/core';
import { UNKNOWN_DIRECTIVE } from './shared/write.ts';
import { COMMENT_NODE, isCommentDirective } from './page/comment-anchor.ts';

export const DIALECT_ID = 'pagemd-dialect';

/** Block directive items that have a node of their own; any other directive becomes `pmd_directive`. */
export const BLOCK_DIRECTIVE_ITEMS = ['pagebreak', 'toc', 'section', 'layout', 'cover', 'index', 'include-directive'] as const;

/** The node (and renamed token) type of a directive item. */
export const directiveType = (item: string): string => `pmd_${item.replace(/-/g, '_')}`;

/**
 * Attributes a token has for reasons other than `{…}` (markdown-it's own, or a pagemd item's): not attributes
 * an author wrote.
 */
const INTRINSIC: Record<string, readonly string[]> = {
  link_open: ['href', 'title'],
  image: ['src', 'alt', 'title'],
  ordered_list_open: ['start', 'type'],
  th_open: ['style', 'colspan', 'rowspan'],
  td_open: ['style', 'colspan', 'rowspan'],
};

/** Tokens whose attributes belong to the pagemd item that made them (callout classes, `::: {…}`, …). */
const OWN_ATTRIBUTES = /^(callout_|div_|container_|alert_|figure|figcaption|annotated_image|pagemd_|pmd_|caption_)/;

/** Token types whose `{…}` attributes a node keeps (the attributes extension, or the pagemd table). */
const KEEPS_ATTRIBUTES = new Set(['heading_open', 'paragraph_open', 'fence', 'image', 'link_open', 'table_open']);

/** The `{…}` attributes an author wrote on a token, as [key, value] pairs; null when there are none. */
export function writtenAttributes(token: Token): [string, string][] | null {
  const intrinsic = INTRINSIC[token.type] ?? [];
  // A cell of a wrapping column (`---+` in the separator) carries the renderer's class `extend`: the table model's (P16).
  const wrapMark = (key: string, value: unknown): boolean => key === 'class' && value === 'extend' && /^(th|td)_open$/.test(token.type);
  const pairs = (token.attrs ?? []).filter(([key, value]) => !intrinsic.includes(key) && !wrapMark(key, value)).map(([key, value]) => [key, String(value)] as [string, string]);
  return pairs.length > 0 ? pairs : null;
}

/** The dialect item: no node of its own; it adds the dialect to the transformer's markdown-it. */
export function dialectItem(fields: Record<string, unknown> = {}): SyntaxItem {
  return {
    id: DIALECT_ID,
    group: 'core',
    markdownIt(md: MarkdownIt) {
      applyDialect(md, { mode: 'editor', options: { fields } });
      md.core.ruler.push('pmd_editor_tokens', editorTokens);
    },
    schema: {},
    fromTokens: {},
    toMarkdown: {},
    label: 'pagemd dialect',
    icon: 'symbol-misc',
  };
}

function editorTokens(state: StateCore): void {
  const tokens = state.tokens;
  for (const o of itemOccurrences(tokens)) {
    const token = o.token as unknown as Token;
    token.meta = { ...(token.meta ?? {}), pmd: { item: o.item, data: o.data } };
  }
  prepareBlocks(tokens, state.src);
}

function prepareBlocks(tokens: Token[], src: string): void {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    switch (token.type) {
      case 'pagemd_directive': {
        const item = pmdItem(token);
        // A review comment's anchor (P12, R-179) gets its own node: it takes no room on the page.
        const comment = item === UNKNOWN_DIRECTIVE && isCommentDirective(pmdData(token));
        token.type = comment ? COMMENT_NODE : (BLOCK_DIRECTIVE_ITEMS as readonly string[]).includes(item) ? directiveType(item) : 'pmd_directive';
        break;
      }
      case 'figure_open': {
        const close = matching(tokens, i, 'figure_open', 'figure_close');
        tokens.splice(i + 1, close - i);
        token.type = 'pmd_figure';
        token.nesting = 0;
        break;
      }
      case 'callout_open': {
        // The label is drawn by the callout's node. The callout's text is one inline token (the reader keeps
        // it together, blank lines included), so its content wrapper becomes a paragraph around it.
        const close = matching(tokens, i, 'callout_open', 'callout_close');
        for (let k = close - 1; k > i; k--) {
          const t = tokens[k]!;
          if (t.type === 'callout_label') tokens.splice(k, 1);
          // (Its `callout-content` class is the renderer's, not an attribute the author wrote.)
          else if (t.type === 'callout_content_open') Object.assign(t, { type: 'paragraph_open', attrs: null });
          else if (t.type === 'callout_content_close') t.type = 'paragraph_close';
        }
        break;
      }
      case 'table_open':
        prepareTable(tokens, i, src);
        break;
    }
    if (tokens[i]!.children) prepareInline(tokens[i]!.children!);
    guardAttributes(tokens[i]!);
  }
}

function prepareInline(children: Token[]): void {
  for (let i = 0; i < children.length; i++) {
    const token = children[i]!;
    const meta = token.meta as Record<string, unknown> | null;
    if (token.type === 'pagemd_directive_inline') {
      token.type = pmdItem(token) === 'index-marker' ? 'pmd_index_marker' : 'pmd_directive_inline';
    } else if (token.type === 'link_open' && meta?.['wikilink']) {
      // [[Target|display]]: one inline atom (R-117), its text is the display the write rule gives back.
      const close = matching(children, i, 'link_open', 'link_close');
      children.splice(i + 1, close - i);
      token.type = 'pmd_wikilink';
      token.nesting = 0;
    } else if (token.type === 'image' && meta?.['embed']) {
      token.type = 'pmd_embed';
    }
    guardAttributes(token);
  }
}

/**
 * A table the editor can hold (a model, every cell readable as inline text) keeps its tokens; any other stays raw
 * (amendment 7; P16: multi-line rows are held when each of their cells is one paragraph).
 */
function prepareTable(tokens: Token[], open: number, src: string): void {
  const close = matching(tokens, open, 'table_open', 'table_close');
  const model = (tokens[open]!.meta as { table?: unknown } | null)?.table;
  // A cell the reader hid or emptied (markdown-it-attrs' column count after a `||` colspan: older pagemd-common,
  // OQ-29) can't be shown or written back from the tokens: the table stays raw (I4).
  const lostCell = tokens.slice(open, close).some(
    (t, k, all) =>
      (/^(tr|th|td)_open$/.test(t.type) && t.hidden) ||
      (t.type === 'inline' && /^(th|td)_open$/.test(all[k - 1]?.type ?? '') && t.content.trim() !== '' && (t.children ?? []).every((c) => c.type === 'text' && c.content === '')),
  );
  const unmodelled = (): void => {
    tokens[open]!.type = 'pmd_unmodelled_table_open';
    tokens[close]!.type = 'pmd_unmodelled_table_close';
  };
  if (!model || lostCell) return unmodelled();
  // (A table that stays raw keeps its tokens as read: the flattening below must not touch it, so it works on a copy first.)
  const trial = tokens.slice(open, close + 1);
  // Anything unexpected while preparing a table keeps it raw: it must never fail the whole document.
  let ok = false;
  try {
    ok = flattenMultilineCells(trial, 0) && !losesText(trial, 0, trial.length - 1, src);
  } catch {
    ok = false;
  }
  if (!ok) return unmodelled();
  tokens.splice(open, close - open + 1, ...trial);
  const end = matching(tokens, open, 'table_open', 'table_close');
  // Rows remember their group (header = -1, body n = n), for writing the model back.
  let group = -1;
  let bodies = -1;
  for (let k = open + 1; k < end; k++) {
    const t = tokens[k]!;
    if (t.type === 'thead_open') group = -1;
    if (t.type === 'tbody_open') group = ++bodies;
    if (t.type === 'tr_open') t.meta = { ...(t.meta ?? {}), pmdGroup: group };
  }
  // The captions are part of the table model; their tokens would read as text inside the table.
  for (let k = end - 1; k > open; k--) {
    if (tokens[k]!.type === 'caption_close') {
      const start = findBack(tokens, k, 'caption_open');
      tokens.splice(start, k - start + 1);
    }
  }
}

/**
 * A multi-line row's cells hold block tokens (a paragraph around the inline text). A cell that is one paragraph,
 * or empty, loses its paragraph wrapper and is read as inline text with its line breaks kept; any other content
 * (a list, two paragraphs, code, a table) can't be a cell here: false, and the table stays raw (P16, amendment 7).
 */
function flattenMultilineCells(tokens: Token[], open: number): boolean {
  // Bounded by the list, not by the closing token's level: a table with no header has its close one level deeper (review fix).
  for (let k = open + 1; k < tokens.length; k++) {
    const row = tokens[k]!;
    const meta = row.meta as { multiline?: boolean; mbounds?: unknown } | null;
    if (row.type !== 'tr_open' || !meta?.multiline || !meta.mbounds) continue;
    let c = k + 1;
    while (c < tokens.length && tokens[c]!.type !== 'tr_close') {
      const cell = tokens[c]!;
      if (cell.type !== 'td_open' && cell.type !== 'th_open') return false;
      let cellClose = c + 1;
      while (cellClose < tokens.length && !(tokens[cellClose]!.level === cell.level && /^(td|th)_close$/.test(tokens[cellClose]!.type))) cellClose++;
      if (cellClose >= tokens.length) return false;
      if (cellClose > c + 1) {
        const [first, text, last] = tokens.slice(c + 1, cellClose);
        const plain = cellClose === c + 4 && first!.type === 'paragraph_open' && !first!.attrs?.length && text!.type === 'inline' && last!.type === 'paragraph_close';
        if (!plain) return false;
        tokens.splice(c + 3, 1); // the paragraph's close, then its open
        tokens.splice(c + 1, 1);
        cellClose -= 2;
      }
      c = cellClose + 1;
    }
  }
  return true;
}

/** Characters that carry no cell text: spaces, the pipes, the line-continuation and escape backslashes, `^^`. */
const NOT_TEXT = /[\s|\\^]/g;
const letters = (text: string): string => [...text.replace(NOT_TEXT, '')].sort().join('');

/**
 * Whether the table's model leaves out some of the text the table's rows have in the file: the reader's cells,
 * put together, must account for every character of the rows (pipes, backslashes, `^^` and spaces aside). It catches
 * a row the reader misreads and would lose words from (a continuation line that doesn't start with `|`).
 */
function losesText(tokens: Token[], open: number, close: number, src: string): boolean {
  const starts = [0];
  for (let i = src.indexOf('\n'); i >= 0; i = src.indexOf('\n', i + 1)) starts.push(i + 1);
  const lineText = (line: number, from?: number): string => {
    const begin = starts[line] ?? src.length;
    const finish = (starts[line + 1] ?? src.length + 1) - 1;
    const text = src.slice(begin, finish);
    return from !== undefined ? text.slice(Math.max(0, from - begin)) : text.replace(/^[\s>]*/, '');
  };
  let written = '';
  let read = '';
  for (let k = open + 1; k < close; k++) {
    const t = tokens[k]!;
    if (t.type === 'tr_open' && t.map) {
      const first = (t.meta as { bounds?: number[] } | null)?.bounds?.[0];
      for (let line = t.map[0]; line < t.map[1]; line++) written += line === t.map[0] ? lineText(line, first) : lineText(line);
    }
    if (t.type === 'inline' && /^(th|td)_open$/.test(tokens[k - 1]?.type ?? '')) read += t.content;
  }
  return letters(written) !== letters(read);
}

/** `{…}` attributes on a token whose node can't keep them: rename it so the block stays raw (amendment 4). */
function guardAttributes(token: Token): void {
  if (OWN_ATTRIBUTES.test(token.type) || KEEPS_ATTRIBUTES.has(token.type)) return;
  if (writtenAttributes(token)) token.type = `pmd_unmodelled_${token.type}`;
}

function pmdData(token: Token): Record<string, unknown> {
  return (token.meta as { pmd?: { data: Record<string, unknown> } } | null)?.pmd?.data ?? {};
}

function pmdItem(token: Token): string {
  const pmd = (token.meta as { pmd?: { item: string } } | null)?.pmd;
  return pmd?.item ?? UNKNOWN_DIRECTIVE;
}

/** Index of the close token that matches the open token at `i`. */
function matching(tokens: readonly Token[], i: number, open: string, close: string): number {
  let depth = 0;
  for (let k = i; k < tokens.length; k++) {
    if (tokens[k]!.type === open) depth++;
    if (tokens[k]!.type === close && --depth === 0) return k;
  }
  throw new Error(`pmd_editor_tokens: no ${close} for the ${open} at ${i}.`);
}

function findBack(tokens: readonly Token[], k: number, type: string): number {
  for (let j = k; j >= 0; j--) if (tokens[j]!.type === type) return j;
  throw new Error(`pmd_editor_tokens: no ${type} before ${k}.`);
}
