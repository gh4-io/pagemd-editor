// output-html (P10): the built-in fallback for Print Preview and Export.
import { describe, expect, it } from 'vitest';
import type { DocSnapshot } from '@pagemd-editor/core';
import { HTML_INFO, HtmlOutput, htmlPage } from '../src/index.ts';

const DOC: DocSnapshot = { uri: 'file:///work/My%20Guide.md', text: '# A\n', version: 1 };

function output(writes: [string, string][] = []): HtmlOutput {
  return new HtmlOutput({
    render: (text) => `<h1>${text.slice(2).trim()}</h1>`,
    css: async () => '.pmd-canvas h1 { color: red; } </style><script>x</script>',
    write: async (target, html) => void writes.push([target, html]),
    reason: "pagemd's renderer is not built",
  });
}

describe('output-html', () => {
  it('makes a whole page: the canvas CSS (closing tags made harmless), the title, the body in .pmd-canvas', () => {
    const page = htmlPage('<p>x</p>', 'p{}</style>', 'a < b');
    expect(page).toContain('<title>a &lt; b</title>');
    expect(page).toContain('p{}<\\/style>');
    expect(page).toContain('<div class="pmd-canvas">\n<p>x</p>\n</div>');
  });

  it('previews as plain HTML, says why, light like the PDF', async () => {
    const result = await output().preview(DOC);
    expect(result.provider).toBe('html');
    expect(result.colorScheme).toBe('light');
    expect(result.message).toBe("pagemd's renderer is not built");
    expect(result.html).toContain('<title>My Guide.md</title>');
    expect(result.html).toContain('<h1>A</h1>');
  });

  it('exports HTML only', async () => {
    const writes: [string, string][] = [];
    expect(await output(writes).export(DOC, 'html', '/out/a.html')).toEqual({ ok: true, target: '/out/a.html' });
    expect(writes.map(([t]) => t)).toEqual(['/out/a.html']);
    const pdf = await output(writes).export(DOC, 'pdf', '/out/a.pdf');
    expect(pdf.ok).toBe(false);
    expect(pdf.message).toMatch(/can't make PDF/);
    expect(writes).toHaveLength(1);
    expect(HTML_INFO.formats).toEqual(['html']);
  });

  it('reports a failed write', async () => {
    const failing = new HtmlOutput({ render: () => '', css: async () => '', write: () => Promise.reject(new Error('read-only')) });
    expect(await failing.export(DOC, 'html', '/x.html')).toEqual({ ok: false, message: 'read-only' });
    expect(await failing.available()).toBe(true);
  });

  it('P27 (R-251): refuses a document the app says it must not show (redactions): the preview holds only the reason, nothing is written', async () => {
    const writes: [string, string][] = [];
    const refusing = new HtmlOutput({
      render: () => '<img src="secret.png">',
      css: async () => '',
      write: async (target, html) => void writes.push([target, html]),
      refuse: (text) => (text.includes('redact') ? 'This document has redacted pictures (secret.png).' : null),
    });
    const doc: DocSnapshot = { uri: 'file:///work/a.md', text: '::: annotated-image secret.png\nredact: []\n:::\n', version: 1 };
    expect(await refusing.export(doc, 'html', '/out/a.html')).toEqual({ ok: false, message: 'This document has redacted pictures (secret.png).' });
    expect(writes).toEqual([]);
    const preview = await refusing.preview(doc);
    expect(preview.html).not.toContain('<img');
    expect(preview.message).toContain('redacted pictures');
    // the control: a document without redactions is shown and exported as before
    expect((await refusing.export({ ...doc, text: '# A\n' }, 'html', '/out/b.html')).ok).toBe(true);
    expect(writes.map(([t]) => t)).toEqual(['/out/b.html']);
  });
});
