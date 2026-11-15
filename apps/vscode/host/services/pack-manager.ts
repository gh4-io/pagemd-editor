// What "Get Profile Packs" shows and does (phase L3-4, L3-5), with no `vscode` import: the rows (a pack's four states), and the run that
// downloads, checks and installs or removes packs one at a time through @pagemd/packs. The order never changes:
//   download to memory (size limited) -> verifyPack with the checksum from the index -> installPack into the shared folder.
// Nothing reaches the disk before every check has passed, and a cancel is honoured between packs (a pack in flight is stopped before it
// is written, so a cancelled run leaves whole packs only).
import {
  EXIT,
  PackError,
  compareVersions,
  findElsewhere,
  installPack as realInstall,
  latestPacks,
  uninstallPack as realUninstall,
  verifyPack as realVerify,
  type IndexPack,
  type InstalledPack,
  type PackIndex,
} from '@pagemd-editor/output-pagemd/packs';
import { SourceError, type OpenedSource } from './pack-source.ts';

export type PackState =
  | { kind: 'not-installed' }
  | { kind: 'installed'; version: string | null }
  | { kind: 'update'; from: string | null; to: string }
  | { kind: 'changed'; version: string | null; files: string[] }
  | { kind: 'unfinished'; version: string | null }
  | { kind: 'blocked'; files: { path: string; pointer: boolean }[] };

export interface PackRow {
  id: string;
  type: string | null;
  look: string | null;
  /** The library's newest entry for this id; null when the source is not reachable or does not carry it. */
  entry: IndexPack | null;
  installed: InstalledPack | null;
  state: PackState;
}

/**
 * The rows: the source's newest packs (L3-4, `latest`) joined with what is installed. `latest` null = the source could not be read
 * (offline, L3-6): only the installed packs are listed and Remove still works.
 */
export function buildRows(input: { latest: IndexPack[] | null; installed: InstalledPack[]; elsewhere?: (id: string) => { path: string; pointer: boolean }[] }): PackRow[] {
  const installed = new Map(input.installed.map((p) => [p.id, p]));
  const rows = new Map<string, PackRow>();
  for (const entry of input.latest ?? []) {
    const have = installed.get(entry.id) ?? null;
    rows.set(entry.id, { id: entry.id, type: entry.type ?? have?.type ?? null, look: entry.look ?? have?.look ?? null, entry, installed: have, state: stateOf(entry, have, input.elsewhere) });
  }
  for (const have of input.installed) {
    if (!rows.has(have.id)) rows.set(have.id, { id: have.id, type: have.type, look: have.look, entry: null, installed: have, state: stateOf(null, have) });
  }
  return [...rows.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function stateOf(entry: IndexPack | null, have: InstalledPack | null, elsewhere?: (id: string) => { path: string; pointer: boolean }[]): PackState {
  if (have) {
    // A hand change comes first: an update, or a reinstall, would stop on the changed file (exit 3), so only Remove is offered.
    if (have.changed.length + have.missing.length > 0) return { kind: 'changed', version: have.version, files: [...have.changed, ...have.missing] };
    if (have.installing) return { kind: 'unfinished', version: have.version };
    if (entry?.version && have.version && compareVersions(have.version, entry.version) < 0) return { kind: 'update', from: have.version, to: entry.version };
    return { kind: 'installed', version: have.version };
  }
  const files = elsewhere?.(entry?.id ?? '') ?? [];
  if (files.length > 0) return { kind: 'blocked', files };
  return { kind: 'not-installed' };
}

/** What the picker says about a row ("not installed", "installed 0.1.0", "update to 0.2.0", "changed by hand", ...). */
export function stateText(row: PackRow): string {
  const s = row.state;
  switch (s.kind) {
    case 'not-installed':
      return row.entry?.version ? `not installed (available ${row.entry.version})` : 'not installed';
    case 'installed':
      return s.version ? `installed ${s.version}` : 'installed';
    case 'update':
      return `update to ${s.to} (installed ${s.from})`;
    case 'changed':
      return `changed by hand${s.version ? ` (installed ${s.version})` : ''}`;
    case 'unfinished':
      return 'an install did not finish: install again to complete it';
    case 'blocked':
      return `cannot be installed: the name already exists in ${s.files[0]?.path ?? 'another folder'}`;
  }
}

/** What selecting a row does. A changed pack can only be removed (its hand-edited files are kept); a blocked name can do nothing. */
export function actionsOf(row: PackRow): ('install' | 'update' | 'remove')[] {
  const s = row.state;
  const out: ('install' | 'update' | 'remove')[] = [];
  if (s.kind === 'not-installed' && row.entry) out.push('install');
  if (s.kind === 'unfinished' && row.entry) out.push('install');
  if (s.kind === 'update' && row.entry) out.push('update');
  if (row.installed) out.push('remove');
  return out;
}

/** The reason and the file in the way, for a blocked name (L2-4, exit 4), in plain words. */
export function blockedText(row: PackRow): string {
  if (row.state.kind !== 'blocked') return '';
  const lines = row.state.files.map((f) => `${f.path}${f.pointer ? " (a pointer file written by pagemd-library's install.mjs; run `node scripts/install.mjs --uninstall` in your pagemd-library checkout)" : ' (rename or move it; the editor never removes it)'}`);
  return `The name "${row.id}" already exists where pagemd looks for profiles, and a name found twice stops every build: ${lines.join('; ')}`;
}

/** The newest pack for every id of an index. */
export const newestPacks = (index: PackIndex): IndexPack[] => latestPacks(index, compareVersions);

// ── The run ──

export interface Outcome {
  id: string;
  action: 'install' | 'update' | 'remove';
  result: 'done' | 'failed' | 'cancelled';
  /** What to tell the user (always set for a failure). */
  message: string;
  code?: number;
}

export interface RunDeps {
  source: OpenedSource | null;
  target: string;
  /** The other folders pagemd searches for profiles (exit 4). */
  elsewhere: string[];
  signal?: AbortSignal;
  /** One line per pack ("Downloading pml-sop-ink 0.1.0 (2 of 5)"). */
  progress?: (line: string) => void;
  log?: (line: string) => void;
  // The real functions; tests replace them to prove an order or a refusal.
  verify?: typeof realVerify;
  install?: typeof realInstall;
  uninstall?: typeof realUninstall;
}

/** A clear message for each exit code of @pagemd/packs (L3-5). */
export function explainPackError(error: PackError, id: string): string {
  const first = error.message.split('\n')[0] ?? error.message;
  switch (error.code) {
    case EXIT.existsElsewhere:
      return error.message;
    case EXIT.wouldOverwrite:
      return `${id} was not installed: ${first} A file of the pack's already exists and is not the pack's own (or was changed by hand); nothing was overwritten.`;
    case EXIT.usage:
      return `${id} was not installed: the source's index could not be used (${first}).`;
    default:
      return `${id} was refused and nothing was written: ${first}`;
  }
}

/** Install, update or remove the chosen packs, one at a time. A failure is reported and the run goes on; offline or a cancel stops it. */
export async function runPacks(wanted: { row: PackRow; action: 'install' | 'update' | 'remove' }[], deps: RunDeps): Promise<Outcome[]> {
  const verify = deps.verify ?? realVerify;
  const install = deps.install ?? realInstall;
  const uninstall = deps.uninstall ?? realUninstall;
  const out: Outcome[] = [];
  let stopped: Outcome['result'] | null = null;
  for (const [i, { row, action }] of wanted.entries()) {
    const id = row.id;
    if (stopped || deps.signal?.aborted) {
      out.push({ id, action, result: 'cancelled', message: `${id}: not ${action === 'remove' ? 'removed' : 'installed'} (the run was stopped).` });
      continue;
    }
    deps.progress?.(`${action === 'remove' ? 'Removing' : action === 'update' ? 'Updating' : 'Installing'} ${id} (${i + 1} of ${wanted.length})`);
    try {
      if (action === 'remove') {
        const r = uninstall(id, deps.target);
        out.push({ id, action, result: 'done', message: r.kept.length > 0 ? `${id} removed; ${r.kept.length} file(s) you had changed were kept: ${r.kept.join(', ')}.` : `${id} removed.` });
        deps.log?.(`Removed ${id} (${r.removed} files, ${r.kept.length} kept).`);
        continue;
      }
      if (!deps.source || !row.entry) throw new SourceError(`${id} is not in the source.`, 'bad-reply');
      const zip = await deps.source.readPack(row.entry, deps.signal);
      if (deps.signal?.aborted) throw new SourceError('Cancelled.', 'cancelled');
      const pack = verify(zip, row.entry.sha256);
      if (pack.id !== id) throw new PackError(`the zip holds "${pack.id}", not "${id}"`, EXIT.refused);
      const result = install(pack, deps.target, { elsewhere: deps.elsewhere });
      out.push({ id, action, result: 'done', message: `${id} ${result.version ?? ''} ${action === 'update' ? 'updated' : 'installed'}.`.replace('  ', ' ') });
      deps.log?.(`${action === 'update' ? 'Updated' : 'Installed'} ${id} ${result.version ?? ''}: ${result.written} written, ${result.unchanged} unchanged, ${result.removed} removed.`);
    } catch (error) {
      if (error instanceof PackError) {
        const message = explainPackError(error, id);
        deps.log?.(`${id}: exit ${error.code}: ${error.message}`);
        out.push({ id, action, result: 'failed', message, code: error.code });
      } else if (error instanceof SourceError) {
        deps.log?.(`${id}: ${error.kind}: ${error.message}`);
        if (error.kind === 'cancelled') {
          stopped = 'cancelled';
          out.push({ id, action, result: 'cancelled', message: `${id}: stopped; nothing was written.` });
        } else {
          if (error.kind === 'offline') stopped = 'failed';
          out.push({ id, action, result: 'failed', message: `${id} was not installed: ${error.message}${error.kind === 'too-large' ? ' Nothing was written.' : ''}` });
        }
      } else {
        const text = error instanceof Error ? error.message : String(error);
        deps.log?.(`${id}: unexpected: ${text}`);
        out.push({ id, action, result: 'failed', message: `${id}: ${text}` });
      }
    }
  }
  return out;
}

/** "Installed 2, updated 1, removed 1; 1 failed, 2 not done (stopped)." */
export function summarize(outcomes: Outcome[]): string {
  const count = (action: Outcome['action'], result: Outcome['result']): number => outcomes.filter((o) => o.action === action && o.result === result).length;
  const done = [
    ['installed', count('install', 'done')],
    ['updated', count('update', 'done')],
    ['removed', count('remove', 'done')],
  ].filter(([, n]) => (n as number) > 0).map(([w, n]) => `${w} ${n}`);
  const failed = outcomes.filter((o) => o.result === 'failed').length;
  const cancelled = outcomes.filter((o) => o.result === 'cancelled').length;
  const parts = [done.length > 0 ? done.join(', ') : 'nothing changed'];
  if (failed > 0) parts.push(`${failed} failed`);
  if (cancelled > 0) parts.push(`${cancelled} not done (stopped)`);
  return `${parts[0]![0]!.toUpperCase()}${parts[0]!.slice(1)}${parts.length > 1 ? `; ${parts.slice(1).join(', ')}` : ''}.`;
}

/** The names `elsewhere` finds for a profile id, with the other folders pagemd searches (L2-4). */
export const elsewhereFinder = (folders: string[], target: string) => (id: string) => (id ? findElsewhere(id, folders, target) : []);
