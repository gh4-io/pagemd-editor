// GFM alerts: `> [!NOTE]` (also TIP, IMPORTANT, WARNING, CAUTION) turns a blockquote into a callout. Detected
// with a core rule that runs before inline parsing (so it can still see each paragraph's raw text), which
// retypes the blockquote's open/close tokens to `alert_open`/`alert_close` and removes the marker line — this
// keeps the item independent of preset-commonmark's `blockquote` (a different token type, no name clash).
import type { MarkdownIt, StateCore } from 'markdown-it';
import { wrapCommand, type SyntaxItem } from '@pagemd-editor/core';

export const ALERT_KINDS = ['note', 'tip', 'important', 'warning', 'caution'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

const MARKER = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*$/i;

function alertRule(state: StateCore): void {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    const open = tokens[i]!;
    if (open.type !== 'blockquote_open') continue;

    let depth = 1;
    let j = i + 1;
    while (j < tokens.length && depth > 0) {
      if (tokens[j]!.type === 'blockquote_open') depth++;
      else if (tokens[j]!.type === 'blockquote_close') depth--;
      j++;
    }
    const close = tokens[j - 1]!;

    const firstOpen = tokens[i + 1];
    const firstInline = tokens[i + 2];
    const firstClose = tokens[i + 3];
    if (firstOpen?.type !== 'paragraph_open' || firstInline?.type !== 'inline' || firstClose?.type !== 'paragraph_close') continue;

    const lines = firstInline.content.split('\n');
    const match = MARKER.exec(lines[0] ?? '');
    if (!match) continue;

    open.type = 'alert_open';
    open.attrSet('kind', match[1]!.toLowerCase());
    close.type = 'alert_close';
    if (lines.length === 1) tokens.splice(i + 1, 3);
    else firstInline.content = lines.slice(1).join('\n');
  }
}

export const alert: SyntaxItem = {
  id: 'alert',
  group: 'blocks',
  markdownIt: (md: MarkdownIt) => md.core.ruler.before('inline', 'gfm-alert', alertRule),
  schema: {
    nodes: {
      alert: {
        content: 'block+',
        group: 'block',
        defining: true,
        attrs: { kind: { default: 'note' } },
        parseDOM: [{ tag: 'blockquote[data-alert]', getAttrs: (dom) => ({ kind: dom.getAttribute('data-alert') }) }],
        toDOM: (node) => ['blockquote', { 'data-alert': node.attrs['kind'], class: `pmd-alert pmd-alert-${node.attrs['kind'] as string}` }, 0],
      },
    },
  },
  fromTokens: { alert: { block: 'alert', getAttrs: (tok) => ({ kind: tok.attrGet('kind') ?? 'note' }) } },
  toMarkdown: {
    nodes: {
      alert: (state, node) => {
        const kind = (node.attrs['kind'] as string).toUpperCase();
        state.wrapBlock('> ', null, node, () => {
          state.write(`[!${kind}]`);
          state.ensureNewLine();
          state.renderContent(node);
        });
      },
    },
  },
  label: 'Alert',
  icon: 'alert',
  slash: { keywords: ['alert', 'note', 'tip', 'warning', 'caution', 'important', 'callout'] },
  commands: [
    ...ALERT_KINDS.map((kind) =>
      wrapCommand({ id: `alert.${kind}`, label: `Callout: ${kind[0]!.toUpperCase()}${kind.slice(1)}`, icon: 'alert', keywords: [kind, 'alert', 'callout'] }, 'alert', { kind }),
    ),
  ],
};
