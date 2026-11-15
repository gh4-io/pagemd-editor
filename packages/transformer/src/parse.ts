// markdown-it tokens → ProseMirror, one TOP-LEVEL block at a time (R-75, ADR-0007).
// Every top-level node remembers where its text sits in the source, so `lossless` can write an
// untouched block back byte for byte. A block the items can't read becomes a raw_block (I4).
import type { MarkdownIt, Token } from 'markdown-it';
import type { Node, Schema } from 'prosemirror-model';
import { MarkdownParser } from 'prosemirror-markdown';
import { groupBlocks, RAW_BLOCK, topBlocks, type GroupRule, type TokenSpec } from '@pagemd-editor/core';

/** Where a top-level block's text sits in the source: [from, to), the last line's ending excluded. */
export interface BlockRange {
  from: number;
  to: number;
}

/** What a parsed (or saved) document knows about its source text. */
export interface SourceInfo {
  /** The exact text the document was read from (or saved as). */
  text: string;
  /** The file's line ending: the first one found, '\n' when there is none. */
  lineEnding: string;
  /** One range per top-level block of the document (`topBlocks`: groups looked through, P18), in order. */
  blocks: BlockRange[];
  /** Writes one changed top-level block as markdown (with '\n' line endings, no trailing newline). */
  writeBlock(node: Node): string;
  /**
   * P26: the changed block `after` written by editing `before`'s old text (in the file's own line endings), or null to write it
   * fresh (the items' `patch` rules; kept only when the result reads back as `after`).
   */
  patchBlock?(before: Node, after: Node, text: string): string | null;
}

const sources = new WeakMap<Node, SourceInfo>();

/** The source a document was read from or last saved as; undefined for documents made otherwise. */
export function sourceOf(doc: Node): SourceInfo | undefined {
  return sources.get(doc);
}

/** Records a document's source (lossless does this after a save, so the next save can reuse text). */
export function recordSource(doc: Node, info: SourceInfo): void {
  const count = topBlocks(doc).length;
  if (info.blocks.length !== count) {
    throw new Error(`recordSource: ${info.blocks.length} ranges for ${count} top-level blocks.`);
  }
  sources.set(doc, info);
}

/** Why a block became a raw_block (kept in its `reason` attribute, for the raw-block editor). */
export type RawReason = 'unknown-token' | 'parse-error' | 'overlap';

/** Line starts and line content ends, splitting on \r\n, \r and \n exactly as markdown-it does. */
function lines(text: string): { starts: number[]; ends: number[] } {
  const starts = [0];
  const ends: number[] = [];
  const re = /\r\n|\r|\n/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    ends.push(m.index);
    starts.push(m.index + m[0].length);
  }
  ends.push(text.length);
  return { starts, ends };
}

export function detectLineEnding(text: string): string {
  return /\r\n|\r|\n/.exec(text)?.[0] ?? '\n';
}

/** Token types the parser can turn into content, from the items' token specs. */
function knownTokens(specs: Record<string, TokenSpec>): Set<string> {
  const known = new Set(['text', 'inline', 'softbreak']);
  for (const [name, spec] of Object.entries(specs)) {
    const single = spec.node !== undefined || spec.noCloseToken || name === 'code_inline' || name === 'code_block' || name === 'fence';
    if (single) known.add(name);
    else known.add(`${name}_open`).add(`${name}_close`);
  }
  return known;
}

function allKnown(tokens: readonly Token[], known: ReadonlySet<string>): boolean {
  return tokens.every((token) => known.has(token.type) && (!token.children || allKnown(token.children, known)));
}

/**
 * A soft line break stays a line break in the text (R-85 B), so an edited paragraph keeps the
 * author's wrapping. prosemirror-markdown would turn it into a space.
 */
function keepSoftBreaks(tokens: readonly Token[]): void {
  for (const token of tokens) {
    if (token.type === 'softbreak') {
      token.type = 'text';
      token.content = '\n';
    }
    if (token.children) keepSoftBreaks(token.children);
  }
}

export interface Parser {
  parse(text: string): Node;
}

export function createParser(
  md: MarkdownIt,
  schema: Schema,
  specs: Record<string, TokenSpec>,
  writeBlock: (node: Node) => string,
  groups: readonly GroupRule[] = [],
  patchBlock?: SourceInfo['patchBlock'],
): Parser {
  const known = knownTokens(specs);
  // prosemirror-markdown's MarkdownParser turns a token list into nodes. It asks its tokenizer for the
  // tokens, so we hand it one top-level block's tokens at a time through this stand-in tokenizer.
  let current: Token[] = [];
  const blockTokenizer = { parse: () => current } as unknown as MarkdownIt;
  const pm = new MarkdownParser(schema, blockTokenizer, specs);
  const rawType = schema.nodes[RAW_BLOCK];
  if (!rawType) throw new Error(`The schema has no ${RAW_BLOCK} node; include core's rawBlockItem.`);

  const raw = (text: string, reason: RawReason): Node =>
    rawType.create({ reason }, text === '' ? null : schema.text(text.replace(/\r\n?/g, '\n')));

  const readBlock = (tokens: Token[]): Node | RawReason => {
    if (!allKnown(tokens, known)) return 'unknown-token';
    keepSoftBreaks(tokens);
    current = tokens;
    try {
      const doc = pm.parse('');
      return doc.childCount === 1 ? doc.child(0) : 'parse-error';
    } catch {
      return 'parse-error';
    } finally {
      current = [];
    }
  };

  return {
    parse(text: string): Node {
      const { starts, ends } = lines(text);
      const tokens = md.parse(text, {});
      const nodes: Node[] = [];
      const blocks: BlockRange[] = [];

      for (let i = 0; i < tokens.length; ) {
        const first = tokens[i]!;
        let last = i;
        if (first.nesting === 1) {
          while (last < tokens.length && !(tokens[last]!.level === 0 && tokens[last]!.nesting === -1)) last++;
        }
        const group = tokens.slice(i, last + 1);
        i = last + 1;
        if (!first.map) throw new Error(`Top-level token '${first.type}' has no line range.`);

        // Lists and unclosed fences include the blank lines after them; those belong to the gap.
        const [startLine, endLine] = first.map;
        let lastLine = endLine - 1;
        while (lastLine > startLine && text.slice(starts[lastLine]!, ends[lastLine]!).trim() === '') lastLine--;
        const range = { from: starts[startLine]!, to: ends[lastLine]! };

        const prev = blocks[blocks.length - 1];
        if (prev && range.from < prev.to) {
          // Never seen with CommonMark; kept so text can never be written twice or lost.
          prev.to = Math.max(prev.to, range.to);
          nodes[nodes.length - 1] = raw(text.slice(prev.from, prev.to), 'overlap');
          continue;
        }
        const node = readBlock(group);
        nodes.push(typeof node === 'string' ? raw(text.slice(range.from, range.to), node) : node);
        blocks.push(range);
      }

      // An empty (or blank) file still needs one block: an empty default block at position 0. The items' groups (P18: pagemd's
      // SECTION and COVER boxes) go around their blocks; the ranges stay one per block (groups are looked through).
      const doc = schema.topNodeType.createAndFill(null, groupBlocks(nodes, groups, schema));
      if (!doc) throw new Error('The top-level blocks do not fit the schema.');
      if (nodes.length === 0) blocks.push({ from: 0, to: 0 });
      recordSource(doc, { text, lineEnding: detectLineEnding(text), blocks, writeBlock, ...(patchBlock ? { patchBlock } : {}) });
      return doc;
    },
  };
}
