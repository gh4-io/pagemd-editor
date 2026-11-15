// Commands (ADR-0013 decision 4): what the ribbon, slash menu, toolbar and keybindings run.
// Modelled on @lumino/commands (label, icon, enabled, keybinding) without its DOM dependencies (ADR-0012).
import type { EditorState, Transaction } from 'prosemirror-state';

export type Dispatch = (tr: Transaction) => void;

export interface CommandSpec {
  id: string;
  label: string;
  icon?: string;
  /** ProseMirror key notation, e.g. 'Mod-b' or 'Mod-Shift-x' ('Mod' is Ctrl, or Cmd on a Mac). */
  keybinding?: string;
  /** P27: more words for the tooltip, after the label (the Redact note, R-251). Optional. */
  description?: string;
  /** Show on the floating selection toolbar. */
  toolbar?: boolean;
  /**
   * 'edit' (default) changes the document and needs an editable canvas; 'view' changes how the document is shown
   * (P7, R-156): it never edits, so it also works in Read. A view command's `run` ignores the editor state.
   */
  kind?: 'edit' | 'view';
  /**
   * Whether the slash menu lists this command (P7, R-156). Default: yes when the command's item has slash
   * keywords. `true` lists a command whose item has none; `false` keeps it off the slash menu.
   */
  slash?: boolean;
  /** Search words for this command alone. When present they are used instead of its item's slash keywords. */
  keywords?: readonly string[];
  isEnabled(state: EditorState): boolean;
  isActive?(state: EditorState): boolean;
  /**
   * Why the command is off here, in plain words, or null (P19 round 3, ADR-0013 amendment: optional). Asked only when
   * `isEnabled` is false; the ribbon adds it to the button's tooltip.
   */
  reason?(state: EditorState): string | null;
  run(state: EditorState, dispatch: Dispatch, args?: unknown): boolean;
}

/** Every command the items declare, by id. Two commands with the same id are an error. */
export class CommandRegistry {
  readonly #commands = new Map<string, CommandSpec>();

  constructor(commands: Iterable<CommandSpec> = []) {
    for (const command of commands) this.add(command);
  }

  add(command: CommandSpec): void {
    if (this.#commands.has(command.id)) throw new Error(`Two commands share the id '${command.id}'.`);
    this.#commands.set(command.id, command);
  }

  list(): CommandSpec[] {
    return [...this.#commands.values()];
  }

  get(id: string): CommandSpec | undefined {
    return this.#commands.get(id);
  }

  /** Runs the command if it exists and is enabled; returns whether it ran. */
  run(id: string, state: EditorState, dispatch: Dispatch, args?: unknown): boolean {
    const command = this.#commands.get(id);
    if (!command || !command.isEnabled(state)) return false;
    return command.run(state, dispatch, args);
  }

  isEnabled(id: string, state: EditorState): boolean {
    return this.#commands.get(id)?.isEnabled(state) ?? false;
  }

  isActive(id: string, state: EditorState): boolean {
    return this.#commands.get(id)?.isActive?.(state) ?? false;
  }

  label(id: string): string | undefined {
    return this.#commands.get(id)?.label;
  }

  icon(id: string): string | undefined {
    return this.#commands.get(id)?.icon;
  }

  keybinding(id: string): string | undefined {
    return this.#commands.get(id)?.keybinding;
  }
}
