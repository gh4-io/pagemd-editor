import type { Node, Slice } from 'prosemirror-model';
import type { Plugin } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { createEditor } from '@pagemd-editor/core';
import { commonmarkPreset } from '@pagemd-editor/preset-commonmark';
import { createTransformer } from '@pagemd-editor/transformer';
import { clipboardPlugin } from '../src/index.ts';

type ClipboardProps = Plugin & {
  props: { clipboardTextSerializer?: (slice: Slice) => string; clipboardTextParser?: (text: string) => Slice };
};

describe('@pagemd-editor/plugin-clipboard', () => {
  it('contributes exactly one ProseMirror plugin', async () => {
    const editor = await createEditor({ presets: [commonmarkPreset], plugins: [clipboardPlugin()] });
    expect(editor.pmPlugins.length).toBe(1);
  });

  it('serializes a copied slice back to markdown', async () => {
    const editor = await createEditor({ presets: [commonmarkPreset], plugins: [clipboardPlugin()] });
    const transformer = createTransformer(editor.registry.items(), { schema: editor.schema });
    const doc: Node = transformer.parse('# Title\n\nSome **bold** text.');
    const slice = doc.slice(0, doc.content.size);
    const plugin = editor.pmPlugins[0] as ClipboardProps;
    expect(plugin.props.clipboardTextSerializer!(slice)).toBe('# Title\n\nSome **bold** text.');
  });

  it('parses pasted plain text as markdown', async () => {
    const editor = await createEditor({ presets: [commonmarkPreset], plugins: [clipboardPlugin()] });
    const plugin = editor.pmPlugins[0] as ClipboardProps;
    const slice = plugin.props.clipboardTextParser!('## Heading');
    expect(slice.content.childCount).toBe(1);
    expect(slice.content.firstChild!.type.name).toBe('heading');
  });
});
