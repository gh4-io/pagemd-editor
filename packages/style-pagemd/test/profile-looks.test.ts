// Fix run "Group B": "choosing another profile does not seem to change the look". What each of pagemd's four bundled profiles gives the canvas.
// Finding: standard_letter, sop and technical-report share one template, one layout and one stylesheet (sop and technical-report only add
// metadata defaults and checks), so their canvas CSS is the same but for one page-footer line in sop ("N of M"); only book-wiki
// brings its own look. Re-resolving after each change of the `profile:` line (one shared cache, as the host does) must follow it every time.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveStyles } from '../src/index.ts';
import { nodeFs, PAGEMD_ROOT } from './fixtures.ts';

const pagemdPath = PAGEMD_ROOT.replace(/[\\/]+$/, '');
const file = path.join(PAGEMD_ROOT, 'examples', 'profile-looks.md');
const css = async (profile: string, cache = new Map()) => {
  const result = await resolveStyles({ path: file, text: `---\nprofile: ${profile}\n---\n\n# Hi\n` }, { fs: nodeFs, pagemdPath, path, cache });
  expect(result.notes).toEqual([]);
  expect(result.styles?.profile).toBe(profile);
  return result.styles!.css;
};

describe('what the four bundled profiles give the canvas', () => {
  it('follows the `profile:` line each time, from one shared cache', async () => {
    const cache = new Map();
    const seen: string[] = [];
    for (const profile of ['standard_letter', 'book-wiki', 'sop', 'technical-report', 'standard_letter', 'book-wiki']) seen.push(await css(profile, cache));
    expect(seen[4]).toBe(seen[0]);
    expect(seen[5]).toBe(seen[1]);
    expect(seen[1]).not.toBe(seen[0]);
  });

  it('standard_letter, sop and technical-report share one stylesheet; book-wiki is its own look', async () => {
    const [letter, sop, report, wiki] = [await css('standard_letter'), await css('sop'), await css('technical-report'), await css('book-wiki')];
    expect(report).toBe(letter);
    expect(sop).not.toBe(letter); // sop adds the page footer "N of M"
    expect(sop.length - letter.length).toBeLessThan(300);
    expect(wiki.length).toBeGreaterThan(letter.length * 5); // book-wiki embeds its own fonts and styles
  });
});
