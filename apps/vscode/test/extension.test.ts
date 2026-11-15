import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as mock from '../../../__mocks__/vscode.ts';
import { EditorProvider, VIEW_TYPE } from '../host/EditorProvider.ts';
import { activate } from '../host/extension.ts';
import { PROTOCOL_VERSION } from '../shared/protocol.ts';
import { readFileSync } from 'node:fs';
import type * as vscode from 'vscode';

const { createdChannels, createExtensionContext, createWebviewPanel, registeredCommands, registeredEditors, resetMock, shownInfo } = mock;

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { contributes: { customEditors: unknown[]; commands: { command: string }[]; configuration: { properties: Record<string, { default?: unknown; scope?: string }> } } };

describe('host activate() (with the vscode stand-in)', () => {
  beforeEach(resetMock);
  afterEach(() => delete process.env['PMD_TEST']);

  it('registers the custom editor, its commands (R-132) and its output channel for disposal', () => {
    const context = createExtensionContext();
    const info = activate(context);

    expect(info).toEqual({ viewType: VIEW_TYPE });
    // log + registerCustomEditorProvider + the symbol provider (P9) + the view commands (printLayout, webLayout, draft, read,
    // code, split, and P10's printPreview) + switchView + P10's three exports and chooseProfile + createLayoutFile +
    // P11's reopenWithEditor and the default-editor watcher + P14's Problems collection and checkDocument
    // + R-234's build status bar item, its tab listener and pagemd.about + L3's getProfilePacks
    expect(context.subscriptions).toHaveLength(24);
    expect(mock.symbolProviders.map((p) => [p.selector, p.metadata])).toEqual([[[{ language: 'markdown' }], { label: 'pagemd' }]]);
    expect(registeredEditors).toHaveLength(1);
    expect(registeredEditors[0]!.viewType).toBe(VIEW_TYPE);
    expect(registeredEditors[0]!.provider).toBeInstanceOf(EditorProvider);
    // P11 (R-175): VS Code's own find stays available where the canvas's find bar isn't (Code view, Print Preview).
    expect(registeredEditors[0]!.options).toMatchObject({ webviewOptions: { enableFindWidget: true } });
    expect(createdChannels.at(-1)?.lines).toEqual(['pagemd Editor activated.']);
    expect([...registeredCommands.keys()]).toEqual([
      'pagemd.about', 'pagemd.printLayout', 'pagemd.webLayout', 'pagemd.draft', 'pagemd.read', 'pagemd.code', 'pagemd.split', 'pagemd.printPreview', 'pagemd.switchView',
      // P10 (R-170): names pagemd-vscode doesn't register (pagemd.exportPdf, pagemd.validate, pagemd.selectProfile, …), so both can be installed.
      'pagemd.exportToPdf', 'pagemd.exportToHtml', 'pagemd.exportToPng', 'pagemd.chooseProfile',
      'pagemd.getProfilePacks',
      // P14 (R-189): not pagemd-vscode's pagemd.validate
      'pagemd.checkDocument',
      'pagemd.reopenWithEditor', 'pagemd.createLayoutFile',
    ]);
    // P14: one Problems collection, "pagemd"
    expect(mock.diagnosticCollections.map((c) => c.name)).toEqual(['pagemd']);
  });

  it('R-234: "pagemd: About this build" names the version, and a dev run says "dev build"', async () => {
    activate(createExtensionContext());
    await mock.commands.executeCommand('pagemd.about');
    expect(shownInfo.at(-1)).toBe('pagemd Editor 9.9.9-test (dev build)');
  });

  it('R-234: the build status bar item shows only while a pagemd editor is the active tab', () => {
    activate(createExtensionContext());
    const item = mock.statusItems.at(-1)!;
    expect(item.text).toBe('pagemd dev build');
    expect(item.command).toBe('pagemd.about');
    expect(item.tooltip).toBe('pagemd Editor 9.9.9-test (dev build)');
    expect(item.visible).toBe(false);
    mock.tabs.active = { viewType: VIEW_TYPE };
    mock.tabs.changed.fire(undefined);
    expect(item.visible).toBe(true);
    mock.tabs.active = { viewType: 'other.editor' };
    mock.tabs.changed.fire(undefined);
    expect(item.visible).toBe(false);
  });

  it('a view command tells the active session to switch views; with none active, it says so instead of throwing', async () => {
    activate(createExtensionContext());
    const provider = registeredEditors.at(-1)!.provider as EditorProvider;
    await mock.commands.executeCommand('pagemd.webLayout');
    expect(shownInfo.at(-1)).toMatch(/no pagemd editor is active/);

    const doc = new mock.MockTextDocument(mock.Uri.file('/work/doc.md'), '# x\n');
    const view = createWebviewPanel();
    provider.resolveCustomTextEditor(doc as unknown as vscode.TextDocument, view.panel);
    view.receive({ kind: 'event', name: 'ready', data: { protocol: PROTOCOL_VERSION } });
    await provider.sessions.get(doc.uri.toString())!.ready;

    await mock.commands.executeCommand('pagemd.webLayout');
    expect(view.posted.at(-1)).toEqual({ kind: 'event', name: 'setView', data: { mode: 'web' } });
    await mock.commands.executeCommand('pagemd.draft');
    expect(view.posted.at(-1)).toEqual({ kind: 'event', name: 'setView', data: { mode: 'draft' } });
    await mock.commands.executeCommand('pagemd.printLayout');
    expect(view.posted.at(-1)).toEqual({ kind: 'event', name: 'setView', data: { mode: 'print' } });
    await mock.commands.executeCommand('pagemd.read');
    expect(view.posted.at(-1)).toEqual({ kind: 'event', name: 'setView', data: { mode: 'read' } });
  });

  it('"pagemd: Switch View" (P6, R-142) offers the seven views in a Quick Pick and switches to the one picked; dismissed does nothing', async () => {
    activate(createExtensionContext());
    const provider = registeredEditors.at(-1)!.provider as EditorProvider;
    const doc = new mock.MockTextDocument(mock.Uri.file('/work/doc.md'), '# x\n');
    const view = createWebviewPanel();
    provider.resolveCustomTextEditor(doc as unknown as vscode.TextDocument, view.panel);
    view.receive({ kind: 'event', name: 'ready', data: { protocol: PROTOCOL_VERSION } });
    await provider.sessions.get(doc.uri.toString())!.ready;
    const before = view.posted.length;

    mock.quickPick.next = undefined;
    await mock.commands.executeCommand('pagemd.switchView');
    expect(mock.quickPicks.at(-1)?.items).toEqual(['Print Layout', 'Web Layout', 'Draft', 'Read', 'Code', 'Split', 'Print Preview']);
    expect(view.posted).toHaveLength(before);
    mock.quickPick.next = 'Read';
    await mock.commands.executeCommand('pagemd.switchView');
    expect(view.posted.at(-1)).toEqual({ kind: 'event', name: 'setView', data: { mode: 'read' } });
    // Given a mode (a keybinding, a test), it switches without asking.
    mock.quickPicks.length = 0;
    await mock.commands.executeCommand('pagemd.switchView', 'web');
    expect(mock.quickPicks).toHaveLength(0);
    expect(view.posted.at(-1)).toEqual({ kind: 'event', name: 'setView', data: { mode: 'web' } });
  });

  it('"pagemd: Create Layout File" reports plain-styles documents as an error rather than throwing', async () => {
    activate(createExtensionContext());
    const provider = registeredEditors.at(-1)!.provider as EditorProvider;
    const doc = new mock.MockTextDocument(mock.Uri.file('/work/doc.md'), '# x\n');
    const view = createWebviewPanel();
    provider.resolveCustomTextEditor(doc as unknown as vscode.TextDocument, view.panel);
    view.receive({ kind: 'event', name: 'ready', data: { protocol: PROTOCOL_VERSION } });
    await provider.sessions.get(doc.uri.toString())!.ready;

    await mock.commands.executeCommand('pagemd.createLayoutFile');
    expect(mock.shownErrors.at(-1)).toMatch(/plain styles/);
  });

  it('offers the test handles only under the test runner (PMD_TEST=1, R-89)', () => {
    process.env['PMD_TEST'] = '1';
    const info = activate(createExtensionContext());
    expect(typeof info.test?.whenReady).toBe('function');
    expect(typeof info.test?.type).toBe('function');
  });

  it('never offers the test handles in a packaged (Production) extension, even with PMD_TEST=1 (R-209)', () => {
    process.env['PMD_TEST'] = '1';
    expect(activate(createExtensionContext(1)).test).toBeUndefined();
    expect(activate(createExtensionContext(3)).test).toBeDefined(); // the test host
  });

  it('keeps the settings that name programs, folders or sources machine-scoped, and declares untrusted-workspace support (R-209)', () => {
    const props = manifest.contributes.configuration.properties;
    expect(props['pagemdEditor.pagemdPath']?.scope).toBe('machine');
    expect(props['pagemdEditor.browserPath']?.scope).toBe('machine');
    expect(props['pagemdEditor.profilePacks.source']?.scope).toBe('machine'); // L3
    const caps = (manifest as unknown as { capabilities: { untrustedWorkspaces: { supported: string; restrictedConfigurations: string[] } } }).capabilities;
    expect(caps.untrustedWorkspaces.supported).toBe('limited');
    expect(caps.untrustedWorkspaces.restrictedConfigurations).toEqual(['pagemdEditor.pagemdPath', 'pagemdEditor.browserPath', 'pagemdEditor.profilePacks.source']);
  });

  it('is registered for *.md as an option, not the default editor (R-87)', () => {
    expect(manifest.contributes.customEditors).toEqual([
      { viewType: VIEW_TYPE, displayName: 'pagemd Editor', selector: [{ filenamePattern: '*.md' }], priority: 'option' },
    ]);
  });

  it('P11 (R-174, R-176): the manifest declares every registered command, and the two settings with their defaults', () => {
    activate(createExtensionContext());
    const declared = manifest.contributes.commands.map((c) => c.command);
    for (const id of registeredCommands.keys()) expect(declared, id).toContain(id);
    const props = manifest.contributes.configuration.properties;
    expect(props['pagemdEditor.imageFolder']).toMatchObject({ default: '.pagemd/assets/img', scope: 'resource' });
    expect(props['pagemdEditor.openByDefault']).toMatchObject({ default: [] }); // nothing changes until the author names files
  });
});
