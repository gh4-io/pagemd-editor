// Gated inserts, host side (P7, ADR-0016 M3, R-154): the `pagemdEditor.gatedInsert` setting and the prompt. The
// webview decides WHEN (the action runner) and, since P8, adds the property itself in the insert's own edit (one undo
// step, R-161); the host owns what VS Code owns: settings and the modal prompt.
import * as vscode from 'vscode';
import { userInfo } from 'node:os';
import type { GateChoice, GatedInsertMode } from '@pagemd-editor/core';
import type { CodeEngine, FigureStyle, SettingsPayload } from '../../shared/protocol.ts';

const SECTION = 'pagemdEditor';
const KEY = 'gatedInsert';

/** The setting, falling back to `ask` for a missing or unknown value. */
export function readGatedInsert(): GatedInsertMode {
  const value = vscode.workspace.getConfiguration(SECTION).get<string>(KEY);
  return value === 'auto' || value === 'warn' ? value : 'ask';
}

/** The name review comments carry (P12, R-180): the setting `pagemdEditor.commentAuthor`, else the computer's user name. */
export function readCommentAuthor(): string {
  const set = vscode.workspace.getConfiguration(SECTION).get<string>('commentAuthor');
  if (typeof set === 'string' && set.trim() !== '') return set.trim();
  try {
    return userInfo().username || 'Author';
  } catch {
    return 'Author';
  }
}

/** `pagemdEditor.figureStyle` (R-254): how a new figure is written. Missing or unknown: readable. */
export function readFigureStyle(): FigureStyle {
  const value = vscode.workspace.getConfiguration(SECTION).get<string>('figureStyle');
  return value === 'native' || value === 'legacy' ? value : 'readable';
}

/** `pagemdEditor.nativeSplit`: Split uses VS Code's own text editor beside the canvas. Off unless set to true (the user wants the split inside one tab). */
export const readNativeSplit = (): boolean => vscode.workspace.getConfiguration(SECTION).get<boolean>('nativeSplit') === true;

/** `pagemdEditor.codeEngine`: monaco-vscode unless set to codemirror. */
export function readCodeEngine(): CodeEngine {
  return vscode.workspace.getConfiguration(SECTION).get<string>('codeEngine') === 'codemirror' ? 'codemirror' : 'monaco-vscode';
}

/** The `editor.*` settings the Monaco views follow, for markdown (the language's own overrides included); only the keys that have a value. */
const EDITOR_KEYS = [
  'fontFamily', 'fontSize', 'fontWeight', 'fontLigatures', 'lineHeight', 'letterSpacing', 'wordWrap', 'tabSize', 'insertSpaces', 'cursorStyle',
  'cursorBlinking', 'cursorWidth', 'lineNumbers', 'renderWhitespace', 'renderLineHighlight', 'minimap.enabled', 'minimap.side', 'folding',
  'bracketPairColorization.enabled', 'rulers', 'smoothScrolling', 'scrollBeyondLastLine', 'glyphMargin', 'stickyScroll.enabled', 'guides.indentation',
  'multiCursorModifier', 'selectionHighlight', 'occurrencesHighlight', 'matchBrackets', 'renderControlCharacters', 'wordWrapColumn',
] as const;
export function readEditorOptions(): Record<string, unknown> {
  const config = vscode.workspace.getConfiguration('editor', { languageId: 'markdown' } as never);
  const out: Record<string, unknown> = {};
  for (const key of EDITOR_KEYS) {
    const value = config.get(key);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export const readSettings = (): SettingsPayload => ({
  gatedInsert: readGatedInsert(),
  commentAuthor: readCommentAuthor(),
  figureStyle: readFigureStyle(),
  nativeSplit: readNativeSplit(),
  codeEngine: readCodeEngine(),
  editorOptions: readEditorOptions(),
});

/** The most specific scope that sets the setting now (folder, then workspace), else the user's. */
export function settingTarget(inspected: { workspaceFolderValue?: unknown; workspaceValue?: unknown } | undefined): vscode.ConfigurationTarget {
  if (inspected?.workspaceFolderValue !== undefined) return vscode.ConfigurationTarget.WorkspaceFolder;
  if (inspected?.workspaceValue !== undefined) return vscode.ConfigurationTarget.Workspace;
  return vscode.ConfigurationTarget.Global;
}

/** True when a configuration change touches the settings the webview shows. */
export const affectsSettings = (event: vscode.ConfigurationChangeEvent): boolean =>
  event.affectsConfiguration(`${SECTION}.${KEY}`) || event.affectsConfiguration(`${SECTION}.commentAuthor`) || event.affectsConfiguration(`${SECTION}.figureStyle`) || event.affectsConfiguration(`${SECTION}.nativeSplit`) || event.affectsConfiguration(`${SECTION}.codeEngine`) || event.affectsConfiguration('editor');

/**
 * The prompt for `ask` mode. "Add <field>" and "Insert Anyway" are this once; "Don't Ask Again" switches the setting
 * to `auto` (so later gated inserts add the property without asking) and also adds it this time (R-154). Dismissing the
 * prompt cancels the insert.
 */
export async function confirmGatedInsert(info: { label: string; field: string; value: unknown }): Promise<GateChoice> {
  const add = `Add ${info.field}`;
  const insert = 'Insert Anyway';
  const never = "Don't Ask Again";
  const picked = await vscode.window.showWarningMessage(
    `"${info.label}" needs ${info.field}: ${String(info.value)} in this document's frontmatter.`,
    { modal: true, detail: `Without it the item may not print as intended. "${add}" puts it in the frontmatter; "${insert}" leaves the frontmatter alone. You can change this in the pagemdEditor.gatedInsert setting.` },
    add,
    insert,
    never,
  );
  if (picked === add) return 'add';
  if (picked === insert) return 'insert';
  if (picked === never) {
    // Written where the value in force comes from: a workspace's own `ask` would otherwise still win over a user value.
    const config = vscode.workspace.getConfiguration(SECTION);
    await config.update(KEY, 'auto', settingTarget(config.inspect<string>(KEY)));
    return 'add';
  }
  return 'cancel';
}
