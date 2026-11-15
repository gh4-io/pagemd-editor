// P11 image paste: the names, what is a picture, and what the paste and drop handlers do (R-174).
import { Schema } from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { describe, expect, it, vi } from 'vitest';
import { assetNameFor, imagePastePmPlugin, isImage, type ImagePasteOptions } from '../src/index.ts';

const schema = new Schema({ nodes: { doc: { content: 'block+' }, block: { content: 'text*', group: 'block', toDOM: () => ['p', 0] }, text: {} } });
const at = new Date(2026, 9, 5, 13, 4, 5);
const png = (name = 'image.png', type = 'image/png'): File => new File([new Uint8Array([1, 2, 3])], name, { type });

describe('names (R-174)', () => {
  it('a pasted picture is named by the time; a dropped file keeps its own name', () => {
    expect(assetNameFor(png('image.png'), 'paste', at)).toBe('image-20261005-130405.png');
    expect(assetNameFor(png(''), 'paste', at)).toBe('image-20261005-130405.png');
    expect(assetNameFor(png('Login screen.png'), 'drop', at)).toBe('Login screen.png');
    expect(assetNameFor(png('image.png'), 'drop', at)).toBe('image.png'); // a dropped file is what its owner named it
    expect(assetNameFor(png('shot.PNG'), 'paste', at)).toBe('shot.PNG'); // a real name from a copied file stays
  });
  it('a missing extension is added from the type; the type decides the extension of a nameless picture', () => {
    expect(assetNameFor(png('photo', 'image/jpeg'), 'drop', at)).toBe('photo.jpg');
    expect(assetNameFor(png('', 'image/svg+xml'), 'paste', at)).toBe('image-20261005-130405.svg');
  });
  it('takes pictures, not other files', () => {
    expect(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'IMAGE/PNG'].map((type) => isImage({ name: 'x', type }))).toEqual([true, true, true, true, true, true]);
    expect(['application/pdf', 'text/plain', 'image/tiff', ''].map((type) => isImage({ name: 'x', type }))).toEqual([false, false, false, false]);
  });
});

function setup(options: Partial<ImagePasteOptions> = {}, editable = true) {
  const written: { name: string; bytes: number }[] = [];
  let n = 0;
  const assets = {
    writeAsset: vi.fn(async (bytes: Uint8Array, name: string) => {
      written.push({ name, bytes: bytes.length });
      return `.pagemd/assets/img/${name.replace(/\.png$/, '')}-${++n}.png`;
    }),
  };
  const state = EditorState.create({ schema, doc: schema.node('doc', null, [schema.node('block', null, schema.text('hello'))]) });
  const dispatched: unknown[] = [];
  const view = { editable, state, dispatch: (tr: unknown) => dispatched.push(tr), posAtCoords: () => ({ pos: 3, inside: 1 }) } as unknown as EditorView;
  const insert = vi.fn((s: EditorState, sources: readonly string[]) => (sources.length > 0 ? s.tr.insertText(sources.join(',')) : null));
  const onInserted = vi.fn();
  const onProblem = vi.fn();
  const plugin = imagePastePmPlugin(assets, { insert, onInserted, onProblem, now: () => at, ...options });
  const paste = (files: File[], text = '') => plugin.props.handlePaste!.call(plugin, view, { clipboardData: { files, getData: () => text } } as never, null as never);
  const drop = (files: File[], at: 'inside' | 'margin' = 'inside') => {
    if (at === 'margin') (view as unknown as { posAtCoords: () => null }).posAtCoords = () => null;
    return (plugin.props.handleDOMEvents!.drop as (v: EditorView, e: DragEvent) => boolean)(view, { dataTransfer: { files }, clientX: 1, clientY: 2, preventDefault: vi.fn() } as never);
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
  return { assets, written, view, insert, onInserted, onProblem, dispatched, paste, drop, settle };
}

describe('paste', () => {
  it('writes the picture, then inserts one figure edit and tells the app', async () => {
    const s = setup();
    expect(s.paste([png()])).toBe(true);
    await s.settle();
    expect(s.written).toEqual([{ name: 'image-20261005-130405.png', bytes: 3 }]);
    expect(s.dispatched).toHaveLength(1);
    expect(s.onInserted).toHaveBeenCalledWith(expect.objectContaining({ sources: ['.pagemd/assets/img/image-20261005-130405-1.png'], origin: 'paste' }));
  });
  it('several pictures are ONE transaction, written in order', async () => {
    const s = setup();
    s.paste([png('a.png'), png('b.png')]);
    await s.settle();
    expect(s.written.map((w) => w.name)).toEqual(['a.png', 'b.png']);
    expect(s.dispatched).toHaveLength(1);
    expect(s.insert.mock.calls.at(-1)![1]).toHaveLength(2);
  });
  it('leaves a text paste alone: nothing but text, or text with the picture (a word processor)', async () => {
    const s = setup();
    expect(s.paste([], 'just words')).toBe(false);
    expect(s.paste([png()], 'words that came with it')).toBe(false);
    expect(s.paste([new File(['x'], 'a.pdf', { type: 'application/pdf' })])).toBe(false);
    await s.settle();
    expect(s.assets.writeAsset).not.toHaveBeenCalled();
  });
  it('writes nothing when there is no place for a figure (and says so)', async () => {
    const s = setup({ insert: () => null });
    expect(s.paste([png()])).toBe(true);
    await s.settle();
    expect(s.assets.writeAsset).not.toHaveBeenCalled();
    expect(s.onProblem).toHaveBeenCalledWith('There is no place for a figure here.');
  });
  it('writes nothing in a read-only canvas', async () => {
    const s = setup({}, false);
    s.paste([png()]);
    await s.settle();
    expect(s.assets.writeAsset).not.toHaveBeenCalled();
    expect(s.onProblem).toHaveBeenCalled();
  });
  it('a file the host refuses is reported, the others still go in', async () => {
    const s = setup();
    s.assets.writeAsset.mockRejectedValueOnce(new Error('disk full'));
    s.paste([png('a.png'), png('b.png')]);
    await s.settle();
    expect(s.onProblem).toHaveBeenCalledWith(expect.stringContaining('disk full'));
    expect(s.insert.mock.calls.at(-1)![1]).toHaveLength(1);
    expect(s.dispatched).toHaveLength(1);
  });
  it('two pastes in a row are written one after the other', async () => {
    const order: string[] = [];
    const s = setup();
    s.assets.writeAsset.mockImplementation(async (_b: Uint8Array, name: string) => {
      order.push(`start ${name}`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`end ${name}`);
      return name;
    });
    s.paste([png('a.png')]);
    s.paste([png('b.png')]);
    await new Promise((r) => setTimeout(r, 60));
    expect(order).toEqual(['start a.png', 'end a.png', 'start b.png', 'end b.png']);
  });
});

describe('drop', () => {
  it('moves the cursor to where the files were dropped, then does what a paste does, with the file names', async () => {
    const s = setup();
    expect(s.drop([png('Login screen.png')])).toBe(true);
    await s.settle();
    expect(s.dispatched).toHaveLength(2); // the cursor move, then the figure
    expect(s.written[0]!.name).toBe('Login screen.png');
    expect(s.onInserted).toHaveBeenCalledWith(expect.objectContaining({ origin: 'drop' }));
  });
  it('a file dropped where there is no text (a page margin) is still taken, at the cursor', async () => {
    const s = setup();
    expect(s.drop([png('shot.png')], 'margin')).toBe(true);
    await s.settle();
    expect(s.dispatched).toHaveLength(1); // no cursor move, just the figure
    expect(s.onInserted).toHaveBeenCalled();
  });
  it('leaves a dragged piece of the document (no files), and files that are not pictures, to ProseMirror', () => {
    const s = setup();
    expect(s.drop([])).toBe(false);
    expect(s.drop([new File(['x'], 'a.txt', { type: 'text/plain' })])).toBe(false);
  });
});
