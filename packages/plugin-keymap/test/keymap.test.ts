// The shortcut keymap (P7, R-157): every command that declares a keybinding runs on its key, through the same runner as
// the buttons (so the gate applies), and only in an editable canvas.
import { Schema } from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { describe, expect, it, vi } from 'vitest';
import { CommandRegistry, type Action, type CommandSpec } from '@pagemd-editor/core';
import { commandKeymap } from '../src/index.ts';

const schema = new Schema({ nodes: { doc: { content: 'paragraph+' }, paragraph: { content: 'text*', toDOM: () => ['p', 0] }, text: {} } });
const command = (id: string, extra: Partial<CommandSpec> = {}): CommandSpec => ({ id, label: id, isEnabled: () => true, run: () => true, ...extra });
const key = (init: Partial<KeyboardEvent> & { key: string }) => ({ stopPropagation: vi.fn(), ...init }) as unknown as KeyboardEvent;
const ctrl = (k: string, extra: Partial<KeyboardEvent> = {}) => key({ key: k, ctrlKey: true, ...extra });

function setup(commands: CommandSpec[], editable = true, gate?: Action['gate']) {
  const list = new CommandRegistry(commands);
  const registry = {
    commands: list,
    action: (id: string): Action | undefined => {
      const c = list.get(id);
      return c && { id, kind: c.kind ?? 'edit', label: c.label, keywords: [], toggle: false, enabled: c.isEnabled(null as never), active: false, ...(gate ? { gate } : {}) };
    },
  };
  const run = vi.fn();
  const plugin = commandKeymap({ registry, run, context: () => undefined });
  const view = { editable, state: EditorState.create({ schema }), dispatch: vi.fn() } as unknown as EditorView;
  const press = (event: KeyboardEvent): boolean => plugin.props.handleKeyDown!.call(plugin, view, event) === true;
  return { list, run, press };
}

describe('commandKeymap', () => {
  it('hands the action for the command bound to the key to the runner, and says it handled it', () => {
    const { press, run } = setup([command('strong.toggle', { keybinding: 'Mod-Alt-d' })]);
    expect(press(ctrl('d', { altKey: true }))).toBe(true);
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]![0]).toMatchObject({ id: 'strong.toggle' });
  });
  it('never runs the command itself: a gated action reaches the runner with its gate, so a shortcut cannot skip it', () => {
    const own = vi.fn(() => true);
    const { press, run } = setup([command('fancy.lower', { keybinding: 'Mod-Alt-l', run: own })], true, { field: 'fancy_lists', value: true, satisfied: false });
    expect(press(ctrl('l', { altKey: true }))).toBe(true);
    expect(own).not.toHaveBeenCalled();
    expect(run.mock.calls[0]![0].gate).toEqual({ field: 'fancy_lists', value: true, satisfied: false });
  });
  it('ignores other keys, and commands without a keybinding', () => {
    const { press, run } = setup([command('a', { keybinding: 'Mod-Alt-d' }), command('b')]);
    expect(press(ctrl('i'))).toBe(false);
    expect(press(key({ key: 'd' }))).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
  it('keeps the key from reaching VS Code (stopPropagation) when it handles it, and only then (R-158)', () => {
    const { press } = setup([command('a', { keybinding: 'Mod-b' })]);
    const mine = ctrl('b');
    expect(press(mine)).toBe(true);
    expect(mine.stopPropagation).toHaveBeenCalledOnce();
    const other = ctrl('p');
    expect(press(other)).toBe(false);
    expect(other.stopPropagation).not.toHaveBeenCalled();
  });
  it('a disabled command still owns its key (bold in a code block does nothing; it does not toggle the sidebar)', () => {
    const { press, run } = setup([command('a', { keybinding: 'Mod-b', isEnabled: () => false })]);
    const event = ctrl('b');
    expect(press(event)).toBe(true);
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
  });
  it('does nothing in a read-only canvas, and skips view commands', () => {
    const readOnly = ctrl('d', { altKey: true });
    expect(setup([command('a', { keybinding: 'Mod-Alt-d' })], false).press(readOnly)).toBe(false);
    expect(readOnly.stopPropagation).not.toHaveBeenCalled(); // in Read, VS Code's own key works
    expect(setup([command('v', { keybinding: 'Mod-Alt-d', kind: 'view' })]).press(ctrl('d', { altKey: true }))).toBe(false);
  });
  it('picks up commands added after start-up, and knows Shift', () => {
    const { list, press, run } = setup([]);
    expect(press(ctrl('x', { shiftKey: true }))).toBe(false);
    list.add(command('late', { keybinding: 'Mod-Shift-x' }));
    expect(press(ctrl('x', { shiftKey: true }))).toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });
});
