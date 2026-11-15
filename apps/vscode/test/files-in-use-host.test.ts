// P25 (R-242, protocol v12): Files in Use on the host. The pagemd-backed styles service answers the report for the document as it is now
// (theme-kit's real defaults/ in the mock's file system); HostFiles opens only a file of the last report, beside the document, at the
// rule's line, and reveals it in the Explorer (inside the workspace) or the system's file manager (outside). Control: a path the
// report never named is refused and nothing runs.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import * as mock from '../../../__mocks__/vscode.ts';
import type * as vscode from 'vscode';
import type { FilesInUse } from '@pagemd-editor/core';
import { HostFiles, openablePaths } from '../host/services/files.ts';
import { NO_FILES, pagemdHostStyles, plainHostStyles } from '../host/services/styles.ts';

const THEME_KIT_DEFAULTS = fileURLToPath(new URL('../../../../pagemd-common/packages/theme-kit/defaults/', import.meta.url)).replace(/\/$/, '');

function loadRealFolder(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) loadRealFolder(full);
    else mock.mockFiles.set(full, new TextEncoder().encode(readFileSync(full, 'utf8')));
  }
}

beforeEach(() => {
  mock.resetMock();
  loadRealFolder(THEME_KIT_DEFAULTS);
  mock.configuration.set('pagemdEditor.pagemdPath', THEME_KIT_DEFAULTS);
});

const options = { extensionUri: mock.Uri.file('/ext') as unknown as vscode.Uri, log: (_l: string) => {} };

describe('the styles service answers the report', () => {
  it("for the document as it is now: pagemd's default profile, its files in priority order", async () => {
    const doc = new mock.MockTextDocument(mock.Uri.file('/work/doc.md'), '# Hello\n');
    mock.openDocuments.push(doc);
    const styles = pagemdHostStyles(options)(doc as unknown as vscode.TextDocument);
    const report = await styles.filesInUse!();
    expect(report.document).toBe('/work/doc.md');
    expect(report.files.map((f) => f.role)).toEqual(['document', 'profile', 'template', 'stylesheet', 'stylesheet', 'stylesheet', 'stylesheet']);
    expect(report.files.filter((f) => f.role === 'stylesheet').map((f) => f.path?.slice(THEME_KIT_DEFAULTS.length))).toEqual([
      '/styles/syntax/shiki-base.css',
      '/layouts/letter.css',
      '/styles/primary.css',
      '/styles/base.css',
    ]);
    expect(report.rules.length).toBeGreaterThan(50);
    // the frontmatter changes: the next answer follows it (no stale resolution)
    doc.setText('---\nprofile: sop\n---\n# Hello\n');
    const again = await styles.filesInUse!();
    expect(again.files.filter((f) => f.role === 'profile').map((f) => f.name)).toEqual(['sop.json', 'standard_letter.json']);
    styles.dispose();
  });

  it('plain styles: no files', async () => {
    const doc = new mock.MockTextDocument(mock.Uri.file('/work/doc.md'), '# Hello\n');
    expect(await plainHostStyles(doc as unknown as vscode.TextDocument).filesInUse!()).toBe(NO_FILES);
  });
});

const REPORT: FilesInUse = {
  document: '/work/doc.md',
  profile: 'x',
  files: [
    { id: 'f1', role: 'document', path: '/work/doc.md', name: 'doc.md', label: 'This document', why: '', foundBy: { kind: 'named' }, bundled: false },
    { id: 'f2', role: 'stylesheet', path: '/work/styles/a.css', name: 'a.css', label: 'Profile stylesheet', why: '', foundBy: { kind: 'search', step: 1, folder: '/work/styles' }, layer: 'profile', rank: 1, bundled: false },
    { id: 'f3', role: 'stylesheet', path: '/pagemd/styles/base.css', name: 'base.css', label: 'Base styles', why: '', foundBy: { kind: 'system' }, layer: 'base', rank: 2, bundled: true },
    { id: 'f4', role: 'stylesheet', path: null, name: 'CSS made from the properties', label: '', why: '', foundBy: { kind: 'generated' }, layer: 'frontmatter', rank: 3, bundled: false },
  ],
  problems: [{ kind: 'duplicate', message: 'Duplicate', source: 'dup.css', paths: ['/work/dup.css', '/work/styles/dup.css'] }],
  cascade: '',
  rules: [],
  plain: false,
};

describe('HostFiles: only the files of the last report', () => {
  it('lists every openable path: the rows with a file and both files of a duplicate name', () => {
    expect(openablePaths(REPORT)).toEqual(['/work/doc.md', '/work/styles/a.css', '/pagemd/styles/base.css', '/work/dup.css', '/work/styles/dup.css']);
  });

  it('opens a file beside the document as a preview, at the line', async () => {
    const files = new HostFiles(() => {});
    files.remember(REPORT);
    expect(await files.open({ path: '/work/styles/a.css', line: 12 })).toBe(true);
    const [id, uri, show] = mock.executedCommands.at(-1)! as [string, mock.Uri, { viewColumn: number; preview: boolean; selection: mock.Range }];
    expect(id).toBe('vscode.open');
    expect(uri.fsPath).toBe('/work/styles/a.css');
    expect(show).toMatchObject({ viewColumn: mock.ViewColumn.Beside, preview: true });
    expect([show.selection.start.line, show.selection.start.character]).toEqual([11, 0]);
    expect(await files.open({ path: '/work/dup.css' })).toBe(true);
    expect(mock.executedCommands.at(-1)![2]).not.toHaveProperty('selection');
  });

  it('reveals in the Explorer inside the workspace, in the system file manager outside', async () => {
    mock.workspace.workspaceFolders = [{ uri: mock.Uri.file('/work') }];
    const files = new HostFiles(() => {});
    files.remember(REPORT);
    await files.open({ path: '/work/styles/a.css', reveal: true });
    expect(mock.executedCommands.at(-1)![0]).toBe('revealInExplorer');
    await files.open({ path: '/pagemd/styles/base.css', reveal: true });
    expect(mock.executedCommands.at(-1)![0]).toBe('revealFileInOS');
    mock.workspace.workspaceFolders = undefined;
  });

  it('control: refuses a path the report never named (and anything not a path), runs nothing, logs it', async () => {
    const log: string[] = [];
    const files = new HostFiles((line) => log.push(line));
    expect(await files.open({ path: '/work/styles/a.css' })).toBe(false); // no report yet
    files.remember(REPORT);
    const before = mock.executedCommands.length;
    for (const path of ['/etc/passwd', '../styles/a.css', 'styles/a.css', 42, '/work/styles/a.css/../../../etc/passwd']) expect(await files.open({ path })).toBe(false);
    expect(mock.executedCommands.length).toBe(before);
    expect(log.length).toBe(6);
    expect(log[1]).toMatch(/^Files in Use: not opened/);
    // a new report replaces what may be opened
    files.remember({ ...REPORT, files: [], problems: [] });
    expect(await files.open({ path: '/work/styles/a.css' })).toBe(false);
  });
});
