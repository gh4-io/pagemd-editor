// P21: each page type's own header/footer boxes (theme-kit's `layoutRunning.named`) as ResolvedStyles.namedRunning, the
// "from the document's properties" marker (a box written with var()) filled with the property for that box.
import { describe, expect, it } from 'vitest';
import { resolveStyles } from '../src/index.ts';
import { memoryEnv, pagemdFiles } from './fixtures.ts';

const PROJECT = { '/proj/package.json': '{}' };
const MULTI = `
@page { size: Letter; margin: 1in;
  @top-left { content: "MAIN HEADER"; } @top-right { content: "MAIN RIGHT"; }
  @bottom-center { content: "Page " counter(page) " of " counter(pages); } }
@page :first { @top-left { content: none; } @bottom-center { content: none; } }
@page wide { size: Letter landscape; margin: 0.5in 0.75in;
  @top-left { content: "WIDE HEADER"; } @bottom-center { content: "Wide page " counter(page); } }
@page wide:first { @top-left { content: "WIDE FIRST"; } }
@page clear { @top-left { content: none; } }
@page props { @top-left { content: var(--page-header-left, none); } @top-right { content: var(--page-header-right, none); } }
.page-wide { page: wide; }
`;

async function stylesOf(frontmatter: string, files: Record<string, string> = {}) {
  const text = `---\n${frontmatter}\n---\n\nx\n`;
  const env = memoryEnv({ ...pagemdFiles(), ...PROJECT, '/proj/doc.md': text, ...files });
  return (await resolveStyles({ path: '/proj/doc.md', text }, env)).styles!;
}
const multi = {
  '/proj/.pagemd/profiles/multi.json': JSON.stringify({ id: 'multi', extends: 'standard_letter', resources: { layout: 'multi.css' } }),
  '/proj/.pagemd/styles/multi.css': MULTI,
};

describe('ResolvedStyles.namedRunning (P21)', () => {
  it('the session-41 layout: wide, wide:first; none is null; var() takes the frontmatter property for that box', async () => {
    const styles = await stylesOf('profile: multi\nrunning_header: { left: "Doc left" }', multi);
    expect(styles.namedRunning).toEqual({
      wide: { header: { left: 'WIDE HEADER' }, footer: { center: 'Wide page :::PAGE' }, first: { header: { left: 'WIDE FIRST' } } },
      clear: { header: { left: null } },
      // var(--page-header-right, none) with no running_header right: the none fallback, cleared
      props: { header: { left: 'Doc left', right: null } },
    });
    // The plain page is as before
    expect(styles.header).toEqual({ left: 'MAIN HEADER', right: 'MAIN RIGHT' });
  });

  it("pagemd's letter.css: its landscape and default pages show the document's properties, as the plain page does", async () => {
    const styles = await stylesOf('running_header: { left: "Acme", right: "Rev 2" }\npage_numbers: "Page X of Y"');
    const plain = { left: 'Acme', center: null, right: 'Rev 2' };
    expect(styles.namedRunning?.['landscape']?.header).toEqual(plain);
    expect(styles.namedRunning?.['default']?.header).toEqual(plain);
    expect(styles.header).toEqual({ left: 'Acme', right: 'Rev 2' });
    // So every box on those pages draws what the plain page draws (left/center/right properties)
    for (const name of ['landscape', 'default']) {
      for (const part of ['header', 'footer'] as const) {
        const own = styles.namedRunning![name]![part]!;
        const base = styles[part] ?? {};
        for (const pos of ['left', 'center', 'right'] as const) expect(own[pos] ?? undefined).toBe(base[pos]);
      }
    }
  });

  it('a layout whose named pages write no boxes gives none', async () => {
    const files = { ...multi, '/proj/.pagemd/styles/multi.css': '@page { size: Letter; } @page wide { size: Letter landscape; }' };
    expect((await stylesOf('profile: multi', files)).namedRunning).toBeUndefined();
  });
});
