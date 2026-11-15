// FIX-template-asset-paths (R-259, OQ-80): the canvas finds a template's and a profile stylesheet's pictures from that file's own
// folder, with @pagemd/resolver's rebaseAssetPaths (the function pagemd's page uses), lists them in Files in Use and names the
// folders the webview must be allowed to load from. The user's shape: the document in 01-SOP/, the profile named by its full path.
import { describe, expect, it } from 'vitest';
import { assetFolders, filesInUse, resolveStyles } from '../src/index.ts';
import { memoryEnv } from './fixtures.ts';

const DOC = '/w/01-SOP/document.md';
const R = '/w/Resources/uofo-how-to-report';
const TEXT = `---\ntitle: T\npipeline_profile: ${R}/profile.json\n---\n# Hello\n\n![own](pic.png)\n`;
const TEMPLATE = [
  '<html><head>{{styles}}<style>.logo{background:url(../assets/images/bg.png)}</style></head><body>',
  '<!-- <img src="../assets/images/dashboard.png"> -->',
  '<header><img src="../assets/images/dashboard.png" alt="A"><img src=".pagemd/assets/old.png" alt="D"><img src="gone.png" alt="G"></header>',
  '<main>{{content}}</main></body></html>',
].join('\n');

function files(): Record<string, string> {
  return {
    [DOC]: TEXT,
    '/w/01-SOP/pic.png': 'png',
    '/w/01-SOP/.pagemd/assets/old.png': 'png',
    [`${R}/profile.json`]: JSON.stringify({ id: 'uofo', extends: 'standard_letter', resources: { template: './templates/t.html', css: ['./styles/p.css'] } }),
    [`${R}/templates/t.html`]: TEMPLATE,
    [`${R}/styles/p.css`]: 'h1 { background: url("../assets/images/bg.png"); } /* url(nope.png) */',
    [`${R}/assets/images/dashboard.png`]: 'png',
    [`${R}/assets/images/bg.png`]: 'png',
  };
}

async function resolve() {
  const env = memoryEnv(files());
  return { env, result: await resolveStyles({ path: DOC, text: TEXT }, env) };
}

describe('the canvas: a template\'s pictures from the template\'s folder', () => {
  it('the template drawn on the canvas names the logo from the document\'s folder; the old shape and the comment stay as written', async () => {
    const { result } = await resolve();
    const html = result.styles!.template!.html;
    expect(html).toContain('<img src="../Resources/uofo-how-to-report/assets/images/dashboard.png" alt="A">');
    expect(html).toContain('<img src=".pagemd/assets/old.png" alt="D">');
    expect(html).toContain('<img src="gone.png" alt="G">');
  });

  it('url() in the profile CSS and in the template\'s own <style> too', async () => {
    const { result } = await resolve();
    const css = result.styles!.css;
    expect(css).toContain('url("../Resources/uofo-how-to-report/assets/images/bg.png")');
    expect(css).toContain('url(../Resources/uofo-how-to-report/assets/images/bg.png)');
  });

  it('the folders the webview must be allowed to load from: only where something was found next to the file', async () => {
    const { result } = await resolve();
    expect(assetFolders(result)).toEqual([`${R}/assets/images`]);
  });

  it('Files in Use lists each file the template and the stylesheet pull in, and the missing one as a problem', async () => {
    const { env, result } = await resolve();
    const report = await filesInUse(result, env);
    const assets = report.files.filter((f) => f.role === 'asset');
    expect(assets.map((f) => [f.source, f.path, f.problem ?? null])).toEqual([
      ['../assets/images/bg.png', `${R}/assets/images/bg.png`, null],
      ['../assets/images/dashboard.png', `${R}/assets/images/dashboard.png`, null],
      ['.pagemd/assets/old.png', '/w/01-SOP/.pagemd/assets/old.png', null],
      ['gone.png', null, `Not found: looked in ${R}/templates/gone.png and /w/01-SOP/gone.png`],
      ['../assets/images/bg.png', `${R}/assets/images/bg.png`, null],
    ]);
    expect(assets[2]!.why).toContain("read from the document's folder");
    expect(report.problems).toContainEqual(expect.objectContaining({ kind: 'template-asset-missing', source: 'gone.png' }));
    // the rows come before the stylesheets, after the template
    const roles = report.files.map((f) => f.role);
    expect(roles.indexOf('template')).toBeLessThan(roles.indexOf('asset'));
    expect(roles.lastIndexOf('asset')).toBeLessThan(roles.indexOf('stylesheet'));
  });
});
