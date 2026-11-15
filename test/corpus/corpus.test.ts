// Golden-corpus round-trip (invariant I2, ADR-0007; roadmap checkpoint 1; P1 acceptance criterion 1).
// Open + save with no edits must give back every byte, and nothing may fall back to raw_block: with
// preset-commonmark every plain-markdown construct has an item.
import { describe, expect, it } from 'vitest';
import { RAW_BLOCK } from '@pagemd-editor/core';
import { roundTrip, transformer } from './round-trip.ts';
import { docsFiles, hasDocs, plainFiles, specExamples, type CorpusEntry } from './sources.ts';

const rawBlocks = (text: string): number => {
  let count = 0;
  transformer.parse(text).descendants((node) => {
    if (node.type.name === RAW_BLOCK) count++;
  });
  return count;
};

describe('golden corpus round-trip', () => {
  it('finds every part of the corpus', () => {
    expect(plainFiles.length).toBeGreaterThanOrEqual(9);
    // docs/ exists only in the source repo (SAN-0b); a public copy runs the rest of the corpus
    if (hasDocs) expect(docsFiles.length).toBeGreaterThanOrEqual(70);
    else expect(docsFiles).toEqual([]);
    expect(specExamples.length).toBe(652);
  });

  const cases: [string, CorpusEntry[]][] = [
    ['plain files', plainFiles],
    ['docs/**/*.md', docsFiles],
    ['CommonMark spec examples', specExamples],
  ];
  describe.each(cases)('%s', (_label, entries) => {
    it.each(entries.map((entry) => [entry.name, entry] as const))('%s is byte-identical after open + save', (_name, entry) => {
      expect(roundTrip(entry.text)).toBe(entry.text);
    });

    it('reads every block with an item (no raw_block)', () => {
      const withRaw = entries.filter((entry) => rawBlocks(entry.text) > 0).map((entry) => entry.name);
      expect(withRaw).toEqual([]);
    });
  });
});
