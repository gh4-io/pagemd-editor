// Picture sizes for the canvas (P27; C13 AD-C13-03): pagemd draws a picture turned 90° or 270° in a box with its sides swapped,
// which needs the picture's size while the HTML is written (`env.pictureSize(src)`). pagemd reads it from the file's header; the
// canvas asks the browser, which is what C13 means by "as a browser shows the file, after its EXIF turn": the picture is loaded
// once (an `Image` resolved against the page's base, the document's folder) and its natural size kept. Until it is known the
// picture is drawn turned in its unturned box (pagemd's own fallback); the node views draw again when it arrives.

export interface PictureSize {
  width: number;
  height: number;
}

const known = new Map<string, PictureSize | 'loading' | 'failed'>();
const waiting = new Set<() => void>();

function resolve(src: string, doc: Document): string {
  try {
    return new URL(src, doc.baseURI).href;
  } catch {
    return src;
  }
}

/**
 * The picture's size if known; else null, and the picture starts loading (`onKnown` runs once when its size arrives, so the
 * caller can draw again). `doc` resolves a document-relative path.
 */
export function pictureSize(src: string, doc: Document | undefined, onKnown?: () => void): PictureSize | null {
  if (!doc || !src) return null;
  const url = resolve(src, doc);
  const found = known.get(url);
  if (found && typeof found === 'object') return found;
  if (onKnown) waiting.add(onKnown);
  if (found) return null; // loading or failed
  const Img = doc.defaultView?.Image;
  if (!Img) return null;
  known.set(url, 'loading');
  const img = new Img();
  img.decoding = 'async';
  img.onload = () => {
    known.set(url, img.naturalWidth > 0 && img.naturalHeight > 0 ? { width: img.naturalWidth, height: img.naturalHeight } : 'failed');
    const run = [...waiting];
    waiting.clear();
    for (const callback of run) callback();
  };
  img.onerror = () => known.set(url, 'failed');
  img.src = url;
  return null;
}

/** Forgets every size (a picture file changed on disk: its size may have changed too). */
export function forgetPictureSizes(): void {
  known.clear();
}

/** The env pagemd's renderer reads (`pictureSize`), for a node view that draws again via `redraw` once a missing size is known. */
export function pictureEnv(doc: Document | undefined, redraw: () => void): Record<string, unknown> & { pictureSize(src: string): PictureSize | null } {
  return { pictureSize: (src: string) => pictureSize(src, doc, redraw) };
}
