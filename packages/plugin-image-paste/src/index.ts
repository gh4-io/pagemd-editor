// @pagemd-editor/plugin-image-paste: paste or drop an image onto the canvas (P11, ADR-0008, R-174).
// The image file is written next to the document through IAssets.writeAsset (the host decides the folder, never
// overwrites, returns a path relative to the `.md`), then the app's `insert` puts a figure for each file into the
// document as ONE transaction (so VS Code's undo takes the figures back in one step; the file stays, R-174). This
// package knows nothing of FIGURE: the app hands it `insert`, which keeps the dialect inside preset-pagemd (I1).
import { Plugin, Selection } from 'prosemirror-state';
import type { EditorState, Transaction } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { IAssets, type EditorPlugin } from '@pagemd-editor/core';

/** Image types we take, with the extension each gets when the file has none. */
const TYPES: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
};

/** What was inserted: the D13 hook (a later phase's "Annotate" follow-up listens here; P11 itself does nothing more). */
export interface ImageInsertedEvent {
  /** Document-relative paths, in the order inserted. */
  sources: readonly string[];
  origin: 'paste' | 'drop';
  /** The view the figures went into (its selection is on the first one). */
  view: EditorView;
}

export interface ImagePasteOptions {
  /** One transaction that inserts a figure for each source at the selection; null when nothing can go there. */
  insert(state: EditorState, sources: readonly string[]): Transaction | null;
  /** The figures are in (the app opens the Inspector's caption field). */
  onInserted?(event: ImageInsertedEvent): void;
  /** Something the author should be told (no room for a figure, the host refused a file). */
  onProblem?(message: string): void;
  /** The clock, for the timestamp names (tests). */
  now?(): Date;
}

interface FileLike {
  name: string;
  type: string;
}

/** Whether `file` is an image we take. */
export function isImage(file: FileLike): boolean {
  return Object.hasOwn(TYPES, file.type.toLowerCase());
}

const two = (n: number): string => String(n).padStart(2, '0');

/**
 * The name a file is saved under (R-174). A pasted picture has no name of its own (the browser calls it `image.png`), so
 * it is named by the time: `image-20261005-134501.png`. A dropped file keeps its own name (the host cleans it, and a clash
 * gets `-1`, `-2`). Either way a missing extension is added from the type.
 */
export function assetNameFor(file: FileLike, origin: 'paste' | 'drop', now: Date): string {
  const ext = TYPES[file.type.toLowerCase()] ?? 'png';
  const generic = file.name.trim() === '' || (origin === 'paste' && /^image\.[a-z0-9]+$/i.test(file.name.trim()));
  if (generic) {
    const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
    return `image-${stamp}.${ext}`;
  }
  return /\.[a-z0-9]+$/i.test(file.name) ? file.name : `${file.name}.${ext}`;
}

/** The image files in `list`, in order. */
function imagesIn(list: FileList | undefined | null): File[] {
  return list ? [...list].filter(isImage) : [];
}

/** The paste/drop handlers as a ProseMirror plugin, for a host that wires it in without the Lumino wrapper (tests). */
export function imagePastePmPlugin(assets: Pick<IAssets, 'writeAsset'>, options: ImagePasteOptions): Plugin {
  let chain: Promise<unknown> = Promise.resolve();
  const now = options.now ?? ((): Date => new Date());
  const problem = (message: string): void => options.onProblem?.(message);

  /** One at a time: two pastes in a row must not choose the same name. */
  function take(view: EditorView, files: File[], origin: 'paste' | 'drop'): void {
    const job = chain.then(async () => {
      // No room for a figure (or the canvas is read-only): write nothing, so no file is left behind for nothing.
      const probe = view.editable ? options.insert(view.state, files.map((_, i) => `probe-${i}`)) : null;
      if (!probe) return problem('There is no place for a figure here.');
      const sources: string[] = [];
      for (const file of files) {
        try {
          sources.push(await assets.writeAsset(new Uint8Array(await file.arrayBuffer()), assetNameFor(file, origin, now())));
        } catch (error) {
          problem(`The image ${file.name || 'from the clipboard'} could not be saved: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (sources.length === 0) return;
      // The selection may have moved while the files were written: the figures go where the cursor is now.
      const tr = options.insert(view.state, sources);
      if (!tr) return problem('There is no place for a figure here.');
      view.dispatch(tr);
      options.onInserted?.({ sources, origin, view });
    });
    chain = job.catch((error: unknown) => problem(`The image could not be inserted: ${error instanceof Error ? error.message : String(error)}`));
  }

  return new Plugin({
    props: {
      handlePaste(view, event) {
        const files = imagesIn(event.clipboardData?.files);
        if (files.length === 0) return false;
        // Text with the picture (a copy from a word processor, a page of a web site) is a text paste: the picture alone wins.
        if ((event.clipboardData?.getData('text/plain') ?? '').trim() !== '') return false;
        take(view, files, 'paste');
        return true;
      },
      // A DOM handler rather than `handleDrop`: ProseMirror calls handleDrop only for a drop where it can find a document
      // position, so a file dropped into a page's margin (Print Layout) would be lost; this one takes it wherever on the canvas.
      handleDOMEvents: {
        drop(view, event) {
          const files = imagesIn(event.dataTransfer?.files);
          if (files.length === 0) return false; // text, or a piece of the document dragged inside it: ProseMirror's own
          event.preventDefault();
          // Where the files were dropped (when that is in the text), not where the cursor was.
          const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
          if (at && view.editable) view.dispatch(view.state.tr.setSelection(Selection.near(view.state.doc.resolve(at.pos), 1)));
          take(view, files, 'drop');
          return true;
        },
      },
    },
  });
}

/** The plugin for the editor: needs IAssets (without it, paste and drop do what they did before). */
export function imagePastePlugin(options: ImagePasteOptions): EditorPlugin<void> {
  return {
    id: '@pagemd-editor/plugin-image-paste:main',
    autoStart: true,
    optional: [IAssets],
    activate: (app, assets: IAssets | null) => {
      if (assets) app.pmPlugins.push(imagePastePmPlugin(assets, options));
    },
  };
}
