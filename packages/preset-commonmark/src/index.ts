// @pagemd-editor/preset-commonmark: every CommonMark item as a SyntaxItem (layered-architecture.md §3).
import type { Preset, SyntaxItem } from '@pagemd-editor/core';
import { blockquote } from './items/blockquote.ts';
import { code } from './items/code.ts';
import { codeBlock } from './items/code-block.ts';
import { emphasis } from './items/emphasis.ts';
import { hardBreak } from './items/hard-break.ts';
import { heading } from './items/heading.ts';
import { html } from './items/html.ts';
import { image } from './items/image.ts';
import { link } from './items/link.ts';
import { lists } from './items/lists.ts';
import { paragraph } from './items/paragraph.ts';
import { rule } from './items/rule.ts';
import { strong } from './items/strong.ts';
import { withFields } from './fields.ts';

export { blockquote, code, codeBlock, emphasis, hardBreak, heading, html, image, link, lists, paragraph, rule, strong };

/** Paragraph comes first: the schema's first block is the default block. Each item carries its Inspector fields (P8). */
export const commonmarkItems: readonly SyntaxItem[] = withFields([paragraph, heading, blockquote, lists, codeBlock, rule, html, image, hardBreak, emphasis, strong, link, code]);

export const commonmarkPreset: Preset = { id: 'commonmark', items: [...commonmarkItems] };
