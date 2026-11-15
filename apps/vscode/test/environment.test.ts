// Phase L2-1, L2-3 (F6): one environment for every pagemd lookup on the host. Before L2 the styles, the checks and the profile picker
// built three, and the picker's home folder (`HOME ?? USERPROFILE`) differed from the others' (`os.homedir()`). Here: the rule
// itself, and the three services each finding the same profile pack in the shared profiles folder (`$PAGEMD_CONFIG_DIR/profiles`,
// in the mock's in-memory files; the real folder is never read).
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import * as nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import * as mock from '../../../__mocks__/vscode.ts';
import { pagemdEnvironment } from '../host/services/environment.ts';
import { PagemdHostDiagnostics, ProblemsCollection } from '../host/services/diagnostics.ts';
import { HostOutput } from '../host/services/output.ts';
import { NO_FILES, PLAIN_STYLES, pagemdHostStyles, type HostStyles } from '../host/services/styles.ts';

const THEME_KIT_DEFAULTS = fileURLToPath(new URL('../../../../pagemd-common/packages/theme-kit/defaults/', import.meta.url)).replace(/\/$/, '');
const loadRealFolder = (dir: string): void => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = nodePath.join(dir, entry.name);
    if (entry.isDirectory()) loadRealFolder(full);
    else mock.mockFiles.set(full, new TextEncoder().encode(readFileSync(full, 'utf8')));
  }
};
const text = (s: string) => new TextEncoder().encode(s);

describe('pagemdEnvironment: the folders', () => {
  it('home is os.homedir(); PAGEMD_CONFIG_DIR moves the shared folder', () => {
    expect(pagemdEnvironment(undefined, { env: { PAGEMD_CONFIG_DIR: '/cfg' } })).toEqual({ homePath: homedir(), sharedProfilesPath: '/cfg/profiles', sharedProfilesReason: 'PAGEMD_CONFIG_DIR' });
  });
  it("the system's rule otherwise (Windows, macOS, Linux, WSL where the Linux and Windows user names differ)", () => {
    expect(pagemdEnvironment(undefined, { env: { LOCALAPPDATA: 'C:\\Users\\Alice\\AppData\\Local' }, platform: 'win32', homePath: 'C:\\Users\\Alice' }).sharedProfilesPath).toMatch(/pagemd[\\/]profiles$/);
    expect(pagemdEnvironment(undefined, { env: {}, platform: 'darwin', homePath: '/Users/j' }).sharedProfilesPath).toBe('/Users/j/Library/Application Support/pagemd/profiles');
    expect(pagemdEnvironment(undefined, { env: {}, platform: 'linux', homePath: '/home/u', exists: () => false, osRelease: '6.1' }).sharedProfilesPath).toBe('/home/u/.local/share/pagemd/profiles');
    const wsl = pagemdEnvironment(undefined, {
      env: { WSL_DISTRO_NAME: 'Ubuntu', USER: 'bob' },
      platform: 'linux',
      homePath: '/home/bob',
      exists: (p) => p === '/mnt/c/Users/Alice/AppData/Local',
      list: () => ['Default', 'Alice', 'Public'],
    });
    expect(wsl).toMatchObject({ sharedProfilesPath: '/mnt/c/Users/Alice/AppData/Local/pagemd/profiles', sharedProfilesReason: 'wsl-only-user' });
  });
  it('the log names the folder used (once)', () => {
    const lines: string[] = [];
    pagemdEnvironment((l) => lines.push(l), { env: { PAGEMD_CONFIG_DIR: '/logged' } });
    pagemdEnvironment((l) => lines.push(l), { env: { PAGEMD_CONFIG_DIR: '/logged' } });
    expect(lines).toEqual(['Shared profiles folder: /logged/profiles (PAGEMD_CONFIG_DIR is set, so its profiles folder is used)']);
  });
});

describe('the styles, the checks and the profile picker use the same folders', () => {
  const saved = process.env['PAGEMD_CONFIG_DIR'];
  const ext = mock.Uri.file('/ext') as unknown as vscode.Uri;
  beforeEach(() => {
    mock.resetMock();
    loadRealFolder(THEME_KIT_DEFAULTS);
    mock.configuration.set('pagemdEditor.pagemdPath', THEME_KIT_DEFAULTS);
    process.env['PAGEMD_CONFIG_DIR'] = '/cfg';
    mock.mockFiles.set('/cfg/profiles/lib-pack.json', text(JSON.stringify({ id: 'lib-pack', extends: 'standard_letter', resources: { css: ['./lib-pack/style.css'] } })));
    mock.mockFiles.set('/cfg/profiles/lib-pack/manifest.json', text('{"id":"lib-pack","version":"0.1.0","files":[]}'));
    mock.mockFiles.set('/cfg/profiles/lib-pack/style.css', text('p { color: rgb(1, 2, 3); }'));
  });
  afterEach(() => {
    if (saved === undefined) delete process.env['PAGEMD_CONFIG_DIR'];
    else process.env['PAGEMD_CONFIG_DIR'] = saved;
  });
  const open = () => {
    const doc = new mock.MockTextDocument(mock.Uri.file('/work/doc.md'), '---\nprofile: lib-pack\n---\n# Pack\n');
    mock.openDocuments.push(doc);
    return doc as unknown as vscode.TextDocument;
  };

  it('the canvas styles find the pack by name', async () => {
    const payload = await pagemdHostStyles({ extensionUri: ext, log: () => {} })(open()).get();
    expect(payload.notes.map((n) => n.kind)).not.toContain('profile-not-found');
    expect(payload.styles?.css).toContain('rgb(1, 2, 3)');
  });

  it('the checks get the same home and shared folder', async () => {
    const seen: { homePath?: string; sharedProfilesPath?: string }[] = [];
    const check = vi.fn(async (_doc: unknown, env: { homePath?: string; sharedProfilesPath?: string }) => {
      seen.push({ homePath: env.homePath, sharedProfilesPath: env.sharedProfilesPath });
      return null;
    });
    await new PagemdHostDiagnostics(open(), { problems: new ProblemsCollection(), extensionUri: ext, log: () => undefined, check: check as never }).run();
    expect(seen).toEqual([{ homePath: homedir(), sharedProfilesPath: '/cfg/profiles' }]);
  });

  it('the profile picker lists the pack (library 0.1.0)', async () => {
    const styles: HostStyles = { get: async () => PLAIN_STYLES, onChange: () => ({ dispose() {} }), createLayoutFile: async () => 'declined', filesInUse: async () => NO_FILES, dispose() {} };
    const output = new HostOutput(open(), mock.createWebviewPanel().panel.webview, { extensionUri: ext, log: () => undefined, styles });
    expect((await output.profiles()).find((p) => p.name === 'lib-pack')).toMatchObject({ source: 'library', version: '0.1.0', duplicates: [] });
  });

  it('no builder of its own is left: the services take their folders from pagemdEnvironment()', () => {
    for (const file of ['styles.ts', 'diagnostics.ts', 'output.ts']) {
      const source = readFileSync(fileURLToPath(new URL(`../host/services/${file}`, import.meta.url)), 'utf8');
      expect(source, file).toContain('pagemdEnvironment(');
      expect(source, file).not.toMatch(/homePath:\s*(os\.homedir\(\)|process\.env)/);
    }
  });
});
