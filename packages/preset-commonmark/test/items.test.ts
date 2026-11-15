// preset-commonmark contract: every node and mark has a reader and a writer; details of the writers.
import { describe, expect, it } from 'vitest';
import { createTransformer } from '@pagemd-editor/transformer';
import { commonmarkItems, commonmarkPreset } from '../src/index.ts';

const t = createTransformer(commonmarkItems);
const { schema } = t;

describe('preset-commonmark', () => {
  it('covers the cohesion-matrix CommonMark rows', () => {
    expect(commonmarkPreset.items.map((i) => i.id)).toEqual(['paragraph', 'heading', 'blockquote', 'lists', 'code_block', 'horizontal_rule', 'html', 'image', 'hard_break', 'emphasis', 'strong', 'link', 'code']);
  });

  it('every node and mark is produced by some token rule', () => {
    const produced = new Set(commonmarkItems.flatMap((i) => Object.values(i.fromTokens).map((s) => s.node ?? s.block ?? s.mark)));
    const declared = commonmarkItems.flatMap((i) => [...Object.keys(i.schema.nodes ?? {}), ...Object.keys(i.schema.marks ?? {})]);
    expect(declared.filter((name) => !produced.has(name))).toEqual([]);
  });

  it('writes link and image targets with spaces in angle brackets', () => {
    const img = schema.nodes['image']!.create({ src: 'my pic.png', alt: 'a_b*', title: null });
    const block = schema.nodes['paragraph']!.create(null, img);
    expect(t.serialize(block)).toBe('![a_b\\*](<my pic.png>)');
    expect(t.parse(`${t.serialize(block)}\n`).child(0).child(0).attrs['src']).toBe('my%20pic.png');
  });

  it('writes numbered lists with the padding after the marker', () => {
    const doc = t.parse('9. a\n10. b\n');
    expect(t.serialize(doc)).toBe('9.  a\n10. b');
  });

  it('keeps a tight list tight when an item holds several blocks', () => {
    const text = '1. text\n   ```\n   code\n   ```\n2. next';
    expect(t.serialize(t.parse(text))).toBe(text);
  });

  it('gives headings an outline entry', () => {
    const doc = t.parse('## Part two\n');
    const heading = commonmarkItems.find((i) => i.id === 'heading')!;
    expect(heading.outline!(doc.child(0), 0)).toEqual({ kind: 'heading', label: 'Part two', level: 2, pos: 0 });
  });
});

describe('image: reading a picture back from the page (P13b)', () => {
  it('takes the file path, never the data: copy the canvas shows for a very large picture (data-pmd-full-src)', () => {
    const rule = schema.nodes['image']!.spec.parseDOM![0]!;
    const el = (attrs: Record<string, string>) => ({ getAttribute: (name: string) => attrs[name] ?? null }) as unknown as HTMLElement;
    const read = (attrs: Record<string, string>) => (rule.getAttrs as (dom: HTMLElement) => Record<string, unknown>)(el(attrs));
    expect(read({ src: 'pics/a.png', alt: 'A' })).toMatchObject({ src: 'pics/a.png', alt: 'A' });
    expect(read({ src: 'data:image/webp;base64,AAAA', 'data-pmd-full-src': 'pics/big.png', alt: 'Big' })).toMatchObject({ src: 'pics/big.png', alt: 'Big' });
  });
});
