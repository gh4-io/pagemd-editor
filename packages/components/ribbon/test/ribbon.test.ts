// The ribbon's model against a fake registry (P7): which tabs and groups it draws, when a group becomes a menu, how
// the arrow keys move between tabs, and the button tooltips. The drawing itself is in test/e2e/ribbon.spec.ts.
import { Schema } from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { createRegistry, type Action, ItemRegistry, ViewState, type CommandSpec, type RibbonLayout, type SyntaxItem } from '@pagemd-editor/core';
import { accessibleName, arrangeButtons, buttonTitle, CursorTabs, foldCandidates, foldGroups, MENU_THRESHOLD, nextTab, ribbonModel, ribbonTitle, STACK_HEIGHT } from '../src/index.ts';

const schema = new Schema({ nodes: { doc: { content: 'paragraph+' }, paragraph: { content: 'text*', toDOM: () => ['p', 0] }, text: {} } });
const state = EditorState.create({ schema });
const command = (id: string, extra: Partial<CommandSpec> = {}): CommandSpec => ({ id, label: id.toUpperCase(), isEnabled: () => true, run: () => true, ...extra });
const item = (id: string, commands: CommandSpec[], extra: Partial<SyntaxItem> = {}): SyntaxItem => ({ id, group: 'text', schema: {}, fromTokens: {}, toMarkdown: {}, label: id, icon: id, commands, ...extra });

const many = Array.from({ length: MENU_THRESHOLD + 1 }, (_, i) => `box.${i}`);
const layout: RibbonLayout = {
  version: 1,
  tabs: [
    { id: 'home', label: 'Home', groups: [{ id: 'text', label: 'Text', commands: ['bold', 'italic'] }, { id: 'boxes', label: 'Box', commands: many }] },
    { id: 'view', label: 'View', groups: [{ id: 'mode', label: 'View', commands: ['view.draft'] }] },
  ],
};
const registry = createRegistry({
  items: new ItemRegistry([item('bold', [command('bold', { keybinding: 'Mod-b' }), command('italic', { isEnabled: () => false })]), item('box', many.map((id) => command(id)))]),
  view: new ViewState(),
  ribbonLayout: layout,
  commands: [command('view.draft', { kind: 'view' })],
});

describe('ribbonModel', () => {
  it('lists the tabs and the selected tab\'s groups with their actions', () => {
    const model = ribbonModel(registry, { context: { state, editable: true } });
    expect(model.tabs).toEqual([
      { id: 'home', label: 'Home', selected: true },
      { id: 'view', label: 'View', selected: false },
    ]);
    expect(model.groups.map((g) => [g.id, g.menu, g.actions.length])).toEqual([['text', false, 2], ['boxes', true, MENU_THRESHOLD + 1]]);
    expect(model.groups[0]!.actions.map((a) => a.enabled)).toEqual([true, false]);
  });
  it('a group becomes a drop-down only above the threshold', () => {
    expect(ribbonModel(registry, {}).groups.map((g) => g.menu)).toEqual([false, true]);
    expect(MENU_THRESHOLD).toBe(6);
  });
  it('selects the tab asked for, falling back to the first shown tab', () => {
    expect(ribbonModel(registry, { selected: 'view' }).groups.map((g) => g.id)).toEqual(['mode']);
    expect(ribbonModel(registry, { selected: 'nope' }).tabs[0]!.selected).toBe(true);
  });
  it('shows only the tabs a view recipe allows (Read: the View tab only)', () => {
    const read = ribbonModel(registry, { tabs: ['view'], selected: 'home' });
    expect(read.tabs).toEqual([{ id: 'view', label: 'View', selected: true }]);
    expect(read.groups.map((g) => g.id)).toEqual(['mode']);
    expect(ribbonModel(registry, { tabs: [] })).toEqual({ tabs: [], groups: [] });
  });
});

describe('nextTab', () => {
  const ids = ['home', 'insert', 'view'];
  it('moves with the arrow keys, wrapping, and Home/End jump', () => {
    expect(nextTab(ids, 'home', 'ArrowRight')).toBe('insert');
    expect(nextTab(ids, 'view', 'ArrowRight')).toBe('home');
    expect(nextTab(ids, 'home', 'ArrowLeft')).toBe('view');
    expect(nextTab(ids, 'insert', 'Home')).toBe('home');
    expect(nextTab(ids, 'insert', 'End')).toBe('view');
    expect(nextTab(ids, 'insert', 'a')).toBeUndefined();
    expect(nextTab([], 'x', 'ArrowRight')).toBeUndefined();
  });
});

describe('buttonTitle', () => {
  it('adds the shortcut (Windows/Linux or Mac) and a note when the syntax is switched off', () => {
    const [bold] = registry.actions({ surface: 'ribbon', tab: 'home' });
    expect(buttonTitle(bold!, false)).toBe('BOLD (Ctrl+B)');
    expect(buttonTitle(bold!, true)).toBe('BOLD (⌘B)');
    expect(buttonTitle({ ...bold!, keybinding: undefined as never, gate: { field: 'fancy_lists', value: true, satisfied: false } }, false)).toBe('BOLD. Needs fancy_lists in the frontmatter.');
  });
});

describe('P17: the icon-first layout', () => {
  const act = (id: string): Action => ({ id, kind: 'edit', label: id.toUpperCase(), keywords: [], toggle: false, enabled: true, active: false });
  const ids = (items: ReturnType<typeof arrangeButtons>): string[] => items.map((i) => (i.kind === 'large' ? `L:${i.action.id}` : `S:${i.actions.map((a) => a.id).join('')}`));

  it('large commands stand alone and runs of small ones stack three to a column; a command with no size is small', () => {
    const list = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(act);
    expect(STACK_HEIGHT).toBe(3);
    expect(ids(arrangeButtons(list, {}))).toEqual(['S:abc', 'S:def', 'S:g']);
    expect(ids(arrangeButtons(list, { a: 'large', d: 'large' }))).toEqual(['L:a', 'S:bc', 'L:d', 'S:efg']);
    expect(ids(arrangeButtons(list, { a: 'small', b: 'large' }))).toEqual(['S:a', 'L:b', 'S:cde', 'S:fg']);
  });

  it('the short title is the layout\'s, else the full label', () => {
    expect(ribbonTitle(act('a'), { a: 'Short' })).toBe('Short');
    expect(ribbonTitle(act('a'), {})).toBe('A');
  });

  it('foldGroups folds from the last group backwards, only as many as it takes, and stops when nothing is left', () => {
    expect([...foldGroups(['a', 'b', 'c'], () => true)]).toEqual([]);
    expect([...foldGroups(['a', 'b', 'c'], (f) => f.size >= 2)]).toEqual(['c', 'b']);
    expect([...foldGroups(['a', 'b'], () => false)]).toEqual(['b', 'a']);
  });

  it('the model carries the layout\'s icon, sizes and titles; a group with no icon takes its first command\'s', () => {
    const sized = createRegistry({
      items: new ItemRegistry([item('bold', [command('bold', { icon: 'bold' }), command('italic', { icon: 'italic' })])]),
      view: new ViewState(),
      ribbonLayout: { version: 1, tabs: [{ id: 'home', label: 'Home', groups: [{ id: 'text', label: 'Text', commands: ['bold', 'italic'], sizes: { bold: 'large' }, titles: { bold: 'B' } }, { id: 'plain', label: 'Plain', icon: 'star', commands: [] }] }] },
    });
    const [group] = ribbonModel(sized, {}).groups;
    expect(group).toMatchObject({ icon: 'bold', sizes: { bold: 'large' }, titles: { bold: 'B' } });
    expect(ids(group!.items)).toEqual(['L:bold', 'S:italic']);
  });
});

describe('accessibleName (P13b: the name starts with the visible text)', () => {
  it('adds the full label after a short title, and leaves a label that already starts with it', () => {
    expect(accessibleName('Bullets', 'Bulleted list')).toBe('Bullets (Bulleted list)');
    expect(accessibleName('Bold', 'Bold')).toBe('Bold');
    expect(accessibleName('Strike', 'Strikethrough')).toBe('Strike (Strikethrough)'); // whole words only
  });
});

describe('P20: a tab that is in the strip only in context (contextTabs) and the ordered automatic tab', () => {
  /** Where the cursor is, standing in for an editor state (the rules only look at this). */
  type Place = 'text' | 'picture' | 'cell' | 'cell-picture';
  const at = (place: Place): EditorState => ({ place }) as unknown as EditorState;
  const placeOf = (s: EditorState): Place => (s as unknown as { place: Place }).place;
  const picture = (s: EditorState): boolean => placeOf(s) === 'picture' || placeOf(s) === 'cell-picture';
  const cell = (s: EditorState): boolean => placeOf(s) === 'cell';
  // The app's rules: first match wins (AD-P20-02); the Image tab exists only with a picture selected.
  const make = (rule: (s: EditorState) => boolean = picture): CursorTabs =>
    new CursorTabs({ autoTab: (s) => (picture(s) ? 'image' : cell(s) || placeOf(s) === 'cell-picture' ? 'table' : null), contextTabs: { image: rule } });
  const all = (): boolean => true;

  /** Plays a list of places from `start`; a string starting with "#" is a tab picked by hand. Returns the selected tab and the strip after each step. */
  function play(tabs: CursorTabs, steps: (Place | `#${string}`)[], start = 'home', allowed: (id: string) => boolean = all) {
    let selected: string | undefined = start;
    let redraws = 0;
    const seen: { selected: string | undefined; image: boolean }[] = [];
    for (const step of steps) {
      if (step.startsWith('#')) selected = step.slice(1);
      else {
        const next = tabs.follow(at(step as Place), selected, allowed);
        if (next.changed) redraws++;
        selected = next.selected;
      }
      seen.push({ selected, image: tabs.present('image', allowed) });
    }
    return { seen, redraws, selected };
  }

  it('the Image tab is not in the strip until a picture is selected; then it is there and comes forward; text: gone, and the earlier tab is back', () => {
    const tabs = make();
    tabs.follow(at('text'), 'home', all);
    expect(tabs.hidden()).toEqual(new Set(['image']));
    expect(ribbonModel(registry, { hidden: tabs.hidden() }).tabs.map((t) => t.id)).toEqual(['home', 'view']);
    const { seen } = play(tabs, ['picture', 'text'], 'insert');
    expect(seen).toEqual([
      { selected: 'image', image: true },
      { selected: 'insert', image: false },
    ]);
    expect(tabs.hidden()).toEqual(new Set(['image']));
  });

  it('a hand-picked tab is kept while the picture stays selected, and kept when the picture is unselected (the Image tab then goes)', () => {
    const { seen } = play(make(), ['picture', '#view', 'picture', 'text']);
    expect(seen.map((s) => s.selected)).toEqual(['image', 'view', 'view', 'view']);
    expect(seen.map((s) => s.image)).toEqual([true, true, true, false]);
  });

  it('a picture in a table cell: Image wins while it is selected, Table comes back on the cell text, leaving the table gives the tab from before the table', () => {
    const { seen } = play(make(), ['cell', 'cell-picture', 'cell', 'text'], 'home');
    expect(seen.map((s) => s.selected)).toEqual(['table', 'image', 'table', 'home']);
    // Straight from the text onto a picture in a cell, then the cell text, then out.
    expect(play(make(), ['cell-picture', 'cell', 'text'], 'layout').seen.map((s) => s.selected)).toEqual(['image', 'table', 'layout']);
  });

  it('the view decides first: in Read (View only) the Image tab never shows and nothing is pulled forward', () => {
    const read = (id: string): boolean => id === 'view';
    const { seen } = play(make(), ['picture', 'text'], 'view', read);
    expect(seen).toEqual([
      { selected: 'view', image: false },
      { selected: 'view', image: false },
    ]);
  });

  it('a selected context tab whose rule turns false falls back to the tab from before, else the first tab', () => {
    // No automatic tab: only the context rule, so the fallback path is the one that runs.
    const tabs = new CursorTabs({ contextTabs: { image: picture } });
    expect(tabs.follow(at('picture'), 'insert', all)).toEqual({ selected: 'insert', changed: true }); // shown, not pulled forward
    expect(tabs.follow(at('picture'), 'image', all)).toEqual({ selected: 'image', changed: false }); // picked by hand
    expect(tabs.follow(at('text'), 'image', all)).toEqual({ selected: undefined, changed: true }); // ribbonModel then takes the first tab
  });

  it('redraws only when the strip or the selected tab changes: typing in the text or moving around the picture does not redraw', () => {
    const { redraws } = play(make(), ['text', 'text', 'text', 'picture', 'picture', 'picture', 'text', 'text', 'text']);
    expect(redraws).toBe(2); // the Image tab in, and out
  });

  it('control: an always-true rule keeps the tab in the strip, and a lost "before" would not bring the earlier tab back', () => {
    const always = play(make(() => true), ['text', 'picture', 'text'], 'insert');
    expect(always.seen.map((s) => s.image)).toEqual([true, true, true]); // the first test's "not in the strip" would fail
    const tabs = make();
    play(tabs, ['picture'], 'insert');
    // Without the before-memory the leaving step would have nowhere to go back to: the first tab, not Insert.
    const forgetful = new CursorTabs({ autoTab: () => null, contextTabs: { image: picture } });
    forgetful.follow(at('picture'), 'image', all);
    expect(forgetful.follow(at('text'), 'image', all).selected).toBeUndefined();
    expect(tabs.follow(at('text'), 'image', all).selected).toBe('insert');
  });

  it('fold order: a higher "fold" number folds first; equal numbers keep the last-group-first order; drop-down groups never fold', () => {
    const g = (id: string, fold = 0, menu = false) => ({ id, fold, menu });
    // The Image tab: Adjust, Size, Shapes (a menu), Caption 2, Details 3, Convert 1 → Details, Caption, Convert, Size, Adjust.
    const order = foldCandidates([g('adjust'), g('size'), g('shapes', 0, true), g('caption', 2), g('details', 3), g('convert', 1)]);
    expect([...foldGroups(order, () => false)]).toEqual(['details', 'caption', 'convert', 'size', 'adjust']);
    expect([...foldGroups(order, (f) => f.size >= 3)]).toEqual(['details', 'caption', 'convert']);
    expect(foldCandidates([g('a'), g('b'), g('c')])).toEqual(['a', 'b', 'c']); // P17's order unchanged
  });
});
