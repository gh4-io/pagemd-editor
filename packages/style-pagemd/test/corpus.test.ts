// R-133 check 1 (P5 acceptance criterion 1): the scoped CSS of every renderable corpus document stays inside the
// canvas, and no @page rule is left in. pagemd's golden corpus (pagemd/tests/corpus, C0) is read in place with
// Node's file system as the resolver's port and the pagemd checkout as pagemd's folder (what a pagemd install
// gives, R-128's `pagemdEditor.pagemdPath`). Documents whose profile can't be found (the docs' own examples such
// as `profile: my-profile`) give plain styles plus a note, and are counted separately.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import postcss from 'postcss';
import { CANVAS_SCOPE, resolveStyles, scopedSelectors } from '../src/index.ts';
import { nodeFs, PAGEMD_ROOT } from './fixtures.ts';

const CORPUS = path.join(PAGEMD_ROOT, 'tests', 'corpus');
const pagemdPath = PAGEMD_ROOT.replace(/[\\/]+$/, '');

function markdownFiles(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter((name) => name.toLowerCase().endsWith('.md') && !name.split(path.sep).some((part) => ['.snapshots', 'node_modules', '.git'].includes(part)))
    .map((name) => path.join(dir, name))
    .sort();
}

/** Why a scoped stylesheet fails check 1: selectors outside the canvas, @page / @import left in. */
function escapes(css: string): string[] {
  const problems = scopedSelectors(css)
    .filter((s) => s !== CANVAS_SCOPE && !s.startsWith(`${CANVAS_SCOPE} `) && !/^\.pmd-canvas[.:[#>+~]/.test(s))
    .map((s) => `selector: ${s}`);
  postcss.parse(css).walkAtRules((rule) => {
    if (/^(page|import)$/i.test(rule.name)) problems.push(`@${rule.name} ${rule.params}`);
  });
  return problems;
}

describe('R-133 check 1: scoped CSS covers every corpus document', { timeout: 120_000 }, () => {
  const files = markdownFiles(CORPUS);

  it('finds the corpus', () => {
    expect(files.length).toBeGreaterThan(80);
  });

  it('nothing escapes .pmd-canvas and no @page rule is left, for every renderable document', async () => {
    const cache = new Map();
    const failures: string[] = [];
    const profiles = new Set<string>();
    let rendered = 0;
    const plainKinds = new Map<string, number>();
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const result = await resolveStyles({ path: file, text }, { fs: nodeFs, pagemdPath, path, cache });
      if (!result.styles) {
        for (const note of result.notes) plainKinds.set(note.kind, (plainKinds.get(note.kind) ?? 0) + 1);
        continue;
      }
      rendered++;
      profiles.add(result.styles.profile ?? '');
      for (const problem of escapes(result.styles.css)) failures.push(`${path.relative(CORPUS, file)}: ${problem}`);
    }
    expect(failures).toEqual([]);
    // Most of the corpus renders, with several profiles (the bundled ones and the examples' own).
    expect(rendered).toBeGreaterThan(files.length * 0.8);
    expect(profiles.size).toBeGreaterThan(5);
    // Only documents whose profile can't be found fall back to plain styles.
    expect([...plainKinds.keys()].filter((kind) => kind !== 'profile-not-found')).toEqual([]);
  });

  it('the check fails on CSS that escapes (control)', () => {
    expect(escapes('.pmd-canvas p { a: b }\n.pmd-canvas, .pmd-canvas.x { c: d }')).toEqual([]);
    expect(escapes('p { a: b }\n.pmd-canvasx { c: d }\n@page { size: a4 }\n@import "x.css";')).toEqual(['selector: p', 'selector: .pmd-canvasx', '@page ', '@import "x.css"']);
  });
});
