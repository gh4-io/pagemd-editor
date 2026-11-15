// "pagemd: Get Profile Packs…" (phase L3, R-263, R-264): the editor's own way to get the library's profile packs, in the manner of Word's
// File ▸ New (R-236): a gallery from a place you configured; online templates when you are online; offline only what is already on
// your computer; and using a template never goes online. In this editor:
//   - the network is touched ONLY by this command, never when a document is opened, built, previewed or exported (pack-source.ts is the
//     only file that fetches; a test scans for it and another stubs `fetch` to fail during open, preview and export);
//   - what is installed is read from the shared profiles folder alone, so the profile picker and every build work offline;
//   - an unreachable source is said plainly, the installed packs are still listed, and Remove still works.
// The sign-in for a private library is VS Code's own GitHub authentication (`vscode.authentication.getSession('github', ['repo'])`): the
// extension never asks for, keeps or logs a token.
import * as os from 'node:os';
import * as vscode from 'vscode';
import { listInstalled, otherProfileFolders, type InstalledPack } from '@pagemd-editor/output-pagemd/packs';
import { pagemdEnvironment } from './environment.ts';
import { actionsOf, blockedText, buildRows, elsewhereFinder, newestPacks, runPacks, stateText, summarize, type Outcome, type PackRow } from './pack-manager.ts';
import { LIBRARY_REPO_URL, SourceError, describeSource, openSource, parseSource, type OpenedSource, type SourceDeps, type SourceSpec } from './pack-source.ts';

export const COMMAND = 'pagemd.getProfilePacks';
export const SETTING = 'profilePacks.source';
const REMOVE_ITEM = 'Remove installed packs…';

export interface PacksDeps {
  log: (line: string) => void;
  showLog?: () => void;
  /** Tests: the network and the sign-in. */
  source?: Pick<SourceDeps, 'fetch' | 'apiBase' | 'authHosts' | 'allowLoopbackHttp'>;
  /** The folder of the open project, for the "name already exists" check (exit 4). */
  projectRoot?: () => string | null;
  /** Is a pagemd editor the active tab (the "Reopen editor" offer)? */
  hasPagemdEditor?: () => boolean;
  /** Pagemd's own folder (the editor's bundled copy), one of the folders searched for the name check. */
  cliPath?: () => string | null;
}

/** What a test or a keybinding may pass to skip the pickers: ids to install (or update), ids to remove. */
export interface PacksPlan {
  install?: string[];
  remove?: string[];
}

/**
 * The configured source (L3-2). `machine` scope already keeps a workspace from setting it; in a workspace you have not trusted the
 * value is read from the user's own settings only, as `restrictedConfigurations` says.
 */
export function sourceSetting(): string {
  const config = vscode.workspace.getConfiguration('pagemdEditor');
  if (vscode.workspace.isTrusted) return String(config.get<string>(SETTING) ?? '').trim();
  return String(config.inspect<string>(SETTING)?.globalValue ?? '').trim();
}

async function sessionToken(create: boolean): Promise<string | null> {
  try {
    const session = await vscode.authentication.getSession('github', ['repo'], create ? { createIfNone: true } : { silent: true });
    return session?.accessToken ?? null;
  } catch {
    return null; // sign-in refused or closed
  }
}

/** Ask which source to use (the setting is empty). */
async function askSource(): Promise<string | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      { label: 'The pagemd library on GitHub', description: 'gh4-io/pagemd-library, latest release (public; a private library set by hand uses your GitHub sign-in)', value: LIBRARY_REPO_URL },
      { label: 'A folder on this computer…', description: 'a folder holding index.json and the pack zips', value: 'folder' },
      { label: 'An https:// address…', description: 'the address of an index.json', value: 'address' },
    ],
    { placeHolder: 'Where should the profile packs come from? (Nothing is fetched until you choose.)' },
  );
  if (!picked) return undefined;
  if (picked.value === 'folder') {
    const folders = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Use this folder' });
    return folders?.[0]?.fsPath;
  }
  if (picked.value === 'address') return vscode.window.showInputBox({ prompt: 'The address of the pack index (https://…/index.json)', placeHolder: 'https://' });
  return picked.value;
}

/** Runs `task` under a notification with a Cancel button; `signal` aborts when it is pressed. */
function withCancel<T>(title: string, task: (signal: AbortSignal, report: (line: string) => void) => Promise<T>): Promise<T> {
  return Promise.resolve(
    vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, (progress, token) => {
      const controller = new AbortController();
      token?.onCancellationRequested(() => controller.abort());
      return task(controller.signal, (line) => progress?.report({ message: line }));
    }),
  );
}

/** The command. Returns what happened (undefined: nothing chosen or no source). */
export async function getProfilePacks(deps: PacksDeps, plan?: PacksPlan): Promise<Outcome[] | undefined> {
  const env = pagemdEnvironment(deps.log);
  const target = env.sharedProfilesPath;
  const read = (): InstalledPack[] => {
    try {
      return listInstalled(target);
    } catch (error) {
      deps.log(`Could not list ${target}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  };

  // 1. The source (L3-2).
  let text = sourceSetting();
  let asked = false;
  if (text === '') {
    if (plan) {
      void vscode.window.showErrorMessage('pagemd Editor: set "pagemdEditor.profilePacks.source" first.');
      return undefined;
    }
    const answer = await askSource();
    if (!answer) return undefined;
    text = answer;
    asked = true;
  }
  let spec: SourceSpec;
  try {
    spec = parseSource(text, os.homedir());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.log(`Profile packs source refused: ${message}`);
    void vscode.window.showErrorMessage(`pagemd Editor: ${message}`);
    return undefined;
  }

  // 2. Read the index (the only network use, and only now).
  let source: OpenedSource | null = null;
  let offlineReason = '';
  let unreachable = false;
  try {
    source = await withCancel('pagemd: reading the profile pack list', (signal) => openSource(spec, { ...deps.source, getToken: sessionToken, homePath: os.homedir(), log: deps.log }, signal));
    deps.log(`Profile pack source: ${source.label}: ${source.index.packs.length} packs.`);
  } catch (error) {
    if (error instanceof SourceError && error.kind === 'cancelled') return undefined;
    offlineReason = error instanceof Error ? error.message : String(error);
    unreachable = error instanceof SourceError && (error.kind === 'offline' || error.kind === 'timeout');
    deps.log(`Profile pack source ${describeSource(spec)} could not be read: ${offlineReason}`);
    if (error instanceof SourceError && (error.kind === 'insecure' || error.kind === 'bad-source')) {
      void vscode.window.showErrorMessage(`pagemd Editor: ${offlineReason}`);
      return undefined;
    }
  }
  if (!source) {
    void vscode.window
      .showWarningMessage(
        `pagemd Editor: ${unreachable ? 'Cannot reach' : 'Cannot read'} the profile packs at ${describeSource(spec)}: ${offlineReason} Showing only what is installed. Profiles you have installed work as usual.`,
        'Show log',
      )
      ?.then?.((choice) => {
        if (choice === 'Show log') deps.showLog?.();
      });
  } else if (asked) {
    void vscode.window.showInformationMessage(`pagemd Editor: read the pack list from ${source.label}. To use it every time, set "pagemdEditor.profilePacks.source".`);
  }

  // 3. The rows.
  const folders = otherProfileFolders({ projectRoot: deps.projectRoot?.() ?? null, homePath: os.homedir(), cliPath: deps.cliPath?.() ?? null });
  const rowsNow = (): PackRow[] => buildRows({ latest: source ? newestPacks(source.index) : null, installed: read(), elsewhere: elsewhereFinder(folders, target) });
  const rows = rowsNow();

  // 4. What to do: from the plan, or the pickers.
  const wanted: { row: PackRow; action: 'install' | 'update' | 'remove' }[] = [];
  if (plan) {
    for (const id of plan.install ?? []) {
      const row = rows.find((r) => r.id === id);
      const action = row ? actionsOf(row).find((a) => a !== 'remove') : undefined;
      if (row && action) wanted.push({ row, action });
      else deps.log(`Plan: ${id} cannot be installed (${row ? stateText(row) : 'not in the source'}).`);
    }
    for (const id of plan.remove ?? []) {
      const row = rows.find((r) => r.id === id);
      if (row?.installed) wanted.push({ row, action: 'remove' });
    }
  } else {
    const pick = await pickPacks(rows, source?.label ?? null);
    if (!pick) return undefined;
    wanted.push(...pick.install.map((row) => ({ row, action: actionsOf(row).find((a) => a !== 'remove') as 'install' | 'update' })));
    if (pick.removeMore) {
      const removals = await pickRemovals(rows);
      if (removals === 'cancel') return undefined;
      wanted.push(...removals.map((row) => ({ row, action: 'remove' as const })));
    }
  }
  if (wanted.length === 0) {
    void vscode.window.showInformationMessage('pagemd Editor: nothing to install or remove.');
    return [];
  }

  // 5. Do it, one pack at a time, with a Cancel button between packs.
  const outcomes = await withCancel('pagemd: profile packs', (signal, report) => runPacks(wanted, { source, target, elsewhere: folders, signal, progress: report, log: deps.log }));
  // Nothing to refresh by hand: the profile picker lists the folder fresh each time and the styles service watches it (AD-L2-20).
  deps.log(`Profile packs: ${summarize(outcomes)}`);
  report(outcomes, deps);
  return outcomes;
}

/**
 * Tells the user what happened. Not awaited by the command: a VS Code notification's promise only settles when it is closed, which
 * would hold the command (and the progress that follows it) open for as long as the message is on screen.
 */
function report(outcomes: Outcome[], deps: PacksDeps): void {
  const failures = outcomes.filter((o) => o.result !== 'done');
  const installed = outcomes.some((o) => o.result === 'done' && o.action !== 'remove');
  const summary = summarize(outcomes);
  if (failures.length > 0) {
    const first = failures.find((o) => o.result === 'failed') ?? failures[0]!;
    void Promise.resolve(vscode.window.showWarningMessage(`pagemd Editor: ${summary} ${first.message}`, 'Show log')).then((choice) => {
      if (choice === 'Show log') deps.showLog?.();
    });
    return;
  }
  const buttons = installed && deps.hasPagemdEditor?.() ? ['Reopen editor'] : [];
  void Promise.resolve(vscode.window.showInformationMessage(`pagemd Editor: ${summary}`, ...buttons)).then((choice) => {
    // A pack's pictures come from a folder the page may not be allowed to read yet (AD-FIX-TAP-08): reopening is the sure way (L3-7).
    if (choice === 'Reopen editor') void vscode.commands.executeCommand('pagemd.reopenWithEditor');
  });
}

/** The multi-select list (L3-4). Returns the packs to install or update, and whether to go on to Remove. */
async function pickPacks(rows: PackRow[], label: string | null): Promise<{ install: PackRow[]; removeMore: boolean } | undefined> {
  if (rows.length === 0) {
    void vscode.window.showInformationMessage('pagemd Editor: the source lists no profile packs, and none are installed.');
    return undefined;
  }
  const rank = (r: PackRow): number => (actionsOf(r).some((a) => a !== 'remove') ? 0 : 1);
  const ordered = [...rows].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
  const items: (vscode.QuickPickItem & { row?: PackRow })[] = ordered.map((row) => ({
    label: row.id,
    description: [[row.type, row.look].filter(Boolean).join(' · '), stateText(row)].filter(Boolean).join('  '),
    detail: row.state.kind === 'blocked' ? blockedText(row) : undefined,
    row,
  }));
  if (rows.some((r) => r.installed)) items.push({ label: REMOVE_ITEM, description: 'choose installed packs to remove (works offline)' });
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    placeHolder: label ? `Profile packs from ${label}: tick the ones to install or update` : 'The source cannot be reached. Installed packs only: choose "Remove installed packs…" to remove some',
  });
  if (!picked) return undefined;
  const install: PackRow[] = [];
  for (const item of picked) {
    if (!item.row) continue;
    if (item.row.state.kind === 'blocked') void vscode.window.showWarningMessage(`pagemd Editor: ${blockedText(item.row)}`);
    if (actionsOf(item.row).some((a) => a !== 'remove')) install.push(item.row);
  }
  return { install, removeMore: picked.some((i) => i.label === REMOVE_ITEM) };
}

/** Which installed packs to remove, and the confirmation. 'cancel' when the user backs out. */
async function pickRemovals(rows: PackRow[]): Promise<PackRow[] | 'cancel'> {
  const installed = rows.filter((r) => r.installed);
  const picked = await vscode.window.showQuickPick(
    installed.map((row) => ({ label: row.id, description: stateText(row), row })),
    { canPickMany: true, placeHolder: 'Remove which installed packs? (files you changed by hand are kept)' },
  );
  if (!picked || picked.length === 0) return 'cancel';
  const ok = await vscode.window.showWarningMessage(
    `Remove ${picked.length} profile pack${picked.length === 1 ? '' : 's'}?`,
    { modal: true, detail: `${picked.map((p) => p.label).join(', ')}\nDocuments that use these profiles will no longer find them. Files you changed by hand are kept.` },
    'Remove',
  );
  return ok === 'Remove' ? picked.map((p) => p.row) : 'cancel';
}
