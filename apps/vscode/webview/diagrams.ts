// Diagrams on the canvas (P10, R-170 Q9): the mermaid browser build shipped with the extension (the exact version pagemd
// pins, R-167), loaded the first time a diagram is drawn, with pagemd's settings (`MERMAID_CONFIG`). preset-pagemd's
// diagram view calls `draw`; drawings are kept by source, and drawn one after another (mermaid's own advice).
import type { DiagramDrawer } from '@pagemd-editor/preset-pagemd';

interface Mermaid {
  initialize(config: Record<string, unknown>): void;
  render(id: string, code: string): Promise<{ svg: string }>;
}

export interface DrawerOptions {
  /** The webview address of mermaid.min.js (protocol v7, `init.mermaidScript`). */
  scriptUrl: string;
  /** The page's script nonce (the CSP allows only scripts carrying it). */
  nonce: string;
  config: Readonly<Record<string, unknown>>;
  /** Whether the current view draws diagrams. */
  enabled(): boolean;
  /** A drawing finished: the block changed height. */
  drawn?(): void;
}

export interface CanvasDiagrams extends DiagramDrawer {
  /** The view changed: blocks not yet drawn are drawn now if the new view draws. */
  refresh(): void;
  /** How many drawings were made (tests). */
  readonly count: number;
}

export function createDiagramDrawer(options: DrawerOptions): CanvasDiagrams {
  let loading: Promise<Mermaid> | undefined;
  let chain: Promise<unknown> = Promise.resolve();
  let next = 0;
  let count = 0;
  const cache = new Map<string, Promise<string>>();
  const views = new Set<() => void>();

  const load = (): Promise<Mermaid> => {
    loading ??= new Promise<Mermaid>((resolve, reject) => {
      const found = (window as unknown as { mermaid?: Mermaid }).mermaid;
      if (found) return resolve(found);
      const script = document.createElement('script');
      script.nonce = options.nonce;
      script.setAttribute('nonce', options.nonce);
      script.src = options.scriptUrl;
      script.onload = () => {
        const mermaid = (window as unknown as { mermaid?: Mermaid }).mermaid;
        if (!mermaid) return reject(new Error('mermaid did not load'));
        mermaid.initialize({ ...options.config });
        resolve(mermaid);
      };
      script.onerror = () => reject(new Error('mermaid could not be loaded'));
      document.head.append(script);
    });
    return loading;
  };

  const draw = (code: string): Promise<string> => {
    let drawing = cache.get(code);
    if (!drawing) {
      drawing = (chain = chain.catch(() => undefined).then(async () => {
        const mermaid = await load();
        const id = `pmd-diagram-${++next}`;
        try {
          const { svg } = await mermaid.render(id, code);
          count++;
          return svg;
        } finally {
          document.getElementById(`d${id}`)?.remove(); // mermaid's scratch element, left behind by a failed render
        }
      })) as Promise<string>;
      cache.set(code, drawing);
      if (cache.size > 200) cache.delete(cache.keys().next().value!);
    }
    return drawing;
  };

  return {
    enabled: options.enabled,
    draw,
    drawn: () => options.drawn?.(),
    subscribe(repaint) {
      views.add(repaint);
      return () => views.delete(repaint);
    },
    refresh() {
      if (!options.enabled()) return;
      for (const repaint of views) repaint();
    },
    get count() {
      return count;
    },
  };
}
