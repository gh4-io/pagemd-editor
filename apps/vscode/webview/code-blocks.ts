// The Code view's colors and folds (P9, R-164): one entry per top-level block, from the transformer's block ranges and the
// kind of node each block was read as. No markdown is read here (one dialect, I1): the blocks are the ones the canvas has.
import type { Node } from 'prosemirror-model';
import type { CodeBlock, CodeKind } from '@pagemd-editor/code-view';
import { topBlocks } from '@pagemd-editor/core';
import { sourceOf } from '@pagemd-editor/transformer';

/** CommonMark's and GFM's node names, and the pagemd ones that aren't directives. Anything `pmd_…` else is a directive. */
const KINDS: Readonly<Record<string, CodeKind>> = {
  heading: 'heading',
  paragraph: 'text',
  blockquote: 'quote',
  bullet_list: 'list',
  ordered_list: 'list',
  code_block: 'code',
  horizontal_rule: 'rule',
  html_block: 'html',
  table: 'table',
  raw_block: 'raw',
  pmd_frontmatter: 'meta',
};

/** What a top-level node is drawn as in the Code view. */
export function kindOf(node: Node): CodeKind {
  const known = KINDS[node.type.name];
  if (known) return known;
  return node.type.name.startsWith('pmd_') ? 'directive' : 'text';
}

/** The Code view's blocks for a document the transformer read (or lossless recorded): ranges in `sourceOf(doc).text`. */
export function codeBlocks(doc: Node): CodeBlock[] {
  const source = sourceOf(doc);
  if (!source) return [];
  const out: CodeBlock[] = [];
  const blocks = topBlocks(doc); // (P18: a SECTION's box is looked through, as the ranges are)
  source.blocks.forEach((range, i) => {
    if (i >= blocks.length) return;
    const node = blocks[i]!.node;
    const kind = kindOf(node);
    out.push({ from: range.from, to: range.to, kind, ...(kind === 'heading' ? { level: node.attrs['level'] as number } : {}) });
  });
  return out;
}
