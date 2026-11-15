// IOutput on the host (P10, R-167–R-170): the runtime file loaded by a real import(), the plain-HTML fallback, the Export
// flow (Save dialog next to the document, progress, Open / Show in Folder, the no-browser message) and the profile picker.
// The real pagemd runtime against the CLI is test/output/pagemd-runtime.test.ts.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as mock from '../../../__mocks__/vscode.ts';
import type * as vscode from 'vscode';
import { NO_FILES, PLAIN_STYLES, type HostStyles } from '../host/services/styles.ts';
import { defaultTarget, HostOutput, loadRuntime } from '../host/services/output.ts';
import type { StylesPayload } from '../shared/protocol.ts';

const scratch = mkdtempSync(join(tmpdir(), 'pmd-p10-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A stand-in runtime file (an ES module, loaded by the host's real import()); records its calls on globalThis. */
function runtimeFile(browser: string | null): string {
  const dir = join(scratch, `rt-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'runtime.mjs');
  writeFileSync(
    file,
    `const calls = (globalThis.__pmdRuntimeCalls ??= []);
export const runtime = {
  async renderForPreview(text, options) { calls.push(['preview', text, options]); if (globalThis.__pmdRenderGate) await globalThis.__pmdRenderGate; return { html: '<img src="file:///work/docs/a.png">', colorScheme: 'light', profile: 'standard_letter' }; },
  async exportText(text, options) { calls.push(['export', text, options]); return { path: options.target, pages: options.format === 'pdf' ? 2 : undefined }; },
  detectBrowser: () => ${JSON.stringify(browser)},
  mermaidVersion: () => '12.1.0',
};
`,
  );
  return file;
}

const calls = (): unknown[][] => ((globalThis as { __pmdRuntimeCalls?: unknown[][] }).__pmdRuntimeCalls ??= []);

const styles = (payload: StylesPayload = PLAIN_STYLES): HostStyles => ({ get: async () => payload, onChange: () => ({ dispose() {} }), createLayoutFile: async () => 'declined', filesInUse: async () => NO_FILES, dispose() {} });

function make(text: string, runtime?: string, path = '/work/docs/guide.md'): { output: HostOutput; doc: mock.MockTextDocument; log: string[]; debug: string[]; view: ReturnType<typeof mock.createWebviewPanel> } {
  const doc = new mock.MockTextDocument(mock.Uri.file(path), text);
  mock.openDocuments.push(doc);
  const log: string[] = [];
  const debug: string[] = [];
  const view = mock.createWebviewPanel();
  const output = new HostOutput(doc as unknown as vscode.TextDocument, view.panel.webview, {
    extensionUri: mock.Uri.file('/ext') as unknown as vscode.Uri,
    log: (line) => log.push(line),
    debug: (line) => debug.push(line),
    styles: styles(),
    runtimeFile: runtime ?? join(scratch, 'missing', 'runtime.mjs'),
  });
  return { output, doc, log, debug, view };
}

beforeEach(() => {
  mock.resetMock();
  calls().length = 0;
});

describe('where an export goes (R-170 Q6)', () => {
  it('next to the document, with pagemd build\'s name', () => {
    expect(defaultTarget('/work/docs/guide.md', 'pdf')).toBe('/work/docs/guide.pdf');
    expect(defaultTarget('/work/docs/Guide.MD', 'html')).toBe('/work/docs/Guide.html');
    expect(defaultTarget('/work/notes', 'png')).toBe('/work/notes.png');
  });
});

describe('the runtime file', () => {
  it('is loaded with a real import(), once', async () => {
    const file = runtimeFile('/usr/bin/google-chrome');
    const a = await loadRuntime(file);
    expect(await loadRuntime(file)).toBe(a);
    expect(a.mermaidVersion()).toBe('12.1.0');
  });

  it('a missing file is "not available": plain HTML, saying why, and editing goes on', async () => {
    const { output, log } = make('# Guide\n');
    expect(output.info()).toEqual([{ id: 'html', label: 'Plain HTML', formats: ['html'] }]);
    const result = await output.preview('N');
    expect(result.provider).toBe('html');
    expect(result.message).toMatch(/pagemd's renderer could not be loaded: pagemd's renderer is not built/);
    expect(result.html).toContain('<h1>Guide</h1>');
    expect(log.join('\n')).toMatch(/could not be loaded/);
  });
});

describe('Print Preview (R-170 Q5, D19)', () => {
  it('pagemd\'s page: the text VS Code has, the nonce, the diagram scripts, the page\'s pictures carried in the page (FIX-preview)', async () => {
    const { output, view } = make('# Guide\n', runtimeFile('/usr/bin/google-chrome'));
    view.webview.options = { localResourceRoots: [mock.Uri.file('/work/docs')] as unknown as vscode.Uri[] };
    mock.mockFiles.set('/work/docs/a.png', new Uint8Array([1, 2, 3]));
    expect(output.info().map((p) => p.id)).toEqual(['pagemd', 'html']);
    const result = await output.preview('N0nce');
    expect(result).toEqual({ html: '<img src="data:image/png;base64,AQID">', provider: 'pagemd', colorScheme: 'light' });
    const [, text, options] = calls()[0] as [string, string, Record<string, string>];
    expect(text).toBe('# Guide\n');
    expect(options['markdownPath']).toBe('/work/docs/guide.md');
    expect(options['cliPath']).toBe('/ext/dist/defaults');
    expect(options['nonce']).toBe('N0nce');
    // The library's address is decided after the render (only a document with a diagram carries it).
    expect(options['beforePolyfill']).toContain('src="data:,pmd-mermaid-library"');
    expect(options['beforePolyfill']).toContain('__pmdPreviewError');
  });

  it('FIX-PGF: each request and each step of making the page is logged at debug level; one asked while an earlier one is still being made is said', async () => {
    const { output, view, log, debug } = make('# Guide\n', runtimeFile('/usr/bin/google-chrome'));
    view.webview.options = { localResourceRoots: [mock.Uri.file('/work/docs')] as unknown as vscode.Uri[] };
    mock.mockFiles.set('/work/docs/a.png', new Uint8Array([1, 2, 3]));
    let open!: () => void;
    (globalThis as { __pmdRenderGate?: Promise<void> }).__pmdRenderGate = new Promise<void>((resolve) => (open = resolve));
    try {
      const first = output.preview('N');
      await new Promise((r) => setTimeout(r, 20));
      const second = output.preview('N'); // e.g. Print → Preview while the first is still rendering
      await new Promise((r) => setTimeout(r, 20));
      expect(log).toEqual([expect.stringMatching(/^Print Preview: request 2 while request 1 \(asked \d+ s ago\) is still being made\.$/)]);
      open();
      await Promise.all([first, second]);
    } finally {
      delete (globalThis as { __pmdRenderGate?: Promise<void> }).__pmdRenderGate;
    }
    const steps = debug.map((line) => line.replace(/\d+ ms/, 'N ms').replace(/\d+ characters/, 'N characters'));
    expect(steps.filter((l) => l.includes('request 1'))).toEqual(['Print Preview (host): request 1 started', 'Print Preview (host): request 1 answered after N ms (pagemd, N characters)']);
    expect(steps).toContain('Print Preview (host): runtime ready after N ms');
    expect(steps).toContain('Print Preview (host): pagemd rendered N characters after N ms');
    expect(steps).toContain('Print Preview (host): files put into the page (0 could not be) after N ms');
    // Once both are answered, a new request is not "while" anything.
    await output.preview('N');
    expect(log).toHaveLength(1);
  });

  it('a document that isn\'t a file gets plain HTML', async () => {
    const doc = new mock.MockTextDocument(mock.Uri.parse('untitled:Untitled-1'), '# U\n');
    const output = new HostOutput(doc as unknown as vscode.TextDocument, mock.createWebviewPanel().panel.webview, { extensionUri: mock.Uri.file('/ext') as unknown as vscode.Uri, log: () => undefined, styles: styles(), runtimeFile: runtimeFile('/c') });
    const result = await output.preview('N');
    expect(result.provider).toBe('html');
    expect(result.message).toMatch(/saved as a file/);
    expect(calls()).toEqual([]);
  });
});

// FIX-preview: VS Code's webview refuses every webview address a `srcdoc` frame asks for (404), so the preview never showed a
// picture. The host now puts the files into the page (data:), reading only what the webview itself may read.
describe('Print Preview carries its own files (FIX-preview)', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  function runtimeWith(html: string): string {
    const dir = join(scratch, `rt-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'runtime.mjs');
    writeFileSync(file, `export const runtime = { async renderForPreview(text, o) { return { html: ${JSON.stringify(html)}.replace('<body>', '<body>' + o.beforePolyfill), colorScheme: 'light', profile: 'p' }; }, async exportText() { return {}; }, detectBrowser: () => null, mermaidVersion: () => '12.1.0' };\n`);
    return file;
  }
  function makeIn(folder: string, html: string, roots: string[]) {
    const doc = new mock.MockTextDocument(mock.Uri.file(`${folder}/guide.md`), '# Guide\n');
    mock.openDocuments.push(doc);
    const view = mock.createWebviewPanel();
    view.webview.options = { localResourceRoots: roots.map((r) => mock.Uri.file(r)) as unknown as vscode.Uri[] };
    return new HostOutput(doc as unknown as vscode.TextDocument, view.panel.webview, { extensionUri: mock.Uri.file('/ext') as unknown as vscode.Uri, log: () => undefined, styles: styles(), runtimeFile: runtimeWith(html) });
  }

  it('pictures in a folder with spaces become data: addresses; the base stays a webview address', async () => {
    mock.mockFiles.set('/work/My Docs/Delay Reporter/.pagemd/assets/img/a b.png', PNG);
    const html = '<html><head><base href="file:///work/My Docs/Delay Reporter/"></head><body><img src="file:///work/My Docs/Delay Reporter/.pagemd/assets/img/a b.png"></body></html>';
    const result = await makeIn('/work/My Docs/Delay Reporter', html, ['/ext/dist/webview', '/work/My Docs/Delay Reporter']).preview('N');
    expect(result.provider).toBe('pagemd');
    expect(result.html).toContain('<base href="https://webview.test/work/My Docs/Delay Reporter/">');
    expect(result.html).toContain(`<img src="data:image/png;base64,${Buffer.from(PNG).toString('base64')}">`);
    expect(result.message).toBeUndefined();
  });

  it('a missing picture, or one outside the folders the webview may read, is named in the status (never read)', async () => {
    mock.mockFiles.set('/secret/x.png', PNG);
    const html = '<html><body><img src="file:///work/d/gone.png"><img src="file:///secret/x.png"></body></html>';
    const result = await makeIn('/work/d', html, ['/work/d']).preview('N');
    expect(result.html).toContain('<img src="https://webview.test/work/d/gone.png">');
    expect(result.html).not.toContain('data:image');
    expect(result.message).toBe('Some files could not be shown: gone.png (not found), x.png (outside the folders the editor may open).');
  });

  it('carries the diagram library only for a document with a diagram', async () => {
    mock.mockFiles.set('/ext/dist/webview/mermaid/mermaid.min.js', new TextEncoder().encode('window.mermaid = {};'));
    const html = '<html><body><figure class="mermaid-diagram"><pre class="mermaid" data-mermaid-id="m1">graph LR</pre></figure></body></html>';
    const result = await makeIn('/work/d', html, ['/ext/dist/webview', '/work/d']).preview('N');
    expect(result.html).toContain(`src="data:text/javascript;base64,${Buffer.from('window.mermaid = {};').toString('base64')}"`);
    const plain = await makeIn('/work/d', '<html><body><p>x</p></body></html>', ['/work/d']).preview('N');
    expect(plain.html).not.toContain('mermaid.min.js');
  });
});

describe('Export (R-170 Q6, R-169)', () => {
  it('opens the Save dialog next to the document; cancelled, nothing runs', async () => {
    const { output } = make('# G\n', runtimeFile('/c'));
    expect(await output.export('pdf')).toEqual({ ok: false, message: 'cancelled' });
    expect(mock.saveDialogs[0]).toMatchObject({ saveLabel: 'Export', filters: { PDF: ['pdf'] } });
    expect(mock.saveDialogs[0]!.defaultUri!.path).toBe('/work/docs/guide.pdf');
    expect(calls()).toEqual([]);
  });

  it('exports the text VS Code has (unsaved edits included) where the author chose, with progress, then Open / Show in Folder', async () => {
    const { output, doc } = make('# G\n', runtimeFile('/usr/bin/google-chrome'));
    doc.setText('# G\n\nUnsaved.\n');
    mock.saveDialog.next = mock.Uri.file('/out/chosen.pdf');
    expect(await output.export('pdf')).toEqual({ ok: true, target: '/out/chosen.pdf', message: '2 pages' });
    expect(calls()[0]).toEqual(['export', '# G\n\nUnsaved.\n', { markdownPath: '/work/docs/guide.md', format: 'pdf', target: '/out/chosen.pdf', cliPath: '/ext/dist/defaults', browserPath: '/usr/bin/google-chrome' }]);
    expect(mock.progressTitles).toEqual(['pagemd: exporting chosen.pdf…']);
    expect(mock.shownInfo).toEqual(['pagemd: exported chosen.pdf (2 pages).']);
  });

  it('with no Chrome, Edge or setting: says so and points to the setting; nothing is downloaded or run', async () => {
    const { output } = make('# G\n', runtimeFile(null));
    mock.saveDialog.next = mock.Uri.file('/out/a.png');
    const result = await output.export('png');
    expect(result.ok).toBe(false);
    expect(mock.shownErrors[0]).toMatch(/No Chrome or Microsoft Edge was found.*pagemdEditor\.browserPath/);
    expect(calls()).toEqual([]);
  });

  it('uses pagemdEditor.browserPath when neither Chrome nor Edge is found', async () => {
    const { output } = make('# G\n', runtimeFile(null));
    mock.configuration.set('pagemdEditor.browserPath', '/opt/chromium/chrome');
    expect((await output.exportTo('pdf', '/out/a.pdf')).ok).toBe(true);
    expect((calls()[0] as [string, string, { browserPath: string }])[2].browserPath).toBe('/opt/chromium/chrome');
  });

  it('without pagemd, HTML still exports (plain), PDF says why not', async () => {
    const { output } = make('# G\n');
    expect(await output.exportTo('html', '/out/a.html')).toEqual({ ok: true, target: '/out/a.html' });
    expect(new TextDecoder().decode(mock.mockFiles.get('/out/a.html'))).toContain('<h1>G</h1>');
    const pdf = await output.exportTo('pdf', '/out/a.pdf');
    expect(pdf.ok).toBe(false);
    expect(pdf.message).toMatch(/can't make PDF/);
  });

  it('P27 (R-251, fail closed): without pagemd, a document with a redaction is refused: no HTML written, the preview holds only the reason', async () => {
    const text = '# G\n\n::: annotated-image shots/secret.png\nredact:\n  - { x: 1, y: 2, width: 3, height: 4 }\n:::\n';
    const { output } = make(text);
    const result = await output.exportTo('html', '/out/r.html');
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/redacted pictures \(shots\/secret\.png\)/);
    expect(mock.mockFiles.has('/out/r.html')).toBe(false);
    const preview = await output.preview('n');
    expect(preview.html).not.toContain('secret.png"');
    expect(preview.html).not.toContain('<img');
    expect(preview.message).toMatch(/redacted pictures/);
    // the control: the same document without the redaction exports (plain), so it is the redaction that is refused
    const plain = make(text.replace(/redact:\n.*\n/, ''), undefined, '/work/docs/plain.md');
    expect((await plain.output.exportTo('html', '/out/p.html')).ok).toBe(true);
  });
});

describe('the profile picker (R-170 Q8)', () => {
  const profile = (id: string) => new TextEncoder().encode(JSON.stringify({ id, description: `${id} profile` }));

  beforeEach(() => {
    mock.mockFiles.set('/ext/dist/defaults/profiles/standard_letter.json', profile('standard_letter'));
    mock.mockFiles.set('/ext/dist/defaults/profiles/sop.json', profile('sop'));
    mock.mockFiles.set('/work/package.json', new TextEncoder().encode('{}'));
    mock.mockFiles.set('/work/.pagemd/profiles/house.json', profile('house'));
  });

  it('lists pagemd\'s own profiles and the project\'s, as `pagemd list` finds them', async () => {
    const { output } = make('# G\n');
    expect((await output.profiles()).map((p) => [p.name, p.source])).toEqual([
      ['house', 'workspace'],
      ['sop', 'pagemd'],
      ['standard_letter', 'pagemd'],
    ]);
  });

  it('writes the frontmatter\'s profile line as one edit (keeping the author\'s key), from the Quick Pick', async () => {
    const { output, doc } = make('---\ntitle: G\nprofile: sop\n---\n# G\n');
    mock.quickPick.next = 'house';
    expect(await output.chooseProfile()).toBe('house');
    expect(mock.quickPicks[0]!.items).toEqual(['house', 'sop', 'standard_letter', 'Get more profile packs…']);
    expect(doc.getText()).toBe('---\ntitle: G\nprofile: house\n---\n# G\n');
    expect(doc.version).toBe(2);
  });

  it('phase L2-8: lists the shared profiles folder (library, with the pack version) and ~/.pagemd (home); a name found twice is marked', async () => {
    const saved = process.env['PAGEMD_CONFIG_DIR'];
    process.env['PAGEMD_CONFIG_DIR'] = '/cfg';
    try {
      mock.mockFiles.set('/cfg/profiles/pml-sop-ink.json', profile('pml-sop-ink'));
      mock.mockFiles.set('/cfg/profiles/pml-sop-ink/manifest.json', new TextEncoder().encode('{"id":"pml-sop-ink","version":"0.1.0","files":[]}'));
      mock.mockFiles.set('/cfg/profiles/uofo-sop.json', profile('uofo-sop'));
      mock.mockFiles.set(join(homedir(), '.pagemd', 'profiles', 'uofo-sop.json').replaceAll('\\', '/'), profile('uofo-sop'));
      const { output } = make('---\nprofile: sop\n---\n# G\n');
      const choices = await output.profiles();
      expect(choices.map((p) => [p.name, p.source, p.version ?? null, p.duplicates.length])).toEqual([
        ['house', 'workspace', null, 0],
        ['pml-sop-ink', 'library', '0.1.0', 0],
        ['sop', 'pagemd', null, 0],
        ['standard_letter', 'pagemd', null, 0],
        ['uofo-sop', 'library', null, 1],
        ['uofo-sop', 'home', null, 1],
      ]);
      expect(await output.chooseProfile()).toBeUndefined();
      const pick = mock.quickPicks.at(-1)!;
      expect(pick.descriptions![pick.items.indexOf('pml-sop-ink')]).toBe('library 0.1.0');
      expect(pick.descriptions![pick.items.indexOf('uofo-sop')]).toBe('library (found twice: the build will stop)');
      expect(pick.descriptions![pick.items.lastIndexOf('uofo-sop')]).toBe('~/.pagemd (found twice: the build will stop)');
    } finally {
      if (saved === undefined) delete process.env['PAGEMD_CONFIG_DIR'];
      else process.env['PAGEMD_CONFIG_DIR'] = saved;
    }
  });

  it('adds a frontmatter when there is none; dismissing the picker changes nothing', async () => {
    const { output, doc } = make('# G\n');
    expect(await output.chooseProfile()).toBeUndefined();
    expect(doc.getText()).toBe('# G\n');
    expect(await output.chooseProfile('sop')).toBe('sop');
    expect(doc.getText()).toBe('---\nprofile: sop\n---\n# G\n');
  });
});
