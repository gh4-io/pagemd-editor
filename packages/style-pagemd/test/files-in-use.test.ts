// P25 (R-242): the Files in Use report from a real resolution over an in-memory project with pagemd's own files at /pagemd. Every row in
// priority order, why each file was chosen (which search step, which kind of path), the problems, and the rule index scoped exactly
// as the canvas scopes the CSS. Controls: a swapped `styles:` list swaps the rows; a file moved to another folder changes its "why".
import { describe, expect, it } from 'vitest';
import { filesInUse, foundBy, indexCss, resolveStyles, scopedSelectors, templateStyles } from '../src/index.ts';
import { memoryEnv } from './fixtures.ts';

const TEMPLATE = [
  '<!doctype html>',
  '<html><head>',
  '<!-- <style>p { color: blue }</style> in a comment counts for nothing -->',
  '<style>',
  'h1 { color: rgb(1, 2, 3); }',
  '</style>',
  '</head><body>{{content}}</body></html>',
].join('\n');

const CHILD_CSS = ['h1 { font-size: 30px; }', '', '@media print {', '  h2 { color: red; }', '}', '@media (prefers-color-scheme: dark) { h3 { color: white; } }', 'html { color: black; }', '@page { size: A4; }'].join('\n');

const PROJECT: Record<string, string> = {
  '/proj/package.json': '{}',
  // step 3 (the workspace's profiles/ folder) for the named profile; step 1 (the document's .pagemd/profiles/) for its parent
  '/proj/profiles/child.json': JSON.stringify({ id: 'child', extends: 'parent', resources: { css: ['child.css', './theme/colors.css'] } }),
  '/proj/docs/.pagemd/profiles/parent.json': JSON.stringify({ id: 'parent', extends: 'standard_letter', resources: { layout: 'wide-layout.css', template: 'tpl.html' } }),
  '/proj/profiles/child.css': CHILD_CSS, // step 2: the folder of the profile that names it
  '/proj/profiles/theme/colors.css': 'p { color: green; }',
  '/proj/styles/wide-layout.css': '@page { size: 300mm 200mm; margin: 10mm; }\nbody { margin: 0; }',
  '/proj/docs/tpl.html': TEMPLATE,
  '/home/user/.pagemd/styles/extra.css': 'h1 { color: navy; }',
  '/proj/docs/local.css': 'h1 { color: teal; }',
};

const DOC = (styles: string[]) => `---\nprofile: child\nstyles: [${styles.map((s) => JSON.stringify(s)).join(', ')}]\n---\n# Title\n`;

async function report(text: string, files: Record<string, string> = PROJECT, path = '/proj/docs/doc.md') {
  const env = memoryEnv({ ...files, [path]: text });
  const resolution = await resolveStyles({ path, text }, env);
  return { resolution, report: await filesInUse(resolution, env) };
}

describe('filesInUse: every file, in priority order', () => {
  it('lists the document, the profile chain, the template, then every stylesheet highest priority first', async () => {
    const { report: r, resolution } = await report(DOC(['extra.css', '${workingPath}/local.css']));
    expect(resolution.styles).not.toBeNull();
    expect(r.plain).toBe(false);
    expect(r.files.map((f) => `${f.role}:${f.path ?? f.name}`)).toEqual([
      'document:/proj/docs/doc.md',
      'profile:/proj/profiles/child.json',
      'profile:/proj/docs/.pagemd/profiles/parent.json',
      'profile:/pagemd/profiles/standard_letter.json',
      'template:/proj/docs/tpl.html',
      'stylesheet:/proj/docs/tpl.html', // the template's own <style>: outside every layer
      'stylesheet:/proj/docs/local.css', // the last `styles:` entry wins
      'stylesheet:/home/user/.pagemd/styles/extra.css',
      ...(r.files.some((f) => f.foundBy.kind === 'generated') ? ['stylesheet:CSS made from the properties'] : []),
      'stylesheet:/proj/profiles/theme/colors.css', // the profile's later CSS file wins over its earlier one
      'stylesheet:/proj/profiles/child.css',
      'stylesheet:/pagemd/styles/syntax/shiki-base.css',
      'stylesheet:/proj/styles/wide-layout.css',
      'stylesheet:/pagemd/styles/primary.css',
      'stylesheet:/pagemd/styles/base.css',
    ]);
    const sheets = r.files.filter((f) => f.role === 'stylesheet');
    expect(sheets.map((f) => f.rank)).toEqual(sheets.map((_, i) => i + 1));
    expect(sheets.map((f) => f.layer)).toEqual(sheets.map((f) => f.layer)); // every stylesheet has a layer
    expect(sheets.every((f) => f.layer !== undefined)).toBe(true);
    expect(r.files.find((f) => f.path === '/pagemd/styles/base.css')!.bundled).toBe(true);
    expect(r.files.find((f) => f.path === '/proj/profiles/child.css')!.bundled).toBe(false);
    expect(r.cascade).toMatch(/higher in this list wins/);
  });

  it('control: the same document with its two styles: entries swapped lists them swapped', async () => {
    const { report: r } = await report(DOC(['${workingPath}/local.css', 'extra.css']));
    const order = r.files.filter((f) => f.layer === 'frontmatter' && f.path).map((f) => f.path);
    expect(order).toEqual(['/home/user/.pagemd/styles/extra.css', '/proj/docs/local.css']);
  });
});

describe('filesInUse: why each file was chosen', () => {
  it('names the search step or the kind of path, in plain words', async () => {
    const { report: r } = await report(DOC(['extra.css', '${workingPath}/local.css']));
    const row = (path: string) => r.files.find((f) => f.path === path && f.role !== 'template' && !(f.layer === 'template'))!;
    // phase L2 (F7): a profile's search has six steps (the shared profiles folder is the fourth); other files keep five
    expect(row('/proj/profiles/child.json').foundBy).toEqual({ kind: 'search', step: 3, folder: '/proj/profiles', of: 6 });
    expect(row('/proj/profiles/child.json').why).toContain('the project folder (workspace root) (search step 3 of 6).');
    expect(row('/proj/docs/.pagemd/profiles/parent.json').foundBy).toMatchObject({ kind: 'search', step: 1 });
    expect(row('/proj/docs/.pagemd/profiles/parent.json').why).toMatch(/^The profile "child" extends it\./);
    expect(row('/pagemd/profiles/standard_letter.json').foundBy).toMatchObject({ kind: 'search', step: 6, of: 6 });
    expect(row('/proj/profiles/child.css').foundBy).toMatchObject({ kind: 'search', step: 2 });
    expect(row('/proj/profiles/child.css').why).toMatch(/^Named by the profile "child"\. Found by its name "child.css" in the profile's folder/);
    expect(row('/proj/profiles/theme/colors.css').foundBy).toEqual({ kind: 'path', base: '/proj/profiles' });
    expect(row('/proj/profiles/theme/colors.css').why).toContain("a path from the profile's folder (/proj/profiles)");
    expect(row('/proj/styles/wide-layout.css').foundBy).toMatchObject({ kind: 'search', step: 3 });
    expect(row('/proj/styles/wide-layout.css').why).toMatch(/^Named by the profile "parent"\./);
    expect(row('/home/user/.pagemd/styles/extra.css').foundBy).toEqual({ kind: 'search', step: 4, folder: '/home/user/.pagemd/styles' });
    expect(row('/home/user/.pagemd/styles/extra.css').why).toContain('your ~/.pagemd folder (search step 4 of 5).');
    expect(row('/home/user/.pagemd/styles/extra.css').why).toMatch(/^Listed in this document's styles:/);
    expect(row('/proj/docs/local.css').foundBy).toEqual({ kind: 'absolute' });
    expect(row('/proj/docs/local.css').why).toContain("${workingPath} is the document's folder");
    expect(row('/pagemd/styles/base.css').foundBy).toEqual({ kind: 'system' });
    const template = r.files.find((f) => f.role === 'template')!;
    expect(template.foundBy).toMatchObject({ kind: 'search', step: 1 });
    expect(template.why).toMatch(/^Named by the profile "parent"\./);
  });

  it('phase L2: a profile pack in the shared profiles folder is "search step 4 of 6"; ~/.pagemd is 5 of 6 for a profile', async () => {
    const shared = '/data/pagemd/profiles';
    const files = {
      '/proj/package.json': '{}',
      [`${shared}/pml-sop-ink.json`]: JSON.stringify({ id: 'pml-sop-ink', extends: 'home-base', resources: { css: ['./pml-sop-ink/style.css'] } }),
      [`${shared}/pml-sop-ink/manifest.json`]: '{"id":"pml-sop-ink","version":"0.1.0","files":[]}',
      [`${shared}/pml-sop-ink/style.css`]: 'p { color: #111; }',
      '/home/user/.pagemd/profiles/home-base.json': JSON.stringify({ id: 'home-base', extends: 'standard_letter' }),
    };
    const path = '/proj/docs/doc.md';
    const text = '---\nprofile: pml-sop-ink\n---\n# Pack\n';
    const env = memoryEnv({ ...files, [path]: text }, { sharedProfilesPath: shared });
    const r = await filesInUse(await resolveStyles({ path, text }, env), env);
    const pack = r.files.find((f) => f.path === `${shared}/pml-sop-ink.json`)!;
    expect(pack.foundBy).toEqual({ kind: 'search', step: 4, folder: shared, of: 6 });
    expect(pack.why).toContain('Found by its name "pml-sop-ink" in the shared profiles folder (profile packs) (search step 4 of 6).');
    expect(r.files.find((f) => f.path === '/home/user/.pagemd/profiles/home-base.json')!.why).toContain('your ~/.pagemd folder (search step 5 of 6).');
    expect(r.files.find((f) => f.path === `${shared}/pml-sop-ink/style.css`)).toBeDefined();
    // control: without the shared folder in the environment the pack is not found at all
    const without = memoryEnv({ ...files, [path]: text });
    expect((await resolveStyles({ path, text }, without)).notes.map((n) => n.kind)).toContain('profile-not-found');
  });

  it('control: the same name moved to another folder gives another step', async () => {
    const files = { ...PROJECT };
    delete files['/proj/profiles/child.css'];
    files['/proj/docs/styles/child.css'] = CHILD_CSS;
    const { report: r } = await report(DOC(['extra.css']), files);
    expect(r.files.find((f) => f.path === '/proj/docs/styles/child.css')!.foundBy).toMatchObject({ kind: 'search', step: 1 });
  });

  it("OQ-55 (answered: follow the code): a ./ path in styles: starts from the profile's folder and the row says so", async () => {
    const files = { ...PROJECT, '/proj/profiles/near-profile.css': 'p{}' };
    const { report: r } = await report(DOC(['./near-profile.css']), files);
    const row = r.files.find((f) => f.path === '/proj/profiles/near-profile.css')!;
    expect(row.foundBy).toEqual({ kind: 'path', base: '/proj/profiles' });
    expect(row.why).toContain("a path from the profile's folder (/proj/profiles)");
  });

  it("OQ-55, no profile set: a ./ path in styles: starts from pagemd's own profiles folder, so a file next to the document is not found (as pagemd's build)", async () => {
    const files = { '/proj/package.json': '{}', '/proj/docs/x.css': 'p{}' };
    const { report: r } = await report('---\nstyles: [./x.css]\n---\n# Hi\n', files);
    expect(r.problems.find((p) => p.source === './x.css')!.message).toBe('Relative path not found: ./x.css (resolved to /pagemd/profiles/x.css)');
    // a plain name and ${workingPath}/ find it
    expect((await report('---\nstyles: [x.css]\n---\n# Hi\n', files)).report.files.find((f) => f.path === '/proj/docs/x.css')!.foundBy).toMatchObject({ kind: 'search', step: 1 });
    expect((await report('---\nstyles: ["${workingPath}/x.css"]\n---\n# Hi\n', files)).report.files.find((f) => f.path === '/proj/docs/x.css')!.foundBy).toEqual({ kind: 'absolute' });
    // the panel's note says both rules (FIX-FT item 4)
    expect(r.cascade).toContain("the profile's folder (only for a file the profile names)");
    expect(r.cascade).toContain('the document\'s own styles: list starts in the profile\'s folder too');
  });

  it("the default profile and pagemd's default layout say so", async () => {
    const { report: r } = await report('# Plain\n', { '/proj/package.json': '{}' });
    expect(r.files[1]).toMatchObject({ role: 'profile', label: "Profile (pagemd's default)", path: '/pagemd/profiles/standard_letter.json' });
    expect(r.files[1]!.why).toMatch(/^No profile in the frontmatter, so pagemd's default profile "standard_letter"/);
    expect(r.files[0]!.why).toMatch(/names no profile/);
    // standard_letter names letter.css with ${cliPath}: a full path after the token
    const layout = r.files.find((f) => f.layer === 'layout')!;
    expect(layout.foundBy).toEqual({ kind: 'absolute' });
    expect(layout.why).toContain("${cliPath} is pagemd's own folder");
    // its resources.css lists primary.css, which pagemd loads anyway: a note, not a stylesheet row
    expect(r.problems).toContainEqual(expect.objectContaining({ kind: 'skipped' }));
    const noLayout = await report('---\nprofile: bare\n---\nx\n', { '/proj/package.json': '{}', '/proj/profiles/bare.json': '{"id":"bare"}' });
    const fallback = noLayout.report.files.find((f) => f.layer === 'layout')!;
    expect(fallback).toMatchObject({ path: '/pagemd/layouts/letter.css', foundBy: { kind: 'default' }, label: "Page layout (pagemd's default)" });
  });
});

describe('filesInUse: problems', () => {
  it('a missing styles: file (with the folders searched) and a name found in two folders (both paths)', async () => {
    const files = { ...PROJECT, '/proj/docs/dup.css': 'p{}', '/proj/styles/dup.css': 'p{}' };
    const { report: r, resolution } = await report(DOC(['nope.css', 'dup.css']), files);
    expect(resolution.styles).toBeNull(); // the canvas falls back to plain styles, as before
    expect(r.plain).toBe(true);
    const missing = r.problems.find((p) => p.source === 'nope.css')!;
    expect(missing.kind).toBe('missing');
    expect(missing.message).toMatch(/^Resource not found: nope.css/);
    const dup = r.problems.find((p) => p.source === 'dup.css')!;
    expect(dup.kind).toBe('duplicate');
    expect(dup.paths).toEqual(['/proj/docs/dup.css', '/proj/styles/dup.css']);
    const rows = r.files.filter((f) => f.layer === 'frontmatter');
    expect(rows.map((f) => f.problem?.split(':')[0])).toEqual(['Duplicate resources found for "dup.css"', 'Resource not found']);
    expect(rows[1]!.candidates!.length).toBeGreaterThan(3); // the folders searched
    // the rest of the trace is still there
    expect(r.files.some((f) => f.path === '/proj/profiles/child.css')).toBe(true);
  });

  it('a profile that is not found: the document row and the problem, nothing else', async () => {
    const { report: r } = await report('---\nprofile: missing-one\n---\nx\n', { '/proj/package.json': '{}' });
    expect(r.plain).toBe(true);
    expect(r.files.map((f) => f.role)).toEqual(['document']);
    expect(r.problems).toEqual([{ kind: 'profile-not-found', message: 'Profile not found in inheritance chain: missing-one', source: 'missing-one' }]);
  });

  it('a document that is not a file has no rows', async () => {
    const env = memoryEnv({});
    const r = await filesInUse(await resolveStyles({ path: null, text: '# x' }, env), env);
    expect(r).toMatchObject({ document: null, files: [], plain: true });
  });
});

describe('the rule index: every rule, scoped as the canvas scopes it', () => {
  it('lines, written selectors, canvas selectors, layers; dropped rules left out', async () => {
    const { report: r, resolution } = await report(DOC(['extra.css']));
    const child = r.files.find((f) => f.path === '/proj/profiles/child.css')!;
    const rules = r.rules.filter((rule) => rule.file === child.id);
    expect(rules.map((rule) => [rule.line, rule.selector, rule.selectors, rule.layer])).toEqual([
      [1, 'h1', ['.pmd-canvas h1'], 'profile'],
      [4, 'h2', ['.pmd-canvas:where(.pmd-print) h2'], 'profile'],
      [7, 'html', ['.pmd-canvas'], 'profile'],
    ]);
    expect(child.rules).toBe(3);
    expect(rules[0]!.declarations).toEqual([{ property: 'font-size', value: '30px', important: false }]);
    // The template's own <style>: its line in the template file (the commented-out one is not there)
    const own = r.files.find((f) => f.layer === 'template')!;
    expect(r.rules.filter((rule) => rule.file === own.id).map((rule) => [rule.line, rule.selector])).toEqual([[5, 'h1']]);
    // Every indexed selector is one the canvas really has (the same scoping)
    const canvas = new Set(scopedSelectors(resolution.styles!.css));
    const missing = r.rules.flatMap((rule) => rule.selectors).filter((s) => !canvas.has(s));
    expect(missing).toEqual([]);
    // order follows the cascade: base's rules first, the template's last
    const orders = r.rules.map((rule) => rule.order);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
    expect(r.rules[0]!.layer).toBe('base');
    expect(r.rules.at(-1)!.layer).toBe('template');
  });

  it('conditions and nested layers are kept for the webview to test', () => {
    const rules = indexCss('@media (min-width: 10px) { @supports (display: grid) { p { color: red } } }\n@layer extra { h1 { margin: 0 } }\n@keyframes k { from { opacity: 0 } }', 'f1', 'profile', 3);
    expect(rules).toEqual([
      expect.objectContaining({ selector: 'p', media: ['(min-width: 10px)'], supports: ['(display: grid)'], line: 1, order: 300000 }),
      expect.objectContaining({ selector: 'h1', nestedLayer: 'extra', line: 2, order: 300001 }),
    ]);
    expect(indexCss('p { color: red', 'f1', 'base', 0).length).toBeLessThanOrEqual(1); // postcss reads an unclosed block; never throws
  });

  it("templateStyles: each <style> block with its line, comments skipped, a media attribute kept", () => {
    expect(templateStyles('<style media="print">\np{}\n</style>\n<!-- <style>x{}</style> -->\n<style>q{}</style>')).toEqual([
      { css: '\np{}\n', line: 0, media: 'print' },
      { css: 'q{}', line: 4 },
    ]);
  });

  it('foundBy: an unknown folder', () => {
    expect(foundBy('styles', 'x.css', '/elsewhere/x.css', { working: '/proj', workspace: '/proj', manifest: null, home: '/home/u', cli: '/pagemd' }, 'frontmatter')).toEqual({ kind: 'unknown' });
  });
});
