import { readFileSync } from 'node:fs';
import { Schema } from 'prosemirror-model';
import { EditorState, type Plugin } from 'prosemirror-state';
import { describe, expect, it, vi } from 'vitest';
import { createEditor } from '@pagemd-editor/core';
import { commonmarkPreset } from '@pagemd-editor/preset-commonmark';
import { historyKeymap, historyPlugin } from '../src/index.ts';

const schema = new Schema({ nodes: { doc: { content: 'text*' }, text: {} } });

/** Fires a keymap plugin's handleKeyDown as prosemirror-view would (its `this` is the plugin's props, and it
 *  reads `view.state`/`view.dispatch`, neither of which our callbacks touch). No DOM available in this
 *  package's test project (tsconfig.node.json), so a `KeyboardEvent`-shaped plain object stands in. */
function press(plugin: Plugin, key: string, mods: { ctrl?: boolean; shift?: boolean }): boolean {
  const view = { state: EditorState.create({ schema, plugins: [plugin] }), dispatch: () => undefined };
  const event = { key, ctrlKey: mods.ctrl ?? false, metaKey: false, shiftKey: mods.shift ?? false, altKey: false, keyCode: 0 };
  return plugin.props.handleKeyDown!.call(plugin, view as never, event as never) ?? false;
}

describe('@pagemd-editor/plugin-history', () => {
  it('contributes exactly one ProseMirror plugin (never a second, prosemirror-history-based undo list)', async () => {
    const editor = await createEditor({
      presets: [commonmarkPreset],
      plugins: [historyPlugin({ isPending: () => false, flushThenRun: () => undefined })],
    });
    expect(editor.pmPlugins.length).toBe(1);
    // Guard against ever depending on prosemirror-history (that would be a second undo list, R-94).
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string> };
    expect(pkg.dependencies['prosemirror-history']).toBeUndefined();
  });

  it('Mod-z flushes and asks for undo only while typing is pending', () => {
    const flushThenRun = vi.fn();
    const plugin = historyKeymap({ isPending: () => true, flushThenRun });
    expect(press(plugin, 'z', { ctrl: true })).toBe(true);
    expect(flushThenRun).toHaveBeenCalledWith('undo');
  });

  it('leaves the key alone (returns false) when nothing is pending, so VS Code handles it natively', () => {
    const flushThenRun = vi.fn();
    const plugin = historyKeymap({ isPending: () => false, flushThenRun });
    expect(press(plugin, 'z', { ctrl: true })).toBe(false);
    expect(flushThenRun).not.toHaveBeenCalled();
  });

  it('Mod-y and Mod-Shift-z both ask for redo', () => {
    const flushThenRun = vi.fn();
    const plugin = historyKeymap({ isPending: () => true, flushThenRun });
    expect(press(plugin, 'y', { ctrl: true })).toBe(true);
    expect(press(plugin, 'z', { ctrl: true, shift: true })).toBe(true);
    expect(flushThenRun).toHaveBeenNthCalledWith(1, 'redo');
    expect(flushThenRun).toHaveBeenNthCalledWith(2, 'redo');
  });
});
