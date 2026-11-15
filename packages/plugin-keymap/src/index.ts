// @pagemd-editor/plugin-keymap: the keys behind the shortcut hints (P7, R-157). Every command that declares a
// `keybinding` (ProseMirror notation, e.g. 'Mod-Alt-b') runs when its key is pressed in an editable canvas, through the
// SAME runner as the ribbon, slash menu and toolbar (and the key does not travel on to VS Code, R-158): a shortcut for a gated insert asks, warns or adds the property
// exactly as a button does (no gate bypass). Commands are read when a key is pressed, so a plugin that adds commands
// later is included.
import { keydownHandler } from 'prosemirror-keymap';
import { Plugin } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import type { Action, ActionContext, Registry } from '@pagemd-editor/core';

type KeyHandler = (view: EditorView, event: KeyboardEvent) => boolean;

export interface KeymapOptions {
  registry: Pick<Registry, 'commands' | 'action'>;
  /** Runs an action: the app's action runner. */
  run(action: Action): void | Promise<void>;
  /** The editor's state for the action's enabled flag and gate values. */
  context(): ActionContext | undefined;
}

/** The keymap as a ProseMirror plugin. `registry.commands` is read afresh whenever its size changes. */
export function commandKeymap(options: KeymapOptions): Plugin {
  const { registry } = options;
  let count = -1;
  let handler: KeyHandler = () => false;
  const rebuild = (): void => {
    const commands = registry.commands.list();
    count = commands.length;
    const bindings: Record<string, (state: never, dispatch: never, view?: EditorView) => boolean> = {};
    for (const command of commands) {
      if (!command.keybinding || command.kind === 'view') continue;
      bindings[command.keybinding] = (_state, _dispatch, view) => {
        if (!view?.editable) return false;
        const action = registry.action(command.id, options.context());
        // Word-style keys win in the document (R-158): the key is ours even where the command can't run (bold in a code
        // block does nothing), so it never turns into a VS Code command (Ctrl+B hiding the sidebar) by surprise.
        if (action?.enabled) void options.run(action);
        return true;
      };
    }
    handler = keydownHandler(bindings as never);
  };
  return new Plugin({
    props: {
      handleKeyDown(view, event) {
        if (registry.commands.list().length !== count) rebuild();
        const handled = handler(view, event);
        // VS Code's webview forwards every key that reaches the page's window to the workbench, whatever preventDefault
        // said (pre/index.html: a bubble `keydown` listener with no defaultPrevented check). Stopping the event here is
        // what keeps a key we handled (Ctrl+B, the Ctrl+K chord prefix) from also running a VS Code command (R-158).
        if (handled) event.stopPropagation();
        return handled;
      },
    },
  });
}
