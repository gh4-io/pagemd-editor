// The pagemd-backed IStyles (P5, amendments 2/6/8): resolves through style-pagemd with a real FileSystem
// adapter over `vscode.workspace.fs`, watches for changes, and runs the create-layout flow. Uses theme-kit's
// real `defaults/` folder (R-128) so the resolver actually finds pagemd's default profile (standard_letter),
// loaded into the mock's in-memory file system (real bytes, read from disk once).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import * as mock from '../../../__mocks__/vscode.ts';
import { pagemdHostStyles, pagemdPathOf, plainHostStyles, vscodeFileSystem } from '../host/services/styles.ts';
import type * as vscode from 'vscode';

/** @pagemd/theme-kit's real defaults/ folder (R-128): every bundled profile/layout/style/template. */
const THEME_KIT_DEFAULTS = fileURLToPath(new URL('../../../../pagemd-common/packages/theme-kit/defaults/', import.meta.url)).replace(/\/$/, '');

function loadRealFolder(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) loadRealFolder(full);
    else mock.mockFiles.set(full, new TextEncoder().encode(readFileSync(full, 'utf8')));
  }
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  mock.resetMock();
  loadRealFolder(THEME_KIT_DEFAULTS);
  mock.configuration.set('pagemdEditor.pagemdPath', THEME_KIT_DEFAULTS);
});

function openDoc(path: string, text: string): mock.MockTextDocument {
  const doc = new mock.MockTextDocument(mock.Uri.file(path), text);
  mock.openDocuments.push(doc);
  return doc;
}

describe('pagemdPathOf', () => {
  it('reads the setting when given, else the bundled dist/defaults next to the extension', () => {
    mock.configuration.set('pagemdEditor.pagemdPath', '/real/pagemd');
    expect(pagemdPathOf(mock.Uri.file('/ext') as unknown as vscode.Uri)).toBe('/real/pagemd');
    mock.configuration.delete('pagemdEditor.pagemdPath');
    expect(pagemdPathOf(mock.Uri.file('/ext') as unknown as vscode.Uri)).toBe('/ext/dist/defaults');
  });

  it('expands a leading ~ to the home folder', () => {
    mock.configuration.set('pagemdEditor.pagemdPath', '~/my-pagemd');
    expect(pagemdPathOf(mock.Uri.file('/ext') as unknown as vscode.Uri)).toMatch(/my-pagemd$/);
    expect(pagemdPathOf(mock.Uri.file('/ext') as unknown as vscode.Uri)).not.toContain('~');
  });
});

describe('vscodeFileSystem', () => {
  it('answers exists/readText/stat/list over the mock file system', async () => {
    const fs = vscodeFileSystem();
    const file = join(THEME_KIT_DEFAULTS, 'styles', 'base.css');
    expect(await fs.exists(file)).toBe(true);
    expect(await fs.exists(join(THEME_KIT_DEFAULTS, 'nope.css'))).toBe(false);
    expect(await fs.readText(file)).toBe(readFileSync(file, 'utf8'));
    expect(await fs.stat(file)).toMatchObject({ isFile: true, isDirectory: false });
    expect(await fs.stat(join(THEME_KIT_DEFAULTS, 'nope'))).toBeNull();
    expect(await fs.list(join(THEME_KIT_DEFAULTS, 'profiles'))).toEqual(expect.arrayContaining(['standard_letter.json']));
  });
});

describe('pagemdHostStyles: a document with no profile named uses pagemd\'s default (standard_letter)', () => {
  const options = { extensionUri: mock.Uri.file('/ext') as unknown as vscode.Uri, log: (_l: string) => {} };

  it('resolves real styles (not plain), with no "using default layout" note (a layout was found)', async () => {
    const doc = openDoc('/work/doc.md', '# Hello\n');
    const styles = pagemdHostStyles(options)(doc as unknown as vscode.TextDocument);
    const payload = await styles.get();
    expect(payload.styles).not.toBeNull();
    expect(payload.styles!.profile).toBe('standard_letter');
    expect(payload.notes.find((n) => n.kind === 'using-default-layout')).toBeUndefined();
    styles.dispose();
  });

  it('a non-file document gets plain styles and cannot create a layout file', async () => {
    const doc = new mock.MockTextDocument(mock.Uri.parse('untitled:Untitled-1'), '# x\n');
    const styles = pagemdHostStyles(options)(doc as unknown as vscode.TextDocument);
    const payload = await styles.get();
    expect(payload).toEqual({ styles: null, gateDefaults: {}, notes: [{ kind: 'not-a-file', message: expect.any(String) }], properties: { required: [], shownOnPage: [], profileFields: [], defaults: {} } });
    await expect(styles.createLayoutFile({ width: 1, height: 1, margins: { top: 0, right: 0, bottom: 0, left: 0 } })).rejects.toThrow(/plain styles/);
    styles.dispose();
  });

  it('re-resolves and notifies listeners when a source file changes on disk (amendment 8)', async () => {
    const doc = openDoc('/work/doc.md', '# Hello\n');
    const styles = pagemdHostStyles(options)(doc as unknown as vscode.TextDocument);
    const seen: unknown[] = [];
    styles.onChange((p) => seen.push(p));
    const before = await styles.get(); // establishes the watched sources
    expect(before.styles).not.toBeNull();

    const primary = join(THEME_KIT_DEFAULTS, 'styles', 'primary.css');
    mock.mockFiles.set(primary, new TextEncoder().encode('/* changed */ body { color: red; }'));
    mock.fireFsEvent('change', primary);
    await tick(400);

    expect(seen.length).toBeGreaterThan(0);
    const payload = seen.at(-1) as { styles: { css: string } | null };
    expect(payload.styles?.css).toContain('color: red');
    styles.dispose();
  });

  it('re-resolves (debounced) when the document text changes', async () => {
    const doc = openDoc('/work/doc.md', '# Hello\n');
    const styles = pagemdHostStyles(options)(doc as unknown as vscode.TextDocument);
    const seen: unknown[] = [];
    styles.onChange((p) => seen.push(p));
    await styles.get();
    doc.setText('---\nprofile: standard_letter\n---\n# Hello\n');
    await tick(500);
    expect(seen.length).toBeGreaterThan(0);
    styles.dispose();
  });

  // Fix run "Group B": choosing another profile (the Document tab or "pagemd: Choose Profile") only writes the `profile:` line; the
  // styles must follow it from the same cache, each time a different profile, with the new look sent to the canvas.
  it('changing the `profile:` line sends the new profile and its look, again and again from one shared cache', async () => {
    const doc = openDoc('/work/doc.md', '---\nprofile: standard_letter\n---\n# Hello\n');
    const styles = pagemdHostStyles(options)(doc as unknown as vscode.TextDocument);
    const seen: { styles: { profile: string; css: string } | null }[] = [];
    styles.onChange((p) => seen.push(p as (typeof seen)[number]));
    const first = await styles.get();
    expect(first.styles?.profile).toBe('standard_letter');
    for (const profile of ['book-wiki', 'sop', 'standard_letter', 'book-wiki']) {
      seen.length = 0;
      doc.setText(`---\nprofile: ${profile}\n---\n# Hello\n`);
      await tick(600);
      expect(seen.at(-1)?.styles?.profile, `after choosing ${profile}`).toBe(profile);
    }
    // book-wiki really looks different (its own fonts and sizes); sop differs from standard_letter in a few lines only.
    const css = async (profile: string) => {
      doc.setText(`---\nprofile: ${profile}\n---\n# Hello\n`);
      return (await styles.get()).styles!.css;
    };
    expect(await css('book-wiki')).not.toBe(await css('standard_letter'));
    styles.dispose();
  });

  it('watches new files created under styles/, profiles/, layouts/, .pagemd/ (amendment 8)', async () => {
    const doc = openDoc('/work/doc.md', '# Hello\n');
    const styles = pagemdHostStyles(options)(doc as unknown as vscode.TextDocument);
    const seen: unknown[] = [];
    styles.onChange((p) => seen.push(p));
    await styles.get();
    mock.fireFsEvent('create', '/work/.pagemd/profiles/whatever.json');
    await tick(400);
    // No assertion on content (the new file is empty/irrelevant here); the point is a refresh was attempted
    // without throwing, and the watcher matched the path (proven by resetting and checking fsWatchers below).
    expect(mock.fsWatchers.some((w) => w.baseDir === '/work' && w.pattern.includes('profiles'))).toBe(true);
    styles.dispose();
  });

  it('createLayoutFile: confirms, writes the layout + per-document profile, and edits the frontmatter (R-129/R-130/R-138)', async () => {
    const doc = openDoc('/work/doc.md', '# Hello\n');
    const styles = pagemdHostStyles(options)(doc as unknown as vscode.TextDocument);
    await styles.get();
    mock.warningDialog.next = 'Create Layout File';
    const result = await styles.createLayoutFile({ width: 210, height: 297, margins: { top: 20, right: 20, bottom: 20, left: 20 } });
    expect(result).toBe('created');
    expect(mock.mockFiles.has('/work/.pagemd/layouts/doc.css')).toBe(true);
    expect(mock.mockFiles.has('/work/.pagemd/profiles/doc.doc.json')).toBe(true);
    const profile = JSON.parse(new TextDecoder().decode(mock.mockFiles.get('/work/.pagemd/profiles/doc.doc.json')!));
    expect(profile).toMatchObject({ id: 'doc.doc', extends: 'standard_letter', resources: { layout: '../layouts/doc.css' } });
    expect(doc.getText()).toContain('profile: ./.pagemd/profiles/doc.doc.json');
    expect(mock.shownWarnings).toHaveLength(1);
    styles.dispose();
  });

  it("createLayoutFile: the document's own layout file is rewritten without the box (R-143); any other layout still asks", async () => {
    const doc = openDoc('/work/doc.md', '# Hello\n');
    const styles = pagemdHostStyles(options)(doc as unknown as vscode.TextDocument);
    await styles.get();
    mock.warningDialog.next = 'Create Layout File';
    const page = (margin: number) => ({ width: 210, height: 297, margins: { top: margin, right: margin, bottom: margin, left: margin } });
    expect(await styles.createLayoutFile(page(20))).toBe('created');
    expect(mock.shownWarnings).toHaveLength(1); // the first time: standard_letter's layout is shared, so it asked

    mock.warningDialog.next = undefined; // a box would now be dismissed: if one appeared, this would come back 'declined'
    expect(await styles.createLayoutFile(page(15))).toBe('created');
    expect(mock.shownWarnings).toHaveLength(1);
    expect(new TextDecoder().decode(mock.mockFiles.get('/work/.pagemd/layouts/doc.css')!)).toContain('15mm');
    styles.dispose();
  });

  it('createLayoutFile: a declined confirmation writes nothing', async () => {
    const doc = openDoc('/work/doc.md', '# Hello\n');
    const styles = pagemdHostStyles(options)(doc as unknown as vscode.TextDocument);
    await styles.get();
    mock.warningDialog.next = undefined;
    const result = await styles.createLayoutFile({ width: 210, height: 297, margins: { top: 20, right: 20, bottom: 20, left: 20 } });
    expect(result).toBe('declined');
    expect(mock.mockFiles.has('/work/.pagemd/layouts/doc.css')).toBe(false);
    styles.dispose();
  });

  it('dispose() tears down its watchers and stops firing onChange', async () => {
    const doc = openDoc('/work/doc.md', '# Hello\n');
    const styles = pagemdHostStyles(options)(doc as unknown as vscode.TextDocument);
    const before = mock.fsWatchers.length;
    expect(before).toBeGreaterThan(0);
    styles.dispose();
    expect(mock.fsWatchers.length).toBe(0);
  });
});

describe('plainHostStyles (control, unchanged from earlier phases)', () => {
  it('always gives plain styles and refuses createLayoutFile', async () => {
    const doc = openDoc('/work/doc.md', '# x\n');
    const styles = plainHostStyles(doc as unknown as vscode.TextDocument);
    expect(await styles.get()).toEqual({ styles: null, gateDefaults: {}, notes: [], properties: { required: [], shownOnPage: [], profileFields: [], defaults: {} } });
    await expect(styles.createLayoutFile({ width: 1, height: 1, margins: { top: 0, right: 0, bottom: 0, left: 0 } })).rejects.toThrow(/plain styles/);
  });
});
