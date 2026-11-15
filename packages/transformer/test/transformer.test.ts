// transformer: per-block reading, ranges, raw_block fallback (R-75, invariant I4).
import type { MarkdownIt } from 'markdown-it';
import { describe, expect, it } from 'vitest';
import { ItemRegistry, RAW_BLOCK, type SyntaxItem } from '@pagemd-editor/core';
import { commonmarkItems } from '@pagemd-editor/preset-commonmark';
import { createTransformer, detectLineEnding, recordSource, sourceOf } from '../src/index.ts';

const t = createTransformer(commonmarkItems);
const slices = (text: string): string[] => {
  const info = sourceOf(t.parse(text))!;
  return info.blocks.map((r) => text.slice(r.from, r.to));
};

describe('parse', () => {
  it('records one range per top-level block, without the last line ending', () => {
    expect(slices('# A\n\npara\nline two\n\n- x\n- y\n')).toEqual(['# A', 'para\nline two', '- x\n- y']);
  });

  it('moves blank lines after a list or an unclosed fence into the gap', () => {
    expect(slices('- a\n\n\nb\n')).toEqual(['- a', 'b']);
    expect(slices('```\ncode\n\n\n')).toEqual(['```\ncode']);
  });

  it('leaves link reference definitions in the gap', () => {
    expect(slices('[x]: /url\n\n[x]\n')).toEqual(['[x]']);
  });

  it('handles CRLF and lone CR line endings', () => {
    expect(slices('a\r\n\r\nb\r\n')).toEqual(['a', 'b']);
    expect(slices('a\r\rb\r')).toEqual(['a', 'b']);
    expect(detectLineEnding('x\r\ny\n')).toBe('\r\n');
    expect(detectLineEnding('no newline')).toBe('\n');
  });

  it('an empty file is one empty default block at position 0', () => {
    const doc = t.parse('');
    expect(doc.childCount).toBe(1);
    expect(doc.child(0).type.name).toBe('paragraph');
    expect(sourceOf(doc)!.blocks).toEqual([{ from: 0, to: 0 }]);
  });

  it('keeps soft line breaks as line breaks (R-85 B)', () => {
    expect(t.parse('one\ntwo\n').child(0).textContent).toBe('one\ntwo');
  });

  it('keeps the author’s markers as attributes', () => {
    const doc = t.parse('* a\n\n1) b\n\nT\n===\n\n~~~js\nx\n~~~\n\n***\n\n_e_ __s__\n');
    expect(doc.child(0).attrs).toMatchObject({ bullet: '*' });
    expect(doc.child(1).attrs).toMatchObject({ delim: ')' });
    expect(doc.child(2).attrs).toMatchObject({ level: 1, setext: true });
    expect(doc.child(3).attrs).toMatchObject({ fence: '~~~', params: 'js' });
    expect(doc.child(4).attrs).toMatchObject({ markup: '***' });
    expect(doc.child(5).child(0).marks[0]!.attrs).toMatchObject({ markup: '_' });
  });
});

describe('raw_block fallback (I4: never lose data)', () => {
  // A preset without a rule for tables' tokens: enabling markdown-it's table rule makes table tokens.
  const tableRule: SyntaxItem = {
    id: 'enable-tables',
    group: 'core',
    markdownIt: (md: MarkdownIt) => {
      md.enable('table');
    },
    schema: {},
    fromTokens: {},
    toMarkdown: {},
    label: 'x',
    icon: 'x',
  };
  const withTables = createTransformer([...commonmarkItems, tableRule]);

  it('a block with a token no item reads becomes a raw_block holding its exact text', () => {
    const text = 'before\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nafter\n';
    const doc = withTables.parse(text);
    expect(doc.child(1).type.name).toBe(RAW_BLOCK);
    expect(doc.child(1).attrs['reason']).toBe('unknown-token');
    expect(doc.child(1).textContent).toBe('| a | b |\n|---|---|\n| 1 | 2 |');
    expect(withTables.serialize(doc.child(1))).toBe('| a | b |\n|---|---|\n| 1 | 2 |');
  });

  it('a raw_block keeps CRLF text as LF inside (the file ending is restored on save)', () => {
    const doc = withTables.parse('| a |\r\n|---|\r\n');
    expect(doc.child(0).textContent).toBe('| a |\n|---|');
  });
});

describe('createTransformer', () => {
  it('refuses items that leave a node without a writer', () => {
    const noWriter: SyntaxItem = { id: 'x', group: 'blocks', schema: { nodes: { x: { group: 'block' } } }, fromTokens: {}, toMarkdown: {}, label: 'x', icon: 'x' };
    expect(() => createTransformer([...commonmarkItems, noWriter])).toThrow(/No item writes the node 'x'/);
  });

  it('refuses clashing items, as the registry does', () => {
    expect(() => createTransformer([...commonmarkItems, ...commonmarkItems])).toThrow(/Two items share the id/);
  });

  it('recordSource refuses ranges that do not match the blocks', () => {
    const doc = t.parse('a\n\nb\n');
    expect(() => recordSource(doc, { ...sourceOf(doc)!, blocks: [] })).toThrow(/0 ranges for 2/);
  });
});

describe('item extensions (ADR-0013 amendment, P4): one item adds attributes to another item\'s node and mark', () => {
  // A made-up extension: a trailing "!" on a heading's markdown-it token is kept on the heading as `loud`,
  // and the link mark remembers its token's markup.
  const loud: SyntaxItem = {
    id: 'loud',
    group: 'text',
    markdownIt: (md: MarkdownIt) =>
      md.core.ruler.push('loud', (state) => {
        for (let i = 0; i < state.tokens.length; i++) {
          const inline = state.tokens[i + 1];
          if (state.tokens[i]!.type === 'heading_open' && inline?.content.endsWith('!')) state.tokens[i]!.meta = { loud: true };
        }
      }),
    schema: {},
    fromTokens: {},
    toMarkdown: {},
    extend: {
      nodes: {
        heading: {
          attrs: { loud: { default: false } },
          fromToken: (tok) => ({ loud: (tok.meta as { loud?: boolean } | null)?.loud === true }),
          write: (original) => (state, node, parent, index) => {
            original(state, node, parent, index);
            if (node.attrs['loud']) (state as unknown as { out: string }).out += ' <!-- loud -->';
          },
        },
        not_in_the_schema: { attrs: { x: { default: null } } },
      },
      marks: {
        link: {
          attrs: { seen: { default: false } },
          fromToken: () => ({ seen: true }),
          write: (original) => ({ ...original, close: (...args) => `${typeof original.close === 'string' ? original.close : original.close(...args)}<!-- seen -->` }),
        },
      },
    },
    label: 'Loud',
    icon: 'megaphone',
  };
  const tl = createTransformer([...commonmarkItems, loud]);

  it('adds the attributes to the schema, reads them from the same token, keeps the owner\'s own attributes', () => {
    const doc = tl.parse('## Hello!\n\n[a](b)\n');
    expect(doc.child(0).attrs).toEqual({ level: 2, setext: false, loud: true });
    expect(doc.child(1).child(0).marks[0]!.attrs).toEqual({ href: 'b', title: null, seen: true });
    expect(tl.schema.nodes['not_in_the_schema']).toBeUndefined();
  });

  it('wraps the owner\'s writer', () => {
    expect(tl.serialize(tl.parse('## Hello!\n\n[a](b)\n'))).toBe('## Hello! <!-- loud -->\n\n[a](b)<!-- seen -->');
    expect(tl.serialize(tl.parse('## Quiet\n'))).toBe('## Quiet');
  });

  it('an attribute the node already has is an error', () => {
    const clash: SyntaxItem = { ...loud, id: 'clash', extend: { nodes: { heading: { attrs: { level: { default: 1 } } } } } };
    expect(() => createTransformer([...commonmarkItems, clash])).toThrow(/adds 'level' to the node 'heading', which already has it/);
  });

  it('control: without the extension the heading has no such attribute', () => {
    expect(createTransformer(commonmarkItems).parse('## Hello!\n').child(0).attrs).toEqual({ level: 2, setext: false });
  });
});

describe('an item list with its overrides already applied (P4)', () => {
  it('reads the same as the presets\' own lists', () => {
    const base: SyntaxItem = { ...commonmarkItems.find((i) => i.id === 'horizontal_rule')! };
    const replacement: SyntaxItem = { ...base, id: 'fancy-rule', overrides: 'horizontal_rule', label: 'Fancy rule' };
    const presetLists = [...commonmarkItems, replacement];
    const registry = new ItemRegistry(presetLists);
    const fromPresets = createTransformer(presetLists);
    const fromRegistry = createTransformer(registry.items());
    expect(fromRegistry.parse('a\n\n***\n').toJSON()).toEqual(fromPresets.parse('a\n\n***\n').toJSON());
    expect(() => new ItemRegistry(registry.items())).toThrow(/no item 'horizontal_rule'/);
  });
});
