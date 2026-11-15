// P10 acceptance (R-170 amendment 8): the editor's export is pagemd's. pagemd's runtime file is built here exactly as
// `npm run build` builds it (from the local pagemd checkout, AD-P10-01), loaded with a real import(), and compared with the
// `pagemd build` command line on pagemd's own example documents: HTML byte for byte, PDF page count and text (pdftotext).
// Also: the canvas, the Print Preview and the CLI draw diagrams with one mermaid version.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error esbuild.mjs is plain JavaScript without type declarations
import { buildRuntime, pagemdCheckout } from '../../esbuild.mjs';
import { MERMAID_VERSION } from '@pagemd-editor/preset-pagemd';
import type { PagemdRuntime } from '@pagemd-editor/output-pagemd';

const CHECKOUT: string = pagemdCheckout();
const CLI = join(CHECKOUT, 'apps', 'cli', 'src', 'index.js');
const EXAMPLES = join(CHECKOUT, 'tests', 'corpus', 'pagemd', 'examples', 'md');
const hasCheckout = existsSync(CLI);
const hasPdfToText = spawnSync('pdftotext', ['-v']).status === 0;

let outdir = '';
let runtime: PagemdRuntime;
let browser: string | null = null;

beforeAll(async () => {
  if (!hasCheckout) return;
  outdir = mkdtempSync(join(tmpdir(), 'pmd-runtime-'));
  const file: string = await buildRuntime(outdir);
  runtime = ((await import(pathToFileURL(file).href)) as { runtime: PagemdRuntime }).runtime;
  browser = runtime.detectBrowser();
  process.env['PAGEMD_MERMAID'] = '0'; // as the CLI below (diagrams aren't what these documents compare)
}, 120_000);
afterAll(() => {
  delete process.env['PAGEMD_MERMAID'];
  if (outdir) rmSync(outdir, { recursive: true, force: true });
});

function cli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC', PAGEMD_MERMAID: '0' }, maxBuffer: 64 * 1024 * 1024 });
}

const pdfText = (file: string): string => execFileSync('pdftotext', [file, '-'], { encoding: 'utf8' });

describe.skipIf(!hasCheckout)('pagemd runtime file = pagemd build', () => {
  it.each(['01-basic-document.md', '05-extended-syntax-stress.md', '09-toc-stress.md', '15-advanced-tables.md'])('HTML of %s, byte for byte', async (name) => {
    const file = join(EXAMPLES, name);
    const viaCli = cli(['build', file, '-o', 'html', '--stdout']);
    expect(viaCli.status, viaCli.stderr).toBe(0);
    const target = join(outdir, 'html', name.replace(/\.md$/, '.html'));
    const result = await runtime.exportText(readFileSync(file, 'utf8'), { markdownPath: file, format: 'html', target, cliPath: CHECKOUT });
    expect(result.path).toBe(target);
    expect(readFileSync(target, 'utf8')).toBe(viaCli.stdout);
  }, 60_000);

  it.skipIf(!hasPdfToText).each(['01-basic-document.md', '12-user-guide-multipage.md', '11-technical-report-multipage.md'])('PDF of %s: same pages, same text', async (name) => {
    if (!browser) return; // no browser on this machine: nothing to compare
    const file = join(EXAMPLES, name);
    const cliDir = join(outdir, 'cli');
    mkdirSync(cliDir, { recursive: true });
    const viaCli = cli(['build', file, '-o', 'pdf', '--output-dir', cliDir]);
    expect(viaCli.status, viaCli.stderr).toBe(0);
    const cliPdf = join(cliDir, name.replace(/\.md$/, '.pdf'));
    const target = join(outdir, 'pdf', name.replace(/\.md$/, '.pdf'));
    const result = await runtime.exportText(readFileSync(file, 'utf8'), { markdownPath: file, format: 'pdf', target, cliPath: CHECKOUT, browserPath: browser });
    const ours = pdfText(target);
    const theirs = pdfText(cliPdf);
    expect(ours.split('\f').length).toBe(theirs.split('\f').length);
    expect(result.pages).toBe(theirs.split('\f').length - 1);
    expect(ours).toBe(theirs);
  }, 180_000);

  it('with the editor\'s own copy of pagemd\'s files (R-128), a document outside pagemd exports as the CLI does', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'pmd-outside-'));
    try {
      const file = join(folder, 'memo.md');
      // P26: with a task list and a footnote too (their HTML and the CSS pagemd adds only for them)
      writeFileSync(file, '---\ntitle: Memo\ndocument_id: M-1\n---\n\n# Memo\n\nA paragraph with **bold** text.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] Done[^1]\n- [ ] Open\n\n[^1]: A note.\n');
      // To a file: for a document outside any project, the CLI also prints a log line on --stdout (a pagemd quirk, AD-P10-13).
      const cliDir = join(folder, 'cli');
      mkdirSync(cliDir);
      const viaCli = cli(['build', file, '-o', 'html', '--output-dir', cliDir]);
      expect(viaCli.status, viaCli.stderr).toBe(0);
      // The build copies theme-kit's defaults/ next to the host bundle; here the source folder is used directly.
      const defaults = join(createRequire(join(process.cwd(), 'package.json')).resolve('@pagemd/theme-kit/defaults/.gitattributes'), '..');
      const result = await runtime.exportText(null, { markdownPath: file, format: 'html', target: join(folder, 'memo.html'), cliPath: defaults });
      expect(result.path).toBe(join(folder, 'memo.html'));
      const ours = readFileSync(join(folder, 'memo.html'), 'utf8').split(defaults).join('<pagemd>');
      expect(ours).toBe(readFileSync(join(cliDir, 'memo.html'), 'utf8').split(CHECKOUT).join('<pagemd>'));
      // P26 (OQ-57, R-246): both print standard_letter's new header: the title and id written, no status or revision (no "Draft", no "Rev 0")
      expect(ours).toContain('<h1 class="document-title">Memo</h1>');
      expect(ours).toContain('M-1');
      expect(ours).not.toContain('class="document-status"');
      expect(ours).not.toContain('Rev 0');
      expect(ours).toContain('<input class="task-list-item-checkbox" checked="" disabled="" type="checkbox"> Done<sup class="footnote-ref">');
      expect(ours).toContain('/* pagemd: footnotes */');
      expect(ours).toContain('/* pagemd: task-lists */');
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }, 60_000);

  it('the Print Preview page: Paged.js with the nonce, the config, absolute file addresses, diagram placeholders', async () => {
    delete process.env['PAGEMD_MERMAID'];
    try {
      const file = join(EXAMPLES, '01-basic-document.md');
      const text = `${readFileSync(file, 'utf8')}\n\n\`\`\`mermaid\ngraph LR\n  A --> B\n\`\`\`\n`;
      const page = await runtime.renderForPreview(text, { markdownPath: file, cliPath: CHECKOUT, nonce: 'N0nce', beforePolyfill: '<!--before-->' });
      expect(page.profile).toBe('standard_letter');
      expect(page.colorScheme).toBe('light');
      expect(page.html.match(/<script nonce="N0nce">/g)?.length).toBe(2);
      expect(page.html).toContain('window.PagedConfig =');
      expect(page.html.indexOf('<!--before-->')).toBeLessThan(page.html.lastIndexOf('<script nonce="N0nce">'));
      expect(page.html).toMatch(/<base href="file:\/\//);
      expect(page.html).toMatch(/<pre class="mermaid" data-mermaid-id="mermaid-[0-9a-f]{10}">graph LR&#10;  A --&gt; B<\/pre>/);
    } finally {
      process.env['PAGEMD_MERMAID'] = '0';
    }
  }, 60_000);
  // FIX-preview: with pagemd's real page (it turns relative addresses into file:// paths), the diagram library is carried only
  // for a document with a diagram, and pictures in a folder with spaces become data: addresses.
  it('PagemdOutput on the real runtime: the library only with a diagram; pictures in a folder with spaces carried in the page', async () => {
    delete process.env['PAGEMD_MERMAID'];
    const folder = mkdtempSync(join(tmpdir(), 'pmd preview '));
    try {
      writeFileSync(join(folder, 'a b.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAD0lEQVR4nGNgYPiPhHBxAN1JC/U39qNPAAAAAElFTkSuQmCC', 'base64'));
      const { PagemdOutput } = await import('@pagemd-editor/output-pagemd');
      const out = new PagemdOutput({
        load: async () => runtime,
        cliPath: () => CHECKOUT,
        browserSetting: () => undefined,
        pathOf: () => join(folder, 'doc.md'),
        page: () => ({
          nonce: 'N0nce',
          mermaidScript: 'https://webview.test/mermaid.min.js',
          mapFileUrl: () => null,
          embed: async (url) => (url.endsWith('/') ? null : { url: 'data:image/png;base64,PIC' }),
          mermaidData: async () => 'data:text/javascript;base64,LIB',
        }),
        mermaidConfig: {},
      });
      const doc = (text: string) => ({ uri: pathToFileURL(join(folder, 'doc.md')).href, text, version: 1 });
      const drawn = await out.preview(doc('# A\n\n![pic](<./a b.png>)\n\n```mermaid\ngraph LR\n  A --> B\n```\n'));
      expect(drawn.html).toContain('<script nonce="N0nce" src="data:text/javascript;base64,LIB"></script>');
      expect(drawn.html).toContain('src="data:image/png;base64,PIC"');
      expect(drawn.message).toBeUndefined();
      const plain = await out.preview(doc('# A\n'));
      expect(plain.html).not.toContain('pmd-mermaid-library');
      expect(plain.html).not.toContain('base64,LIB');
    } finally {
      process.env['PAGEMD_MERMAID'] = '0';
      rmSync(folder, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('one mermaid version (R-167)', () => {
  it('the editor webview\'s copy is the version @pagemd/syntax names, pinned exactly', () => {
    const app = JSON.parse(readFileSync(join(process.cwd(), 'apps', 'vscode', 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    expect(app.dependencies['mermaid']).toBe(MERMAID_VERSION);
    const installed = createRequire(join(process.cwd(), 'apps', 'vscode', 'package.json'))('mermaid/package.json') as { version: string };
    expect(installed.version).toBe(MERMAID_VERSION);
  });

  it.skipIf(!hasCheckout)('pagemd (the CLI, and so the export) draws with the same version', () => {
    expect(runtime.mermaidVersion()).toBe(MERMAID_VERSION);
    const parser = JSON.parse(readFileSync(join(CHECKOUT, 'packages', 'parser', 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    expect(parser.dependencies['mermaid']).toBe(MERMAID_VERSION);
  });
});
