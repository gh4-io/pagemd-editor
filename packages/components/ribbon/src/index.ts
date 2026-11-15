// @pagemd-editor/ribbon: the tabbed button bar (ADR-0013 decision 3, P7). It draws `registry.ribbon()` (the layout
// file's tabs and groups, plus "More") and asks `registry.actions()` for each button's label, enabled and active
// state. It knows no syntax: a button is an Action; clicking it hands the Action to `run` (the action runner).
// Styling uses VS Code's theme variables (editor UI).
import { formatKeybinding, type Action, type ActionContext, type Registry, type RibbonButtonSize } from '@pagemd-editor/core';
import { Plugin, type EditorState } from 'prosemirror-state';

/** A group with more commands than this is drawn as one drop-down button (like Word's "Styles"). */
export const MENU_THRESHOLD = 6;

/** Small buttons stack this many high (Office's three), then start a new column. */
export const STACK_HEIGHT = 3;

export interface RibbonOptions {
  registry: Registry;
  /** Runs an action (the action runner). */
  run(action: Action): void;
  /** The editor's state for enabled/active; undefined before the canvas exists (every button is then enabled). */
  context(): ActionContext | undefined;
  /** Shortcut hints in Mac symbols. */
  mac?: boolean;
  /** Escape inside the ribbon's buttons: the app puts the focus back in the document (P13b). */
  exit?(): void;
  /** Tab ids to show; 'all' (default) shows every tab. Read shows only the View tab (R-156). */
  tabs?: 'all' | readonly string[];
  /**
   * The tab that belongs to where the cursor is, or null (P19 round 3: 'table' in a table). On entering such a place the
   * ribbon selects that tab; a tab picked by hand meanwhile is kept; on leaving, the tab from before comes back (only if
   * the automatic one is still selected). P20: the app orders its rules, first match wins ('image' before 'table').
   */
  autoTab?(state: EditorState): string | null;
  /**
   * P20 (ADR-0013 amendment): tabs that are in the strip only while their rule is true for the editor's state (the Image
   * tab: a picture selected). A tab not named here is always there (if the view's `tabs` allow it). If the selected tab
   * leaves the strip, the tab from before it comes back, else the first tab.
   */
  contextTabs?: Readonly<Record<string, (state: EditorState) => boolean>>;
}

/** What a group draws (P17): a large button (a big icon over a short title), or a column of up to three small buttons. */
export type RibbonItem = { kind: 'large'; action: Action } | { kind: 'stack'; actions: Action[] };

/** One group as drawn: a row of buttons, or one drop-down button holding them. */
export interface RibbonGroupModel {
  id: string;
  label: string;
  menu: boolean;
  actions: Action[];
  /** The group's icon (the layout file's, else its first command's): shown when the group is one drop-down button. */
  icon: string | undefined;
  /** The layout file's sizes; a command it doesn't name is small. */
  sizes: Readonly<Record<string, RibbonButtonSize>>;
  /** The layout file's short ribbon titles, by command id. */
  titles: Readonly<Record<string, string>>;
  /** P20: the layout's fold order (higher folds first in a narrow window; 0 when not given). */
  fold: number;
  /** `actions` arranged for drawing as buttons (not used when `menu`). */
  items: RibbonItem[];
}

/** Large commands stand alone; runs of small ones are stacked, three to a column (a large one ends the run). */
export function arrangeButtons(actions: readonly Action[], sizes: Readonly<Record<string, RibbonButtonSize>>): RibbonItem[] {
  const items: RibbonItem[] = [];
  let run: Action[] = [];
  const flush = (): void => {
    for (let i = 0; i < run.length; i += STACK_HEIGHT) items.push({ kind: 'stack', actions: run.slice(i, i + STACK_HEIGHT) });
    run = [];
  };
  for (const action of actions) {
    if (sizes[action.id] === 'large') {
      flush();
      items.push({ kind: 'large', action });
    } else run.push(action);
  }
  flush();
  return items;
}

/** The text a ribbon button shows: the layout's short title, else the full label. The full label stays the tooltip and the accessible name. */
export const ribbonTitle = (action: Action, titles: Readonly<Record<string, string>>): string => titles[action.id] ?? action.label;

/**
 * Which groups to fold into a drop-down button so the rest fit (P17): from the last group backwards, each one that is
 * not a drop-down already, until `fits(folded)` says the panel fits (or nothing is left to fold). Pure; the ribbon
 * supplies `fits` by measuring.
 */
export function foldGroups(candidates: readonly string[], fits: (folded: ReadonlySet<string>) => boolean): Set<string> {
  const folded = new Set<string>();
  for (let i = candidates.length - 1; i >= 0 && !fits(folded); i--) folded.add(candidates[i]!);
  return folded;
}

/**
 * The groups that may fold, in the order `foldGroups` wants (it folds from the end): drop-down groups never fold; a higher
 * `fold` number goes later (so it folds first); equal numbers keep the layout's order (the last group folds first, P17).
 */
export function foldCandidates(groups: readonly Pick<RibbonGroupModel, 'id' | 'menu' | 'fold'>[]): string[] {
  return groups
    .map((group, at) => ({ group, at }))
    .filter(({ group }) => !group.menu)
    .sort((a, b) => a.group.fold - b.group.fold || a.at - b.at)
    .map(({ group }) => group.id);
}

/** Where the cursor-following tab stands: the automatic tab for where the cursor is, the tab it replaced, and the tab it selected. */
interface AutoState {
  want: string | null;
  before: string | undefined;
  chosen: string | undefined;
}

/**
 * The tabs that follow the cursor, without a DOM (so it can be tested): P19 round 3's automatic tab and P20's context tabs.
 * `follow` says which tab to select after a document or selection change, and whether anything the ribbon draws changed
 * (the strip, or the selected tab), so the ribbon redraws only then, not on every keystroke.
 */
export class CursorTabs {
  readonly #autoTab: ((state: EditorState) => string | null) | undefined;
  readonly #rules: Readonly<Record<string, (state: EditorState) => boolean>>;
  #auto: AutoState = { want: null, before: undefined, chosen: undefined };
  /** The context tabs whose rule is true now. */
  #present = new Set<string>();

  constructor(options: Pick<RibbonOptions, 'autoTab' | 'contextTabs'>) {
    this.#autoTab = options.autoTab;
    this.#rules = options.contextTabs ?? {};
  }

  /** The context tabs that are not in the strip now (`ribbonModel`'s `hidden`). */
  hidden(): Set<string> {
    return new Set(Object.keys(this.#rules).filter((id) => !this.#present.has(id)));
  }

  /** Is `id` in the strip now: allowed by the view, and, for a context tab, its rule true? */
  present(id: string, allowed: (id: string) => boolean): boolean {
    return allowed(id) && (!(id in this.#rules) || this.#present.has(id));
  }

  /**
   * After a change: the tab to select (undefined: the first tab) and whether the strip or the selected tab changed. With
   * no state (no canvas yet) no context tab shows and nothing is selected automatically.
   */
  follow(state: EditorState | undefined, selected: string | undefined, allowed: (id: string) => boolean): { selected: string | undefined; changed: boolean } {
    const present = new Set(state ? Object.keys(this.#rules).filter((id) => this.#rules[id]!(state)) : []);
    const stripChanged = present.size !== this.#present.size || [...present].some((id) => !this.#present.has(id));
    this.#present = present;
    const shown = (id: string): boolean => this.present(id, allowed);
    const want = state ? (this.#autoTab?.(state) ?? null) : null;
    let next = selected;
    let fallback = this.#auto.before;
    if (want !== this.#auto.want) {
      if (want && shown(want)) {
        const before = this.#auto.want && selected === this.#auto.chosen ? this.#auto.before : selected;
        this.#auto = { want, before, chosen: selected === want ? undefined : want };
        next = want;
        fallback = before;
      } else {
        // Leaving: back to the tab from before, unless the author picked another one meanwhile.
        if (this.#auto.chosen && selected === this.#auto.chosen && this.#auto.before && shown(this.#auto.before)) next = this.#auto.before;
        this.#auto = { want: null, before: undefined, chosen: undefined };
      }
    }
    // The selected tab left the strip (a context tab whose rule is now false): the tab from before, else the first tab.
    if (next !== undefined && !shown(next)) next = fallback !== undefined && shown(fallback) ? fallback : undefined;
    return { selected: next, changed: stripChanged || next !== selected };
  }
}

export interface RibbonModel {
  tabs: { id: string; label: string; selected: boolean }[];
  /** The selected tab's groups. */
  groups: RibbonGroupModel[];
}

/** What the ribbon draws: pure, so it can be tested without a DOM. `selected` falls back to the first shown tab. */
export function ribbonModel(
  registry: Registry,
  options: { context?: ActionContext | undefined; tabs?: 'all' | readonly string[] | undefined; selected?: string | undefined; hidden?: ReadonlySet<string> | undefined },
): RibbonModel {
  // P20: `hidden` names the context tabs whose rule is false now (not in the strip at all).
  const shown = registry.ribbon().tabs.filter((tab) => (options.tabs === undefined || options.tabs === 'all' || options.tabs.includes(tab.id)) && !options.hidden?.has(tab.id));
  const selected = shown.find((tab) => tab.id === options.selected)?.id ?? shown[0]?.id;
  const tabs = shown.map((tab) => ({ id: tab.id, label: tab.label, selected: tab.id === selected }));
  if (selected === undefined) return { tabs, groups: [] };
  const query = { surface: 'ribbon' as const, tab: selected, ...(options.context ? { context: options.context } : {}) };
  const byGroup = new Map<string, RibbonGroupModel>();
  for (const action of registry.actions(query)) {
    const group = action.group!;
    let found = byGroup.get(group.id);
    if (!found) byGroup.set(group.id, (found = { id: group.id, label: group.label, menu: false, actions: [], icon: undefined, sizes: {}, titles: {}, fold: 0, items: [] }));
    found.actions.push(action);
  }
  const groups = [...byGroup.values()];
  const declared = new Map(registry.ribbon().tabs.find((tab) => tab.id === selected)?.groups.map((group) => [group.id, group]));
  for (const group of groups) {
    const layout = declared.get(group.id);
    // P27 (R-252): the layout's `"menu": false` keeps a long group as buttons (it still folds when the ribbon is too narrow).
    group.menu = layout?.menu ?? group.actions.length > MENU_THRESHOLD;
    group.icon = layout?.icon ?? group.actions.find((a) => a.icon)?.icon;
    group.sizes = layout?.sizes ?? {};
    group.titles = layout?.titles ?? {};
    group.fold = layout?.fold ?? 0;
    group.items = arrangeButtons(group.actions, group.sizes);
  }
  return { tabs, groups };
}

/** The next tab for an arrow key, Home or End (wraps around); undefined for any other key. */
export function nextTab(ids: readonly string[], current: string, key: string): string | undefined {
  if (ids.length === 0) return undefined;
  const at = Math.max(0, ids.indexOf(current));
  if (key === 'ArrowRight') return ids[(at + 1) % ids.length];
  if (key === 'ArrowLeft') return ids[(at - 1 + ids.length) % ids.length];
  if (key === 'Home') return ids[0];
  if (key === 'End') return ids[ids.length - 1];
  return undefined;
}

/**
 * The accessible name of a button whose visible title is shorter than its label: it starts with the visible text (WCAG 2.5.3, so voice
 * control and a screen reader agree) and still holds the full label: "Bullets (Bulleted list)". Unchanged when the label already starts with the title.
 */
export function accessibleName(visible: string, label: string): string {
  const v = visible.trim().toLowerCase();
  const l = label.toLowerCase();
  return l === v || l.startsWith(`${v} `) ? label : `${visible.trim()} (${label})`;
}

/** A button's tooltip: its label, its shortcut when it has one, its description (P27), and a note when its syntax is switched off. */
export const buttonTitle = (action: Action, mac: boolean): string => {
  const named = action.keybinding ? `${action.label} (${formatKeybinding(action.keybinding, mac)})` : action.label;
  const title = action.description ? `${named}. ${action.description}` : named;
  return action.gate && !action.gate.satisfied ? `${title}. Needs ${action.gate.field} in the frontmatter.` : title;
};

export class Ribbon {
  readonly element: HTMLElement;
  /** Add this to the canvas's `pmPlugins`: it refreshes the buttons' state when the document or selection changes. */
  readonly plugin: Plugin;
  readonly #options: RibbonOptions;
  readonly #doc: Document;
  readonly #tablist: HTMLElement;
  readonly #panel: HTMLElement;
  readonly #buttons = new Map<string, HTMLElement[]>();
  #tabs: 'all' | readonly string[];
  #selected: string | undefined;
  /** The tabs that follow the cursor (autoTab, P19 round 3) and the tabs shown only in context (P20). */
  readonly #cursor: CursorTabs;
  /** How often the strip and panel were drawn (P20: a test checks it does not grow with every keystroke). */
  #redraws = 0;
  #pending: number | undefined;
  #groups: RibbonGroupModel[] = [];
  #width = 0;
  #observer: ResizeObserver | undefined;
  #openMenu: { button: HTMLElement; menu: HTMLElement } | undefined;
  readonly #onOutside = (event: Event): void => {
    if (this.#openMenu && !this.#openMenu.menu.contains(event.target as Node) && !this.#openMenu.button.contains(event.target as Node)) this.#closeMenu();
  };

  constructor(parent: HTMLElement, options: RibbonOptions) {
    this.#options = options;
    this.#tabs = options.tabs ?? 'all';
    this.#cursor = new CursorTabs(options);
    this.#doc = parent.ownerDocument;
    this.element = this.#doc.createElement('div');
    this.element.className = 'pmd-ribbon';
    // P13b (amendment 8a): the ribbon is a landmark of its own, so a screen reader can jump to it (and F6 lands in it).
    this.element.setAttribute('role', 'region');
    this.element.setAttribute('aria-label', 'Ribbon');
    this.#tablist = this.#doc.createElement('div');
    this.#tablist.className = 'pmd-ribbon-tabs';
    this.#tablist.setAttribute('role', 'tablist');
    this.#tablist.setAttribute('aria-label', 'Ribbon tabs');
    this.#panel = this.#doc.createElement('div');
    this.#panel.className = 'pmd-ribbon-panel';
    this.#panel.setAttribute('role', 'tabpanel');
    this.element.append(this.#tablist, this.#panel);
    this.#panel.addEventListener('keydown', (event) => this.#onPanelKey(event));
    this.#panel.addEventListener('focusin', (event) => this.#rove(event.target as HTMLElement));
    parent.prepend(this.element);
    this.#doc.addEventListener('pointerdown', this.#onOutside, true);
    this.plugin = new Plugin({
      view: (view) => {
        // ProseMirror builds this again whenever the canvas makes a new editor state (a document re-read): draw once.
        this.#followCursor(view.state);
        this.update();
        return {
          update: (view, previous) => {
            if (previous.doc.eq(view.state.doc) && previous.selection.eq(view.state.selection) && previous.storedMarks === view.state.storedMarks) return;
            this.#followCursor(view.state);
            this.update();
          },
        };
      },
    });
    // Narrow window (P17): groups fold into one drop-down button each, last first, before any button is lost.
    if (typeof ResizeObserver !== 'undefined') {
      this.#observer = new ResizeObserver(() => {
        const width = this.element.clientWidth;
        if (width === this.#width) return;
        this.#width = width;
        this.#fit();
      });
      this.#observer.observe(this.element);
    }
    this.refresh();
  }

  readonly #allowed = (id: string): boolean => this.#tabs === 'all' || this.#tabs.includes(id);

  /**
   * Selects the tab that belongs to where the cursor is (autoTab), puts the earlier one back on leaving, and shows or
   * hides the context tabs (P20). Redraws only when the strip or the selected tab changed.
   */
  #followCursor(state: EditorState | undefined): void {
    const next = this.#cursor.follow(state, this.#selected, this.#allowed);
    if (!next.changed) return;
    this.#selected = next.selected;
    this.refresh();
  }

  /** Is the tab `id` in the strip now (P20: the Image tab only while a picture is selected)? */
  shows(id: string): boolean {
    return !this.element.hidden && this.#cursor.present(id, this.#allowed);
  }

  /** How many times the strip was drawn (tests: it grows when the strip or the selected tab changes, not with every keystroke). */
  get redraws(): number {
    return this.#redraws;
  }

  /** Which tabs show (the view recipe's `ribbonTabs`); the context tabs are checked again (the canvas may be read-only now). */
  setTabs(tabs: 'all' | readonly string[]): void {
    this.#tabs = tabs;
    this.#selected = this.#cursor.follow(this.#options.context()?.state, this.#selected, this.#allowed).selected;
    this.refresh();
  }

  /** Redraws the tabs, groups and buttons (the structure changed: a view switch, new commands). */
  refresh(): void {
    this.#closeMenu();
    // A redraw replaces the buttons: what had the focus gets it back (a tab by id, a button by command), never the page.
    const had = this.element.contains(this.#doc.activeElement) ? (this.#doc.activeElement as HTMLElement) : null;
    const keep = had ? { id: had.id, command: had.dataset['command'] } : null;
    this.#redraws++;
    const model = ribbonModel(this.#options.registry, { context: this.#options.context(), tabs: this.#tabs, selected: this.#selected, hidden: this.#cursor.hidden() });
    this.#selected = model.tabs.find((tab) => tab.selected)?.id;
    this.element.hidden = model.tabs.length === 0;
    this.#tablist.replaceChildren(...model.tabs.map((tab) => this.#tab(tab, model.tabs.map((t) => t.id))));
    this.#groups = model.groups;
    this.#draw(new Set());
    this.#fit();
    this.#panel.id = `pmd-ribbon-panel`;
    this.#rove(undefined);
    if (keep && !this.element.contains(this.#doc.activeElement)) {
      const same = (keep.id ? this.#doc.getElementById(keep.id) : null) ?? (keep.command ? this.#panel.querySelector<HTMLElement>(`[data-command="${CSS.escape(keep.command)}"]`) : null);
      (same ?? (this.#selected ? this.#doc.getElementById(`pmd-ribbon-tab-${this.#selected}`) : null))?.focus();
    }
    if (this.#selected) this.#panel.setAttribute('aria-labelledby', `pmd-ribbon-tab-${this.#selected}`);
  }

  /** F6 lands here (P13b, R-208): the selected tab, so the arrow keys move between the tabs and Tab goes on to the buttons. */
  focusEntry(): boolean {
    const tab = this.#selected ? this.#doc.getElementById(`pmd-ribbon-tab-${this.#selected}`) : null;
    if (this.element.hidden || !tab) return false;
    tab.focus();
    return true;
  }

  /**
   * The panel's buttons are ONE Tab stop (P13b, amendment 8c): the arrow keys, Home and End move between them (a "roving"
   * tab index), instead of a Tab stop for every button. Menu items inside an open menu keep the menu's own keys.
   */
  #stops(): HTMLElement[] {
    return [...this.#panel.querySelectorAll<HTMLElement>('button')].filter((button) => !button.closest('.pmd-ribbon-menu'));
  }

  /** Makes `current` (or the first button) the panel's one Tab stop. */
  #rove(current: HTMLElement | undefined): void {
    const stops = this.#stops();
    const keep = current && stops.includes(current) ? current : (stops.find((stop) => stop.tabIndex === 0 && this.#panel.contains(stop)) ?? stops[0]);
    for (const stop of stops) stop.tabIndex = stop === keep ? 0 : -1;
  }

  #onPanelKey(event: KeyboardEvent): void {
    const target = event.target as HTMLElement;
    if (target.closest('.pmd-ribbon-menu')) return;
    if (event.key === 'Escape' && this.#options.exit) {
      event.preventDefault();
      this.#options.exit();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const stops = this.#stops();
    const at = stops.indexOf(target);
    if (at < 0) return;
    const to = event.key === 'ArrowRight' ? (at + 1) % stops.length : event.key === 'ArrowLeft' ? (at - 1 + stops.length) % stops.length : event.key === 'Home' ? 0 : event.key === 'End' ? stops.length - 1 : -1;
    if (to < 0) return;
    event.preventDefault();
    this.#closeMenu();
    stops[to]!.focus(); // (focusin makes it the Tab stop)
  }

  /** Re-reads every drawn button's enabled and active state (one frame at most, however often it is called). */
  update(): void {
    if (this.#pending !== undefined) return;
    const win = this.#doc.defaultView;
    const apply = (): void => {
      this.#pending = undefined;
      this.#apply();
    };
    this.#pending = win ? win.requestAnimationFrame(apply) : (setTimeout(apply, 0) as unknown as number);
  }

  /** Draws the groups, the ones named in `folded` as a drop-down button. */
  #draw(folded: ReadonlySet<string>): void {
    this.#closeMenu();
    this.#buttons.clear();
    this.#panel.replaceChildren(...this.#groups.map((group) => this.#group(group, folded.has(group.id))));
  }

  /**
   * Folds groups until the panel fits its width; a hidden or unmeasured ribbon (width 0) is left alone. P20 (AD-P20-09): if
   * the panel still does not fit with every group folded (a phone-narrow window), its drop-down buttons wrap onto a second
   * row instead of making the page scroll sideways.
   */
  #fit(): void {
    if (this.#panel.clientWidth === 0 || this.#groups.length === 0) return;
    this.#panel.classList.remove('pmd-ribbon-wrap');
    const overflows = (): boolean => this.#panel.scrollWidth > this.#panel.clientWidth + 1;
    this.#draw(new Set());
    const folded = foldGroups(foldCandidates(this.#groups), (set) => {
      this.#draw(set);
      return !overflows();
    });
    this.#draw(folded);
    this.#panel.classList.toggle('pmd-ribbon-wrap', overflows());
  }

  destroy(): void {
    this.#observer?.disconnect();
    this.#doc.removeEventListener('pointerdown', this.#onOutside, true);
    if (this.#pending !== undefined) this.#doc.defaultView?.cancelAnimationFrame(this.#pending);
    this.element.remove();
  }

  #apply(): void {
    if (!this.#selected) return;
    const context = this.#options.context();
    for (const action of this.#options.registry.actions({ surface: 'ribbon', tab: this.#selected, ...(context ? { context } : {}) })) {
      for (const button of this.#buttons.get(action.id) ?? []) setState(button, action);
    }
  }

  #tab(tab: { id: string; label: string; selected: boolean }, ids: string[]): HTMLElement {
    const button = this.#doc.createElement('button');
    button.type = 'button';
    button.id = `pmd-ribbon-tab-${tab.id}`;
    button.className = 'pmd-ribbon-tab';
    button.textContent = tab.label;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(tab.selected));
    button.setAttribute('aria-controls', 'pmd-ribbon-panel');
    button.tabIndex = tab.selected ? 0 : -1;
    button.addEventListener('mousedown', (event) => event.preventDefault()); // keep the editor's selection
    button.addEventListener('click', () => this.#select(tab.id));
    button.addEventListener('keydown', (event) => {
      const next = nextTab(ids, tab.id, event.key);
      if (next === undefined) return;
      event.preventDefault();
      this.#select(next, true);
    });
    return button;
  }

  #select(id: string, focus = false): void {
    this.#selected = id;
    this.refresh();
    if (focus) this.#doc.getElementById(`pmd-ribbon-tab-${id}`)?.focus();
  }

  #group(group: RibbonGroupModel, folded: boolean): HTMLElement {
    const element = this.#doc.createElement('div');
    element.className = 'pmd-ribbon-group';
    element.setAttribute('role', 'group');
    element.setAttribute('aria-label', group.label);
    const buttons = this.#doc.createElement('div');
    buttons.className = 'pmd-ribbon-buttons';
    const dropdown = group.menu || folded;
    if (dropdown) buttons.append(this.#menuButton(group));
    else
      for (const item of group.items) {
        if (item.kind === 'large') buttons.append(this.#button(item.action, 'pmd-ribbon-button pmd-ribbon-large', group.titles));
        else {
          const stack = this.#doc.createElement('div');
          stack.className = 'pmd-ribbon-stack';
          for (const action of item.actions) stack.append(this.#button(action, 'pmd-ribbon-button pmd-ribbon-small', group.titles));
          buttons.append(stack);
        }
      }
    // A drop-down button carries its group's name itself (as Office's collapsed groups do), so no second name under it.
    if (dropdown) {
      element.append(buttons);
      return element;
    }
    const label = this.#doc.createElement('div');
    label.className = 'pmd-ribbon-group-label';
    label.textContent = group.label;
    label.setAttribute('aria-hidden', 'true');
    element.append(buttons, label);
    return element;
  }

  #button(action: Action, className: string, titles: Readonly<Record<string, string>>, role?: string): HTMLElement {
    const button = this.#doc.createElement('button');
    button.type = 'button';
    button.className = className;
    button.dataset['command'] = action.id;
    // Icon first (P17), then a short title (the layout's, else the label). The full label stays the accessible name.
    const label = this.#doc.createElement('span');
    label.className = 'pmd-ribbon-label';
    label.textContent = ribbonTitle(action, titles);
    button.replaceChildren(...(action.icon ? [codicon(this.#doc, action.icon)] : []), label);
    if (label.textContent !== action.label) button.setAttribute('aria-label', accessibleName(label.textContent ?? '', action.label));
    button.title = buttonTitle(action, this.#options.mac ?? false);
    if (role) button.setAttribute('role', role);
    // The editor keeps its focus and selection while a button is pressed.
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', () => {
      if (button.getAttribute('aria-disabled') === 'true') return;
      this.#closeMenu();
      this.#options.run(action);
    });
    setState(button, action);
    const list = this.#buttons.get(action.id);
    if (list) list.push(button);
    else this.#buttons.set(action.id, [button]);
    return button;
  }

  #menuButton(group: RibbonGroupModel): HTMLElement {
    const wrap = this.#doc.createElement('div');
    wrap.className = 'pmd-ribbon-menu-wrap';
    const button = this.#doc.createElement('button');
    button.type = 'button';
    button.className = 'pmd-ribbon-button pmd-ribbon-large pmd-ribbon-menu-button';
    const label = this.#doc.createElement('span');
    label.className = 'pmd-ribbon-label';
    label.textContent = `${group.label} ▾`;
    button.replaceChildren(...(group.icon ? [codicon(this.#doc, group.icon)] : []), label);
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    const menu = this.#doc.createElement('div');
    menu.className = 'pmd-ribbon-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', group.label);
    menu.hidden = true;
    for (const action of group.actions) menu.append(this.#button(action, 'pmd-ribbon-menu-item', {}, 'menuitem'));
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', () => (this.#openMenu?.button === button ? this.#closeMenu() : this.#open(button, menu)));
    const items = (): HTMLElement[] => [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].filter((item) => item.getAttribute('aria-disabled') !== 'true');
    const move = (from: HTMLElement | null, step: number): void => {
      const list = items();
      if (list.length === 0) return;
      const at = from ? list.indexOf(from) : -1;
      list[(at + step + list.length) % list.length]!.focus();
    };
    button.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        if (this.#openMenu?.button !== button) this.#open(button, menu);
        move(null, 1);
      }
    });
    menu.addEventListener('keydown', (event) => {
      const active = this.#doc.activeElement as HTMLElement | null;
      if (event.key === 'ArrowDown') (event.preventDefault(), move(active, 1));
      else if (event.key === 'ArrowUp') (event.preventDefault(), move(active, -1));
      else if (event.key === 'Escape') {
        event.preventDefault();
        this.#closeMenu();
        button.focus();
      }
    });
    wrap.append(button, menu);
    return wrap;
  }

  #open(button: HTMLElement, menu: HTMLElement): void {
    this.#closeMenu();
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    this.#openMenu = { button, menu };
  }

  #closeMenu(): void {
    if (!this.#openMenu) return;
    this.#openMenu.menu.hidden = true;
    this.#openMenu.button.setAttribute('aria-expanded', 'false');
    this.#openMenu = undefined;
  }
}

/** VS Code's own icon (codicons, R-162; the app loads the font). Hidden from screen readers: the text says it. */
function codicon(doc: Document, name: string): HTMLElement {
  const span = doc.createElement('span');
  span.className = `codicon codicon-${name}`;
  span.setAttribute('aria-hidden', 'true');
  return span;
}

function setState(button: HTMLElement, action: Action): void {
  button.setAttribute('aria-disabled', String(!action.enabled));
  // P19 round 3: an action that is off can say why (a table not in standard form): the tooltip (a button's description) says it.
  const base = button.dataset['title'] ?? button.title;
  button.dataset['title'] = base;
  button.title = !action.enabled && action.reason ? `${base}. Off: ${action.reason}` : base;
  // Only a toggle can be pressed or not; a one-shot button (Insert Table) says nothing about it.
  if (button.getAttribute('role') === 'menuitem') {
    if (action.toggle && action.active) button.setAttribute('aria-current', 'true');
    else button.removeAttribute('aria-current');
  } else if (action.toggle) button.setAttribute('aria-pressed', String(action.active));
  else button.removeAttribute('aria-pressed');
  if (action.gate && !action.gate.satisfied) button.dataset['gated'] = 'true';
  else delete button.dataset['gated'];
}

/** Editor UI, so it uses the VS Code theme variables. */
export const ribbonCss = `
.pmd-ribbon { position: relative; z-index: 40; flex: none; font-family: var(--vscode-font-family); background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); border-bottom: 1px solid var(--vscode-panel-border, transparent); font-size: 12px; color: var(--vscode-foreground); }
.pmd-ribbon[hidden] { display: none; }
.pmd-ribbon-tabs { display: flex; flex-wrap: wrap; gap: 2px; padding: 2px 8px 0; }
.pmd-ribbon-tab { font: inherit; color: var(--vscode-foreground); background: transparent; border: 0; border-bottom: 2px solid transparent; padding: 3px 10px; cursor: pointer; }
.pmd-ribbon-tab[aria-selected="true"] { border-bottom-color: var(--vscode-focusBorder, currentColor); }
.pmd-ribbon-tab:hover { background: var(--vscode-toolbar-hoverBackground, transparent); }
.pmd-ribbon-panel { display: flex; flex-wrap: nowrap; align-items: stretch; gap: 0; padding: 4px 8px 2px; }
.pmd-ribbon-panel.pmd-ribbon-wrap { flex-wrap: wrap; row-gap: 4px; }
.pmd-ribbon-group { flex: none; display: flex; flex-direction: column; padding: 0 6px; border-right: 1px solid var(--vscode-panel-border, transparent); }
.pmd-ribbon-group:last-child { border-right: 0; }
.pmd-ribbon-buttons { display: flex; flex-wrap: nowrap; gap: 2px; flex: 1; align-items: flex-start; }
.pmd-ribbon-group-label { text-align: center; color: var(--vscode-descriptionForeground); font-size: 11px; padding-top: 2px; white-space: nowrap; }
.pmd-ribbon-stack { display: flex; flex-direction: column; gap: 0; align-items: stretch; }
.pmd-ribbon-button, .pmd-ribbon-menu-item { font: inherit; color: var(--vscode-foreground); background: transparent; border: 1px solid transparent; border-radius: 3px; padding: 2px 8px; cursor: pointer; text-align: left; white-space: nowrap; display: inline-flex; align-items: center; gap: 4px; }
.pmd-ribbon-small { padding: 1px 6px; font-size: 11px; }
.pmd-ribbon-large { position: relative; flex-direction: column; justify-content: flex-start; gap: 2px; min-width: 48px; max-width: 76px; padding: 3px 4px; text-align: center; white-space: normal; font-size: 11px; line-height: 13px; }
.pmd-ribbon-large .pmd-ribbon-label { display: block; overflow-wrap: anywhere; }
.pmd-ribbon .codicon { font-size: 14px; color: var(--vscode-icon-foreground, var(--vscode-foreground)); }
.pmd-ribbon-large .codicon { font-size: 24px; width: 24px; height: 24px; line-height: 24px; text-align: center; }
.pmd-ribbon-button:hover, .pmd-ribbon-menu-item:hover { background: var(--vscode-toolbar-hoverBackground, transparent); }
.pmd-ribbon-button[aria-pressed="true"], .pmd-ribbon-menu-item[aria-current="true"] { background: var(--vscode-toolbar-activeBackground, var(--vscode-list-activeSelectionBackground)); border-color: var(--vscode-focusBorder, transparent); }
.pmd-ribbon-button[aria-disabled="true"], .pmd-ribbon-menu-item[aria-disabled="true"] { opacity: 0.45; cursor: default; }
.pmd-ribbon-button[data-gated="true"]::after, .pmd-ribbon-menu-item[data-gated="true"]::after { content: " \\2022"; color: var(--vscode-editorWarning-foreground); }
.pmd-ribbon-large[data-gated="true"]::after { content: "\\2022"; position: absolute; top: 0; right: 4px; }
.pmd-ribbon button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.pmd-ribbon-menu-wrap { position: relative; }
.pmd-ribbon-menu { position: absolute; z-index: 20; top: 100%; left: 0; min-width: 14em; max-height: 60vh; overflow: auto; display: flex; flex-direction: column; padding: 4px; background: var(--vscode-menu-background, var(--vscode-editorWidget-background)); color: var(--vscode-menu-foreground, var(--vscode-foreground)); border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border, transparent)); box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0,0,0,.3)); }
.pmd-ribbon-menu[hidden] { display: none; }
`;
