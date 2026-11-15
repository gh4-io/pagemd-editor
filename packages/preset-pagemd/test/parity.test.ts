// P4 amendment 12: one dialect (I1). The editor's markdown-it (the transformer's 'commonmark' instance with every
// preset) must read the corpus exactly as @pagemd/syntax's own editor mode does (createDialect), before the
// editor's own token step (`pmd_editor_tokens`, which only renames and regroups). The one known difference is
// bookkeeping on automatic links: preset-gfm reads them with its own rule (P3, R-99), which leaves the link
// tokens' `info`/`markup` empty; the links themselves (text, address, place) are the same.
import { describe, expect, it } from 'vitest';
import { createDialect } from '@pagemd/syntax';
import { corpus, transformerFor } from './corpus-files.ts';
import { frontmatterBlock, gateFields } from '../src/index.ts';

interface Tok {
  type: string;
  tag: string;
  map: number[] | null;
  attrs: [string, string][] | null;
  markup: string;
  info: string;
  content: string;
  meta: unknown;
  children: Tok[] | null;
  nesting: number;
  hidden: boolean;
}

/** Everything a token says, with the automatic-link bookkeeping left out. */
function normal(tokens: readonly Tok[]): unknown[] {
  return tokens.map((t) => {
    const autolink = t.markup === 'linkify' || ((t.type === 'link_open' || t.type === 'link_close') && t.markup === '' && t.info === '' && (t.attrs?.length ?? 0) <= 1);
    return {
      type: t.type,
      tag: t.tag,
      map: t.map,
      attrs: t.attrs,
      markup: autolink ? '' : t.markup,
      info: autolink ? '' : t.info,
      content: t.content,
      nesting: t.nesting,
      hidden: t.hidden,
      meta: JSON.stringify(t.meta ?? null),
      children: t.children?.length ? normal(t.children) : null,
    };
  });
}

function editorTokens(text: string): unknown[] {
  const md = transformerFor(text).markdownIt;
  md.core.ruler.disable('pmd_editor_tokens');
  try {
    // The frontmatter is the editor's own node (P8): pagemd takes it off before markdown-it ever sees the text.
    return normal((md.parse(text, {}) as unknown as Tok[]).filter((t) => t.type !== 'pmd_frontmatter'));
  } finally {
    md.core.ruler.enable('pmd_editor_tokens');
  }
}

/** pagemd's reading: the frontmatter taken off (gray-matter), blanked out so every line and offset stays the same. */
const pagemdTokens = (text: string): unknown[] => {
  const block = frontmatterBlock(text);
  const body = block ? text.slice(0, block.end).replace(/[^\r\n]/g, ' ') + text.slice(block.end) : text;
  return normal(createDialect({ mode: 'editor', options: { fields: gateFields(text) } }).parse(body, {}) as unknown as Tok[]);
};

describe('P4: the editor reads pagemd exactly as @pagemd/syntax does (I1)', () => {
  it('every corpus file gives the same tokens', () => {
    const differ = corpus.filter((f) => JSON.stringify(editorTokens(f.text)) !== JSON.stringify(pagemdTokens(f.text))).map((f) => f.name);
    expect(differ).toEqual([]);
  });

  it('the fancy-lists switch comes from the frontmatter, as in pagemd (4 corpus files have it on)', () => {
    expect(corpus.filter((f) => gateFields(f.text)['fancy_lists'] === true).length).toBe(4);
  });

  it('control: a reading difference is caught (fancy lists switched the other way)', () => {
    const file = corpus.find((f) => f.name.endsWith('04-fancy-lists-stress.md'))!;
    const off = normal(createDialect({ mode: 'editor', options: { fields: { fancy_lists: false } } }).parse(file.text, {}) as unknown as Tok[]);
    expect(JSON.stringify(editorTokens(file.text))).not.toBe(JSON.stringify(off));
  });
});
