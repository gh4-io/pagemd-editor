// P11 (R-176): the setting that makes chosen files open in the pagemd editor, copied into VS Code's own
// `workbench.editorAssociations`, touching only what we wrote.
import { beforeEach, describe, expect, it } from 'vitest';
import * as mock from '../../../__mocks__/vscode.ts';
import { mergeAssociations, syncDefaultEditors } from '../host/default-editor.ts';
import type * as vscode from 'vscode';

const VIEW = 'pagemd-editor.editor';
beforeEach(mock.resetMock);

describe('mergeAssociations', () => {
  it('adds our patterns to the object form, and remembers them', () => {
    const merged = mergeAssociations({ '*.csv': 'csv.editor' }, ['*.pagemd.md', 'docs/**/*.md'], [], VIEW);
    expect(merged.value).toEqual({ '*.csv': 'csv.editor', '*.pagemd.md': VIEW, 'docs/**/*.md': VIEW });
    expect(merged.written).toEqual(['*.pagemd.md', 'docs/**/*.md']);
  });
  it('removes only the patterns WE wrote that are no longer wanted', () => {
    const current = { '*.a.md': VIEW, '*.mine.md': VIEW, '*.csv': 'csv.editor' };
    const merged = mergeAssociations(current, ['*.a.md'], ['*.a.md', '*.gone.md'], VIEW);
    expect(merged.value).toBeUndefined(); // *.gone.md isn't there; *.mine.md is the author's own and stays
    const removed = mergeAssociations(current, [], ['*.a.md'], VIEW);
    expect(removed.value).toEqual({ '*.mine.md': VIEW, '*.csv': 'csv.editor' });
  });
  it('never takes over a pattern the author mapped to another editor, and says so', () => {
    const merged = mergeAssociations({ '*.md': 'vscode.markdown.preview.editor' }, ['*.md', '*.pagemd.md'], [], VIEW);
    expect(merged.skipped).toEqual(['*.md']);
    expect(merged.written).toEqual(['*.pagemd.md']);
    expect(merged.value).toEqual({ '*.md': 'vscode.markdown.preview.editor', '*.pagemd.md': VIEW });
  });
  it('a pattern already mapped to us (by the author) is not changed and is not ours to remove later', () => {
    const merged = mergeAssociations({ '*.pagemd.md': VIEW }, ['*.pagemd.md'], [], VIEW);
    expect(merged.value).toBeUndefined();
  });
  it('works on the older array form too, keeping entries it does not understand', () => {
    const current = [{ viewType: 'csv.editor', filenamePattern: '*.csv' }, { odd: true }];
    const merged = mergeAssociations(current, ['*.pagemd.md'], [], VIEW);
    expect(merged.value).toEqual([...current, { viewType: VIEW, filenamePattern: '*.pagemd.md' }]);
    const back = mergeAssociations(merged.value, [], ['*.pagemd.md'], VIEW);
    expect(back.value).toEqual(current);
  });
  it('nothing wanted and nothing written: no value, no change (also for a missing or odd setting)', () => {
    for (const current of [undefined, null, {}, [], 'x']) expect(mergeAssociations(current, [], [], VIEW).value).toBeUndefined();
  });
});

describe('syncDefaultEditors', () => {
  const memento = (): vscode.Memento => {
    const data = new Map<string, unknown>();
    return { keys: () => [...data.keys()], get: (key: string, fallback?: unknown) => (data.has(key) ? data.get(key) : fallback), update: (key: string, value: unknown) => (data.set(key, value), Promise.resolve()) } as unknown as vscode.Memento;
  };
  const context = () => ({ globalState: memento(), workspaceState: memento() });

  it('does nothing at all while the setting is empty (the default)', async () => {
    await syncDefaultEditors(context(), VIEW, () => {});
    expect(mock.configurationUpdates).toEqual([]);
  });
  it('writes the user scope for a user setting, then takes it out when the setting is emptied', async () => {
    const ctx = context();
    mock.configurationScopes.set('pagemdEditor.openByDefault', { globalValue: ['*.pagemd.md'] });
    await syncDefaultEditors(ctx, VIEW, () => {});
    expect(mock.configurationUpdates).toEqual([{ key: 'workbench.editorAssociations', value: { '*.pagemd.md': VIEW }, target: mock.ConfigurationTarget.Global }]);
    mock.configurationScopes.set('workbench.editorAssociations', { globalValue: { '*.pagemd.md': VIEW } });
    mock.configurationScopes.set('pagemdEditor.openByDefault', { globalValue: [] });
    await syncDefaultEditors(ctx, VIEW, () => {});
    expect(mock.configurationUpdates.at(-1)).toEqual({ key: 'workbench.editorAssociations', value: {}, target: mock.ConfigurationTarget.Global });
  });
  it('a workspace setting goes to the workspace scope, and only when a folder is open', async () => {
    mock.configurationScopes.set('pagemdEditor.openByDefault', { workspaceValue: ['docs/**/*.md'] });
    await syncDefaultEditors(context(), VIEW, () => {});
    expect(mock.configurationUpdates).toEqual([]);
    mock.workspace.workspaceFolders = [{ uri: mock.Uri.file('/work') }];
    await syncDefaultEditors(context(), VIEW, () => {});
    expect(mock.configurationUpdates).toEqual([{ key: 'workbench.editorAssociations', value: { 'docs/**/*.md': VIEW }, target: mock.ConfigurationTarget.Workspace }]);
  });
  it('a refused write is logged, not thrown', async () => {
    mock.configurationScopes.set('pagemdEditor.openByDefault', { globalValue: ['*.x.md'] });
    const lines: string[] = [];
    const original = mock.workspace.getConfiguration;
    mock.workspace.getConfiguration = ((section?: string) => ({ ...original(section), update: () => Promise.reject(new Error('read-only settings')) })) as typeof original;
    try {
      await syncDefaultEditors(context(), VIEW, (l) => lines.push(l));
    } finally {
      mock.workspace.getConfiguration = original;
    }
    expect(lines.join('\n')).toContain('read-only settings');
  });
});
