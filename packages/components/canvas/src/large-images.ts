// Very large pictures on the canvas (P13b, amendment 11, D27 rest, AD-P13-07). A picture wider or taller than 4000 px is shown from
// a smaller copy made in the browser: at most twice its shown width, so it is as sharp as the page can show it. The file is never
// touched, the picture keeps its real proportions and the width that holds it to the page (so pages lay out as before), and pixel edits still read the original
// from the host (`readAsset`). The copy is a `data:` URL because the webview's policy allows `data:` pictures but not `blob:`
// (R-171 is not widened for this).

/** A picture with a side longer than this is shown from a copy (the same number as the warning in the image editor, D27). */
export const LARGE_IMAGE_SIDE = 4000;
/** The copy is at most this many times the picture's shown width. */
export const COPY_FACTOR = 2;
/** How long a picture waits, hidden, for its copy. */
export const COPY_TIMEOUT_MS = 15000;
/** CSS px assumed for a picture that is not laid out (about a page's text width). */
export const FALLBACK_SHOWN_WIDTH = 800;

export interface CopyPlan {
  width: number;
  height: number;
  /** The copy's file type: JPEG stays JPEG; everything else becomes WebP (it keeps transparency). */
  mime: 'image/jpeg' | 'image/webp';
}

/**
 * Whether a picture of `natural` pixels shown `shownWidth` CSS pixels wide needs a smaller copy, and how big. Null: show the
 * file itself (small enough, a vector picture, or nothing would be saved). `src` only decides the copy's file type.
 */
export function copyPlan(natural: { width: number; height: number }, shownWidth: number, src: string): CopyPlan | null {
  const { width, height } = natural;
  if (!(width > 0) || !(height > 0)) return null;
  if (Math.max(width, height) <= LARGE_IMAGE_SIDE) return null;
  if (/\.svgz?([?#]|$)/i.test(src) || /^data:image\/svg/i.test(src)) return null; // vector: nothing to shrink
  // A picture that loads while the canvas is not drawn (the Code view) has no shown width yet: the width of a page's text stands in.
  const target = Math.round((shownWidth > 0 ? shownWidth : FALLBACK_SHOWN_WIDTH) * COPY_FACTOR);
  if (target >= width) return null;
  return { width: target, height: Math.max(1, Math.round((height * target) / width)), mime: /\.jpe?g([?#]|$)/i.test(src) || /^data:image\/jpe?g/i.test(src) ? 'image/jpeg' : 'image/webp' };
}

const FULL = 'data-pmd-full-src';

/** The file's own `src` of a picture on the canvas, also while it is shown from a copy. */
export function fullSrcOf(img: HTMLImageElement): string | null {
  return img.getAttribute(FULL) ?? img.getAttribute('src');
}

/** Points a picture at its file again (a changed file: the next load decides about a copy anew). */
export function setFullSrc(img: HTMLImageElement, src: string): void {
  img.removeAttribute(FULL);
  img.setAttribute('src', src);
}

export interface LargeImagesOptions {
  /** The bytes of the picture at the document-relative path (IAssets.readAsset); rejects for what the host will not read. */
  read(path: string): Promise<Uint8Array>;
}

/**
 * Watches the pictures of `root`. A picture is not painted until it has loaded and been looked at: the browser decodes a picture
 * when it first paints it, and a decoded 8000 x 6000 picture is about 190 MB that it keeps in its cache whatever the page shows
 * afterwards (measured: +250 MB for the file, +0 for a picture that was never painted). A large one stays hidden (its space
 * stays) until its smaller copy is ready; every other picture is shown the moment it has loaded.
 */
export class LargeImages {
  readonly #root: HTMLElement;
  readonly #read: LargeImagesOptions['read'];
  readonly #copies = new Map<string, Promise<string | null>>();
  /** The `visibility` a held picture had, to give back. */
  readonly #held = new WeakMap<HTMLImageElement, string>();
  readonly #observer: MutationObserver;
  readonly #onLoad = (event: Event): void => {
    if (event.target instanceof HTMLImageElement) void this.#shrink(event.target);
  };
  readonly #onError = (event: Event): void => {
    if (event.target instanceof HTMLImageElement) this.#release(event.target);
  };
  /** Copies made so far (tests and the status of the work). */
  made = 0;

  constructor(root: HTMLElement, options: LargeImagesOptions) {
    this.#root = root;
    this.#read = options.read;
    root.addEventListener('load', this.#onLoad, true);
    root.addEventListener('error', this.#onError, true);
    this.#observer = new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) this.#watch(node);
    });
    this.#observer.observe(root, { childList: true, subtree: true });
    this.#watch(root);
  }

  destroy(): void {
    this.#observer.disconnect();
    this.#root.removeEventListener('load', this.#onLoad, true);
    this.#root.removeEventListener('error', this.#onError, true);
  }

  #watch(node: Node): void {
    if (node instanceof HTMLImageElement) this.#hold(node);
    else if (node instanceof Element) for (const img of node.querySelectorAll('img')) this.#hold(img);
  }

  /** A picture that is still loading is not painted yet (it may turn out to be a large one). */
  #hold(img: HTMLImageElement): void {
    if (img.hasAttribute(FULL) || img.classList.contains('ProseMirror-separator') || this.#held.has(img)) return;
    if (img.complete) {
      if (img.naturalWidth > 0) void this.#shrink(img); // known already (from the cache): decided at once
      return;
    }
    this.#held.set(img, img.style.visibility);
    img.style.visibility = 'hidden';
  }

  /** Shows a held picture again. */
  #release(img: HTMLImageElement): void {
    const was = this.#held.get(img);
    if (was === undefined) return;
    this.#held.delete(img);
    img.style.visibility = was;
    if (img.getAttribute('style') === '') img.removeAttribute('style');
  }

  async #shrink(img: HTMLImageElement): Promise<void> {
    if (img.hasAttribute(FULL) || img.classList.contains('ProseMirror-separator')) return this.#release(img); // already a copy
    const src = img.currentSrc || img.src;
    const written = img.getAttribute('src'); // as the document writes it: relative to the document (the host reads it by that path)
    const plan = written === null || /^[a-z][a-z0-9+.-]*:/i.test(written) ? null : copyPlan({ width: img.naturalWidth, height: img.naturalHeight }, img.offsetWidth, written);
    if (written === null || !plan) return this.#release(img); // small, a web address, a data: picture or a vector picture: as it is
    // a large picture: hidden until the copy is ready
    if (!this.#held.has(img)) {
      this.#held.set(img, img.style.visibility);
      img.style.visibility = 'hidden';
    }
    const key = `${src}|${plan.width}`;
    let copy = this.#copies.get(key);
    if (!copy) {
      // no copy (the host refuses, or does not answer in 15 s): the picture shows from the file
      copy = Promise.race([this.#read(written).then((bytes) => makeCopy(bytes, plan)), new Promise<null>((resolve) => setTimeout(resolve, COPY_TIMEOUT_MS, null))]).catch(() => null);
      this.#copies.set(key, copy);
      if (this.#copies.size > 16) this.#copies.delete(this.#copies.keys().next().value!);
    }
    const url = await copy;
    if (!url || !img.isConnected || (img.currentSrc || img.src) !== src) return this.#release(img); // no copy, gone, or pointed elsewhere meanwhile
    // Nothing else changes: the same rules that held the file to the page's width (max-width, a width the author gave) hold the copy,
    // which is at least twice that wide, and its height follows the same picture ratio.
    img.setAttribute(FULL, written);
    img.addEventListener('load', () => this.#release(img), { once: true }); // shown when the copy has loaded
    img.addEventListener('error', () => this.#release(img), { once: true });
    img.setAttribute('src', url);
    this.made++;
  }
}

async function makeCopy(bytes: Uint8Array, plan: CopyPlan): Promise<string> {
  // The decoding and the resize happen inside createImageBitmap, off the main thread.
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]), { resizeWidth: plan.width, resizeHeight: plan.height, resizeQuality: 'high' });
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2D canvas');
    ctx.drawImage(bitmap, 0, 0);
    const blob = await canvas.convertToBlob({ type: plan.mime, quality: 0.9 });
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error ?? new Error('could not read the copy'));
      reader.readAsDataURL(blob);
    });
  } finally {
    bitmap.close();
  }
}
