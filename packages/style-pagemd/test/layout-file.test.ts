// Create Layout File (P5, R-129, R-130): the plan, applied to an in-memory file system, then resolved again.
import { describe, expect, it } from 'vitest';
import { createMemoryFileSystem } from '@pagemd/resolver';
import type { PageGeometry, TextEdit } from '@pagemd-editor/core';
import { frontmatterProfileEdit, overlayFileSystem, pageCss, planLayoutFile, resolveStyles, rewritePage, type StyleEnvironment } from '../src/index.ts';
import { pagemdFiles } from './fixtures.ts';

const LETTER: PageGeometry = { width: 215.9, height: 279.4, margins: { top: 25.4, right: 25.4, bottom: 25.4, left: 25.4 } };
const A4_20: PageGeometry = { width: 210, height: 297, margins: { top: 20, right: 20, bottom: 20, left: 20 } };
const NARROW: PageGeometry = { ...LETTER, margins: { top: 10, right: 12.5, bottom: 10, left: 12.5 } };
const PAGEMD = pagemdFiles();
const LETTER_CSS = PAGEMD['/pagemd/layouts/letter.css']!;
const BOOK_CSS = PAGEMD['/pagemd/layouts/book.css']!;

const applyEdit = (text: string, edit: TextEdit | null) => (edit ? text.slice(0, edit.from) + edit.text + text.slice(edit.to) : text);

/** A project in memory; `create()` plans, writes and re-resolves like the host will (after the confirm prompt). */
function project(files: Record<string, string>, docPath = '/proj/doc.md') {
  const all: Record<string, string> = { ...PAGEMD, '/proj/package.json': '{}', ...files };
  const env = (): StyleEnvironment => ({ fs: createMemoryFileSystem(all).async(), pagemdPath: '/pagemd', homePath: '/home/user' });
  const resolve = () => resolveStyles({ path: docPath, text: all[docPath]! }, env());
  return {
    files: all,
    resolve,
    async create(page: PageGeometry) {
      const before = await resolve();
      const plan = await planLayoutFile({ path: docPath, text: all[docPath]! }, before.basis!, page, env());
      for (const write of plan.writes) all[write.path] = write.text;
      all[docPath] = applyEdit(all[docPath]!, plan.edit);
      return { before, plan, after: await resolve() };
    },
  };
}

/** The lines of `b` that differ from `a` (same line count and line endings expected). */
function changedLines(a: string, b: string): [string, string][] {
  expect((b.match(/\r\n/g) ?? []).length).toBe((a.match(/\r\n/g) ?? []).length);
  const x = a.split(/\r?\n/);
  const y = b.split(/\r?\n/);
  expect(y.length).toBe(x.length);
  return x.map((line, i) => [line, y[i]!] as [string, string]).filter(([l, r]) => l !== r);
}

describe('rewritePage (R-130): only the plain @page size and margins change', () => {
  it('leaves the text byte for byte when the page is unchanged ("Create Layout File" writes the current page)', () => {
    expect(rewritePage(LETTER_CSS, LETTER)).toBe(LETTER_CSS);
    expect(rewritePage(BOOK_CSS, { width: 215.9, height: 279.4, margins: { top: 19.05, right: 15.24, bottom: 19.05, left: 15.24 } })).toBe(BOOK_CSS);
  });

  it('changes size and margin in place, keeping comments, margin boxes, :first/:left/:right and named pages', () => {
    const out = rewritePage(LETTER_CSS, A4_20);
    expect(changedLines(LETTER_CSS, out)).toEqual([
      ['  size: Letter;', '  size: a4;'],
      ['  margin: 1.0in;', '  margin: 20mm;'],
    ]);
  });

  it('writes landscape with the keyword, other sizes as lengths, and short margin shorthands', () => {
    expect(changedLines(LETTER_CSS, rewritePage(LETTER_CSS, { ...LETTER, width: 279.4, height: 215.9 }))).toEqual([['  size: Letter;', '  size: Letter landscape;']]);
    expect(changedLines(LETTER_CSS, rewritePage(LETTER_CSS, { ...LETTER, width: 100, height: 150.25 }))).toEqual([['  size: Letter;', '  size: 100mm 150.25mm;']]);
    expect(changedLines(LETTER_CSS, rewritePage(LETTER_CSS, NARROW))).toEqual([['  margin: 1.0in;', '  margin: 10mm 12.5mm;']]);
    const uneven = { ...LETTER, margins: { top: 1, right: 2, bottom: 3, left: 4 } };
    expect(changedLines(LETTER_CSS, rewritePage(LETTER_CSS, uneven))).toEqual([['  margin: 1.0in;', '  margin: 1mm 2mm 3mm 4mm;']]);
  });

  it('replaces per-side margins with one shorthand in the rule that sets them', () => {
    const css = '@page {\n  size: letter;\n  margin-top: 1in;\n  margin-bottom: 1in;\n}\n@page :first { margin-top: 3in; }\n';
    expect(rewritePage(css, NARROW)).toBe('@page {\n  size: letter;\n  margin: 10mm 12.5mm;\n}\n@page :first { margin-top: 3in; }\n');
  });

  it('adds what the rule lacks, and a rule when there is none', () => {
    expect(rewritePage('@page {\n  margin: 1in;\n}\n', A4_20)).toBe('@page {\n  size: a4;\n  margin: 20mm;\n}\n');
    expect(rewritePage('@page {\n  size: a4;\n}\n', A4_20)).toBe('@page {\n  size: a4;\n  margin: 20mm;\n}\n');
    expect(rewritePage('p { color: red }\n', A4_20)).toBe(`p { color: red }\n\n${pageCss(A4_20)}`);
    expect(pageCss(LETTER)).toBe('@page {\n  size: letter;\n  margin: 25.4mm;\n}\n');
  });

  it('changes the declaration that wins (the last one), also when its value is unreadable (var(), calc())', () => {
    expect(rewritePage('@page {\n  size: letter;\n  margin: 1in;\n}\n@page { margin: var(--m); }\n', NARROW)).toBe('@page {\n  size: letter;\n  margin: 1in;\n}\n@page { margin: 10mm 12.5mm; }\n');
    expect(rewritePage('@page { size: letter; margin: 20mm } @page { size: calc(1in) }', A4_20)).toBe('@page { size: letter; margin: 20mm } @page { size: a4 }');
  });
});

describe('frontmatterProfileEdit (R-129)', () => {
  const ref = './.pagemd/profiles/doc.doc.json';
  const edit = (text: string) => applyEdit(text, frontmatterProfileEdit(text, ref));

  it('adds a frontmatter when there is none', () => {
    expect(edit('# Title\n')).toBe(`---\nprofile: ${ref}\n---\n# Title\n`);
  });

  it('adds a profile line before the closing ---', () => {
    expect(edit('---\ntitle: T\n---\nx')).toBe(`---\ntitle: T\nprofile: ${ref}\n---\nx`);
    expect(edit('---\n---\nx')).toBe(`---\nprofile: ${ref}\n---\nx`);
  });

  it('changes the existing profile line, under the key the author wrote, and only that line', () => {
    expect(edit('---\ntitle: T\nprofile: sop # house style\nstatus: Draft\n---\n')).toBe(`---\ntitle: T\nprofile: ${ref}\nstatus: Draft\n---\n`);
    expect(edit("---\nlayout-template: 'sop'\n---\n")).toBe(`---\nlayout-template: ${ref}\n---\n`);
    expect(edit('---\n"profile":\n  sop\ntitle: x\n---\n')).toBe(`---\n"profile": ${ref}\ntitle: x\n---\n`);
  });

  it('keeps the document\'s line endings', () => {
    expect(edit('---\r\ntitle: T\r\n---\r\nx\r\n')).toBe(`---\r\ntitle: T\r\nprofile: ${ref}\r\n---\r\nx\r\n`);
    expect(edit('# T\r\n')).toBe(`---\r\nprofile: ${ref}\r\n---\r\n# T\r\n`);
  });

  it('quotes a path YAML would misread', () => {
    expect(edit('x')).toContain(`profile: ${ref}\n`);
    expect(applyEdit('x', frontmatterProfileEdit('x', './.pagemd/profiles/a b#c.json'))).toContain('profile: "./.pagemd/profiles/a b#c.json"');
  });

  it("refuses a frontmatter it can't read", () => {
    expect(() => frontmatterProfileEdit('---\na: [x\n---\n', ref)).toThrow(/can't be read/);
  });
});

describe('planLayoutFile: per-document profile + layout, then the resolver finds them (R-129)', () => {
  it('a document on the default profile: copies letter.css, extends standard_letter, names the profile', async () => {
    const p = project({ '/proj/doc.md': '# Doc\n' });
    const { before, plan, after } = await p.create(NARROW);
    expect(before.styles!.layout).toEqual({ path: '/pagemd/layouts/letter.css', bundled: true });

    expect(plan.writes.map((w) => w.path)).toEqual(['/proj/.pagemd/layouts/doc.css', '/proj/.pagemd/profiles/doc.doc.json']);
    expect(changedLines(LETTER_CSS, plan.writes[0]!.text)).toEqual([['  margin: 1.0in;', '  margin: 10mm 12.5mm;']]);
    expect(JSON.parse(plan.writes[1]!.text)).toEqual({ id: 'doc.doc', extends: 'standard_letter', resources: { layout: '../layouts/doc.css' } });
    expect(p.files['/proj/doc.md']).toBe('---\nprofile: ./.pagemd/profiles/doc.doc.json\n---\n# Doc\n');
    // pagemd's own files are untouched.
    expect(Object.keys(p.files).filter((f) => f.startsWith('/pagemd/') && p.files[f] !== PAGEMD[f])).toEqual([]);

    const styles = after.styles!;
    expect(after.notes).toEqual([]);
    expect(styles.layout).toEqual({ path: '/proj/.pagemd/layouts/doc.css', bundled: false });
    expect(styles.page).toEqual(NARROW);
    expect(styles.usingDefault).toBe(false);
    expect(styles.profile).toBe('doc.doc'); // the profile's own id (R-139)
    expect(styles.sources).toEqual(expect.arrayContaining(['/proj/.pagemd/profiles/doc.doc.json', '/pagemd/profiles/standard_letter.json', '/proj/.pagemd/layouts/doc.css']));
    // Still the parent's CSS and the landscape page.
    expect(styles.namedPages?.['landscape']).toBeDefined();
    expect(after.basis!.profilePath).toBe('/proj/.pagemd/profiles/doc.doc.json');
  });

  it('a second change only rewrites the layout file (the document already uses its profile)', async () => {
    const p = project({ '/proj/doc.md': '# Doc\n' });
    await p.create(NARROW);
    const profileText = p.files['/proj/.pagemd/profiles/doc.doc.json'];
    const docText = p.files['/proj/doc.md'];
    const { plan, after } = await p.create(A4_20);
    expect(plan).toMatchObject({ reusesProfile: true, edit: null });
    expect(plan.writes.map((w) => w.path)).toEqual(['/proj/.pagemd/layouts/doc.css']);
    expect(p.files['/proj/.pagemd/profiles/doc.doc.json']).toBe(profileText);
    expect(p.files['/proj/doc.md']).toBe(docText);
    expect(after.styles!.page).toEqual(A4_20);
  });

  it('`extends` given as a path (./profiles/custom.json, read from the document\'s folder)', async () => {
    const p = project({
      '/proj/doc.md': '---\ntitle: X\nprofile: ./profiles/custom.json\n---\ntext\n',
      '/proj/profiles/custom.json': JSON.stringify({ id: 'custom', resources: { css: ['custom.css'] } }),
      '/proj/styles/custom.css': '.custom-marker { color: plum }',
    });
    const { before, plan, after } = await p.create(A4_20);
    expect(before.styles!.usingDefault).toBe(true);
    expect(JSON.parse(plan.writes[1]!.text)).toEqual({ id: 'doc.doc', extends: './profiles/custom.json', resources: { layout: '../layouts/doc.css' } });
    // The default layout was what the document showed, so it is what gets copied.
    expect(changedLines(LETTER_CSS, plan.writes[0]!.text)).toEqual([
      ['  size: Letter;', '  size: a4;'],
      ['  margin: 1.0in;', '  margin: 20mm;'],
    ]);
    expect(p.files['/proj/doc.md']).toBe('---\ntitle: X\nprofile: ./.pagemd/profiles/doc.doc.json\n---\ntext\n');
    expect(after.notes).toEqual([]);
    expect(after.styles!.css).toContain('.pmd-canvas .custom-marker');
    expect(after.styles!.layout).toEqual({ path: '/proj/.pagemd/layouts/doc.css', bundled: false });
    expect(after.styles!.page).toEqual(A4_20);
    expect(after.styles!.sources).toContain('/proj/profiles/custom.json');
  });

  it('`extends` given as a relative path out of a subfolder (../shared/house.yaml)', async () => {
    const p = project(
      {
        '/proj/guides/intro.md': '---\nprofile: ../shared/house.yaml\n---\n',
        '/proj/shared/house.yaml': 'id: house\nextends: standard_letter\nmetadata:\n  defaults:\n    fancy_lists: true\n',
      },
      '/proj/guides/intro.md',
    );
    const { plan, after } = await p.create(NARROW);
    expect(plan.writes.map((w) => w.path)).toEqual(['/proj/guides/.pagemd/layouts/intro.css', '/proj/guides/.pagemd/profiles/intro.doc.json']);
    expect(JSON.parse(plan.writes[1]!.text).extends).toBe('../shared/house.yaml');
    expect(after.notes).toEqual([]);
    expect(after.styles!.page).toEqual(NARROW);
    expect(after.gateDefaults).toEqual({ fancy_lists: true });
  });

  it("a bundled profile's own layout (book-wiki's book.css) is copied, never written (R-134)", async () => {
    const p = project({ '/proj/book.md': '---\nprofile: book-wiki\n---\n' }, '/proj/book.md');
    const { before, plan, after } = await p.create({ width: 215.9, height: 279.4, margins: { top: 20, right: 15, bottom: 20, left: 15 } });
    expect(before.styles!.layout).toEqual({ path: '/pagemd/layouts/book.css', bundled: true });
    expect(plan.writes.every((w) => !w.path.startsWith('/pagemd/'))).toBe(true);
    expect(changedLines(BOOK_CSS, plan.writes[0]!.text)).toEqual([['  margin: 0.75in 0.6in 0.75in 0.6in;', '  margin: 20mm 15mm;']]);
    expect(after.styles!.layout).toEqual({ path: '/proj/.pagemd/layouts/book.css', bundled: false });
  });

  it('a document named like a bundled profile (sop.md, profile sop) works: the .doc suffix avoids the clash (R-138)', async () => {
    const p = project({ '/proj/sop.md': '---\nprofile: sop\n---\n' }, '/proj/sop.md');
    const { plan, after } = await p.create(NARROW);
    expect(plan.writes.map((w) => w.path)).toEqual(['/proj/.pagemd/layouts/sop.css', '/proj/.pagemd/profiles/sop.doc.json']);
    expect(JSON.parse(plan.writes[1]!.text)).toEqual({ id: 'sop.doc', extends: 'sop', resources: { layout: '../layouts/sop.css' } });
    expect(p.files['/proj/sop.md']).toBe('---\nprofile: ./.pagemd/profiles/sop.doc.json\n---\n');
    expect(after.notes).toEqual([]);
    expect(after.styles!.profile).toBe('sop.doc');
    expect(after.styles!.sources).toContain('/pagemd/profiles/sop.json');
    // Another document here that names `sop` still gets pagemd's sop, not the per-document one.
    const other = await resolveStyles({ path: '/proj/other.md', text: '---\nprofile: sop\n---\n' }, { fs: createMemoryFileSystem(p.files), pagemdPath: '/pagemd' });
    expect(other.notes).toEqual([]);
    expect(other.styles!.profile).toBe('sop');
    expect(other.styles!.layout).toEqual({ path: '/pagemd/layouts/letter.css', bundled: true });
  });

  it('safety net: refuses when a profile by the per-document name already exists elsewhere (R-138)', async () => {
    const local = project({ '/proj/notes.md': '# n\n', '/proj/profiles/notes.doc.json': '{"id":"notes.doc"}' }, '/proj/notes.md');
    await expect(local.create(NARROW)).rejects.toThrow(/A profile named "notes.doc.json" already exists \(\/proj\/profiles\/notes.doc.json\)/);
  });

  it("works when the parent profile's files are named from its own folder (the corpus's example profiles, R-136)", async () => {
    // academic.json in pagemd's examples: `css: ["../styles/06-academic.css"]`. Under the per-document profile, `../`
    // is still read from academic.json's own folder (pagemd-common R-136).
    const p = project({
      '/proj/md/paper.md': '---\nprofile: "../profiles/academic.json"\n---\n',
      '/proj/profiles/academic.json': JSON.stringify({ id: 'academic', resources: { layout: null, css: ['../styles/06-academic.css'] } }),
      '/proj/styles/06-academic.css': 'h1 { color: maroon }',
    }, '/proj/md/paper.md');
    const before = await p.resolve();
    expect(before.styles!.profile).toBe('academic');
    const { plan, after } = await p.create(NARROW);
    expect(JSON.parse(plan.writes[1]!.text).extends).toBe('../profiles/academic.json');
    expect(after.notes).toEqual([]);
    expect(after.styles!.css).toContain('.pmd-canvas h1 { color: maroon }');
    expect(after.styles!.sources).toContain('/proj/styles/06-academic.css');
    expect(after.styles!.page).toEqual(NARROW);
  });

  it("refuses when another of the profile's stylesheets sets the page after the layout", async () => {
    const p = project({
      '/proj/doc.md': '---\nprofile: fixed\n---\n',
      '/proj/profiles/fixed.json': JSON.stringify({ id: 'fixed', extends: 'standard_letter', resources: { css: ['fixed.css'] } }),
      '/proj/styles/fixed.css': '@page { margin: 0.5in }',
    });
    await expect(p.create(A4_20)).rejects.toThrow(/sets the page after the layout/);
  });

  it("never writes into pagemd's folder", async () => {
    const files = { ...PAGEMD, '/pagemd/guide.md': '# g\n' };
    const env: StyleEnvironment = { fs: createMemoryFileSystem(files), pagemdPath: '/pagemd' };
    const doc = { path: '/pagemd/guide.md', text: '# g\n' };
    const resolution = await resolveStyles(doc, env);
    await expect(planLayoutFile(doc, resolution.basis!, NARROW, env)).rejects.toThrow(/never writes into pagemd's own folder/);
  });

  it('needs a file', async () => {
    const p = project({ '/proj/doc.md': '' });
    const basis = (await p.resolve()).basis!;
    await expect(planLayoutFile({ path: null, text: '' }, basis, NARROW, { fs: createMemoryFileSystem({}), pagemdPath: '/pagemd' })).rejects.toThrow(/saved as a file/);
  });
});

describe('overlayFileSystem', () => {
  it('shows the writes over the real files, with their folders, and writes nothing', async () => {
    const real = createMemoryFileSystem({ '/p/a.txt': 'A', '/p/b.txt': 'B' });
    const fs = overlayFileSystem(real, [{ path: '/p/b.txt', text: 'B2' }, { path: '/p/new/deep/c.txt', text: 'C' }]);
    expect(await fs.readText('/p/b.txt')).toBe('B2');
    expect(await fs.readText('/p/a.txt')).toBe('A');
    expect(await fs.readText('/p/new/deep/c.txt')).toBe('C');
    expect(await fs.exists('/p/new/deep')).toBe(true);
    expect(await fs.stat('/p/new')).toEqual({ isFile: false, isDirectory: true, size: 0 });
    expect(await fs.list('/p')).toEqual(['a.txt', 'b.txt', 'new']);
    expect(await fs.list('/p/new')).toEqual(['deep']);
    expect(real.exists('/p/new')).toBe(false);
    expect(real.readText('/p/b.txt')).toBe('B');
  });
});

