// The user's colour theme for the Code view (Monaco with VS Code's services): the active theme's file, found among the installed and
// built-in extensions' contributions, with its `include` chain flattened, plus the user's own colour and token-colour customizations.
// The Code view registers it with Monaco, so the markdown is coloured with the theme the user chose, not a default.
import * as vscode from 'vscode';
import type { CodeThemePayload } from '../../shared/protocol.ts';

/** A theme file is JSON with comments and trailing commas: both removed outside strings. */
export function parseJsonc(text: string): unknown {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

interface ThemeFile {
  include?: string;
  colors?: Record<string, unknown>;
  tokenColors?: unknown;
  semanticTokenColors?: Record<string, unknown>;
  [key: string]: unknown;
}

/** The theme file with the files it `include`s merged in (the included first, so the including file wins). A tokenColors path (a .tmTheme) is not followed. */
export async function flattenTheme(file: vscode.Uri, depth = 0): Promise<ThemeFile> {
  const json = parseJsonc(Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8')) as ThemeFile;
  if (!json.include || depth > 5) return json;
  const base = await flattenTheme(vscode.Uri.joinPath(file, '..', json.include), depth + 1);
  const { include: _include, ...own } = json;
  return {
    ...base,
    ...own,
    colors: { ...base.colors, ...own.colors },
    tokenColors: [...(Array.isArray(base.tokenColors) ? base.tokenColors : []), ...(Array.isArray(own.tokenColors) ? own.tokenColors : [])],
    semanticTokenColors: { ...base.semanticTokenColors, ...own.semanticTokenColors },
  };
}

const UI = { 'vs': 'vs', 'vs-dark': 'vs-dark', 'hc-black': 'hc-black', 'hc-light': 'hc-light' } as const;

/** The active theme as the Code view takes it; null when the theme cannot be found (the view then uses its default of the same kind). */
export async function readCodeTheme(): Promise<CodeThemePayload | null> {
  const name = vscode.workspace.getConfiguration('workbench').get<string>('colorTheme');
  if (!name) return null;
  for (const extension of vscode.extensions.all) {
    const themes = (extension.packageJSON as { contributes?: { themes?: { id?: string; label?: string; uiTheme?: string; path?: string }[] } }).contributes?.themes ?? [];
    const found = themes.find((t) => t.path && (t.label === name || t.id === name));
    if (!found?.path) continue;
    try {
      const file = await flattenTheme(vscode.Uri.joinPath(extension.extensionUri, found.path));
      return {
        id: found.id ?? found.label ?? name,
        uiTheme: UI[found.uiTheme as keyof typeof UI] ?? 'vs-dark',
        json: JSON.stringify(file),
        tokenColorCustomizations: vscode.workspace.getConfiguration('editor').get('tokenColorCustomizations') ?? {},
        colorCustomizations: vscode.workspace.getConfiguration('workbench').get('colorCustomizations') ?? {},
      };
    } catch {
      return null;
    }
  }
  return null;
}

/** True when a configuration change can change the Code view's theme. */
export const affectsCodeTheme = (event: vscode.ConfigurationChangeEvent): boolean =>
  event.affectsConfiguration('workbench.colorTheme') || event.affectsConfiguration('workbench.colorCustomizations') || event.affectsConfiguration('editor.tokenColorCustomizations');
