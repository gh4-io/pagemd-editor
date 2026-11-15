// The Monaco script with VS Code's own services (experiment, code engines): `@codingame/monaco-vscode-api` brings VS Code's TextMate
// grammars (the same markdown colouring as VS Code), its theme service and its keybindings and settings services to Monaco. Built as
// one self-contained script (`dist/webview/monaco/monaco-vscode.js`, no chunks: the page's policy only lets the nonce'd script run);
// its own files (the grammar engine's wasm, the markdown grammar, the default themes) are fetched from next to it, which is what
// `import.meta.url` is defined as at build time (`globalThis.__pmdMonacoBase`, set by the view before it adds the script).
// No web workers: Monaco and the grammar service fall back to the page's own thread.
import { initialize } from '@codingame/monaco-vscode-api/services';
import getTextMateServiceOverride from '@codingame/monaco-vscode-textmate-service-override';
import getThemeServiceOverride from '@codingame/monaco-vscode-theme-service-override';
import getLanguagesServiceOverride from '@codingame/monaco-vscode-languages-service-override';
import getConfigurationServiceOverride, { updateUserConfiguration } from '@codingame/monaco-vscode-configuration-service-override';
import getKeybindingsServiceOverride from '@codingame/monaco-vscode-keybindings-service-override';
import getEditorServiceOverride from '@codingame/monaco-vscode-editor-service-override';
import { ExtensionHostKind, registerExtension } from '@codingame/monaco-vscode-api/extensions';
import '@codingame/monaco-vscode-theme-defaults-default-extension';
import '@codingame/monaco-vscode-markdown-basics-default-extension';
import * as monaco from '@codingame/monaco-vscode-editor-api';

// VS Code's own defaults, used when the user's theme could not be found.
const DEFAULTS = { light: 'Default Light Modern', dark: 'Default Dark Modern', 'hc-light': 'Default High Contrast Light', 'hc-dark': 'Default High Contrast' } as const;
type Kind = keyof typeof DEFAULTS;
interface Theme {
  id: string;
  uiTheme: 'vs' | 'vs-dark' | 'hc-black' | 'hc-light';
  json: string;
  tokenColorCustomizations: unknown;
  colorCustomizations: unknown;
}
/** Theme files made from the host's text, read back by the view's `fetch` (see index.ts). */
const themeFiles = ((globalThis as unknown as { __pmdThemeFiles?: Map<string, string> }).__pmdThemeFiles ??= new Map<string, string>());
let counter = 0;

const ready = (async () => {
  await initialize({
    ...getTextMateServiceOverride(),
    ...getThemeServiceOverride(),
    ...getLanguagesServiceOverride(),
    ...getConfigurationServiceOverride(),
    ...getKeybindingsServiceOverride(),
    ...getEditorServiceOverride(() => Promise.resolve(undefined)),
  }, undefined, {
    // Tokenise on the page's own thread: no web worker (and no worker rule in the page's policy).
    configurationDefaults: { 'editor.experimental.asyncTokenization': false, 'workbench.colorTheme': DEFAULTS.dark },
  });
  const api = monaco as typeof monaco & { __pmd?: { applyTheme(theme: Theme | null, kind: Kind): void } };
  api.__pmd = {
    /** The user's theme, registered as a small extension whose theme file is the host's text; without one, VS Code's default of the same kind. */
    applyTheme(theme, kind) {
      if (!theme) return void updateUserConfiguration(JSON.stringify({ 'workbench.colorTheme': DEFAULTS[kind] }));
      const id = `pmd-theme-${++counter}`;
      const url = `https://pmd.theme/${id}.json`;
      themeFiles.set(url, theme.json);
      const extension = registerExtension(
        { name: id, publisher: 'pagemd', version: '1.0.0', engines: { vscode: '*' }, contributes: { themes: [{ id, label: id, uiTheme: theme.uiTheme, path: './theme.json' }] } },
        ExtensionHostKind.LocalProcess,
        { system: true },
      );
      extension.registerFileUrl('theme.json', url, { mimeType: 'application/json', size: theme.json.length });
      void extension.whenReady().then(() =>
        updateUserConfiguration(JSON.stringify({ 'workbench.colorTheme': id, 'editor.tokenColorCustomizations': theme.tokenColorCustomizations, 'workbench.colorCustomizations': theme.colorCustomizations })),
      );
    },
  };
  return api;
})();

(globalThis as unknown as { __pmdMonacoReady: Promise<typeof monaco> }).__pmdMonacoReady = ready;
