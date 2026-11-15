// The Comments panel (P12, ADR-0015, R-181): a panel on the right of the page listing the review threads: the quoted text,
// the messages, Reply, Resolve / Reopen and Delete; a box for a new comment; and "Needs attention", the threads whose
// anchor is gone and the anchors with no thread. It knows no markup and never touches the document or the side file: the
// app gives it the data to draw (`data()`) and does what the buttons ask for.

export interface PanelMessage {
  author: string;
  created: string;
  text: string;
}

export interface PanelThread {
  id: string;
  quote: string;
  resolved: boolean;
  created: string;
  comments: readonly PanelMessage[];
}

/** An anchor in the text with no thread behind it (`index` = which anchor, in document order). */
export interface PanelBare {
  index: number;
  id: string;
  /** A second anchor for a thread that already has one. */
  duplicate: boolean;
}

export interface PanelData {
  /** The side file: 'ready', still being read, 'unreadable' (left alone) or 'unavailable' (no service). */
  status: 'loading' | 'ready' | 'unreadable' | 'unavailable';
  /** Why the status is not ready, or the last save problem. */
  message: string;
  /** False in Read: the panel only reads. */
  editable: boolean;
  /** Threads whose anchor is in the text, in document order. */
  attached: readonly PanelThread[];
  orphans: readonly PanelThread[];
  bare: readonly PanelBare[];
  /** The thread selected on the page or in the panel. */
  active: string | null;
  /** What a new comment would be about now. */
  quote: string;
}

export interface CommentsPanelOptions {
  data(): PanelData;
  /** A new thread with this first message. Rejects with the reason it could not be made. */
  create(text: string): Promise<void>;
  reply(id: string, text: string): Promise<void>;
  setResolved(id: string, resolved: boolean): Promise<void>;
  /** Delete a thread (and its anchor line when it has one). */
  remove(id: string): Promise<void>;
  /** Go to the thread's block on the page. */
  reveal(id: string): void;
  /** Put an orphaned thread's anchor above the block the cursor is in. */
  reattach(id: string): Promise<void>;
  /** Take an anchor with no thread out of the text. */
  removeAnchor(index: number): void;
  onClose(): void;
}

const ICON_ADD = 'comment';

export class CommentsPanel {
  readonly element: HTMLElement;
  readonly #o: CommentsPanelOptions;
  readonly #doc: Document;
  readonly #note: HTMLElement;
  readonly #compose: HTMLElement;
  readonly #composeQuote: HTMLElement;
  readonly #composeText: HTMLTextAreaElement;
  readonly #composeError: HTMLElement;
  readonly #list: HTMLElement;
  readonly #attention: HTMLElement;
  readonly #resolvedToggle: HTMLInputElement;
  readonly #newButton: HTMLButtonElement;
  /** Unsent reply text per thread, kept while the panel redraws. */
  readonly #drafts = new Map<string, string>();
  #key = '';
  #local: string | null | undefined;
  #composing = false;

  constructor(parent: HTMLElement, options: CommentsPanelOptions) {
    this.#o = options;
    const d = (this.#doc = parent.ownerDocument);
    this.element = d.createElement('aside');
    this.element.className = 'pmd-comments';
    this.element.setAttribute('aria-label', 'Comments');

    const head = d.createElement('div');
    head.className = 'pmd-comments-head';
    const title = d.createElement('span');
    title.className = 'pmd-comments-title';
    title.textContent = 'Comments';
    const tools = d.createElement('div');
    tools.className = 'pmd-comments-tools';
    this.#newButton = iconButton(d, ICON_ADD, 'New comment', () => this.startCompose());
    tools.append(this.#newButton, iconButton(d, 'close', 'Close the Comments panel', () => options.onClose()));
    head.append(title, tools);

    this.#note = d.createElement('div');
    this.#note.className = 'pmd-comments-note';
    this.#note.setAttribute('role', 'status');

    this.#compose = d.createElement('div');
    this.#compose.className = 'pmd-comments-compose';
    this.#compose.hidden = true;
    this.#composeQuote = d.createElement('div');
    this.#composeQuote.className = 'pmd-comments-quote';
    this.#composeText = d.createElement('textarea');
    this.#composeText.className = 'pmd-comments-input';
    this.#composeText.rows = 3;
    this.#composeText.placeholder = 'Write a comment…';
    this.#composeText.setAttribute('aria-label', 'New comment');
    this.#composeError = d.createElement('div');
    this.#composeError.className = 'pmd-comments-error';
    const composeButtons = d.createElement('div');
    composeButtons.className = 'pmd-comments-buttons';
    const add = textButton(d, 'Comment', () => void this.#submitCompose(), true);
    add.dataset['role'] = 'compose-add';
    composeButtons.append(add, textButton(d, 'Cancel', () => this.cancelCompose()));
    this.#compose.append(this.#composeQuote, this.#composeText, this.#composeError, composeButtons);
    this.#composeText.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        void this.#submitCompose();
      } else if (event.key === 'Escape') {
        event.stopPropagation();
        this.cancelCompose();
      }
    });

    this.#list = d.createElement('div');
    this.#list.className = 'pmd-comments-list';
    this.#attention = d.createElement('div');
    this.#attention.className = 'pmd-comments-attention';

    const foot = d.createElement('label');
    foot.className = 'pmd-comments-foot';
    this.#resolvedToggle = d.createElement('input');
    this.#resolvedToggle.type = 'checkbox';
    this.#resolvedToggle.addEventListener('change', () => this.refresh());
    foot.append(this.#resolvedToggle, d.createTextNode(' Show resolved'));

    this.element.append(head, this.#note, this.#compose, this.#list, this.#attention, foot);
    parent.append(this.element);
  }

  get visible(): boolean {
    return !this.element.hidden;
  }

  /** The thread the panel shows as selected (clicked here, or set by the app). */
  get activeId(): string | null {
    return this.#local === undefined ? this.#o.data().active : this.#local;
  }

  show(): void {
    this.element.hidden = false;
    this.refresh();
  }

  hide(): void {
    this.element.hidden = true;
  }

  /** Draws again when what it shows has changed. */
  refresh(): void {
    if (this.element.hidden) return;
    const data = this.#o.data();
    this.#local = undefined; // the app's selection wins again
    const canChange = data.status === 'ready' && data.editable;
    const key = JSON.stringify([data, this.#resolvedToggle.checked, this.#composing, canChange]);
    this.#newButton.disabled = !canChange;
    if (key === this.#key) return;
    this.#key = key;
    this.#draw(data, canChange);
  }

  /** Opens the box for a new comment and puts the cursor in it. */
  startCompose(): void {
    const data = this.#o.data();
    if (data.status !== 'ready' || !data.editable) return;
    this.#composing = true;
    this.#composeError.textContent = '';
    this.show();
    this.#key = '';
    this.refresh();
    this.#composeText.focus();
  }

  cancelCompose(): void {
    this.#composing = false;
    this.#composeText.value = '';
    this.#composeError.textContent = '';
    this.#key = '';
    this.refresh();
  }

  /** Puts the cursor in a thread's reply box. */
  focusReply(id: string): void {
    this.show();
    this.#list.querySelector<HTMLTextAreaElement>(`[data-thread="${cssEscape(id)}"] textarea`)?.focus();
  }

  /** Scrolls a thread's card into view. */
  scrollTo(id: string): void {
    this.#list.querySelector<HTMLElement>(`[data-thread="${cssEscape(id)}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }

  async #submitCompose(): Promise<void> {
    const text = this.#composeText.value.trim();
    if (text === '') {
      this.#composeError.textContent = 'Write something first.';
      return;
    }
    try {
      await this.#o.create(text);
    } catch (error) {
      this.#composeError.textContent = error instanceof Error ? error.message : String(error);
      return;
    }
    this.cancelCompose();
  }

  #draw(data: PanelData, canChange: boolean): void {
    const d = this.#doc;
    const focus = this.#focused();
    this.#note.textContent = data.status === 'ready' ? data.message : data.status === 'loading' ? 'Loading comments…' : data.message;
    this.#note.hidden = this.#note.textContent === '';
    this.#note.className = `pmd-comments-note${data.status === 'unreadable' || data.message ? ' pmd-comments-warning' : ''}`;

    this.#compose.hidden = !(this.#composing && canChange);
    this.#composeQuote.textContent = data.quote === '' ? 'On the block at the cursor' : `On: “${data.quote}”`;

    const showResolved = this.#resolvedToggle.checked;
    const shown = data.attached.filter((t) => showResolved || !t.resolved || t.id === data.active);
    this.#list.replaceChildren();
    if (data.attached.length === 0) {
      const empty = d.createElement('div');
      empty.className = 'pmd-comments-empty';
      empty.textContent = data.status === 'ready' ? (canChange ? 'No comments yet. Put the cursor in a paragraph and choose New comment.' : 'No comments.') : '';
      this.#list.append(empty);
    } else if (shown.length === 0) {
      const empty = d.createElement('div');
      empty.className = 'pmd-comments-empty';
      empty.textContent = 'Every comment is resolved. Tick “Show resolved” to see them.';
      this.#list.append(empty);
    }
    for (const thread of shown) this.#list.append(this.#card(thread, data, canChange, true));

    this.#attention.replaceChildren();
    if (data.orphans.length > 0 || data.bare.length > 0) {
      const title = d.createElement('div');
      title.className = 'pmd-comments-subtitle';
      title.textContent = 'Needs attention';
      this.#attention.append(title);
      for (const thread of data.orphans) this.#attention.append(this.#card(thread, data, canChange, false));
      for (const bare of data.bare) this.#attention.append(this.#bare(bare, canChange));
    }
    this.#restore(focus);
  }

  #card(thread: PanelThread, data: PanelData, canChange: boolean, attached: boolean): HTMLElement {
    const d = this.#doc;
    const card = d.createElement('div');
    card.className = `pmd-comments-thread${thread.resolved ? ' pmd-comments-resolved' : ''}${attached ? '' : ' pmd-comments-orphan'}`;
    card.dataset['thread'] = thread.id;
    if (thread.id === data.active) card.setAttribute('aria-current', 'true');
    card.tabIndex = 0;

    const top = d.createElement('div');
    top.className = 'pmd-comments-top';
    const quote = d.createElement('div');
    quote.className = 'pmd-comments-quote';
    quote.textContent = thread.quote === '' ? `Comment ${thread.id}` : `“${thread.quote}”`;
    top.append(quote);
    if (!attached) {
      const why = d.createElement('div');
      why.className = 'pmd-comments-why';
      why.textContent = 'Its place in the text is gone.';
      top.append(why);
    }
    if (attached) {
      const select = (): void => {
        this.#local = thread.id;
        this.#o.reveal(thread.id);
      };
      top.addEventListener('click', select);
      card.addEventListener('keydown', (event) => {
        if (event.target === card && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          select();
        }
      });
    }
    card.append(top);

    for (const message of thread.comments) {
      const row = d.createElement('div');
      row.className = 'pmd-comments-message';
      const who = d.createElement('div');
      who.className = 'pmd-comments-who';
      const name = d.createElement('strong');
      name.textContent = message.author;
      const when = d.createElement('span');
      when.className = 'pmd-comments-when';
      when.textContent = ` ${formatTime(message.created)}`;
      who.append(name, when);
      const text = d.createElement('div');
      text.className = 'pmd-comments-text';
      text.textContent = message.text;
      row.append(who, text);
      card.append(row);
    }

    if (canChange) {
      if (attached && !thread.resolved) {
        const box = d.createElement('textarea');
        box.className = 'pmd-comments-input';
        box.rows = 2;
        box.placeholder = 'Reply…';
        box.setAttribute('aria-label', `Reply to ${thread.id}`);
        box.value = this.#drafts.get(thread.id) ?? '';
        box.addEventListener('input', () => this.#drafts.set(thread.id, box.value));
        const send = async (): Promise<void> => {
          const text = box.value.trim();
          if (text === '') return;
          try {
            await this.#o.reply(thread.id, text);
            this.#drafts.delete(thread.id);
          } catch (error) {
            box.title = error instanceof Error ? error.message : String(error);
          }
        };
        box.addEventListener('keydown', (event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault();
            void send();
          }
        });
        const reply = textButton(d, 'Reply', () => void send(), true);
        reply.dataset['role'] = 'reply';
        const row = d.createElement('div');
        row.className = 'pmd-comments-buttons';
        row.append(reply);
        card.append(box, row);
      }
      const actions = d.createElement('div');
      actions.className = 'pmd-comments-buttons';
      if (attached) {
        const resolve = textButton(d, thread.resolved ? 'Reopen' : 'Resolve', () => void this.#o.setResolved(thread.id, !thread.resolved));
        resolve.dataset['role'] = 'resolve';
        actions.append(resolve);
      } else {
        const reattach = textButton(d, 'Re-attach here', () => void this.#o.reattach(thread.id));
        reattach.dataset['role'] = 'reattach';
        actions.append(reattach);
      }
      const remove = textButton(d, 'Delete', () => void this.#o.remove(thread.id));
      remove.dataset['role'] = 'delete';
      actions.append(remove);
      card.append(actions);
    }
    return card;
  }

  #bare(bare: PanelBare, canChange: boolean): HTMLElement {
    const d = this.#doc;
    const card = d.createElement('div');
    card.className = 'pmd-comments-thread pmd-comments-orphan';
    card.dataset['anchor'] = String(bare.index);
    const text = d.createElement('div');
    text.className = 'pmd-comments-why';
    text.textContent = bare.duplicate ? `A second marker for comment ${bare.id}.` : `A marker for comment ${bare.id} has no thread.`;
    card.append(text);
    if (canChange) {
      const row = d.createElement('div');
      row.className = 'pmd-comments-buttons';
      const remove = textButton(d, 'Remove marker', () => this.#o.removeAnchor(bare.index));
      remove.dataset['role'] = 'remove-marker';
      row.append(remove);
      card.append(row);
    }
    return card;
  }

  /** The reply box that has the focus, with its text selection, so a redraw can put it back. */
  #focused(): { thread: string; start: number; end: number } | undefined {
    const active = this.#doc.activeElement;
    if (!(active instanceof HTMLTextAreaElement) || !this.element.contains(active) || active === this.#composeText) return undefined;
    const thread = active.closest<HTMLElement>('[data-thread]')?.dataset['thread'];
    return thread ? { thread, start: active.selectionStart, end: active.selectionEnd } : undefined;
  }

  #restore(focus: { thread: string; start: number; end: number } | undefined): void {
    if (!focus) return;
    const box = this.element.querySelector<HTMLTextAreaElement>(`[data-thread="${cssEscape(focus.thread)}"] textarea`);
    if (!box) return;
    box.focus();
    box.setSelectionRange(focus.start, focus.end);
  }
}

const cssEscape = (value: string): string => value.replace(/["\\]/g, '\\$&');

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function iconButton(d: Document, icon: string, label: string, onClick: () => void): HTMLButtonElement {
  const b = d.createElement('button');
  b.type = 'button';
  b.className = 'pmd-comments-icon';
  b.title = label;
  b.setAttribute('aria-label', label);
  const span = d.createElement('span');
  span.className = `codicon codicon-${icon}`;
  span.setAttribute('aria-hidden', 'true');
  b.append(span);
  b.addEventListener('click', onClick);
  return b;
}

function textButton(d: Document, label: string, onClick: () => void, primary = false): HTMLButtonElement {
  const b = d.createElement('button');
  b.type = 'button';
  b.className = primary ? 'pmd-comments-button pmd-comments-primary' : 'pmd-comments-button';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

/** Editor UI, so VS Code's theme variables only (no color of its own). */
export const commentsPanelCss = `
.pmd-comments { flex: none; width: 280px; display: flex; flex-direction: column; min-height: 0; font-family: var(--vscode-font-family); font-size: 12px; color: var(--vscode-foreground); background: var(--vscode-sideBar-background, var(--vscode-editor-background)); border-left: 1px solid var(--vscode-panel-border, transparent); }
.pmd-comments[hidden] { display: none; }
.pmd-comments-head { display: flex; align-items: center; justify-content: space-between; padding: 2px 4px 2px 8px; border-bottom: 1px solid var(--vscode-panel-border, transparent); }
.pmd-comments-title { font-weight: 600; text-transform: uppercase; font-size: 11px; color: var(--vscode-descriptionForeground); }
.pmd-comments-tools { display: flex; }
.pmd-comments-icon { font: inherit; color: var(--vscode-icon-foreground, var(--vscode-foreground)); background: transparent; border: 0; border-radius: 3px; padding: 2px; cursor: pointer; display: inline-flex; }
.pmd-comments-icon:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground, transparent); }
.pmd-comments-icon:disabled { opacity: 0.4; cursor: default; }
.pmd-comments-note { padding: 6px 8px; color: var(--vscode-descriptionForeground); }
.pmd-comments-note[hidden] { display: none; }
.pmd-comments-warning { color: var(--vscode-editorWarning-foreground, var(--vscode-descriptionForeground)); }
.pmd-comments-compose { padding: 8px; border-bottom: 1px solid var(--vscode-panel-border, transparent); }
.pmd-comments-compose[hidden] { display: none; }
.pmd-comments-list { flex: 1; overflow: auto; padding: 4px 0; }
.pmd-comments-empty { padding: 6px 8px; color: var(--vscode-descriptionForeground); }
.pmd-comments-attention { border-top: 1px solid var(--vscode-panel-border, transparent); max-height: 40%; overflow: auto; }
.pmd-comments-attention:empty { display: none; }
.pmd-comments-subtitle { padding: 6px 8px 2px; font-weight: 600; text-transform: uppercase; font-size: 11px; color: var(--vscode-descriptionForeground); }
.pmd-comments-thread { margin: 6px 8px; padding: 6px 8px; border: 1px solid var(--vscode-panel-border, var(--vscode-editorWidget-border, #888)); border-radius: 4px; background: var(--vscode-editor-background); }
.pmd-comments-thread[aria-current="true"] { border-color: var(--vscode-focusBorder); }
.pmd-comments-thread:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
.pmd-comments-resolved { opacity: 0.7; }
.pmd-comments-orphan { border-style: dashed; }
.pmd-comments-top { cursor: pointer; }
.pmd-comments-quote { color: var(--vscode-descriptionForeground); font-style: italic; overflow-wrap: anywhere; margin-bottom: 4px; }
.pmd-comments-why { color: var(--vscode-editorWarning-foreground, var(--vscode-descriptionForeground)); margin-bottom: 4px; }
.pmd-comments-message { margin: 4px 0; }
.pmd-comments-when { color: var(--vscode-descriptionForeground); font-size: 11px; }
.pmd-comments-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.pmd-comments-input { width: 100%; box-sizing: border-box; margin-top: 4px; font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; padding: 3px 5px; resize: vertical; }
.pmd-comments-input:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.pmd-comments-buttons { display: flex; gap: 6px; margin-top: 4px; }
.pmd-comments-button { font: inherit; padding: 2px 8px; color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); background: var(--vscode-button-secondaryBackground, transparent); border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px; cursor: pointer; }
.pmd-comments-button:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-toolbar-hoverBackground)); }
.pmd-comments-primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
.pmd-comments-primary:hover { background: var(--vscode-button-hoverBackground); }
.pmd-comments-error { color: var(--vscode-errorForeground); margin-top: 4px; }
.pmd-comments-foot { padding: 4px 8px; border-top: 1px solid var(--vscode-panel-border, transparent); color: var(--vscode-descriptionForeground); cursor: pointer; }
`;
