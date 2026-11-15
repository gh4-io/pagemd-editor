// Actions (P7, ADR-0013 amendment, R-156): what the ribbon, slash menu and selection toolbar draw. The registry
// turns its commands into `Action`s for one surface; components never see a CommandSpec's code, only an Action
// (label, icon, keywords, enabled, active) and hand it back to the runner (runner.ts) to be run.
import type { EditorState } from 'prosemirror-state';
import type { CommandSpec } from './commands.ts';

export type Surface = 'ribbon' | 'slash' | 'toolbar';

/** `pagemdEditor.gatedInsert` (ADR-0016 M3): what happens when an item whose gate is off is inserted. */
export type GatedInsertMode = 'ask' | 'auto' | 'warn';

/** What an action's enabled/active state depends on. The app builds it fresh for each query. */
export interface ActionContext {
  state: EditorState;
  /** False in Read: edit commands are then disabled. View commands stay enabled. */
  editable: boolean;
  /** The document's gate values, e.g. `{ fancy_lists: false }` (from preset-pagemd's `gateFields`). */
  gates?: Readonly<Record<string, unknown>>;
}

export interface ActionQuery {
  surface: Surface;
  /** Ribbon only: the tab's id. Without it every tab's actions are listed, in layout order. */
  tab?: string;
  /** Without a context every action is enabled and none is active (a static listing). */
  context?: ActionContext;
  /** Slash only: the typed text; matches the label and the keywords, case-insensitively. */
  search?: string;
}

export interface Action {
  id: string;
  kind: 'edit' | 'view';
  label: string;
  icon?: string;
  /** ProseMirror key notation; `formatKeybinding` makes it readable. */
  keybinding?: string;
  /** P27: more words for the tooltip, after the label and the shortcut. */
  description?: string;
  keywords: readonly string[];
  /** Ribbon only: the group the layout file puts it in. */
  group?: { id: string; label: string };
  /** Present when the command's item is gated (e.g. fancy lists need `fancy_lists`); `satisfied` says if the gate is on. */
  gate?: { field: string; value: unknown; satisfied: boolean };
  /** True when the command can be on or off (it has `isActive`): a toggle shows pressed/not pressed, a one-shot button doesn't. */
  toggle: boolean;
  enabled: boolean;
  active: boolean;
  /** Why the action is off, in plain words, when its command says (P19 round 3: a table not in standard form). */
  reason?: string;
}

/** A command's static facts (everything except enabled/active/reason), cached per surface. */
export type ActionBase = Omit<Action, 'enabled' | 'active' | 'reason'>;

const MAC_SYMBOLS: Readonly<Record<string, string>> = { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧' };

/**
 * A readable shortcut for a ProseMirror key notation ("Mod-Shift-x" → "Ctrl+Shift+X", or "⇧⌘X" on a Mac).
 * The shortcut is shown on buttons as a hint; the keymap plugin is what makes the key work.
 */
export function formatKeybinding(binding: string, mac: boolean): string {
  const parts = binding.split(/-(?=.)/);
  const key = parts.pop() ?? '';
  const named = key.length === 1 ? key.toUpperCase() : key;
  const modifiers = parts.map((m) => (m === 'Meta' || m === 'Cmd' ? 'Mod' : m));
  if (mac) {
    const order = ['Ctrl', 'Alt', 'Shift', 'Mod'];
    const symbols = order.filter((m) => modifiers.includes(m)).map((m) => MAC_SYMBOLS[m]!);
    return `${symbols.join('')}${named}`;
  }
  const names = modifiers.map((m) => (m === 'Mod' ? 'Ctrl' : m));
  const order = ['Ctrl', 'Alt', 'Shift'];
  return [...order.filter((m) => names.includes(m)), named].join('+');
}

export function toAction(base: ActionBase, command: CommandSpec, context: ActionContext | undefined, gates?: Readonly<Record<string, unknown>>): Action {
  const gate = base.gate;
  const action: Action = {
    ...base,
    ...(gate ? { gate: { ...gate, satisfied: gates ? gateSatisfied(gates[gate.field], gate.value) : true } } : {}),
    enabled: true,
    active: false,
  };
  if (!context) return action;
  action.enabled = (command.kind !== 'view' ? context.editable : true) && command.isEnabled(context.state);
  action.active = command.isActive?.(context.state) ?? false;
  if (!action.enabled && command.reason) {
    const reason = command.reason(context.state);
    if (reason) action.reason = reason;
  }
  return action;
}

/** A gate is on when the document's value matches: `true` accepts any truthy value (pagemd's `Boolean(value)`). */
export function gateSatisfied(actual: unknown, wanted: unknown): boolean {
  return wanted === true ? Boolean(actual) : actual === wanted;
}
