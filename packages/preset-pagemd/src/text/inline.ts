// Inline pagemd items: wikilinks and inline badge callouts. Each is an inline atom holding its write data.
// A wikilink is an atom, not a text mark (R-117): a mark's text would be escaped as ordinary markdown, and
// escapes inside `[[…]]` don't read back; its target and display text are edited as fields (P8).
import type { Node } from 'prosemirror-model';
import { insertInlineCommand, type SyntaxItem } from '@pagemd-editor/core';
import { inlineWriter } from '../shared/write.ts';

const dataOf = (node: Node): Record<string, unknown> => node.attrs['data'] as Record<string, unknown>;
const pmdData = (tok: { meta: unknown }): Record<string, unknown> => ({ ...((tok.meta as { pmd?: { data: Record<string, unknown> } } | null)?.pmd?.data ?? {}) });
const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** `[[Page]]` / `[[Page|shown text]]` */
export const wikilinks: SyntaxItem = {
  id: 'wikilinks',
  group: 'text',
  schema: {
    nodes: {
      pmd_wikilink: {
        inline: true,
        group: 'inline',
        atom: true,
        selectable: true,
        attrs: { data: {} },
        toDOM: (node) => {
          const data = dataOf(node);
          const target = str(data['target']);
          return ['a', { href: target, class: 'wikilink', contenteditable: 'false' }, str(data['display']) || target];
        },
      },
    },
  },
  fromTokens: { pmd_wikilink: { node: 'pmd_wikilink', getAttrs: (tok) => ({ data: pmdData(tok) }) } },
  toMarkdown: { nodes: { pmd_wikilink: inlineWriter(() => 'wikilinks') } },
  label: 'Wikilink',
  icon: 'link',
  slash: { keywords: ['wikilink', 'page link', 'wiki'] },
  commands: [
    insertInlineCommand({ id: 'wikilinks.insert', label: 'Wikilink', icon: 'link', toolbar: true, keywords: ['wikilink', 'page link', 'wiki'] }, 'pmd_wikilink', (schema, text) =>
      schema.nodes['pmd_wikilink']!.create({ data: { target: text || 'Page', display: '' } }),
    ),
  ],
};

/** Inline badge callouts, e.g. `[!WARNING]` in text (@pagemd/syntax `inline-callout`). */
export const inlineCallout: SyntaxItem = {
  id: 'inline-callout',
  group: 'text',
  schema: {
    nodes: {
      pmd_inline_callout: {
        inline: true,
        group: 'inline',
        atom: true,
        selectable: true,
        attrs: { data: {} },
        toDOM: (node) => {
          const type = str(dataOf(node)['type']);
          return ['span', { class: `callout callout-${type.toLowerCase()} callout-inline`, contenteditable: 'false' }, ['span', { class: 'callout-label' }, type.toUpperCase()]];
        },
      },
    },
  },
  fromTokens: { inline_callout: { node: 'pmd_inline_callout', getAttrs: (tok) => ({ data: pmdData(tok) }) } },
  toMarkdown: { nodes: { pmd_inline_callout: inlineWriter(() => 'inline-callout') } },
  label: 'Badge',
  icon: 'tag',
  slash: { keywords: ['badge', 'inline callout'] },
  commands: [
    ...(['WARNING', 'DANGER'] as const).map((type) =>
      insertInlineCommand(
        { id: `inline-callout.${type.toLowerCase()}`, label: `Badge: ${type[0]}${type.slice(1).toLowerCase()}`, icon: 'tag', keywords: ['badge', 'inline callout', type.toLowerCase()] },
        'pmd_inline_callout',
        (schema) => schema.nodes['pmd_inline_callout']!.create({ data: { type, markup: `[!${type}]` } }),
      ),
    ),
  ],
};

export const inlineItems: readonly SyntaxItem[] = [wikilinks, inlineCallout];
