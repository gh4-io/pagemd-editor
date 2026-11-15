// @pagemd-editor/plugin-history: answers VS Code's undo/redo (layered-architecture.md §3, P3).
// OQ-23 (R-94): VS Code's undo list is the only one. This package does NOT add prosemirror-history's own undo
// list; it formalizes what P2 built inline in apps/vscode/webview/main.ts — while typing hasn't been sent yet,
// Ctrl+Z/Y must flush it first (VS Code would otherwise skip a save/undo on a file it doesn't yet know is
// dirty, R-91 addition 1) and then ask the host to run its own command. When nothing is pending, the binding
// returns `false` (not handled) so the keypress is left alone and VS Code's native keybinding handles it
// directly, exactly as before.
import { keymap } from 'prosemirror-keymap';
import { Plugin } from 'prosemirror-state';
import type { EditorPlugin } from '@pagemd-editor/core';

export interface HistoryCallbacks {
  /** True while there is typing the host doesn't have yet. */
  isPending(): boolean;
  /** Sends the pending typing, then asks the host to run `command`. Only called while `isPending()` was true. */
  flushThenRun(command: 'undo' | 'redo'): void;
}

function bind(command: 'undo' | 'redo', callbacks: HistoryCallbacks) {
  return (): boolean => {
    if (!callbacks.isPending()) return false;
    callbacks.flushThenRun(command);
    return true;
  };
}

/** The keymap alone, for a host that wants to wire it in without the Lumino plugin wrapper (e.g. a test). */
export function historyKeymap(callbacks: HistoryCallbacks): Plugin {
  return keymap({
    'Mod-z': bind('undo', callbacks),
    'Mod-y': bind('redo', callbacks),
    'Mod-Shift-z': bind('redo', callbacks),
  });
}

/** As an editor plugin: contributes the keymap to `pmPlugins`. `callbacks` come from the host app. */
export function historyPlugin(callbacks: HistoryCallbacks): EditorPlugin<void> {
  return {
    id: '@pagemd-editor/plugin-history:main',
    autoStart: true,
    activate: (app) => {
      app.pmPlugins.push(historyKeymap(callbacks));
    },
  };
}
