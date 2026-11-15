// ISidecar, host side (P12, R-180, protocol v8): the review comments' side file `.pagemd/comments/<doc>.json` next to the
// document, read and written as JSON; a file that is not JSON fails the read; the session answers the two requests and
// tells the webview when the file changes on disk; the comment author setting.
import { beforeEach, describe, expect, it } from 'vitest';
import * as mock from '../../../__mocks__/vscode.ts';
import { EditorProvider } from '../host/EditorProvider.ts';
import { workspaceFileSystem } from '../host/services/file-system.ts';
import { readCommentAuthor, readSettings } from '../host/services/gated-insert.ts';
import { HostSidecar, SIDECAR_FOLDER, sidecarName } from '../host/services/sidecar.ts';
import { PROTOCOL_VERSION } from '../shared/protocol.ts';
import type * as vscode from 'vscode';

beforeEach(mock.resetMock);

const FILE = '/work/docs/.pagemd/comments/guide.json';
const put = (path: string, text: string): void => void mock.mockFiles.set(path, new TextEncoder().encode(text));
const text = (path: string): string => new TextDecoder().decode(mock.mockFiles.get(path));
const sidecar = (documentPath = '/work/docs/guide.md') => new HostSidecar(mock.Uri.file(documentPath) as unknown as vscode.Uri, workspaceFileSystem);

describe('sidecarName', () => {
  it('is the file name without its extension, like the layout file (R-129)', () => {
    expect(sidecarName('/work/docs/guide.md')).toBe('guide.json');
    expect(sidecarName('/work/docs/a.b.markdown')).toBe('a.b.json');
    expect(sidecarName('/work/docs/README')).toBe('README.json');
    expect(SIDECAR_FOLDER).toBe('.pagemd/comments');
  });
});

describe('HostSidecar', () => {
  it('a missing (or empty) file reads as null', async () => {
    expect(await sidecar().read('comments')).toBeNull();
    put(FILE, '  \n');
    expect(await sidecar().read('comments')).toBeNull();
  });

  it('reads the JSON, with or without a byte-order mark', async () => {
    put(FILE, '﻿{"version":1,"threads":[]}');
    expect(await sidecar().read('comments')).toEqual({ version: 1, threads: [] });
  });

  it('a file that is not JSON fails with the reason and the file name', async () => {
    put(FILE, 'this is not json');
    await expect(sidecar().read('comments')).rejects.toThrow(/\.pagemd\/comments\/guide\.json is not valid JSON/);
  });

  it('writes two-space JSON with a final newline, creating .pagemd/comments next to the document', async () => {
    await sidecar().write('comments', { version: 1, threads: [] });
    expect(text(FILE)).toBe('{\n  "version": 1,\n  "threads": []\n}\n');
    expect(mock.mockDirs.has('/work/docs/.pagemd/comments')).toBe(true);
  });

  it('a file that used CRLF keeps it', async () => {
    put(FILE, '{\r\n  "version": 1,\r\n  "threads": []\r\n}\r\n');
    await sidecar().write('comments', { version: 1, threads: [{ id: 'c1' }] });
    expect(text(FILE)).toContain('\r\n');
    expect(text(FILE).replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('writes happen in the order they came', async () => {
    const s = sidecar();
    await Promise.all([s.write('comments', { n: 1 }), s.write('comments', { n: 2 }), s.write('comments', { n: 3 })]);
    expect(JSON.parse(text(FILE))).toEqual({ n: 3 });
  });

  it('knows no other kind of side file', async () => {
    await expect(sidecar().read('layouts' as never)).rejects.toThrow(/no side file/);
    expect(() => sidecar().write('layouts' as never, {})).toThrow(/no side file/);
  });
});

function open() {
  const doc = new mock.MockTextDocument(mock.Uri.file('/work/docs/guide.md'), '# Title\n');
  mock.openDocuments.push(doc);
  mock.workspace.workspaceFolders = [{ uri: mock.Uri.file('/work') }];
  const provider = new EditorProvider(mock.Uri.file('/ext') as unknown as vscode.Uri, { log: () => undefined, testing: false });
  const view = mock.createWebviewPanel();
  provider.resolveCustomTextEditor(doc as unknown as vscode.TextDocument, view.panel);
  return { view, session: provider.sessions.get(doc.uri.toString())! };
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe('the session (protocol v8)', () => {
  it('answers readSidecar and writeSidecar', async () => {
    const { view, session } = open();
    view.receive({ kind: 'event', name: 'ready', data: { protocol: PROTOCOL_VERSION } });
    await session.ready;
    view.posted.length = 0;
    view.receive({ kind: 'request', id: 1, method: 'readSidecar', params: { kind: 'comments' } });
    await tick();
    expect(view.posted).toEqual([{ kind: 'response', id: 1, ok: true, result: null }]);
    view.receive({ kind: 'request', id: 2, method: 'writeSidecar', params: { kind: 'comments', data: { version: 1, threads: [] } } });
    await tick();
    expect(view.posted[1]).toEqual({ kind: 'response', id: 2, ok: true, result: undefined });
    expect(JSON.parse(text(FILE))).toEqual({ version: 1, threads: [] });
    put(FILE, 'broken');
    view.receive({ kind: 'request', id: 3, method: 'readSidecar', params: { kind: 'comments' } });
    await tick();
    expect(view.posted[2]).toMatchObject({ kind: 'response', id: 3, ok: false, error: expect.stringContaining('not valid JSON') });
  });

  it('says sidecarChanged when this document\'s file changes on disk, and for no other file', async () => {
    const { view, session } = open();
    view.receive({ kind: 'event', name: 'ready', data: { protocol: PROTOCOL_VERSION } });
    await session.ready;
    view.posted.length = 0;
    mock.fireFsEvent('change', '/work/docs/.pagemd/comments/other.json');
    mock.fireFsEvent('change', FILE);
    mock.fireFsEvent('create', FILE); // two events in a row: one message
    await tick(300);
    expect(view.posted).toEqual([{ kind: 'event', name: 'sidecarChanged', data: { kind: 'comments' } }]);
  });
});

describe('the comment author', () => {
  it('is the setting when it has a name, else the computer\'s user name', () => {
    mock.configuration.set('pagemdEditor.commentAuthor', '  Jane Doe ');
    expect(readCommentAuthor()).toBe('Jane Doe');
    mock.configuration.set('pagemdEditor.commentAuthor', '   ');
    expect(readCommentAuthor().length).toBeGreaterThan(0);
    mock.configuration.delete('pagemdEditor.commentAuthor');
    expect(readSettings().commentAuthor).toBe(readCommentAuthor());
  });
});
