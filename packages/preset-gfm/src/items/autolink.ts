// GFM autolinks: a bare URL (http://…, www.…) becomes a link with no special syntax. markdown-it ships this
// as a core rule, but only wires it into its 'default' preset, not the strict 'commonmark' preset this project
// builds on (verified: `commonmark`'s core rule chain has no 'linkify' entry at all). `md.linkify` (the
// `linkify-it` matcher) is still built regardless of preset, so this item adds the missing core rule itself,
// the same technique markdown-it's own rule uses. It produces plain `link_open`/`text`/`link_close` tokens, so
// it needs no schema, reader or writer of its own — preset-commonmark's `link` item already owns the `link`
// mark and writes a link whose text equals its href back out as a bare `<href>` autolink.
import type { MarkdownIt, StateCore, Token } from 'markdown-it';
import type { SyntaxItem } from '@pagemd-editor/core';

function linkifyRule(state: StateCore): void {
  for (const blockToken of state.tokens) {
    if (blockToken.type !== 'inline' || !blockToken.children) continue;
    let depth = 0; // inside an existing link (already-linked text, or a link's own label, isn't re-linked)
    const children = blockToken.children;
    let i = 0;
    while (i < children.length) {
      const token = children[i]!;
      if (token.type === 'link_open') depth++;
      else if (token.type === 'link_close') depth--;
      else if (token.type === 'text' && depth === 0) {
        const replaced = splitLinks(state, token);
        if (replaced) {
          children.splice(i, 1, ...replaced);
          i += replaced.length;
          continue;
        }
      }
      i++;
    }
  }
}

/** Splits one text token into text/link_open/text/link_close… around every match, or null if there's none. */
function splitLinks(state: StateCore, token: Token): Token[] | null {
  const text = token.content;
  const matches = state.md.linkify.match(text);
  if (!matches || matches.length === 0) return null;

  const out: Token[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.index < cursor) continue; // overlapping matches never happen in practice; be defensive
    if (match.index > cursor) out.push(textToken(state, text.slice(cursor, match.index)));
    const open = new state.Token('link_open', 'a', 1);
    open.attrSet('href', match.url);
    open.markup = 'linkify';
    open.children = [];
    out.push(open, textToken(state, match.text));
    out.push(new state.Token('link_close', 'a', -1));
    cursor = match.lastIndex;
  }
  if (out.length === 0) return null;
  if (cursor < text.length) out.push(textToken(state, text.slice(cursor)));
  return out;
}

function textToken(state: StateCore, content: string): Token {
  const token = new state.Token('text', '', 0);
  token.content = content;
  return token;
}

export const autolink: SyntaxItem = {
  id: 'autolink',
  group: 'text',
  markdownIt: (md: MarkdownIt) => md.core.ruler.after('inline', 'gfm-autolink', linkifyRule),
  schema: {},
  fromTokens: {},
  toMarkdown: {},
  label: 'Autolink',
  icon: 'link',
};
