// P21 acceptance criterion 7: on every one of pagemd's golden-corpus documents (pagemd/tests/corpus, read in place) the
// page types the document uses draw the same headers and footers as before P21. pagemd's own letter.css writes its
// `landscape` and `default` pages' boxes with var(), the document's properties, which is what the plain page shows.
// Pages 2 to 5 of each type, first of a run or not (page 1 as a page type follows the spec order, see running.test.ts).
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveStyles, type FileSystem } from '@pagemd-editor/style-pagemd';
import { runningFor } from '@pagemd-editor/pagination';
import fs from 'node:fs';

const PAGEMD_ROOT = fileURLToPath(new URL('../../../pagemd/', import.meta.url));
const CORPUS = path.join(PAGEMD_ROOT, 'tests', 'corpus');
const nodeFs: FileSystem = {
  exists: (p: string) => fs.existsSync(p),
  readText: (p: string) => fs.readFileSync(p, 'utf8'),
  stat: (p: string) => {
    try {
      const s = fs.statSync(p);
      return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size };
    } catch {
      return null;
    }
  },
  list: (p: string) => fs.readdirSync(p),
} as unknown as FileSystem;

/** The LAYOUT names a document uses, outside fenced code. */
function pageTypes(text: string): string[] {
  const names = new Set<string>();
  let fence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const m = !fence && /^<!--\s*::LAYOUT(?:\(([^)]*)\))?(?:\s+name=["']?([\w-]+)["']?)?\s*-->\s*$/.exec(line.trim());
    if (m) names.add(m[1] || m[2] || 'default');
  }
  return [...names];
}

describe('P21 criterion 7: pagemd\'s corpus draws the same headers and footers as before', { timeout: 180_000 }, () => {
  const files = (readdirSync(CORPUS, { recursive: true }) as string[]).filter((f) => f.endsWith('.md')).map((f) => path.join(CORPUS, f)).sort();

  it('every page type a corpus document uses (bundled and the examples\' own layouts)', async () => {
    const cache = new Map();
    const differences: string[] = [];
    let checked = 0;
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const types = pageTypes(text);
      if (types.length === 0) continue;
      const result = await resolveStyles({ path: file, text }, { fs: nodeFs, pagemdPath: PAGEMD_ROOT.replace(/[\\/]+$/, ''), path, cache });
      if (!result.styles) continue;
      const { namedRunning: _, ...before } = result.styles;
      for (const name of types) {
        for (const number of [2, 3, 4, 5]) {
          for (const firstOfType of [true, false]) {
            const page = { number, total: 9, blank: false, strings: {}, name, firstOfType };
            const now = runningFor(result.styles, page);
            const was = runningFor(before, page);
            if (JSON.stringify(now) !== JSON.stringify(was)) differences.push(`${path.relative(CORPUS, file)} ${name} p${number}${firstOfType ? ' first' : ''}`);
            checked++;
          }
        }
      }
    }
    expect(differences).toEqual([]);
    expect(checked).toBeGreaterThan(0);
  });
});
