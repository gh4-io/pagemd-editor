// Gated inserts, host side (P7, ADR-0016 M3, R-154, protocol v4): the setting, the prompt and the messages that carry
// them. Since P8 (protocol v5) the property is added by the webview, in the insert's own edit (R-161).
import { beforeEach, describe, expect, it } from 'vitest';
import * as mock from '../../../__mocks__/vscode.ts';
import { EditorProvider } from '../host/EditorProvider.ts';
import { confirmGatedInsert, readGatedInsert, readSettings } from '../host/services/gated-insert.ts';
import { PROTOCOL_VERSION } from '../shared/protocol.ts';
import type * as vscode from 'vscode';

beforeEach(mock.resetMock);
const tick = () => new Promise((r) => setTimeout(r, 0));
const info = { label: 'Lettered list (a. b. c.)', field: 'fancy_lists', value: true };

describe('the pagemdEditor.figureStyle setting (R-254)', () => {
  it('is readable by default; native and legacy are read; an unknown value is readable; it reaches the webview with the other settings', () => {
    expect(readSettings().figureStyle).toBe('readable');
    mock.configuration.set('pagemdEditor.figureStyle', 'native');
    expect(readSettings().figureStyle).toBe('native');
    mock.configuration.set('pagemdEditor.figureStyle', 'legacy');
    expect(readSettings().figureStyle).toBe('legacy');
    mock.configuration.set('pagemdEditor.figureStyle', 'fancy');
    expect(readSettings().figureStyle).toBe('readable');
  });
});

describe('the pagemdEditor.gatedInsert setting', () => {
  it('is ask by default, and a missing or unknown value is ask too', () => {
    expect(readGatedInsert()).toBe('ask');
    mock.configuration.set('pagemdEditor.gatedInsert', 'sometimes');
    expect(readGatedInsert()).toBe('ask');
    mock.configuration.set('pagemdEditor.gatedInsert', 'warn');
    expect(readSettings()).toMatchObject({ gatedInsert: 'warn' });
    mock.configuration.set('pagemdEditor.gatedInsert', 'auto');
    expect(readGatedInsert()).toBe('auto');
  });
});

describe('the ask prompt', () => {
  it('is a modal naming the item and the property, with three choices', async () => {
    mock.warningDialog.next = 'Insert Anyway';
    await confirmGatedInsert(info);
    expect(mock.shownWarnings).toHaveLength(1);
    expect(mock.shownWarnings[0]).toMatchObject({ modal: true, items: ['Add fancy_lists', 'Insert Anyway', "Don't Ask Again"] });
    expect(mock.shownWarnings[0]!.message).toContain('Lettered list');
    expect(mock.shownWarnings[0]!.message).toContain('fancy_lists');
  });
  it('maps the buttons: add, insert anyway, dismiss', async () => {
    mock.warningDialog.next = 'Add fancy_lists';
    expect(await confirmGatedInsert(info)).toBe('add');
    mock.warningDialog.next = 'Insert Anyway';
    expect(await confirmGatedInsert(info)).toBe('insert');
    mock.warningDialog.next = undefined;
    expect(await confirmGatedInsert(info)).toBe('cancel');
    expect(mock.configurationUpdates).toEqual([]);
  });
  it('"Don\'t Ask Again" switches the setting to auto (for all workspaces) and still adds the property this time (R-154)', async () => {
    mock.warningDialog.next = "Don't Ask Again";
    expect(await confirmGatedInsert(info)).toBe('add');
    expect(mock.configurationUpdates).toEqual([{ key: 'pagemdEditor.gatedInsert', value: 'auto', target: mock.ConfigurationTarget.Global }]);
    expect(readGatedInsert()).toBe('auto');
  });
});

describe('"Don\'t Ask Again" writes where the value in force comes from (R-157 review)', () => {
  const key = 'pagemdEditor.gatedInsert';
  it('a workspace value of ask is replaced at the workspace, a folder value at the folder, else the user\'s', async () => {
    mock.warningDialog.next = "Don't Ask Again";
    mock.configurationScopes.set(key, { globalValue: 'ask', workspaceValue: 'ask' });
    await confirmGatedInsert(info);
    mock.configurationScopes.set(key, { workspaceValue: 'ask', workspaceFolderValue: 'warn' });
    await confirmGatedInsert(info);
    mock.configurationScopes.set(key, { globalValue: 'warn' });
    await confirmGatedInsert(info);
    expect(mock.configurationUpdates.map((u) => u.target)).toEqual([mock.ConfigurationTarget.Workspace, mock.ConfigurationTarget.WorkspaceFolder, mock.ConfigurationTarget.Global]);
  });
});

function open(text = '---\ntitle: T\n---\n\nBody.\n') {
  const doc = new mock.MockTextDocument(mock.Uri.file('/work/docs/guide.md'), text);
  mock.openDocuments.push(doc);
  mock.workspace.workspaceFolders = [{ uri: mock.Uri.file('/work') }];
  const provider = new EditorProvider(mock.Uri.file('/ext') as unknown as vscode.Uri, { log: () => undefined, testing: false });
  const view = mock.createWebviewPanel();
  provider.resolveCustomTextEditor(doc as unknown as vscode.TextDocument, view.panel);
  return { doc, view, session: provider.sessions.get(doc.uri.toString())! };
}
const ready = async (view: ReturnType<typeof open>['view'], session: ReturnType<typeof open>['session']) => {
  view.receive({ kind: 'event', name: 'ready', data: { protocol: PROTOCOL_VERSION } });
  await session.ready;
  view.posted.length = 0;
};

describe('protocol v4/v5 messages', () => {
  it('init carries the settings, and a changed setting is announced afterwards', async () => {
    mock.configuration.set('pagemdEditor.gatedInsert', 'warn');
    const { view, session } = open();
    view.receive({ kind: 'event', name: 'ready', data: { protocol: PROTOCOL_VERSION } });
    await session.ready;
    expect(view.posted[0]).toMatchObject({ name: 'init', data: { settings: { gatedInsert: 'warn' } } });
    view.posted.length = 0;
    await mock.workspace.getConfiguration('pagemdEditor').update('gatedInsert', 'auto');
    expect(view.posted).toEqual([{ kind: 'event', name: 'settingsChanged', data: { gatedInsert: 'auto', commentAuthor: expect.any(String), figureStyle: 'readable', nativeSplit: false, codeEngine: 'monaco-vscode', editorOptions: {} } }]);
    view.posted.length = 0;
    await mock.workspace.getConfiguration('somethingElse').update('other', 1);
    expect(view.posted).toEqual([]); // not our setting
  });

  it('confirmGatedInsert answers with the author\'s choice', async () => {
    const { view, session } = open();
    await ready(view, session);
    mock.warningDialog.next = 'Add fancy_lists';
    view.receive({ kind: 'request', id: 7, method: 'confirmGatedInsert', params: info });
    await tick();
    expect(view.posted).toEqual([{ kind: 'response', id: 7, ok: true, result: 'add' }]);
  });

  it('addFrontmatterField is gone (protocol v5, R-161): the webview adds the property in the insert\'s own edit', async () => {
    const { doc, view, session } = open();
    await ready(view, session);
    view.receive({ kind: 'request', id: 8, method: 'addFrontmatterField', params: { field: 'fancy_lists', value: true } } as never);
    await tick();
    expect(doc.getText()).toBe('---\ntitle: T\n---\n\nBody.\n');
    expect(view.posted).toContainEqual({ kind: 'response', id: 8, ok: false, error: expect.stringContaining('addFrontmatterField') });
  });
});
