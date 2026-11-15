// The Files in Use panel (P25, R-242): a panel on the right listing every file that builds the document, in priority order (the
// document, its profile and the profiles it extends, the template, then every stylesheet highest priority first), why each was
// chosen, the problems, and "Where did this come from" for the block at the cursor: each main property, the rule that sets it
// (file, line, selector) and the rules it beat, as Word's Reveal Formatting does. Read-only: Open and Reveal ask the app (which asks
// the host) to show a file; nothing here edits the document or a file. It knows no syntax: the app gives it the report and the
// canvas's elements.
import type { FileUse, FilesInUse } from '@pagemd-editor/core';
import { attribute, domCascadeHost, type Candidate, type PropertyTrace } from './cascade.ts';

export interface InspectChain {
  /** "Heading 2", "Cell", "Table". */
  label: string;
  element: Element;
}

export interface InspectTarget {
  /** Why "where did this come from" is off now (Draft, Code, Print Preview, plain styles); absent when it works. */
  note?: string;
  /** The block at the cursor first, then the blocks around it. */
  chain: InspectChain[];
}

export interface FilesPanelOptions {
  /** The report for the document as it is now (the app asks the host). */
  load(): Promise<FilesInUse>;
  /** Show a file of the report (at a line). */
  open(path: string, line?: number): void;
  /** Show it in VS Code's Explorer (or the system's file manager). */
  reveal(path: string): void;
  /** The canvas's block at the cursor and around it. */
  inspect(): InspectTarget;
  /** The app's one live region (P13b, AD-P13-10). */
  announce?(message: string): void;
  onClose(): void;
}

const ROLE_ICON: Record<FileUse['role'], string> = { document: 'markdown', profile: 'symbol-namespace', template: 'file-code', stylesheet: 'symbol-color', asset: 'file-media' };

export class FilesPanel {
  readonly element: HTMLElement;
  readonly #o: FilesPanelOptions;
  readonly #doc: Document;
  readonly #body: HTMLElement;
  readonly #status: HTMLElement;
  readonly #lists: HTMLElement;
  readonly #where: HTMLElement;
  #report: FilesInUse | null = null;
  #byId = new Map<string, FileUse>();
  #loading: Promise<void> | null = null;
  #generation = 0;
  #pending: number | undefined;
  #chainKey = '';
  #chosen = 0;
  #focusRow: string | null = null;

  constructor(parent: HTMLElement, options: FilesPanelOptions) {
    this.#o = options;
    const d = (this.#doc = parent.ownerDocument);
    this.element = d.createElement('aside');
    this.element.className = 'pmd-files';
    this.element.setAttribute('aria-label', 'Files in use');
    this.element.hidden = true;
    const head = d.createElement('div');
    head.className = 'pmd-files-head';
    const title = d.createElement('h2');
    title.className = 'pmd-files-title';
    title.textContent = 'Files in use';
    const tools = d.createElement('div');
    tools.className = 'pmd-files-tools';
    tools.append(iconButton(d, 'refresh', 'Read the files again', () => void this.refresh()), iconButton(d, 'close', 'Close Files in Use', () => options.onClose()));
    head.append(title, tools);
    this.#body = d.createElement('div');
    this.#body.className = 'pmd-files-body';
    this.#status = d.createElement('p');
    this.#status.className = 'pmd-files-status';
    this.#lists = d.createElement('div');
    this.#where = d.createElement('section');
    this.#where.className = 'pmd-files-where';
    this.#where.setAttribute('aria-labelledby', 'pmd-files-where-title');
    this.#body.append(this.#status, this.#lists, this.#where);
    this.element.append(head, this.#body);
    this.element.addEventListener('keydown', (event) => this.#keys(event));
    parent.append(this.element);
  }

  get visible(): boolean {
    return !this.element.hidden;
  }

  /** The report drawn now (null before the first answer). */
  get report(): FilesInUse | null {
    return this.#report;
  }

  /** Shows the panel and reads the files again (a file may have changed while it was closed). */
  show(): void {
    this.element.hidden = false;
    void this.refresh();
  }

  hide(): void {
    this.element.hidden = true;
  }

  /** Asks for the report again (the profile or a file changed, or Refresh); nothing while hidden (`show` reads it). */
  refresh(): Promise<void> {
    if (this.element.hidden) return Promise.resolve();
    const generation = ++this.#generation;
    this.#status.textContent = 'Reading the files…';
    this.#loading = this.#o
      .load()
      .then((report) => {
        if (generation !== this.#generation) return;
        this.#report = report;
        this.#byId = new Map(report.files.map((f) => [f.id, f]));
        this.#drawLists();
        this.#chainKey = '';
        this.#drawWhere();
      })
      .catch((error: unknown) => {
        if (generation !== this.#generation) return;
        this.#status.textContent = `The files could not be read: ${error instanceof Error ? error.message : String(error)}`;
      })
      .finally(() => {
        if (generation === this.#generation) this.#loading = null;
      });
    return this.#loading;
  }

  /** Waits for a report being read (tests). */
  async settled(): Promise<void> {
    while (this.#loading) await this.#loading;
  }

  /** Redraws "where did this come from" on the next frame (the cursor, the document or the view changed). */
  update(): void {
    if (this.element.hidden || this.#pending !== undefined) return;
    const win = this.#doc.defaultView;
    const run = (): void => {
      this.#pending = undefined;
      this.#drawWhere();
    };
    this.#pending = win ? win.requestAnimationFrame(run) : (setTimeout(run, 0) as unknown as number);
  }

  destroy(): void {
    if (this.#pending !== undefined) this.#doc.defaultView?.cancelAnimationFrame(this.#pending);
    this.element.remove();
  }

  // ── the lists ──

  #drawLists(): void {
    const report = this.#report!;
    const d = this.#doc;
    const focused = this.#doc.activeElement && this.#lists.contains(this.#doc.activeElement) ? ((this.#doc.activeElement as HTMLElement).closest<HTMLElement>('[data-id]')?.dataset['id'] ?? null) : null;
    this.#lists.replaceChildren();
    const sheets = report.files.filter((f) => f.role === 'stylesheet');
    const top = report.files.filter((f) => f.role !== 'stylesheet');
    this.#status.textContent = report.files.length === 0 ? 'This document is not a file, so no pagemd files build it.' : `${report.files.length} files${report.plain ? ' found; the page shows plain styles (see Problems)' : ', in priority order'}.`;
    if (report.files.length > 0) {
      const how = d.createElement('details');
      how.className = 'pmd-files-how';
      const summary = d.createElement('summary');
      summary.textContent = 'How the order works';
      const text = d.createElement('p');
      text.textContent = report.cascade;
      how.append(summary, text);
      this.#lists.append(how);
    }
    if (top.length) this.#lists.append(this.#section('pmd-files-sec-doc', top.some((f) => f.role === 'asset') ? 'Document, profile, template and the files they use' : 'Document, profile and template', top, false));
    if (sheets.length) this.#lists.append(this.#section('pmd-files-sec-css', `Stylesheets, highest priority first (${sheets.length})`, sheets, true));
    const problems = report.problems.filter((p) => p.kind !== 'skipped');
    const notes = report.problems.filter((p) => p.kind === 'skipped');
    if (problems.length) this.#lists.append(this.#notes('Problems', problems, 'pmd-files-problems'));
    if (notes.length) this.#lists.append(this.#notes('Notes', notes, 'pmd-files-notes'));
    // One Tab stop for the rows: the one focused before, else the first.
    const rows = this.#rowButtons();
    const keep = (focused ?? this.#focusRow) && rows.find((b) => b.closest<HTMLElement>('[data-id]')!.dataset['id'] === (focused ?? this.#focusRow));
    (keep || rows[0])?.setAttribute('tabindex', '0');
    if (focused && keep) keep.focus();
    this.#o.announce?.(`Files in use: ${report.files.length} files.`);
  }

  #section(id: string, heading: string, files: FileUse[], ranked: boolean): HTMLElement {
    const d = this.#doc;
    const section = d.createElement('section');
    section.className = 'pmd-files-section';
    section.setAttribute('aria-labelledby', id);
    const h = d.createElement('h3');
    h.id = id;
    h.textContent = heading;
    const list = d.createElement('ul');
    list.className = 'pmd-files-list';
    for (const file of files) list.append(this.#row(file, ranked, files.length));
    section.append(h, list);
    return section;
  }

  #row(file: FileUse, ranked: boolean, of: number): HTMLElement {
    const d = this.#doc;
    const li = d.createElement('li');
    li.className = 'pmd-files-row';
    li.dataset['id'] = file.id;
    li.dataset['role'] = file.role;
    if (file.layer) li.dataset['layer'] = file.layer;
    if (file.problem) li.dataset['problem'] = 'true';
    const top = d.createElement('div');
    top.className = 'pmd-files-row-top';
    const open = d.createElement('button');
    open.type = 'button';
    open.className = 'pmd-files-open';
    open.tabIndex = -1;
    const icon = d.createElement('span');
    icon.className = `codicon codicon-${file.problem ? 'warning' : ROLE_ICON[file.role]}`;
    icon.setAttribute('aria-hidden', 'true');
    const name = d.createElement('span');
    name.className = 'pmd-files-name';
    name.textContent = file.name;
    const label = d.createElement('span');
    label.className = 'pmd-files-label';
    label.textContent = ranked && file.rank ? `${file.rank}. ${file.label}` : file.label;
    const where = file.path ? file.path : file.problem ? 'not found' : 'not a file';
    // The name is the button's own text (axe: the visible words are part of it), with the action and the place said only to a screen reader.
    const before = hidden(d, file.path ? 'Open ' : '');
    const after = hidden(d, `${ranked && file.rank ? `, priority ${file.rank} of ${of}` : ''}${file.path ? '' : ` (${where})`}`);
    open.append(before, icon, name, ' ', label, after);
    if (file.path) {
      open.title = `Open ${file.path}`;
      open.addEventListener('click', () => this.#o.open(file.path!));
    } else {
      open.setAttribute('aria-disabled', 'true');
      open.title = file.problem ?? 'Not a file: pagemd makes it';
    }
    top.append(open);
    if (file.path) {
      const reveal = iconButton(d, 'folder-opened', `Reveal ${file.name} in the Explorer`, () => this.#o.reveal(file.path!));
      reveal.classList.add('pmd-files-reveal');
      reveal.tabIndex = -1;
      top.append(reveal);
    }
    li.append(top);
    const folder = d.createElement('div');
    folder.className = 'pmd-files-path';
    folder.textContent = file.path ?? where;
    const why = d.createElement('p');
    why.className = 'pmd-files-why';
    why.id = `pmd-files-why-${file.id}`;
    why.textContent = file.why;
    open.setAttribute('aria-describedby', why.id);
    li.append(folder, why);
    if (file.bundled) {
      const note = d.createElement('p');
      note.className = 'pmd-files-bundled';
      note.textContent = "pagemd's own file: to change it, copy it into your project and name the copy in your profile.";
      li.append(note);
    }
    if (typeof file.rules === 'number') {
      const count = d.createElement('span');
      count.className = 'pmd-files-count';
      count.textContent = `${file.rules} rule${file.rules === 1 ? '' : 's'}`;
      folder.append(' · ', count);
    }
    if (file.problem) {
      const problem = d.createElement('p');
      problem.className = 'pmd-files-problem';
      problem.textContent = file.problem;
      li.append(problem);
      if (file.candidates?.length) li.append(this.#paths(file.candidates));
    }
    return li;
  }

  #paths(paths: readonly string[]): HTMLElement {
    const d = this.#doc;
    const list = d.createElement('ul');
    list.className = 'pmd-files-candidates';
    for (const path of paths) {
      const li = d.createElement('li');
      li.textContent = path;
      list.append(li);
    }
    return list;
  }

  #notes(heading: string, items: FilesInUse['problems'], className: string): HTMLElement {
    const d = this.#doc;
    const section = d.createElement('section');
    section.className = `pmd-files-section ${className}`;
    const id = `${className}-title`;
    section.setAttribute('aria-labelledby', id);
    const h = d.createElement('h3');
    h.id = id;
    h.textContent = heading;
    const list = d.createElement('ul');
    list.className = 'pmd-files-list';
    for (const item of items) {
      const li = d.createElement('li');
      li.className = 'pmd-files-note';
      li.dataset['kind'] = item.kind;
      const text = d.createElement('p');
      text.textContent = item.message.split('\n')[0]!;
      li.append(text);
      if (item.paths?.length) {
        const paths = d.createElement('div');
        paths.className = 'pmd-files-dups';
        for (const path of item.paths) {
          const b = d.createElement('button');
          b.type = 'button';
          b.className = 'pmd-files-link';
          b.textContent = path;
          b.setAttribute('aria-label', `Open ${path}`);
          b.addEventListener('click', () => this.#o.open(path));
          paths.append(b);
        }
        li.append(paths);
      }
      list.append(li);
    }
    section.append(h, list);
    return section;
  }

  #rowButtons(): HTMLButtonElement[] {
    return [...this.#lists.querySelectorAll<HTMLButtonElement>('.pmd-files-open')];
  }

  /** Up/Down/Home/End between the rows (one Tab stop), Right/Left to the row's Reveal button and back, Shift+Enter reveals. */
  #keys(event: KeyboardEvent): void {
    const target = event.target as HTMLElement;
    const row = target.closest<HTMLElement>('.pmd-files-row');
    if (!row || !this.#lists.contains(row)) return;
    const rows = this.#rowButtons();
    const open = row.querySelector<HTMLButtonElement>('.pmd-files-open')!;
    const reveal = row.querySelector<HTMLButtonElement>('.pmd-files-reveal');
    const at = rows.indexOf(open);
    const move = (i: number): void => {
      const next = rows[Math.max(0, Math.min(rows.length - 1, i))];
      if (!next) return;
      for (const b of rows) b.tabIndex = -1;
      next.tabIndex = 0;
      next.focus();
      this.#focusRow = next.closest<HTMLElement>('[data-id]')!.dataset['id'] ?? null;
    };
    if (event.key === 'ArrowDown') move(at + 1);
    else if (event.key === 'ArrowUp') move(at - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(rows.length - 1);
    else if (event.key === 'ArrowRight' && target === open && reveal) reveal.focus();
    else if (event.key === 'ArrowLeft' && target === reveal) open.focus();
    else if (event.key === 'Enter' && event.shiftKey && reveal) reveal.click();
    else return;
    event.preventDefault();
  }

  // ── where did this come from ──

  #drawWhere(): void {
    if (this.element.hidden) return;
    const d = this.#doc;
    const target = this.#o.inspect();
    const chain = target.chain;
    const key = chain.map((c) => c.label).join('|');
    if (key !== this.#chainKey) {
      this.#chainKey = key;
      this.#chosen = 0;
    }
    const keepFocus = this.#where.contains(d.activeElement) ? (d.activeElement as HTMLElement).dataset['focusKey'] : undefined;
    this.#where.replaceChildren();
    const h = d.createElement('h3');
    h.id = 'pmd-files-where-title';
    h.textContent = 'Where did this come from?';
    this.#where.append(h);
    const report = this.#report;
    const say = (text: string): void => {
      const p = d.createElement('p');
      p.className = 'pmd-files-where-note';
      p.textContent = text;
      this.#where.append(p);
    };
    if (!report) return say('Reading the files…');
    if (target.note) return say(target.note);
    if (chain.length === 0) return say('Put the cursor in a paragraph, a heading or a table, or select a picture.');
    // The blocks at the cursor: the innermost first; pick one to look at it instead.
    const group = d.createElement('div');
    group.className = 'pmd-files-chain';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'Look at');
    chain.forEach((entry, i) => {
      const b = d.createElement('button');
      b.type = 'button';
      b.className = 'pmd-files-chip';
      b.textContent = entry.label;
      b.dataset['focusKey'] = `chip-${i}`;
      b.setAttribute('aria-pressed', String(i === this.#chosen));
      b.addEventListener('click', () => {
        this.#chosen = i;
        this.#drawWhere();
      });
      group.append(b);
    });
    this.#where.append(group);
    const element = chain[Math.min(this.#chosen, chain.length - 1)]!.element;
    const win = d.defaultView!;
    const traces = attribute(element, report.rules, domCascadeHost(win));
    const computed = win.getComputedStyle(element);
    let list: HTMLElement | null = null;
    let group_ = '';
    for (const t of traces) {
      if (t.group !== group_ || !list) {
        group_ = t.group;
        const g = d.createElement('h4');
        g.className = 'pmd-files-group';
        g.textContent = t.group;
        list = d.createElement('dl');
        list.className = 'pmd-files-props';
        this.#where.append(g, list);
      }
      const pair = d.createElement('div');
      pair.className = 'pmd-files-pair';
      pair.append(...this.#property(t, computed.getPropertyValue(t.property).trim()));
      list.append(pair);
    }
    if (keepFocus) this.#where.querySelector<HTMLElement>(`[data-focus-key="${keepFocus}"]`)?.focus();
  }

  #property(t: PropertyTrace, shown: string): HTMLElement[] {
    const d = this.#doc;
    const dt = d.createElement('dt');
    dt.dataset['property'] = t.property;
    const label = d.createElement('span');
    label.className = 'pmd-files-prop';
    label.textContent = t.label;
    const value = d.createElement('span');
    value.className = 'pmd-files-value';
    value.textContent = shown || '—';
    value.title = `${t.property} on the page: ${shown}`;
    dt.append(label, value);
    const dd = d.createElement('dd');
    dd.dataset['property'] = t.property;
    dd.dataset['source'] = t.source;
    if (t.source === 'inline') dd.append(text(d, `Set on the element itself: ${t.inline}`));
    else if (t.source === 'none') dd.append(text(d, "No rule in these files sets it: the browser's or the editor's default."));
    else if (t.source === 'inherited' && !t.winner) dd.append(text(d, `Inherited from ${t.ancestor}, set on it directly: ${t.inline}`));
    else if (t.winner) {
      if (t.source === 'inherited') dd.append(text(d, `Inherited from ${t.ancestor}: `));
      dd.append(this.#ruleButton(t.winner, `win-${t.property}`));
    }
    if (t.beaten.length) {
      const more = d.createElement('details');
      more.className = 'pmd-files-beaten';
      const summary = d.createElement('summary');
      summary.textContent = `${t.beaten.length} more rule${t.beaten.length === 1 ? '' : 's'} lost`;
      more.append(summary);
      const ul = d.createElement('ul');
      t.beaten.slice(0, 12).forEach((c, i) => {
        const li = d.createElement('li');
        li.append(this.#ruleButton(c, `lost-${t.property}-${i}`));
        ul.append(li);
      });
      more.append(ul);
      dd.append(more);
    }
    return [dt, dd];
  }

  #ruleButton(c: Candidate, focusKey: string): HTMLElement {
    const d = this.#doc;
    const file = this.#byId.get(c.rule.file);
    const b = d.createElement('button');
    b.type = 'button';
    b.className = 'pmd-files-rule';
    b.dataset['focusKey'] = focusKey;
    b.dataset['file'] = file?.path ?? '';
    b.dataset['line'] = String(c.rule.line);
    const where = d.createElement('span');
    where.className = 'pmd-files-rule-where';
    where.textContent = `${file?.name ?? '?'}:${c.rule.line}`;
    const selector = d.createElement('span');
    selector.className = 'pmd-files-rule-selector';
    selector.textContent = c.rule.selector;
    const decl = d.createElement('code');
    decl.className = 'pmd-files-rule-decl';
    decl.textContent = `${c.via ?? c.declaration.property}: ${c.declaration.value}${c.declaration.important ? ' !important' : ''}`;
    const layer = file?.label ?? c.rule.layer;
    b.append(where, ' ', selector, ' ', decl, hidden(d, ` (${layer})`));
    if (file?.path) {
      b.title = `Open ${file.path} at line ${c.rule.line}`;
      b.addEventListener('click', () => this.#o.open(file.path!, c.rule.line));
    } else {
      b.setAttribute('aria-disabled', 'true');
      b.title = 'Made by pagemd from the properties: not a file';
    }
    return b;
  }
}

/** Words for a screen reader only (part of the accessible name, not drawn). */
function hidden(d: Document, content: string): HTMLElement {
  const span = d.createElement('span');
  span.className = 'pmd-files-sr';
  span.textContent = content;
  return span;
}

function text(d: Document, content: string): HTMLElement {
  const span = d.createElement('span');
  span.className = 'pmd-files-where-text';
  span.textContent = content;
  return span;
}

function iconButton(d: Document, iconName: string, label: string, onClick: () => void): HTMLButtonElement {
  const b = d.createElement('button');
  b.type = 'button';
  b.className = 'pmd-files-button';
  b.title = label;
  b.setAttribute('aria-label', label);
  const icon = d.createElement('span');
  icon.className = `codicon codicon-${iconName}`;
  icon.setAttribute('aria-hidden', 'true');
  b.append(icon);
  b.addEventListener('click', onClick);
  return b;
}

/** Editor UI: VS Code's theme variables only (light, dark, high contrast); paths wrap, nothing scrolls sideways. */
export const filesPanelCss = `
.pmd-files { flex: none; width: 320px; max-width: 50%; min-width: 0; display: flex; flex-direction: column; min-height: 0; font-family: var(--vscode-font-family); font-size: 12px; color: var(--vscode-foreground); background: var(--vscode-sideBar-background, var(--vscode-editor-background)); border-left: 1px solid var(--vscode-panel-border, transparent); }
.pmd-files[hidden] { display: none; }
.pmd-files-head { display: flex; align-items: center; justify-content: space-between; padding: 2px 4px 2px 8px; border-bottom: 1px solid var(--vscode-panel-border, transparent); }
.pmd-files-title { margin: 0; font-weight: 600; text-transform: uppercase; font-size: 11px; color: var(--vscode-foreground); }
.pmd-files-tools { display: flex; }
.pmd-files-button { font: inherit; color: var(--vscode-icon-foreground, var(--vscode-foreground)); background: transparent; border: 0; border-radius: 3px; padding: 2px; cursor: pointer; display: inline-flex; }
.pmd-files-button:hover { background: var(--vscode-toolbar-hoverBackground, transparent); }
.pmd-files-button:focus-visible, .pmd-files-open:focus-visible, .pmd-files-rule:focus-visible, .pmd-files-chip:focus-visible, .pmd-files-link:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.pmd-files-body { flex: 1; overflow-y: auto; overflow-x: hidden; padding: 4px 8px 24px; overflow-wrap: anywhere; }
.pmd-files-status { margin: 4px 0; color: var(--vscode-foreground); }
.pmd-files-how summary { cursor: pointer; color: var(--vscode-textLink-foreground, var(--vscode-foreground)); }
.pmd-files-how p { margin: 4px 0 8px; }
.pmd-files-section h3, .pmd-files-where h3 { margin: 10px 0 4px; font-size: 11px; font-weight: 600; text-transform: uppercase; color: var(--vscode-foreground); }
.pmd-files-list { list-style: none; margin: 0; padding: 0; }
.pmd-files-row { padding: 4px 0 6px; border-bottom: 1px solid var(--vscode-panel-border, transparent); }
.pmd-files-row-top { display: flex; align-items: flex-start; gap: 2px; }
.pmd-files-open { flex: 1; min-width: 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 6px; text-align: left; font: inherit; color: inherit; background: transparent; border: 0; border-radius: 2px; padding: 2px; cursor: pointer; }
.pmd-files-open:hover:not([aria-disabled="true"]) { background: var(--vscode-list-hoverBackground, transparent); }
.pmd-files-open[aria-disabled="true"] { cursor: default; }
.pmd-files-open .codicon { flex: none; align-self: center; }
.pmd-files-name { font-weight: 600; }
.pmd-files-label { color: var(--vscode-foreground); }
.pmd-files-path { margin: 0 2px; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; color: var(--vscode-foreground); opacity: 0.85; }
.pmd-files-why, .pmd-files-bundled, .pmd-files-problem { margin: 2px 2px 0; }
.pmd-files-bundled { font-style: italic; }
.pmd-files-problem, .pmd-files-problems .pmd-files-note p { color: var(--vscode-errorForeground, var(--vscode-foreground)); }
.pmd-files-candidates { margin: 2px 0 0 18px; padding: 0; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
.pmd-files-note p { margin: 2px 0; }
.pmd-files-dups { display: flex; flex-direction: column; align-items: flex-start; }
.pmd-files-link, .pmd-files-rule { font: inherit; color: var(--vscode-textLink-foreground, var(--vscode-foreground)); background: transparent; border: 0; padding: 1px 2px; text-align: left; cursor: pointer; overflow-wrap: anywhere; }
.pmd-files-link:hover, .pmd-files-rule:hover:not([aria-disabled="true"]) { text-decoration: underline; }
.pmd-files-rule[aria-disabled="true"] { cursor: default; color: var(--vscode-foreground); }
.pmd-files-rule-where { font-weight: 600; }
.pmd-files-rule-decl { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; color: var(--vscode-foreground); }
.pmd-files-chain { display: flex; flex-wrap: wrap; gap: 4px; margin: 2px 0 6px; }
.pmd-files-chip { font: inherit; color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); background: var(--vscode-button-secondaryBackground, transparent); border: 1px solid var(--vscode-button-border, var(--vscode-panel-border, transparent)); border-radius: 10px; padding: 1px 8px; cursor: pointer; }
.pmd-files-chip[aria-pressed="true"] { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
.pmd-files-props { margin: 0; }
.pmd-files-group { margin: 8px 0 2px; font-size: 12px; font-weight: 600; }
.pmd-files-sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.pmd-files-pair dt { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 0 8px; margin-top: 4px; }
.pmd-files-prop { font-weight: 600; }
.pmd-files-value { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
.pmd-files-pair dd { margin: 0 0 4px 8px; }
.pmd-files-beaten summary { cursor: pointer; }
.pmd-files-beaten ul { margin: 2px 0 0 12px; padding: 0; }
.pmd-files-beaten .pmd-files-rule { text-decoration: line-through; }
.pmd-files-where-note { margin: 4px 0; }
`;
