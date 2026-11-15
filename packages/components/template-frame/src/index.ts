// @pagemd-editor/template-frame (P18, R-228): the profile's HTML template drawn around the canvas's text area, as pagemd's page
// has it. style-pagemd (host) fills the template's tokens with pagemd's own code and marks where `{{content}}` was with an empty
// slot element; this component parses that HTML with the browser's inert parser, makes it safe, puts the frame's top-level
// nodes into the canvas (which stands for pagemd's `<body>`) and puts the text area (ProseMirror's element) where the slot is:
// - when the slot is the only content of its element (`<main class="brochure-content">{{content}}</main>`), the text area takes
//   that element's place, and the app gives the text area its attributes (`hostAttributes`): `.brochure-content` and
//   `.invitation-body > p` then style the text area as they style pagemd's element;
// - otherwise the text area goes where the slot is.
// The frame is never edited and never saved: it is drawn from the template and the properties. A new template (a property was
// edited) changes the frame AROUND the text area without moving it, so typing and the selection carry on; only a template whose
// shape around the slot changed is built again (the app gives the focus back, `onMoved`). No DOM library in the unit tests: the
// DOM parts are checked in the browser (test/e2e/print-fidelity.spec.ts); the rules are pure functions tested here.
import { keepsAttribute, sanitize, TEMPLATE_SLOT, type PageTemplate } from '@pagemd-editor/core';

/** On the canvas while a frame is drawn. */
export const FRAMED_CLASS = 'pmd-framed';
/** On the text area while it stands inside a frame. */
export const FRAME_HOST_CLASS = 'pmd-frame-host';
/** On every top-level node of the frame (an element). */
export const FRAME_NODE_CLASS = 'pmd-frame';
/** Page gaps (components/pagination's GAP_CLASS): never a piece of the frame. */
const GAP_CLASS = 'pmd-page-gap';

// What a template may not bring (scripts, frames, event attributes, script addresses) is core's (safe-html.ts), shared with the
// raw HTML blocks drawn in the views styled by the profile.
export { DROPPED_ELEMENTS, keepsAttribute, sanitize } from '@pagemd-editor/core';

/**
 * The attributes the text area takes from the element it stands in for: everything but what the editor itself owns (editing,
 * role, the accessible name, the Tab order), or what `keepsAttribute` drops.
 */
export function carriedAttributes(attributes: ReadonlyArray<readonly [string, string]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of attributes) {
    const n = name.toLowerCase();
    if (n === 'contenteditable' || n === 'role' || n === 'tabindex' || n === 'spellcheck' || n.startsWith('aria-') || !keepsAttribute(n, value)) continue;
    out[n] = value;
  }
  return out;
}

export interface TemplateFrameOptions {
  /** The text area was moved into a newly built frame; `hadFocus`: it had the focus before (give it back). */
  onMoved?(hadFocus: boolean): void;
}

/** The frame's parts above and below the text area, in the order they flow on the page (for the pagination). */
export interface FramePieces {
  before: HTMLElement[];
  after: HTMLElement[];
}

interface Built {
  nodes: Node[];
  /** The element the text area takes the place of: the slot's element (replace) or the slot itself. */
  target: Element;
  replace: boolean;
  path: number[];
  tags: string[];
  host: Record<string, string>;
}

export class TemplateFrame {
  readonly #canvas: HTMLElement;
  readonly #content: HTMLElement;
  readonly #options: TemplateFrameOptions;
  /** The frame's top-level nodes, in the canvas, in order (empty: no frame). */
  #nodes: Node[] = [];
  #key: string | null = null;
  #bodyClasses: string[] = [];
  #host: Record<string, string> = {};
  #replace = false;
  #tags: string[] = [];
  #resize: ResizeObserver | null = null;

  constructor(canvas: HTMLElement, content: HTMLElement, options: TemplateFrameOptions = {}) {
    this.#canvas = canvas;
    this.#content = content;
    this.#options = options;
  }

  /** Whether a frame is drawn. */
  get active(): boolean {
    return this.#nodes.length > 0;
  }

  /** The attributes the text area carries for the element it stands in for ({} when it stands in for none). */
  get hostAttributes(): Readonly<Record<string, string>> {
    return this.#host;
  }

  /** Draws `template` around the text area; null: the text area alone, as before P18. */
  set(template: PageTemplate | null): void {
    const key = template ? `${template.bodyClass ?? ''}\u0000${template.html}` : null;
    if (key === this.#key) return;
    this.#key = key;
    this.#setBodyClasses(template?.bodyClass ?? '');
    const built = template ? this.#build(template.html) : null;
    if (!built) {
      this.#unframe();
      return;
    }
    if (this.active && this.#samePlace(built)) this.#morph(built);
    else this.#rebuild(built);
    this.#replace = built.replace;
    this.#tags = built.tags;
    this.#host = built.host;
    this.#content.classList.add(FRAME_HOST_CLASS);
    this.#canvas.classList.add(FRAMED_CLASS);
    this.#watch();
    this.updateOffsets();
  }

  /**
   * The frame's elements above and below the text area, in page order: at each level from the outside in, the elements before
   * the one holding the text area; then, from the inside out, the ones after it. An element beside the text area (in a row) is
   * neither: it doesn't end above the text area or start below it.
   */
  pieces(): FramePieces {
    const before: HTMLElement[] = [];
    const afterLevels: HTMLElement[][] = [];
    if (!this.active) return { before, after: [] };
    const box = this.#content.getBoundingClientRect();
    const chain = this.#chain();
    let siblings: Node[] = this.#nodes;
    for (const link of chain) {
      const at = siblings.indexOf(link);
      const elements = (nodes: Node[]) => nodes.filter((n): n is HTMLElement => n instanceof HTMLElement && !n.classList.contains(GAP_CLASS));
      before.push(...elements(siblings.slice(0, at)).filter((el) => el.getBoundingClientRect().bottom <= box.top + 1));
      afterLevels.unshift(elements(siblings.slice(at + 1)).filter((el) => el.getBoundingClientRect().top >= box.bottom - 1));
      if (link === this.#content) break;
      siblings = [...link.childNodes];
    }
    return { before, after: afterLevels.flat() };
  }

  /** The outermost frame element holding the text area (the flow pages in columns arrange), or the text area itself. */
  flowRoot(): HTMLElement {
    const top = this.#chain()[0];
    return top instanceof HTMLElement ? top : this.#content;
  }

  /**
   * Where the text area sits in the canvas (unzoomed px from the canvas's padding box), as CSS variables on the canvas, so the
   * properties card can hang at the top of the page instead of inside the template (`--pmd-frame-top`, `--pmd-frame-left`).
   */
  updateOffsets(): void {
    const canvas = this.#canvas;
    if (!this.active) {
      canvas.style.removeProperty('--pmd-frame-top');
      canvas.style.removeProperty('--pmd-frame-left');
      return;
    }
    const c = canvas.getBoundingClientRect();
    const t = this.#content.getBoundingClientRect();
    const scale = canvas.offsetWidth > 0 ? c.width / canvas.offsetWidth : 1;
    const border = (side: 'Top' | 'Left') => parseFloat(getComputedStyle(canvas)[`border${side}Width`]) || 0;
    const pad = (side: 'Left') => parseFloat(getComputedStyle(canvas)[`padding${side}`]) || 0;
    canvas.style.setProperty('--pmd-frame-top', `${Math.round(((t.top - c.top) / scale - border('Top')) * 100) / 100}px`);
    canvas.style.setProperty('--pmd-frame-left', `${Math.round(((t.left - c.left) / scale - border('Left') - pad('Left')) * 100) / 100}px`);
  }

  destroy(): void {
    this.#resize?.disconnect();
    this.#resize = null;
    this.#unframe();
  }

  // ── building ──

  #build(html: string): Built | null {
    const doc = this.#canvas.ownerDocument;
    const holder = doc.createElement('template');
    holder.innerHTML = html;
    const fragment = holder.content;
    sanitize(fragment);
    const slots = [...fragment.querySelectorAll(TEMPLATE_SLOT)];
    const slot = slots[0];
    if (!slot) return null;
    for (const extra of slots.slice(1)) extra.remove();
    const parent = slot.parentElement;
    const replace = parent !== null && [...parent.childNodes].every((n) => n === slot || (n.nodeType === 3 && (n.textContent ?? '').trim() === ''));
    const target = replace ? parent! : slot;
    const nodes = [...fragment.childNodes];
    const path: number[] = [];
    const tags: string[] = [];
    for (let n: Node = target; ; ) {
      const up: Node | null = n.parentNode;
      if (!up || up === fragment) {
        path.unshift(nodes.indexOf(n as ChildNode));
        tags.unshift((n as Element).tagName ?? '');
        break;
      }
      path.unshift([...up.childNodes].indexOf(n as ChildNode));
      tags.unshift((n as Element).tagName ?? '');
      n = up;
    }
    for (const node of nodes) if (node instanceof HTMLElement) node.classList.add(FRAME_NODE_CLASS);
    return { nodes, target, replace, path, tags, host: replace ? carriedAttributes([...target.attributes].map((a) => [a.name, a.value] as const)) : {} };
  }

  /** The nodes from the frame's top level down to the text area. */
  #chain(): Node[] {
    const chain: Node[] = [];
    for (let n: Node | null = this.#content; n && n !== this.#canvas; n = n.parentNode) chain.unshift(n);
    return chain;
  }

  /** The text area's place in the current frame, as indexes (the top level counted in the frame's own nodes). */
  #path(): number[] {
    const chain = this.#chain();
    return chain.map((n, i) => (i === 0 ? this.#nodes.indexOf(n) : [...chain[i - 1]!.childNodes].indexOf(n as ChildNode)));
  }

  #samePlace(built: Built): boolean {
    if (built.replace !== this.#replace) return false;
    const path = this.#path();
    if (path.length !== built.path.length || path.some((p, i) => p !== built.path[i])) return false;
    return built.tags.length === this.#tags.length && built.tags.every((t, i) => t === this.#tags[i]);
  }

  /** Same place for the text area: change everything around it, level by level, and leave the text area where it is. */
  #morph(built: Built): void {
    const chain = this.#chain(); // [the frame's top-level node, …, the text area]
    let oldSiblings: Node[] = this.#nodes;
    let newSiblings: Node[] = built.nodes;
    let top: Node[] = this.#nodes;
    for (let level = 0; level < chain.length; level++) {
      const at = built.path[level]!;
      const keep = chain[level]!;
      const replacing = newSiblings[at]!;
      for (const old of oldSiblings) if (old !== keep) (old as ChildNode).remove();
      const host = keep.parentNode!;
      for (let i = 0; i < at; i++) host.insertBefore(newSiblings[i]!, keep);
      let after: Node = keep;
      for (let i = at + 1; i < newSiblings.length; i++) {
        host.insertBefore(newSiblings[i]!, after.nextSibling);
        after = newSiblings[i]!;
      }
      if (level === 0) top = [...newSiblings.slice(0, at), keep, ...newSiblings.slice(at + 1)];
      if (keep === this.#content) break;
      syncAttributes(keep as Element, replacing as Element);
      oldSiblings = [...keep.childNodes];
      newSiblings = [...replacing.childNodes];
    }
    this.#nodes = top;
  }

  #rebuild(built: Built): void {
    const content = this.#content;
    const doc = content.ownerDocument;
    const hadFocus = content.contains(doc.activeElement);
    const anchor = this.active ? this.#nodes[0]! : content;
    for (const node of built.nodes) this.#canvas.insertBefore(node, anchor);
    built.target.replaceWith(content);
    for (const old of this.#nodes) (old as ChildNode).remove();
    this.#nodes = built.nodes;
    this.#options.onMoved?.(hadFocus);
  }

  #unframe(): void {
    if (!this.active) return;
    const content = this.#content;
    const hadFocus = content.contains(content.ownerDocument.activeElement);
    this.#canvas.insertBefore(content, this.#nodes[0]!);
    for (const old of this.#nodes) (old as ChildNode).remove();
    this.#nodes = [];
    this.#host = {};
    this.#tags = [];
    this.#key = null;
    content.classList.remove(FRAME_HOST_CLASS);
    this.#canvas.classList.remove(FRAMED_CLASS);
    this.#setBodyClasses('');
    this.updateOffsets();
    this.#options.onMoved?.(hadFocus);
  }

  #setBodyClasses(value: string): void {
    const next = value.split(/\s+/).filter(Boolean);
    for (const c of this.#bodyClasses) if (!next.includes(c)) this.#canvas.classList.remove(c);
    for (const c of next) this.#canvas.classList.add(c);
    this.#bodyClasses = next;
  }

  /** The card's place follows the text area's: re-read it whenever the canvas or the text area changes size. */
  #watch(): void {
    const Resize = this.#canvas.ownerDocument.defaultView?.ResizeObserver;
    if (this.#resize || !Resize) return;
    this.#resize = new Resize(() => this.updateOffsets());
    this.#resize.observe(this.#canvas);
    this.#resize.observe(this.#content);
  }
}

/** Makes `target`'s attributes those of `source` (the frame element kept in place takes the new template's attributes). */
function syncAttributes(target: Element, source: Element): void {
  for (const attr of [...target.attributes]) if (!source.hasAttribute(attr.name)) target.removeAttribute(attr.name);
  for (const attr of [...source.attributes]) if (target.getAttribute(attr.name) !== attr.value) target.setAttribute(attr.name, attr.value);
}

/**
 * Structural CSS: the properties card (the frontmatter) hangs at the top of the page, out of the page's flow, while a frame
 * is drawn (inside the template it would take room the PDF doesn't give it, or become a cell of a table layout).
 */
export const templateFrameCss = `
.pmd-canvas.${FRAMED_CLASS} .${FRAME_HOST_CLASS} > .pmd-fm-card { position: absolute; z-index: 3; margin: 0;
  top: calc(4px - var(--pmd-frame-top, 0px)); left: calc(0px - var(--pmd-frame-left, 0px)); max-width: none; }
/* (its rows carry the card's own background: drawn over the page, they never take the page's color behind them) */
.pmd-canvas.${FRAMED_CLASS} .${FRAME_HOST_CLASS} > .pmd-fm-card > * { background: inherit; }
`;
