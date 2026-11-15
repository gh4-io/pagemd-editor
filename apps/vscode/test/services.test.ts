// The host services (P2): document sync, assets (the C2 path contract), links.
import { beforeEach, describe, expect, it } from 'vitest';
import * as mock from '../../../__mocks__/vscode.ts';
import { ASSET_FOLDER, cleanAssetName, documentRelative, HostAssets, isInside, MAX_READ_BYTES, readablePath, resolveImageFolder } from '../host/services/assets.ts';
import { applyTextEdits, HostDocumentSync } from '../host/services/document-sync.ts';
import type { FileSystem, SizedFileSystem } from '../host/services/file-system.ts';
import { classifyLink, HostLinks } from '../host/services/links.ts';
import type * as vscode from 'vscode';

beforeEach(mock.resetMock);

function openDocument(text: string, path = '/work/docs/a.md'): mock.MockTextDocument {
  const doc = new mock.MockTextDocument(mock.Uri.file(path), text);
  mock.openDocuments.push(doc);
  return doc;
}

describe('HostDocumentSync', () => {
  it('applies edits made against the current version, and reports its own change to nobody', async () => {
    const doc = openDocument('# A\n\none\n\ntwo\n');
    const external: string[] = [];
    const sync = new HostDocumentSync(doc as unknown as vscode.TextDocument, (text) => external.push(text));

    const result = await sync.applyEdits([{ from: 5, to: 8, text: 'ONE' }], 1);
    expect(result).toEqual({ status: 'ok', version: 2 });
    expect(doc.getText()).toBe('# A\n\nONE\n\ntwo\n');
    expect(external).toEqual([]);
    sync.dispose();
  });

  it('refuses edits made against an old version and returns the current text (stale → re-sync)', async () => {
    const doc = openDocument('one\n');
    const sync = new HostDocumentSync(doc as unknown as vscode.TextDocument, () => {});
    doc.setText('changed elsewhere\n');
    expect(await sync.applyEdits([{ from: 0, to: 3, text: 'x' }], 1)).toEqual({ status: 'stale', text: 'changed elsewhere\n', version: 2, eol: '\n' });
    expect(doc.getText()).toBe('changed elsewhere\n');
  });

  it('refuses malformed edits (overlapping, unsorted, out of range) instead of applying them', async () => {
    const doc = openDocument('abcdef');
    const sync = new HostDocumentSync(doc as unknown as vscode.TextDocument, () => {});
    for (const edits of [
      [{ from: 2, to: 4, text: '' }, { from: 3, to: 5, text: '' }],
      [{ from: 4, to: 5, text: '' }, { from: 0, to: 1, text: '' }],
      [{ from: 0, to: 99, text: '' }],
      [{ from: 3, to: 2, text: '' }],
    ]) {
      expect((await sync.applyEdits(edits, 1)).status).toBe('stale');
    }
    expect(doc.getText()).toBe('abcdef');
  });

  it('reports stale when VS Code refuses the edit', async () => {
    const doc = openDocument('abc');
    const sync = new HostDocumentSync(doc as unknown as vscode.TextDocument, () => {});
    mock.applyEditMode.value = 'refuse';
    expect((await sync.applyEdits([{ from: 0, to: 1, text: 'x' }], 1)).status).toBe('stale');
  });

  it('reports every change that did not come from the webview (other editors, git, undo)', () => {
    const doc = openDocument('one\n');
    const other = openDocument('other\n', '/work/b.md');
    const external: [string, number][] = [];
    new HostDocumentSync(doc as unknown as vscode.TextDocument, (text, version) => external.push([text, version]));
    doc.setText('two\n');
    other.setText('ignored: another document\n');
    expect(external).toEqual([['two\n', 2]]);
  });

  it('applyTextEdits applies sorted edits against the original positions', () => {
    expect(applyTextEdits('0123456789', [{ from: 1, to: 3, text: 'ab' }, { from: 5, to: 5, text: '+' }, { from: 8, to: 10, text: '' }])).toBe('0ab34+567');
  });

  it('keeps CRLF positions exact (offsets count \\r\\n as two characters)', async () => {
    const doc = openDocument('a\r\n\r\nb\r\n');
    const sync = new HostDocumentSync(doc as unknown as vscode.TextDocument, () => {});
    await sync.applyEdits([{ from: 5, to: 6, text: 'B' }], 1);
    expect(doc.getText()).toBe('a\r\n\r\nB\r\n');
  });
});

describe('HostAssets: the C2 path contract (relative to the .md, forward slashes, no leading /)', () => {
  it('cleans names: no folders, safe characters, never empty or hidden', () => {
    expect(cleanAssetName('Screen Shot 2026-09-27 at 10.00.png')).toBe('Screen-Shot-2026-09-27-at-10.00.png');
    expect(cleanAssetName('../../etc/passwd')).toBe('passwd');
    expect(cleanAssetName('C:\\Users\\me\\café.png')).toBe('cafe.png');
    expect(cleanAssetName('.hidden.png')).toBe('hidden.png');
    expect(cleanAssetName('???')).toBe('image');
  });

  it('writes into .pagemd/assets/img next to the document, never overwriting', async () => {
    const written = new Map<string, Uint8Array>();
    const fs: FileSystem = {
      exists: async (uri) => written.has(uri.path),
      createDirectory: async () => {},
      writeFile: async (uri, bytes) => void written.set(uri.path, bytes),
    };
    const assets = new HostAssets(mock.Uri.file('/work/docs/a.md') as unknown as vscode.Uri, fs);
    const bytes = new Uint8Array([137, 80, 78, 71]);

    expect(await assets.writeAsset(bytes, 'shot.png')).toBe(`${ASSET_FOLDER}/shot.png`);
    expect(await assets.writeAsset(bytes, 'shot.png')).toBe(`${ASSET_FOLDER}/shot-1.png`);
    expect(await assets.writeAsset(bytes, 'sub/dir/shot.png')).toBe(`${ASSET_FOLDER}/shot-2.png`);
    expect([...written.keys()]).toEqual(['/work/docs/.pagemd/assets/img/shot.png', '/work/docs/.pagemd/assets/img/shot-1.png', '/work/docs/.pagemd/assets/img/shot-2.png']);
    expect(written.get('/work/docs/.pagemd/assets/img/shot.png')).toBe(bytes);
    for (const path of [`${ASSET_FOLDER}/shot.png`]) {
      expect(path).not.toMatch(/^\/|\\/);
    }
  });

  it('writes where the setting says (P11), read at every write, and returns that path', async () => {
    const written = new Set<string>();
    const fs: FileSystem = { exists: async (uri) => written.has(uri.path), createDirectory: async () => {}, writeFile: async (uri) => void written.add(uri.path) };
    let folder = 'images';
    const assets = new HostAssets(mock.Uri.file('/work/docs/a.md') as unknown as vscode.Uri, fs, () => folder);
    expect(await assets.writeAsset(new Uint8Array(1), 'a.png')).toBe('images/a.png');
    folder = 'media/shots';
    expect(await assets.writeAsset(new Uint8Array(1), 'a.png')).toBe('media/shots/a.png');
    expect([...written]).toEqual(['/work/docs/images/a.png', '/work/docs/media/shots/a.png']);
  });

  it('two writes of the same name at once never choose the same file (never overwrite)', async () => {
    const written: string[] = [];
    const fs: FileSystem = {
      exists: async (uri) => written.includes(uri.path),
      createDirectory: async () => {},
      writeFile: async (uri) => {
        await new Promise((r) => setTimeout(r, 5)); // a slow disk: without the queue both would have seen the name as free
        written.push(uri.path);
      },
    };
    const assets = new HostAssets(mock.Uri.file('/work/docs/a.md') as unknown as vscode.Uri, fs);
    const paths = await Promise.all([assets.writeAsset(new Uint8Array(1), 'x.png'), assets.writeAsset(new Uint8Array(1), 'x.png'), assets.writeAsset(new Uint8Array(1), 'x.png')]);
    expect(paths).toEqual([`${ASSET_FOLDER}/x.png`, `${ASSET_FOLDER}/x-1.png`, `${ASSET_FOLDER}/x-2.png`]);
    expect(new Set(written).size).toBe(3);
  });

  it('the imageFolder setting: a folder below the document, else the default (and what was refused)', () => {
    expect(resolveImageFolder(undefined)).toEqual({ folder: ASSET_FOLDER });
    expect(resolveImageFolder('')).toEqual({ folder: ASSET_FOLDER });
    expect(resolveImageFolder('images')).toEqual({ folder: 'images' });
    expect(resolveImageFolder(' ./media\\shots/ ')).toEqual({ folder: 'media/shots' });
    for (const bad of ['../images', 'a/../../b', '/abs', 'C:/pics', 'c:\\pics', '.', './', 'a//b', 'a/./b']) expect(resolveImageFolder(bad), bad).toEqual({ folder: ASSET_FOLDER, invalid: bad });
  });

  it('picked files come back relative to the document; another drive or scheme gives undefined', async () => {
    expect(documentRelative('/c:/docs/guide/a.md', '/c:/docs/img/x.png')).toBe('../img/x.png');
    expect(documentRelative('/c:/docs/a.md', '/C:/docs/b.md')).toBe('b.md');
    expect(documentRelative('/c:/docs/a.md', '/d:/pics/x.png')).toBeUndefined();
    expect(documentRelative('/home/me/a.md', '/home/me/sub dir/ü.png')).toBe('sub dir/ü.png');

    const assets = new HostAssets(mock.Uri.file('/work/docs/a.md') as unknown as vscode.Uri, {} as FileSystem);
    mock.dialog.next = [mock.Uri.file('/work/img/x.png')];
    expect(await assets.pickFile(['png'])).toBe('../img/x.png');
    mock.dialog.next = [mock.Uri.parse('vscode-remote://host/work/img/x.png')];
    expect(await assets.pickFile()).toBeUndefined();
    mock.dialog.next = undefined;
    expect(await assets.pickFile()).toBeUndefined();
  });
});

describe('HostAssets.readAsset (P15, R-196): only pictures the canvas can already show', () => {
  /** Files by path with their sizes; the workspace is /work, the document /work/docs/a.md. */
  function reader(files: Record<string, number>, roots = ['/work'], ignoreCase = false) {
    const read: string[] = [];
    const fs: SizedFileSystem = {
      exists: async (uri) => uri.path in files,
      createDirectory: async () => {},
      writeFile: async () => {},
      readFile: async (uri) => {
        read.push(uri.path);
        return new Uint8Array([files[uri.path]! % 256]);
      },
      size: async (uri) => {
        if (!(uri.path in files)) throw new Error('no such file');
        return files[uri.path]!;
      },
    };
    const assets = new HostAssets(mock.Uri.file('/work/docs/a.md') as unknown as vscode.Uri, fs, undefined, {
      fs,
      roots: () => roots.map((r) => mock.Uri.file(r) as unknown as vscode.Uri),
      ignoreCase,
    });
    return { assets, read };
  }

  it('reads a picture beside the document, in a subfolder, above it inside the workspace, and a %20 name', async () => {
    const { assets, read } = reader({ '/work/docs/a.png': 1, '/work/docs/shots/b.jpg': 2, '/work/img/c.webp': 3, '/work/docs/my shot.png': 4 });
    expect([...(await assets.readAsset('a.png'))]).toEqual([1]);
    expect([...(await assets.readAsset('./shots/b.jpg'))]).toEqual([2]);
    expect([...(await assets.readAsset('../img/c.webp'))]).toEqual([3]);
    expect([...(await assets.readAsset('my%20shot.png?v=2#top'))]).toEqual([4]);
    expect(read).toEqual(['/work/docs/a.png', '/work/docs/shots/b.jpg', '/work/img/c.webp', '/work/docs/my shot.png']);
  });

  it('answers a plain Uint8Array, never a Node Buffer (a Buffer would reach the webview as JSON, not as binary)', async () => {
    const fs: SizedFileSystem = { exists: async () => true, createDirectory: async () => {}, writeFile: async () => {}, readFile: async () => Buffer.from([1, 2, 3]), size: async () => 3 };
    const assets = new HostAssets(mock.Uri.file('/work/docs/a.md') as unknown as vscode.Uri, fs, undefined, { fs, roots: () => [] });
    const bytes = await assets.readAsset('a.png');
    expect(bytes.constructor).toBe(Uint8Array);
    expect(JSON.stringify(bytes)).not.toContain('Buffer');
    expect([...bytes]).toEqual([1, 2, 3]);
  });

  it('refuses, without reading: outside the document folder and the workspace, a non-picture, an address, too large, missing', async () => {
    const { assets, read } = reader({ '/home/me/.ssh/id.png': 1, '/work/docs/notes.md': 1, '/work/docs/big.png': MAX_READ_BYTES + 1, '/work/docs/ok.png': MAX_READ_BYTES });
    await expect(assets.readAsset('../../home/me/.ssh/id.png')).rejects.toThrow(/outside the document's folder and the workspace/);
    await expect(assets.readAsset('notes.md')).rejects.toThrow(/not a picture this editor can change/);
    await expect(assets.readAsset('pic.svg')).rejects.toThrow(/not a picture/);
    await expect(assets.readAsset('/work/docs/ok.png')).rejects.toThrow(/not a path relative to the document/);
    await expect(assets.readAsset('C:/work/docs/ok.png')).rejects.toThrow(/not a path relative/);
    await expect(assets.readAsset('https://x.org/a.png')).rejects.toThrow(/not a path relative/);
    await expect(assets.readAsset('file:///work/docs/ok.png')).rejects.toThrow(/not a path relative/);
    await expect(assets.readAsset('big.png')).rejects.toThrow(/larger than 50 MB/);
    await expect(assets.readAsset('gone.png')).rejects.toThrow(/was not found/);
    expect(read).toEqual([]);
    // the control: exactly 50 MB is read
    expect([...(await assets.readAsset('ok.png'))]).toEqual([MAX_READ_BYTES % 256]);
  });

  it("the document's own folder is a root even with no workspace; not pagemd's folder; case folds only where file names do", async () => {
    const { assets } = reader({ '/work/docs/a.png': 1, '/work/other/b.png': 2 }, []);
    expect([...(await assets.readAsset('a.png'))]).toEqual([1]);
    await expect(assets.readAsset('../other/b.png')).rejects.toThrow(/outside/);
    expect(isInside(mock.Uri.file('/Work/Docs/a.png') as unknown as vscode.Uri, mock.Uri.file('/work/docs') as unknown as vscode.Uri)).toBe(false);
    expect(isInside(mock.Uri.file('/Work/Docs/a.png') as unknown as vscode.Uri, mock.Uri.file('/work/docs') as unknown as vscode.Uri, true)).toBe(true);
    expect(isInside(mock.Uri.file('/work/docs2/a.png') as unknown as vscode.Uri, mock.Uri.file('/work/docs') as unknown as vscode.Uri)).toBe(false);
    expect(readablePath('a.PNG')).toEqual({ segments: ['a.PNG'] });
    const none = new HostAssets(mock.Uri.file('/work/docs/a.md') as unknown as vscode.Uri, {} as FileSystem);
    await expect(none.readAsset('a.png')).rejects.toThrow(/not available/);
  });
});

describe('HostLinks: the host decides what a document link may open', () => {
  it('opens web and mail links outside, relative paths in VS Code, and refuses everything else', () => {
    expect(classifyLink('https://example.com/a?b#c')).toEqual({ kind: 'external', uri: 'https://example.com/a?b#c' });
    expect(classifyLink('mailto:a@b.c')).toEqual({ kind: 'external', uri: 'mailto:a@b.c' });
    expect(classifyLink('other.md#section')).toEqual({ kind: 'file', path: 'other.md' });
    expect(classifyLink('../docs/My%20File.md')).toEqual({ kind: 'file', path: '../docs/My File.md' });
    for (const href of ['command:workbench.action.terminal.new', 'javascript:alert(1)', 'file:///etc/passwd', '/etc/passwd', 'C:\\Windows\\x.md', '#top', '', 'vscode:extension/x']) {
      expect(classifyLink(href).kind, href).toBe('refused');
    }
  });

  it('routes each kind to the right place', () => {
    const log: string[] = [];
    const links = new HostLinks(mock.Uri.file('/work/docs/a.md') as unknown as vscode.Uri, (l) => log.push(l));
    links.open('https://example.com');
    links.open('b.md');
    links.open('command:evil');
    expect(mock.openedExternal).toEqual(['https://example.com']);
    expect(mock.executedCommands).toEqual([['vscode.open', mock.Uri.file('/work/docs/b.md')]]);
    expect(log).toEqual(["Link not opened ('command:' links are not opened): command:evil"]);
  });
});
