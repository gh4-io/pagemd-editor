// Which files open in the pagemd editor by themselves (P11, R-176, ADR-0008 amendment).
// VS Code picks a custom editor by file NAME only (a glob in `customEditors[].selector`): it cannot look inside the file for
// pagemd's frontmatter keys or for a nearby `.pagemd/` folder, so the editor stays an "option" (Open With…) and the author
// chooses which files open in it:
//  - the setting `pagemdEditor.openByDefault` (a list of file patterns) is copied into VS Code's own
//    `workbench.editorAssociations`, in the same scope (user or workspace) the setting is in; and
//  - "pagemd: Reopen with pagemd Editor" reopens the file in the active tab once.
// Nothing is written unless the list holds a pattern (or held one we wrote). Only entries WE wrote are ever removed or
// changed (we remember them), and a pattern the author already mapped to another editor is left as the author set it.
import * as vscode from 'vscode';

export const OPEN_BY_DEFAULT = 'openByDefault';
const SECTION = 'pagemdEditor';

/** What the pure merge did, for the message and the tests. */
export interface MergeResult {
  /** The new `workbench.editorAssociations` value, or undefined when nothing changes. */
  value: unknown;
  /** The patterns now mapped to our editor by us (remembered for the next run). */
  written: string[];
  /** Wanted patterns the author had already mapped to another editor (left alone). */
  skipped: string[];
}

type ObjectForm = Record<string, string>;
type ArrayForm = { viewType: string; filenamePattern?: string; [key: string]: unknown }[];

/**
 * `current` (VS Code's `workbench.editorAssociations`: an object `{ pattern: viewType }`, or the older array of
 * `{ viewType, filenamePattern }`) with our patterns in: `wanted` are mapped to `viewType`; those in `previous` (written by
 * us before) that are no longer wanted are taken out again, when they still map to `viewType`.
 */
export function mergeAssociations(current: unknown, wanted: readonly string[], previous: readonly string[], viewType: string): MergeResult {
  const array = Array.isArray(current);
  const entries: [string, string][] = array
    ? (current as ArrayForm).flatMap((e) => (typeof e?.filenamePattern === 'string' && typeof e.viewType === 'string' ? [[e.filenamePattern, e.viewType] as [string, string]] : []))
    : Object.entries((current && typeof current === 'object' ? current : {}) as ObjectForm);
  const map = new Map(entries);
  const written: string[] = [];
  const skipped: string[] = [];
  let changed = false;
  for (const pattern of previous) {
    if (!wanted.includes(pattern) && map.get(pattern) === viewType) {
      map.delete(pattern);
      changed = true;
    }
  }
  for (const pattern of wanted) {
    const has = map.get(pattern);
    if (has === undefined) {
      map.set(pattern, viewType);
      changed = true;
      written.push(pattern);
    } else if (has === viewType) written.push(pattern);
    else skipped.push(pattern);
  }
  if (!changed) return { value: undefined, written, skipped };
  if (array) {
    // Entries we can't read (another shape) stay; ours are added or dropped.
    const kept = (current as ArrayForm).filter((e) => !(typeof e?.filenamePattern === 'string' && e.viewType === viewType && !map.has(e.filenamePattern)));
    const have = new Set(kept.flatMap((e) => (typeof e?.filenamePattern === 'string' ? [e.filenamePattern] : [])));
    for (const [pattern, view] of map) if (!have.has(pattern)) kept.push({ viewType: view, filenamePattern: pattern });
    return { value: kept, written, skipped };
  }
  return { value: Object.fromEntries(map), written, skipped };
}

const patternsOf = (value: unknown): string[] => (Array.isArray(value) ? value.filter((p): p is string => typeof p === 'string' && p.trim() !== '').map((p) => p.trim()) : []);

/**
 * Brings `workbench.editorAssociations` in line with the setting, once per scope (user, workspace). Safe to run any time:
 * it changes nothing when they already agree.
 */
export async function syncDefaultEditors(context: { globalState: vscode.Memento; workspaceState: vscode.Memento }, viewType: string, log: (line: string) => void): Promise<void> {
  const setting = vscode.workspace.getConfiguration(SECTION).inspect<string[]>(OPEN_BY_DEFAULT);
  const workbench = vscode.workspace.getConfiguration('workbench');
  const inspected = workbench.inspect<unknown>('editorAssociations');
  const scopes: { target: vscode.ConfigurationTarget; wanted: string[]; current: unknown; memory: vscode.Memento; key: string }[] = [
    { target: vscode.ConfigurationTarget.Global, wanted: patternsOf(setting?.globalValue), current: inspected?.globalValue, memory: context.globalState, key: 'pagemd.defaultEditor.written' },
  ];
  if ((vscode.workspace.workspaceFolders?.length ?? 0) > 0) {
    scopes.push({ target: vscode.ConfigurationTarget.Workspace, wanted: patternsOf(setting?.workspaceValue), current: inspected?.workspaceValue, memory: context.workspaceState, key: 'pagemd.defaultEditor.written' });
  }
  for (const scope of scopes) {
    const previous = scope.memory.get<string[]>(scope.key, []);
    if (scope.wanted.length === 0 && previous.length === 0) continue;
    const merged = mergeAssociations(scope.current, scope.wanted, previous, viewType);
    try {
      if (merged.value !== undefined) await workbench.update('editorAssociations', merged.value, scope.target);
      await scope.memory.update(scope.key, merged.written);
    } catch (error) {
      log(`Could not update workbench.editorAssociations: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (merged.skipped.length > 0) {
      const message = `pagemd Editor: ${merged.skipped.map((p) => `"${p}"`).join(', ')} already open${merged.skipped.length === 1 ? 's' : ''} in another editor (workbench.editorAssociations); left as you set it.`;
      log(message);
      void vscode.window.showInformationMessage(message);
    }
  }
}

/** Watches the setting; runs the sync now and on every change. */
export function watchDefaultEditors(context: vscode.ExtensionContext, viewType: string, log: (line: string) => void): vscode.Disposable {
  void syncDefaultEditors(context, viewType, log);
  return vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration(`${SECTION}.${OPEN_BY_DEFAULT}`)) void syncDefaultEditors(context, viewType, log);
  });
}

/** The file of the active tab when it is a markdown file in a text editor (or in this editor already), else undefined. */
function activeMarkdown(): { uri: vscode.Uri; tab: vscode.Tab | undefined } | undefined {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  const input = tab?.input;
  if (input instanceof vscode.TabInputText && /\.(md|markdown)$/i.test(input.uri.path)) return { uri: input.uri, tab };
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.languageId === 'markdown') return { uri: editor.document.uri, tab: undefined };
  return undefined;
}

/** "pagemd: Reopen with pagemd Editor": the active markdown file, in the pagemd editor, in place of the text editor tab. */
export async function reopenWithPagemd(viewType: string): Promise<void> {
  const found = activeMarkdown();
  if (!found) {
    void vscode.window.showInformationMessage('pagemd Editor: open a markdown file in the text editor first.');
    return;
  }
  await vscode.commands.executeCommand('vscode.openWith', found.uri, viewType, found.tab?.group.viewColumn);
  // The text editor's tab for the same file goes (a "reopen", not a second copy). Unsaved changes are not lost: both editors
  // show the one document VS Code holds.
  if (found.tab) await vscode.window.tabGroups.close(found.tab);
}
