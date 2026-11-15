import { describe, expect, it } from 'vitest';
import { createEditor } from '@pagemd-editor/core';
import { commonmarkPreset } from '@pagemd-editor/preset-commonmark';
import { inputRulesPlugin } from '../src/index.ts';

describe('@pagemd-editor/plugin-input-rules', () => {
  it('contributes exactly one ProseMirror plugin, built from the items that declare inputRules', async () => {
    const editor = await createEditor({ presets: [commonmarkPreset], plugins: [inputRulesPlugin] });
    expect(editor.pmPlugins.length).toBe(1);
  });

  it('an item with no inputRules contributes nothing (no crash on an empty rule set)', async () => {
    const editor = await createEditor({ presets: [{ id: 'empty', items: [] }], plugins: [inputRulesPlugin] });
    expect(editor.pmPlugins.length).toBe(1); // still one plugin, just with zero rules inside
  });
});
