// One editor session: the ready → init handshake, message routing, flush before save, and the webview page.
import { beforeEach, describe, expect, it } from 'vitest';
import * as mock from '../../../__mocks__/vscode.ts';
import { EditorProvider, webviewHtml } from '../host/EditorProvider.ts';
import type { HostStyles } from '../host/services/styles.ts';
import { PROTOCOL_VERSION, type StylesPayload } from '../shared/protocol.ts';
import type * as vscode from 'vscode';

beforeEach(mock.resetMock);

const tick = () => new Promise((r) => setTimeout(r, 0));

function open(text = '# Title\n\nBody.\n', styles?: (document: vscode.TextDocument) => HostStyles) {
  const doc = new mock.MockTextDocument(mock.Uri.file('/work/docs/guide.md'), text);
  mock.openDocuments.push(doc);
  mock.workspace.workspaceFolders = [{ uri: mock.Uri.file('/work') }];
  const log: string[] = [];
  const debug: string[] = [];
  const provider = new EditorProvider(mock.Uri.file('/ext') as unknown as vscode.Uri, { log: (l) => log.push(l), debug: (l) => debug.push(l), testing: false, ...(styles ? { styles } : {}) });
  const view = mock.createWebviewPanel();
  provider.resolveCustomTextEditor(doc as unknown as vscode.TextDocument, view.panel);
  return { doc, provider, view, log, debug, session: provider.sessions.get(doc.uri.toString())! };
}

describe('EditorProvider / EditorSession', () => {
  it('sets up the webview: scripts on, the bundle, the document folder and the workspace as resource roots', () => {
    const { view } = open();
    expect(view.webview.options.enableScripts).toBe(true);
    // P10: and pagemd's own folder (the Print Preview's templates and styles, D19).
    expect((view.webview.options.localResourceRoots as unknown as mock.Uri[]).map((u) => u.path)).toEqual(['/ext/dist/webview', '/work/docs', '/work', '/ext/dist/defaults']);
    expect(view.webview.html).toContain('src="https://webview.test/ext/dist/webview/main.js"');
  });

  it('FIX-template-asset-paths: a template\'s picture folder outside the workspace is added before init; one needed later is only logged', async () => {
    const plain: StylesPayload = { styles: null, gateDefaults: {}, notes: [], properties: { required: [], shownOnPage: [], profileFields: [], defaults: {} } };
    const listeners: ((p: StylesPayload) => void)[] = [];
    let folders = ['/elsewhere/Resources/uofo/assets/images', '/work/docs/assets'];
    const { view, session, log } = open(undefined, () => ({
      get: async () => plain,
      onChange: (listener) => (listeners.push(listener), { dispose() {} }),
      createLayoutFile: async () => 'declined',
      assetFolders: () => folders,
      dispose() {},
    }));
    const roots = () => (view.webview.options.localResourceRoots as unknown as mock.Uri[]).map((u) => u.path);
    view.receive({ kind: 'event', name: 'ready', data: { protocol: PROTOCOL_VERSION } });
    await session.ready;
    // the document's own folder already covers /work/docs/assets; only the outside folder is added
    expect(roots()).toEqual(['/ext/dist/webview', '/work/docs', '/work', '/ext/dist/defaults', '/elsewhere/Resources/uofo/assets/images']);
    expect(view.posted[0]).toMatchObject({ name: 'init' });
    folders = ['/other/assets'];
    for (const listener of listeners) listener(plain);
    expect(roots()).not.toContain('/other/assets');
    expect(log.some((line) => line.includes('/other/assets') && line.includes('reopen the editor'))).toBe(true);
  });

  it('answers ready with the document, its version and the folder address for images (C1)', async () => {
    const { view, session } = open();
    view.receive({ kind: 'event', name: 'ready', data: { protocol: PROTOCOL_VERSION } });
    await session.ready;
    expect((view.posted as { kind: string; name?: string }[]).filter((m) => m.name !== 'codeTheme')).toEqual([
      {
        kind: 'event',
        name: 'init',
        data: {
          protocol: PROTOCOL_VERSION,
          text: '# Title\n\nBody.\n',
          version: 1,
          // Protocol v11 (fix-sync-bugs): the file's line ending, which VS Code turns every inserted line break into.
          eol: '\n',
          fileName: 'guide.md',
          documentBase: 'https://webview.test/work/docs/',
          testing: false,
          // No styles service given: plain styles (protocol v2).
          styles: { styles: null, gateDefaults: {}, notes: [], properties: { required: [], shownOnPage: [], profileFields: [], defaults: {} } },
          // Protocol v4 (P7): the editor's settings.
          settings: { gatedInsert: 'ask', commentAuthor: expect.any(String), figureStyle: 'readable', nativeSplit: false, codeEngine: 'monaco-vscode', editorOptions: {} },
          // Protocol v7 (P10): no pagemd runtime file next to this host, so Print Preview and Export use plain HTML.
          output: [{ id: 'html', label: 'Plain HTML', formats: ['html'] }],
          mermaidScript: 'https://webview.test/ext/dist/webview/mermaid/mermaid.min.js',
        },
      },
    ]);
  });

  it('protocol v2: resolves the styles before init, answers getStyles/createLayoutFile, forwards changes after init', async () => {
    const payload: StylesPayload = { styles: null, gateDefaults: { fancy_lists: true }, notes: [{ kind: 'profile-not-found', message: 'Profile not found: x', source: 'x' }], properties: { required: [], shownOnPage: [], profileFields: [], defaults: {} } };
    const listeners: ((p: StylesPayload) => void)[] = [];
    const calls: string[] = [];
    let disposed = false;
    const { view, session } = open(undefined, (document) => {
      calls.push(`for ${document.uri.path}`);
      return {
        get: async () => (calls.push('get'), payload),
        onChange: (listener) => (listeners.push(listener), { dispose() {} }),
        createLayoutFile: async (page) => (calls.push(`create ${page.width}`), 'created'),
        dispose: () => void (disposed = true),
      };
    });
    listeners[0]!(payload); // before init: not sent (init carries the latest)
    view.receive({ kind: 'event', name: 'ready', data: { protocol: PROTOCOL_VERSION } });
    await session.ready;
    expect((view.posted as { kind: string; name?: string }[]).filter((m) => m.name !== 'codeTheme')).toEqual([{ kind: 'event', name: 'init', data: expect.objectContaining({ protocol: 16, styles: payload }) }]);

    view.receive({ kind: 'request', id: 5, method: 'getStyles', params: {} });
    view.receive({ kind: 'request', id: 6, method: 'createLayoutFile', params: { page: { width: 210, height: 297, margins: { top: 1, right: 1, bottom: 1, left: 1 } } } });
    await tick();
    expect(view.posted).toContainEqual({ kind: 'response', id: 5, ok: true, result: payload });
    expect(view.posted).toContainEqual({ kind: 'response', id: 6, ok: true, result: 'created' });

    listeners[0]!({ ...payload, gateDefaults: {} });
    expect(view.posted.at(-1)).toEqual({ kind: 'event', name: 'stylesChanged', data: { ...payload, gateDefaults: {} } });
    expect(calls).toEqual(['for /work/docs/guide.md', 'get', 'get', 'create 210']);
    view.dispose();
    expect(disposed).toBe(true);
  });

  it('plain styles when the styles service fails, and createLayoutFile says why it cannot', async () => {
    const { view, session, log } = open(undefined, () => ({
      get: () => Promise.reject(new Error('disk on fire')),
      onChange: () => ({ dispose() {} }),
      createLayoutFile: () => Promise.reject(new Error('no profile')),
      dispose() {},
    }));
    view.receive({ kind: 'event', name: 'ready', data: { protocol: PROTOCOL_VERSION } });
    await session.ready;
    expect(view.posted[0]).toMatchObject({ name: 'init', data: { styles: { styles: null, gateDefaults: {}, notes: [] } } });
    expect(log.at(-1)).toMatch(/disk on fire/);
    view.receive({ kind: 'request', id: 9, method: 'createLayoutFile', params: { page: { width: 1, height: 1, margins: { top: 0, right: 0, bottom: 0, left: 0 } } } });
    await tick();
    expect(view.posted.at(-1)).toEqual({ kind: 'response', id: 9, ok: false, error: 'no profile' });
  });

  it('the default (plain) styles service cannot create a layout file', async () => {
    const { view } = open();
    view.receive({ kind: 'request', id: 3, method: 'createLayoutFile', params: { page: { width: 1, height: 1, margins: { top: 0, right: 0, bottom: 0, left: 0 } } } });
    await tick();
    expect(view.posted.at(-1)).toMatchObject({ kind: 'response', id: 3, ok: false, error: expect.stringMatching(/plain styles/) });
  });

  it('refuses a webview that speaks another protocol version', () => {
    const { view, log } = open();
    view.receive({ kind: 'event', name: 'ready', data: { protocol: PROTOCOL_VERSION + 1 } });
    expect(view.posted).toEqual([]);
    expect(mock.shownErrors).toHaveLength(1);
    expect(log[0]).toMatch(/protocol/);
  });

  it('applies edits from the webview and answers with the new version', async () => {
    const { view, doc } = open();
    view.receive({ kind: 'request', id: 7, method: 'applyEdits', params: { edits: [{ from: 9, to: 13, text: 'Text' }], version: 1 } });
    await tick();
    expect(doc.getText()).toBe('# Title\n\nText.\n');
    expect(view.posted).toEqual([{ kind: 'response', id: 7, ok: true, result: { status: 'ok', version: 2 } }]);
  });

  it('forwards outside changes to the webview', () => {
    const { view, doc } = open();
    doc.setText('# Changed\n');
    expect(view.posted).toEqual([{ kind: 'event', name: 'externalChange', data: { text: '# Changed\n', version: 2, eol: '\n' } }]);
  });

  it('protocol v11: a CRLF file says so; an edit VS Code changes (its \'\\n\' made \'\\r\\n\') is reported back, one VS Code already matches is not', async () => {
    const { view, doc, session } = open('# Title\r\n\r\nBody.\r\n');
    view.receive({ kind: 'event', name: 'ready', data: { protocol: PROTOCOL_VERSION } });
    await session.ready;
    expect((view.posted[0] as { data: { eol: string } }).data.eol).toBe('\r\n');
    view.posted.length = 0;
    view.receive({ kind: 'request', id: 1, method: 'applyEdits', params: { edits: [{ from: 16, to: 16, text: '\r\n\r\nMore.' }], version: 1 } });
    await tick();
    expect(doc.getText()).toBe('# Title\r\n\r\nBody.\r\n\r\nMore.\r\n');
    expect(view.posted).toEqual([{ kind: 'response', id: 1, ok: true, result: { status: 'ok', version: 2 } }]);
    view.posted.length = 0;
    view.receive({ kind: 'request', id: 2, method: 'applyEdits', params: { edits: [{ from: 25, to: 25, text: '\n\nLF.' }], version: 2 } });
    await tick();
    expect(doc.getText()).toBe('# Title\r\n\r\nBody.\r\n\r\nMore.\r\n\r\nLF.\r\n');
    expect(view.posted[0]).toEqual({ kind: 'event', name: 'externalChange', data: { text: doc.getText(), version: 3, eol: '\r\n' } });
  });

  it('protocol v11: the line ending changing on a file with no line break (no text change) still reaches the webview', async () => {
    const { view, doc, session } = open('');
    view.receive({ kind: 'event', name: 'ready', data: { protocol: PROTOCOL_VERSION } });
    await session.ready;
    view.posted.length = 0;
    doc.eol = mock.EndOfLine.CRLF;
    mock.workspaceEvents.change.fire({ document: doc as unknown as vscode.TextDocument, contentChanges: [], reason: undefined });
    expect(view.posted).toEqual([{ kind: 'event', name: 'externalChange', data: { text: '', version: 1, eol: '\r\n' } }]);
    mock.workspaceEvents.change.fire({ document: doc as unknown as vscode.TextDocument, contentChanges: [], reason: undefined }); // a dirty-mark change: nothing new
    expect(view.posted).toHaveLength(1);
  });

  it('runs only undo, redo and save for the webview, nothing else', () => {
    const { view } = open();
    for (const command of ['undo', 'redo', 'save', 'workbench.action.terminal.new', 'toString', '__proto__']) {
      view.receive({ kind: 'event', name: 'runCommand', data: { command } });
    }
    expect(mock.executedCommands).toEqual([['undo'], ['redo'], ['workbench.action.files.save']]);
  });

  it('takes binary asset bytes (C5) and refuses anything that is not binary', async () => {
    const { view } = open();
    view.receive({ kind: 'request', id: 1, method: 'writeAsset', params: { bytes: new Uint8Array([1, 2]), name: 'a.png' } });
    view.receive({ kind: 'request', id: 2, method: 'writeAsset', params: { bytes: 'AQI=', name: 'a.png' } });
    await tick();
    await tick();
    expect(view.posted).toContainEqual({ kind: 'response', id: 1, ok: true, result: '.pagemd/assets/img/a.png' });
    expect(view.posted).toContainEqual({ kind: 'response', id: 2, ok: false, error: 'writeAsset: bytes must be binary (Uint8Array or ArrayBuffer).' });
  });

  it('P15 (protocol v10): readAsset hands back a picture the canvas can show, as binary, and refuses one outside (R-196)', async () => {
    const { view } = open();
    view.receive({ kind: 'request', id: 1, method: 'writeAsset', params: { bytes: new Uint8Array([7, 8]), name: 'shot.png' } });
    await tick();
    await tick();
    view.receive({ kind: 'request', id: 2, method: 'readAsset', params: { path: '.pagemd/assets/img/shot.png' } });
    view.receive({ kind: 'request', id: 3, method: 'readAsset', params: { path: '../../../../outside/shot.png' } });
    for (let i = 0; i < 4; i++) await tick();
    const answer = view.posted.find((m) => (m as { id?: number }).id === 2) as { ok: boolean; result: Uint8Array };
    expect(answer.ok).toBe(true);
    expect([...answer.result]).toEqual([7, 8]);
    expect(view.posted).toContainEqual({ kind: 'response', id: 3, ok: false, error: expect.stringMatching(/outside the document's folder/) });
  });

  it('asks the webview to flush before VS Code saves, and waits for it', async () => {
    const { view, doc, session } = open();
    view.receive({ kind: 'event', name: 'ready', data: { protocol: PROTOCOL_VERSION } });
    await session.ready;
    const waits: Promise<unknown>[] = [];
    mock.workspaceEvents.willSave.fire({ document: doc, waitUntil: (p: Promise<unknown>) => waits.push(p) } as unknown as vscode.TextDocumentWillSaveEvent);
    expect(waits).toHaveLength(1);
    const flush = view.posted.at(-1) as { kind: string; id: number; method: string };
    expect(flush).toMatchObject({ kind: 'request', method: 'flush' });

    let done = false;
    void waits[0]!.then(() => (done = true));
    await tick();
    expect(done).toBe(false); // still waiting for the webview
    view.receive({ kind: 'response', id: flush.id, ok: true, result: undefined });
    await tick();
    expect(done).toBe(true);
  });

  it('tracks the active session (R-132): the panel that is focused now', () => {
    const { provider, session, view } = open();
    expect(provider.activeSession).toBe(session); // starts active (mock default)
    view.setActive(false);
    expect(provider.activeSession).toBeUndefined();
    view.setActive(true);
    expect(provider.activeSession).toBe(session);
    view.dispose();
    expect(provider.activeSession).toBeUndefined();
  });

  it('setView emits setView only once the webview is ready (R-132)', async () => {
    const { view, session } = open();
    session.setView('web'); // too early: the webview hasn't loaded yet
    expect(view.posted).toEqual([]);
    view.receive({ kind: 'event', name: 'ready', data: { protocol: PROTOCOL_VERSION } });
    await session.ready;
    session.setView('draft');
    expect(view.posted.at(-1)).toEqual({ kind: 'event', name: 'setView', data: { mode: 'draft' } });
  });

  it('createLayoutFileForCurrentPage uses the resolved page, and rejects for plain styles', async () => {
    const page = { width: 210, height: 297, margins: { top: 1, right: 1, bottom: 1, left: 1 } };
    const calls: unknown[] = [];
    const { session } = open(undefined, () => ({
      get: async () => ({ styles: { css: '', page, usingDefault: false, sources: [] }, gateDefaults: {}, notes: [], properties: { required: [], shownOnPage: [], profileFields: [], defaults: {} } }),
      onChange: () => ({ dispose() {} }),
      createLayoutFile: async (p) => (calls.push(p), 'created'),
      dispose() {},
    }));
    await expect(session.createLayoutFileForCurrentPage()).resolves.toBe('created');
    expect(calls).toEqual([page]);

    const { session: plain } = open(undefined, () => ({
      get: async () => ({ styles: null, gateDefaults: {}, notes: [], properties: { required: [], shownOnPage: [], profileFields: [], defaults: {} } }),
      onChange: () => ({ dispose() {} }),
      createLayoutFile: () => Promise.reject(new Error('nope')),
      dispose() {},
    }));
    await expect(plain.createLayoutFileForCurrentPage()).rejects.toThrow(/plain styles/);
  });

  it('watches image files in the document folder and its asset folder, flat (C9, amendment 11; P5 finding: a recursive out-of-workspace watcher never fires in a real VS Code, verified in test:vscode)', async () => {
    const { view, session, doc } = open();
    view.receive({ kind: 'event', name: 'ready', data: { protocol: PROTOCOL_VERSION } });
    await session.ready;
    view.posted.length = 0;
    mock.fireFsEvent('change', '/work/docs/photo.png');
    mock.fireFsEvent('create', '/work/docs/.pagemd/assets/img/pasted.png');
    mock.fireFsEvent('create', '/work/docs/sub/nested.jpg'); // a nested folder is not watched (the P5 finding)
    mock.fireFsEvent('change', '/elsewhere/unrelated.png'); // outside the document folder: ignored
    void doc; // the document itself isn't touched by this test
    await new Promise((r) => setTimeout(r, 300));
    const events = view.posted.filter((m) => (m as { name?: string }).name === 'assetsChanged') as { data: { paths: string[] } }[];
    expect(events).toHaveLength(1);
    expect(events[0]!.data.paths.sort()).toEqual(['.pagemd/assets/img/pasted.png', 'photo.png']);
  });

  it('closes the channel when the panel goes away', async () => {
    const { view, provider, doc, session } = open();
    const pending = session.channel.request('flush', {});
    view.dispose();
    await expect(pending).rejects.toThrow(/closed/);
    expect(provider.sessions.has(doc.uri.toString())).toBe(false);
    doc.setText('after close\n');
    expect(view.posted.filter((m) => (m as { name?: string }).name === 'externalChange')).toEqual([]);
  });
});

describe('the log (FIX-PGF)', () => {
  it("the page's log lines reach the output channel: debug at debug level, info as an ordinary line, at most 500 characters", async () => {
    const { view, log, debug } = open();
    view.receive({ kind: 'event', name: 'log', data: { level: 'debug', message: 'Print Preview #1: render start' } });
    view.receive({ kind: 'event', name: 'log', data: { level: 'info', message: 'x'.repeat(600) } });
    expect(debug).toEqual(['[page] Print Preview #1: render start']);
    expect(log).toEqual([`[page] ${'x'.repeat(500)}`]);
  });

  it('a message VS Code did not deliver to the page is written to the log (named, without its contents)', async () => {
    const { view, log, session } = open();
    view.webview.postMessage = () => Promise.resolve(false);
    session.channel.emit('saved', {});
    view.webview.postMessage = () => Promise.reject(new Error('too large'));
    view.receive({ kind: 'request', id: 7, method: 'getStyles', params: {} });
    await tick();
    await tick();
    expect(log).toEqual(['A message to the editor page was not delivered (the event "saved").', 'A message to the editor page was not delivered (the answer to request 7): too large']);
  });
});

describe('webviewHtml', () => {
  it('allows only the nonce-tagged bundle, inline styles (P10), and images from the allowed roots, https and data:', () => {
    const html = webviewHtml('https://webview.test', 'https://webview.test/main.js', 'N0NCE');
    const csp = /content="([^"]+)"/.exec(html)![1]!;
    expect(csp.split('; ')).toEqual([
      "default-src 'none'",
      'img-src https://webview.test https: data:',
      // P10 (AD-P10-05): Paged.js's own style elements in the Print Preview frame and mermaid's drawings; scripts stay nonce-only.
      "style-src https://webview.test 'unsafe-inline'",
      'font-src https://webview.test data:',
      "script-src 'nonce-N0NCE' 'wasm-unsafe-eval'",
      "connect-src https://webview.test",
    ]);
    expect(html).toContain('<script nonce="N0NCE" src="https://webview.test/main.js"></script>');
    expect(webviewHtml('a', 'b')).not.toBe(webviewHtml('a', 'b')); // a fresh nonce every time
    // P8 (R-162): VS Code's icon stylesheet, from the extension (allowed by style-src and font-src above).
    expect(webviewHtml('a', 'b', 'N', 'https://webview.test/codicons/codicon.css')).toContain('<link rel="stylesheet" href="https://webview.test/codicons/codicon.css" />');
    expect(html).not.toContain('<link');
  });
});
