// output-pagemd (P10): the provider around pagemd's runtime, with a stand-in runtime. The real runtime against the CLI is
// test/output/pagemd-runtime.test.ts.
import { describe, expect, it } from 'vitest';
import type { DocSnapshot, OutputFormat } from '@pagemd-editor/core';
import { embedFileUrls, mermaidRunner, NO_BROWSER, outsideScripts, PagemdOutput, previewWatch, rewriteFileUrls, type PagemdRuntime, type PreviewPage } from '../src/index.ts';

const DOC: DocSnapshot = { uri: 'file:///work/a.md', text: '# A\n', version: 3 };
const PAGE: PreviewPage = { nonce: 'N0nce', mermaidScript: 'https://webview.test/ext/dist/webview/mermaid/mermaid.min.js', mapFileUrl: (url) => url.replace('file:///work/', 'https://webview.test/work/') };

interface Calls {
  preview: Parameters<PagemdRuntime['renderForPreview']>[];
  export: Parameters<PagemdRuntime['exportText']>[];
}

function fake(browser: string | null, overrides: Partial<PagemdRuntime> = {}): { runtime: PagemdRuntime; calls: Calls } {
  const calls: Calls = { preview: [], export: [] };
  const runtime: PagemdRuntime = {
    renderForPreview: async (text, options) => {
      calls.preview.push([text, options]);
      return { html: `<html><head><base href="file:///work/"></head><body><img src="file:///work/a.png"><script>var u = "file:///work/x";</script></body></html>`, colorScheme: 'light', profile: 'standard_letter' };
    },
    exportText: async (text, options) => {
      calls.export.push([text, options]);
      return { path: options.target, ...(options.format === 'pdf' ? { pages: 4 } : {}) };
    },
    detectBrowser: () => browser,
    mermaidVersion: () => '12.1.0',
    ...overrides,
  };
  return { runtime, calls };
}

function output(runtime: Promise<PagemdRuntime>, setting?: string, path: string | null = '/work/a.md', page: PreviewPage = PAGE): PagemdOutput {
  return new PagemdOutput({
    load: () => runtime,
    cliPath: () => '/ext/dist/defaults',
    browserSetting: () => setting,
    pathOf: () => path,
    page: () => page,
    mermaidConfig: { startOnLoad: false, securityLevel: 'strict' },
  });
}

describe('the Print Preview page (D19)', () => {
  it('rewrites every file:// address outside scripts, and leaves scripts alone', () => {
    const html = `<base href="file:///work/"><img src="file:///work/a%20b.png"><div style="background: url(file:///work/bg.png)"></div><script>"file:///work/keep"</script>`;
    const out = rewriteFileUrls(html, (url) => `W[${url.slice('file://'.length)}]`);
    expect(out).toBe(`<base href="W[/work/]"><img src="W[/work/a%20b.png]"><div style="background: url(W[/work/bg.png])"></div><script>"file:///work/keep"</script>`);
  });

  it('keeps an address the webview can\'t load as it was', () => {
    expect(rewriteFileUrls('<img src="file:///elsewhere/x.png">', () => null)).toBe('<img src="file:///elsewhere/x.png">');
  });

  // FIX-preview: pagemd writes its file addresses with the path's own spaces (not `%20`), so an address ends at its closing quote.
  it('rewrites a whole address with spaces in it (pagemd writes them as they are), in quotes and in CSS', () => {
    const html = `<base href="file:///D:/My Documents/Delay Reporter/"><img\n  src="file:///D:/My Documents/a b.png" alt="x"><i style='background: url(file:///D:/My Documents/bg.png)'></i><p style="background: url(&quot;file:///D:/My Documents/q.png&quot;)"></p>`;
    const out = rewriteFileUrls(html, (url) => `W[${url.slice('file://'.length)}]`);
    expect(out).toBe(`<base href="W[/D:/My Documents/Delay Reporter/]"><img\n  src="W[/D:/My Documents/a b.png]" alt="x"><i style='background: url(W[/D:/My Documents/bg.png])'></i><p style="background: url(&quot;W[/D:/My Documents/q.png]&quot;)"></p>`);
  });

  it('embeds each file once as the address the map gives (data:), outside scripts only, and lists what could not be embedded', async () => {
    const html = `<base href="file:///w/d/"><img src="file:///w/d/a b.png"><img src="file:///w/d/a b.png"><img src="file:///w/gone.png"><script>"file:///w/d/a b.png"</script>`;
    const asked: string[] = [];
    const out = await embedFileUrls(html, async (url) => {
      asked.push(url);
      if (url.endsWith('/')) return null;
      return url.includes('gone') ? { problem: 'gone.png (not found)' } : { url: 'data:image/png;base64,AAA' };
    });
    expect(asked).toEqual(['file:///w/d/', 'file:///w/d/a b.png', 'file:///w/gone.png']);
    expect(out.html).toBe(`<base href="file:///w/d/"><img src="data:image/png;base64,AAA"><img src="data:image/png;base64,AAA"><img src="file:///w/gone.png"><script>"file:///w/d/a b.png"</script>`);
    expect(out.problems).toEqual(['gone.png (not found)']);
  });

  it('the watch script records an error or a failed promise in the page (so a stopped layout is reported, not waited on)', () => {
    const html = previewWatch('ab"c');
    expect(html).toMatch(/^<script nonce="abc">/);
    expect(html).toContain("addEventListener('error'");
    expect(html).toContain("addEventListener('unhandledrejection'");
    expect(html).toContain('__pmdPreviewError');
  });

  it('splits the HTML around its scripts', () => {
    expect(outsideScripts('a<script src="x"></script>b<SCRIPT>c</SCRIPT >d')).toEqual([
      ['a', false],
      ['<script src="x"></script>', true],
      ['b', false],
      ['<SCRIPT>c</SCRIPT >', true],
      ['d', false],
    ]);
  });

  it('the diagram scripts carry the nonce, load mermaid from the extension and draw before Paged.js', () => {
    const html = mermaidRunner('ab"c', 'https://w/m.js?x="1"', { theme: 'default' });
    expect(html.match(/<script nonce="abc"/g)).toHaveLength(2);
    expect(html).toContain('src="https://w/m.js?x=&quot;1&quot;"');
    expect(html).toContain('window.mermaid.initialize({"theme":"default"})');
    expect(html).toContain("pre.mermaid[data-mermaid-id]");
    expect(html).toContain('config.before = async function');
    expect(html).toContain('if (before) return before(flow);');
  });
});

describe('PagemdOutput', () => {
  it('previews through the runtime: the document text and path, pagemd\'s folder, the nonce and the diagram scripts; file addresses rewritten', async () => {
    const { runtime, calls } = fake('/usr/bin/google-chrome');
    const result = await output(Promise.resolve(runtime)).preview(DOC);
    expect(calls.preview).toHaveLength(1);
    const [text, options] = calls.preview[0]!;
    expect(text).toBe('# A\n');
    expect(options).toMatchObject({ markdownPath: '/work/a.md', cliPath: '/ext/dist/defaults', nonce: 'N0nce' });
    expect(options.beforePolyfill).toContain(PAGE.mermaidScript);
    expect(result).toEqual({
      html: '<html><head><base href="https://webview.test/work/"></head><body><img src="https://webview.test/work/a.png"><script>var u = "file:///work/x";</script></body></html>',
      provider: 'pagemd',
      colorScheme: 'light',
    });
  });

  // FIX-preview: VS Code refuses every webview address asked for by a `srcdoc` frame (its service worker can't tell which webview
  // the frame belongs to), so the preview page carries its files itself: pictures, fonts and the diagram library as data: addresses.
  it('embeds the page\'s files (data:) and says which could not be shown; the base stays a webview address', async () => {
    const { runtime } = fake('/c', {
      renderForPreview: async () => ({ html: '<html><head><base href="file:///work/My Docs/"></head><body><img src="file:///work/My Docs/a.png"><img src="file:///work/My Docs/gone.png"></body></html>', colorScheme: 'light', profile: 'p' }),
    });
    const page: PreviewPage = { ...PAGE, embed: async (url) => (url.endsWith('/') ? null : url.endsWith('gone.png') ? { problem: 'gone.png (not found)' } : { url: 'data:image/png;base64,QQ==' }) };
    const result = await output(Promise.resolve(runtime), undefined, '/work/My Docs/a.md', page).preview(DOC);
    expect(result.html).toBe('<html><head><base href="https://webview.test/work/My Docs/"></head><body><img src="data:image/png;base64,QQ=="><img src="https://webview.test/work/My Docs/gone.png"></body></html>');
    expect(result.message).toBe('Some files could not be shown: gone.png (not found).');
  });

  it('carries the diagram library (data:) only when the document has a diagram; without one the page loads no library', async () => {
    const withDiagram = '<html><body><figure class="mermaid-diagram"><pre class="mermaid" data-mermaid-id="m1">graph LR</pre></figure></body></html>';
    let asked = 0;
    const page: PreviewPage = { ...PAGE, embed: async () => null, mermaidData: async () => (asked++, 'data:text/javascript;base64,TQ==') };
    const make = (html: string) => fake('/c', { renderForPreview: async (_t, o) => ({ html: html.replace('<body>', `<body>${o.beforePolyfill}`), colorScheme: 'light', profile: 'p' }) }).runtime;
    const drawn = await output(Promise.resolve(make(withDiagram)), undefined, '/work/a.md', page).preview(DOC);
    expect(drawn.html).toContain('src="data:text/javascript;base64,TQ=="');
    expect(drawn.html).not.toContain(PAGE.mermaidScript);
    expect(asked).toBe(1);
    const plain = await output(Promise.resolve(make('<html><body><p>No diagram</p></body></html>')), undefined, '/work/a.md', page).preview(DOC);
    expect(plain.html).not.toMatch(/<script[^>]*\ssrc=/);
    expect(plain.html).toContain('__pmdPreviewError');
    expect(asked).toBe(1);
  });

  it('finds the browser in the approved order (R-169): Chrome or Edge first, then the setting', async () => {
    expect(await output(Promise.resolve(fake('/usr/bin/microsoft-edge').runtime), '/opt/chromium').browser()).toBe('/usr/bin/microsoft-edge');
    expect(await output(Promise.resolve(fake(null).runtime), ' /opt/chromium ').browser()).toBe('/opt/chromium');
    expect(await output(Promise.resolve(fake(null).runtime), '  ').browser()).toBeNull();
  });

  it.each<[OutputFormat, number | undefined]>([
    ['pdf', 4],
    ['png', undefined],
  ])('exports %s with the browser found', async (format, pages) => {
    const { runtime, calls } = fake('/usr/bin/google-chrome');
    const result = await output(Promise.resolve(runtime)).export(DOC, format, `/out/a.${format}`);
    expect(calls.export[0]![1]).toEqual({ markdownPath: '/work/a.md', format, target: `/out/a.${format}`, cliPath: '/ext/dist/defaults', browserPath: '/usr/bin/google-chrome' });
    expect(result).toEqual({ ok: true, target: `/out/a.${format}`, ...(pages ? { message: '4 pages' } : {}) });
  });

  it('refuses a PDF or PNG without any browser, and never asks the runtime (nothing is downloaded)', async () => {
    const { runtime, calls } = fake(null);
    expect(await output(Promise.resolve(runtime)).export(DOC, 'pdf', '/out/a.pdf')).toEqual({ ok: false, message: NO_BROWSER });
    expect(await output(Promise.resolve(runtime)).export(DOC, 'png', '/out/a.png')).toEqual({ ok: false, message: NO_BROWSER });
    expect(calls.export).toEqual([]);
  });

  it('exports HTML without a browser (diagrams then stay code, as in pagemd)', async () => {
    const { runtime, calls } = fake(null);
    expect(await output(Promise.resolve(runtime)).export(DOC, 'html', '/out/a.html')).toEqual({ ok: true, target: '/out/a.html' });
    expect(calls.export[0]![1]).not.toHaveProperty('browserPath');
  });

  it('reports a failed export with pagemd\'s message', async () => {
    const { runtime } = fake('/c', { exportText: () => Promise.reject(new Error('Template load failed')) });
    expect(await output(Promise.resolve(runtime)).export(DOC, 'pdf', '/o.pdf')).toEqual({ ok: false, message: 'Template load failed' });
  });

  it('a document that is not a file can\'t be previewed or exported', async () => {
    const out = output(Promise.resolve(fake('/c').runtime), undefined, null);
    await expect(out.preview(DOC)).rejects.toThrow(/saved as a file/);
    expect((await out.export(DOC, 'html', '/o.html')).ok).toBe(false);
  });

  it('is not available when the runtime fails to load, and loads it once', async () => {
    let loads = 0;
    const failing = new PagemdOutput({ load: () => (loads++, Promise.reject(new Error('missing'))), cliPath: () => '', browserSetting: () => undefined, pathOf: () => '/a.md', page: () => PAGE, mermaidConfig: {} });
    expect(await failing.available()).toBe(false);
    expect(await failing.available()).toBe(false);
    expect(loads).toBe(1);
    expect(await output(Promise.resolve(fake('/c').runtime)).available()).toBe(true);
  });
});
