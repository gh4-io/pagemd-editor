// preset-gfm contract: tables, strikethrough, autolinks, alerts read and write correctly on top of commonmark.
import { describe, expect, it } from 'vitest';
import { createTransformer } from '@pagemd-editor/transformer';
import { commonmarkItems } from '@pagemd-editor/preset-commonmark';
import { gfmItems, gfmPreset } from '../src/index.ts';

const t = createTransformer([...commonmarkItems, ...gfmItems]);

describe('preset-gfm', () => {
  it('covers the cohesion-matrix GFM rows', () => {
    expect(gfmPreset.items.map((i) => i.id)).toEqual(['table', 'strikethrough', 'autolink', 'alert']);
  });

  describe('table', () => {
    it('reads and writes a table with alignment, byte-identical with no edits', () => {
      const text = '| a | b | c |\n| :--- | ---: | :---: |\n| 1 | 2 | 3 |\n| x | y | z |';
      const doc = t.parse(text);
      expect(doc.childCount).toBe(1);
      expect(doc.child(0).type.name).toBe('table');
      expect(t.serialize(doc)).toBe(text);
    });

    it('gives each header cell its alignment attribute', () => {
      const doc = t.parse('| a | b | c |\n| :--- | ---: | :---: |\n| 1 | 2 | 3 |');
      const row = doc.child(0).child(0);
      expect([row.child(0).attrs['align'], row.child(1).attrs['align'], row.child(2).attrs['align']]).toEqual(['left', 'right', 'center']);
    });

    it('escapes a literal pipe inside a cell when the table is rewritten', () => {
      const doc = t.parse('| a |\n| --- |\n| x \\| y |');
      expect(t.serialize(doc)).toContain('x \\| y');
    });

    it('keeps inline formatting inside a cell', () => {
      const text = '| a |\n| --- |\n| **bold** and *em* |';
      expect(t.serialize(t.parse(text))).toBe(text);
    });

    it('handles a header-only table (no body rows)', () => {
      const text = '| a | b |\n| --- | --- |';
      expect(t.serialize(t.parse(text))).toBe(text);
    });
  });

  describe('strikethrough', () => {
    it('round-trips ~~text~~', () => {
      expect(t.serialize(t.parse('a ~~b~~ c'))).toBe('a ~~b~~ c');
    });
  });

  describe('autolink', () => {
    it('turns a bare URL into a link', () => {
      const doc = t.parse('see http://example.com now');
      const marks = doc.child(0).child(0).marks;
      expect(marks.some((m) => m.type.name === 'link')).toBe(false); // "see " has no mark
      let found = false;
      doc.descendants((node) => {
        if (node.isText && node.marks.some((m) => m.type.name === 'link' && m.attrs['href'] === 'http://example.com')) found = true;
      });
      expect(found).toBe(true);
    });

    it('writes a changed autolink back as a bare <url> (isPlainUrl)', () => {
      const doc = t.parse('see http://example.com now');
      expect(t.serialize(doc)).toBe('see <http://example.com> now');
    });

    it('does not re-link text already inside an explicit markdown link', () => {
      const doc = t.parse('[http://example.com](http://example.com)');
      let count = 0;
      doc.descendants((node) => {
        if (node.isText) count += node.marks.filter((m) => m.type.name === 'link').length;
      });
      expect(count).toBe(1);
    });

    it('does not link a URL inside a code span', () => {
      const doc = t.parse('`http://example.com`');
      let hasLink = false;
      doc.descendants((node) => {
        if (node.isText && node.marks.some((m) => m.type.name === 'link')) hasLink = true;
      });
      expect(hasLink).toBe(false);
    });
  });

  describe('alert', () => {
    it('reads a marker-only alert and writes it back byte-identical', () => {
      const text = '> [!NOTE]\n> Some text.';
      const doc = t.parse(text);
      expect(doc.child(0).type.name).toBe('alert');
      expect(doc.child(0).attrs['kind']).toBe('note');
      expect(t.serialize(doc)).toBe(text);
    });

    it('reads every alert kind', () => {
      for (const kind of ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION']) {
        const doc = t.parse(`> [!${kind}]\n> x`);
        expect(doc.child(0).attrs['kind']).toBe(kind.toLowerCase());
      }
    });

    it('does not treat an ordinary blockquote as an alert', () => {
      const doc = t.parse('> just a quote');
      expect(doc.child(0).type.name).toBe('blockquote');
    });

    it('rewrites the marker line if the alert is edited', () => {
      const doc = t.parse('> [!WARNING]\n> old');
      const alertType = doc.child(0).type;
      const edited = alertType.create({ kind: 'warning' }, doc.child(0).content.firstChild!.copy(doc.child(0).content.firstChild!.content));
      expect(t.serialize(edited)).toBe('> [!WARNING]\n> old');
    });
  });
});
