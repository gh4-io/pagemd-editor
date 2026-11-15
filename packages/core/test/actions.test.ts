// P7 (ADR-0013 amendment, R-156): what the registry hands the three surfaces: `actions()`, the ribbon layout file's
// rules (`parseRibbonLayout`, `ribbon()` dropping what doesn't exist), shortcut hints, and the action runner with
// its gated-insert policy. Everything runs against a fake registry: no preset, no DOM.
import { Schema } from 'prosemirror-model';
import { EditorState, TextSelection, type Transaction } from 'prosemirror-state';
import { describe, expect, it, vi } from 'vitest';
import {
  createActionRunner,
  createRegistry,
  formatKeybinding,
  ItemRegistry,
  parseRibbonLayout,
  ViewState,
  type Action,
  type ActionContext,
  type CommandSpec,
  type GatePolicy,
  type PropertiesProvider,
  type RibbonLayout,
  type SyntaxItem,
} from '../src/index.ts';

const schema = new Schema({ nodes: { doc: { content: 'paragraph+' }, paragraph: { content: 'text*', group: 'block', toDOM: () => ['p', 0] }, text: {} } });
const stateOf = (text = 'hello world'): EditorState => {
  const state = EditorState.create({ schema, doc: schema.node('doc', null, [schema.node('paragraph', null, text ? [schema.text(text)] : [])]) });
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, 1)));
};
const context = (extra: Partial<ActionContext> = {}): ActionContext => ({ state: stateOf(), editable: true, ...extra });

const command = (id: string, extra: Partial<CommandSpec> = {}): CommandSpec => ({ id, label: id, isEnabled: () => true, run: () => true, ...extra });
const item = (id: string, commands: CommandSpec[], extra: Partial<SyntaxItem> = {}): SyntaxItem => ({
  id,
  group: 'text',
  schema: {},
  fromTokens: {},
  toMarkdown: {},
  label: id,
  icon: id,
  commands,
  ...extra,
});

const layout: RibbonLayout = {
  version: 1,
  tabs: [
    {
      id: 'home',
      label: 'Home',
      groups: [
        { id: 'text', label: 'Text', commands: ['bold.toggle', 'ghost.command', 'italic.toggle'] },
        { id: 'lists', label: 'Lists', commands: ['fancy.lower', 'fancy.upper'] },
      ],
    },
    { id: 'insert', label: 'Insert', groups: [{ id: 'tools', label: 'Image tools', reserved: true, commands: [] }, { id: 'blocks', label: 'Blocks', commands: ['table.insert'] }] },
    { id: 'empty', label: 'Empty', groups: [{ id: 'gone', label: 'Gone', commands: ['ghost.one', 'ghost.two'] }] },
  ],
};

function build(options: { layout?: RibbonLayout; extraItems?: SyntaxItem[]; commands?: CommandSpec[]; properties?: PropertiesProvider } = {}) {
  const items = new ItemRegistry([
    item('bold', [command('bold.toggle', { label: 'Bold', keybinding: 'Mod-b', toolbar: true, isActive: () => true })]),
    item('italic', [command('italic.toggle', { label: 'Italic', toolbar: true, isEnabled: () => false })]),
    item('table', [command('table.insert', { label: 'Table' })], { slash: { keywords: ['grid', 'rows'] } }),
    item('fancy', [command('fancy.lower', { label: 'Lettered list', keywords: ['letter'] }), command('fancy.upper', { label: 'Upper list', slash: false })], {
      slash: { keywords: ['list', 'fancy'] },
      gate: { field: 'fancy_lists', value: true },
    }),
    item('loose', [command('loose.thing', { label: 'Loose thing' })]),
    item('forced', [command('forced.thing', { label: 'Forced thing', slash: true })]),
    ...(options.extraItems ?? []),
  ]);
  return createRegistry({ items, view: new ViewState(), ribbonLayout: options.layout ?? layout, ...(options.commands ? { commands: options.commands } : {}), ...(options.properties ? { properties: options.properties } : {}) });
}

describe('Registry.ribbon()', () => {
  const ribbon = build().ribbon();
  it('drops command ids no command has, then empty groups and tabs', () => {
    expect(ribbon.tabs.map((t) => t.id)).toEqual(['home', 'insert', 'more']); // 'empty' is gone with its two ghosts
    expect(ribbon.tabs[0]!.groups.find((g) => g.id === 'text')!.commands).toEqual(['bold.toggle', 'italic.toggle']);
  });
  it('leaves a reserved group out while it holds nothing, and shows it once its commands exist', () => {
    expect(ribbon.tabs[1]!.groups.map((g) => g.id)).toEqual(['blocks']);
    const later: RibbonLayout = { version: 1, tabs: [{ id: 'insert', label: 'Insert', groups: [{ id: 'tools', label: 'Image tools', reserved: true, commands: ['image.crop'] }] }] };
    const registry = build({ layout: later, commands: [command('image.crop', { label: 'Crop' })] });
    expect(registry.ribbon().tabs[0]!.groups).toEqual([{ id: 'tools', label: 'Image tools', reserved: true, commands: ['image.crop'] }]);
  });
  it('puts every unplaced command in More', () => {
    expect(ribbon.tabs.at(-1)!.groups[0]!.commands).toEqual(['loose.thing', 'forced.thing']);
  });
  it('is computed on each call: a command added later shows up', () => {
    const registry = build();
    registry.commands.add(command('late.command', { label: 'Late' }));
    expect(registry.ribbon().tabs.at(-1)!.groups[0]!.commands).toContain('late.command');
  });
  it('commands that belong to no item (the app\'s view commands) are placed like any other', () => {
    const registry = build({ commands: [command('view.draft', { kind: 'view' })], layout: { version: 1, tabs: [{ id: 'view', label: 'View', groups: [{ id: 'v', label: 'View', commands: ['view.draft'] }] }] } });
    expect(registry.ribbon().tabs.map((t) => t.id)).toEqual(['view', 'more']);
  });
});

describe('Registry.actions()', () => {
  const registry = build();
  it('ribbon: the layout order for a tab, each action knowing its group', () => {
    const actions = registry.actions({ surface: 'ribbon', tab: 'home' });
    expect(actions.map((a) => [a.id, a.group!.id])).toEqual([
      ['bold.toggle', 'text'],
      ['italic.toggle', 'text'],
      ['fancy.lower', 'lists'],
      ['fancy.upper', 'lists'],
    ]);
    expect(registry.actions({ surface: 'ribbon' }).length).toBeGreaterThan(actions.length); // no tab: every tab
  });
  it('enabled and active come from the command and the editor state; without a context everything is enabled', () => {
    const [bold, italic] = registry.actions({ surface: 'ribbon', tab: 'home', context: context() });
    expect([bold!.enabled, bold!.active, italic!.enabled, italic!.active]).toEqual([true, true, false, false]);
    expect(registry.actions({ surface: 'ribbon', tab: 'home' }).every((a) => a.enabled && !a.active)).toBe(true);
  });
  it('edit commands are disabled in a read-only canvas; view commands are not', () => {
    const view = build({ commands: [command('view.draft', { kind: 'view' })] });
    const read = (id: string) => view.actions({ surface: 'ribbon', context: context({ editable: false }) }).find((a) => a.id === id)!;
    expect(read('bold.toggle').enabled).toBe(false);
    expect(view.actions({ surface: 'ribbon', context: context({ editable: false }) }).find((a) => a.id === 'view.draft')!.enabled).toBe(true);
  });
  it('toolbar: only commands marked toolbar', () => {
    expect(registry.actions({ surface: 'toolbar' }).map((a) => a.id)).toEqual(['bold.toggle', 'italic.toggle']);
  });
  it('slash: commands whose item has slash keywords (slash: true forces, slash: false hides), searched in label and keywords', () => {
    expect(registry.actions({ surface: 'slash' }).map((a) => a.id)).toEqual(['table.insert', 'fancy.lower', 'forced.thing']);
    expect(registry.actions({ surface: 'slash', search: 'GRID' }).map((a) => a.id)).toEqual(['table.insert']); // item keyword, case-insensitive
    expect(registry.actions({ surface: 'slash', search: 'letter' }).map((a) => a.id)).toEqual(['fancy.lower']);
    expect(registry.actions({ surface: 'slash', search: 'fancy' }).map((a) => a.id)).toEqual([]); // the command's own keywords replace the item's
    expect(registry.actions({ surface: 'slash', search: 'xyz' })).toEqual([]);
  });
  it('slash: label matches rank before keyword matches', () => {
    const ranked = build({
      extraItems: [item('zeta', [command('zeta.one', { label: 'Plain', keywords: ['table'] }), command('zeta.two', { label: 'Tabletop' })], { slash: { keywords: [] } })],
    });
    expect(ranked.actions({ surface: 'slash', search: 'table' }).map((a) => a.id)).toEqual(['table.insert', 'zeta.two', 'zeta.one']); // starts with, contains, keyword
  });
  it('gated actions say whether their gate is on, from the document\'s gate values', () => {
    const off = registry.actions({ surface: 'ribbon', tab: 'home', context: context({ gates: { fancy_lists: false } }) }).find((a) => a.id === 'fancy.lower')!;
    expect(off.gate).toEqual({ field: 'fancy_lists', value: true, satisfied: false });
    const on = registry.actions({ surface: 'ribbon', tab: 'home', context: context({ gates: { fancy_lists: true } }) }).find((a) => a.id === 'fancy.lower')!;
    expect(on.gate!.satisfied).toBe(true);
    expect(registry.actions({ surface: 'ribbon', tab: 'home' }).find((a) => a.id === 'bold.toggle')!.gate).toBeUndefined();
  });
  it('picks up commands added after the first call', () => {
    const live = build();
    expect(live.actions({ surface: 'toolbar' })).toHaveLength(2);
    live.commands.add(command('late.bold', { toolbar: true }));
    expect(live.actions({ surface: 'toolbar' })).toHaveLength(3);
  });
});

describe('Action.toggle and Registry.action()', () => {
  const registry = build();
  it('only a command with isActive is a toggle (a one-shot button is not "pressed" or "not pressed")', () => {
    const byId = (id: string) => registry.actions({ surface: 'ribbon' }).find((a) => a.id === id)!;
    expect(byId('bold.toggle').toggle).toBe(true);
    expect(byId('italic.toggle').toggle).toBe(false);
    expect(byId('table.insert').toggle).toBe(false);
  });
  it('one command as an action, from any surface, with its gate from the context', () => {
    const action = registry.action('forced.thing', context())!;
    expect(action).toMatchObject({ id: 'forced.thing', label: 'Forced thing', enabled: true });
    const gated = registry.action('fancy.upper', context({ gates: { fancy_lists: false } }))!;
    expect(gated.gate).toEqual({ field: 'fancy_lists', value: true, satisfied: false });
    expect(registry.action('nope')).toBeUndefined();
  });
});

describe('formatKeybinding', () => {
  it('writes ProseMirror key names readably, for Windows/Linux and for a Mac', () => {
    expect(formatKeybinding('Mod-b', false)).toBe('Ctrl+B');
    expect(formatKeybinding('Mod-Shift-x', false)).toBe('Ctrl+Shift+X');
    expect(formatKeybinding('Mod-Alt-1', false)).toBe('Ctrl+Alt+1');
    expect(formatKeybinding('Mod-b', true)).toBe('⌘B');
    expect(formatKeybinding('Mod-Shift-x', true)).toBe('⇧⌘X');
    expect(formatKeybinding('Mod-Shift-.', false)).toBe('Ctrl+Shift+.');
    expect(formatKeybinding('Mod--', false)).toBe('Ctrl+-');
  });
});

describe('parseRibbonLayout', () => {
  const group = (extra: Record<string, unknown>) => ({ version: 1, tabs: [{ id: 'a', label: 'A', groups: [{ id: 'g', label: 'G', commands: ['a'], ...extra }] }] });
  it('P17: keeps a group\'s icon, sizes and short titles', () => {
    const json = group({ icon: 'bold', sizes: { a: 'large' }, titles: { a: 'Bold' } });
    expect(parseRibbonLayout(json).tabs[0]!.groups[0]).toEqual({ id: 'g', label: 'G', commands: ['a'], icon: 'bold', sizes: { a: 'large' }, titles: { a: 'Bold' } });
  });
  const ok = { version: 1, tabs: [{ id: 'home', label: 'Home', groups: [{ id: 'g', label: 'G', commands: ['a'] }] }] };
  it('accepts a good file, keeping `reserved`', () => {
    expect(parseRibbonLayout(ok)).toEqual(ok);
    const reserved = { version: 1, tabs: [{ id: 'home', label: 'Home', groups: [{ id: 'g', label: 'G', reserved: true, commands: [] }] }] };
    expect(parseRibbonLayout(reserved).tabs[0]!.groups[0]!.reserved).toBe(true);
  });
  it.each([
    ['not an object', 5, /the file must be an object/],
    ['no version', { tabs: [] }, /"version" must be 1/],
    ['another version', { version: 2, tabs: [] }, /"version" must be 1/],
    ['no tabs list', { version: 1 }, /"tabs" must be a list/],
    ['a tab without an id', { version: 1, tabs: [{ label: 'x', groups: [] }] }, /tab 1 "id"/],
    ['a tab without groups', { version: 1, tabs: [{ id: 'a', label: 'A' }] }, /needs a "groups" list/],
    ['two tabs with one id', { version: 1, tabs: [{ id: 'a', label: 'A', groups: [] }, { id: 'a', label: 'B', groups: [] }] }, /two tabs share the id 'a'/],
    ['two groups with one id', { version: 1, tabs: [{ id: 'a', label: 'A', groups: [{ id: 'g', label: 'G', commands: [] }] }, { id: 'b', label: 'B', groups: [{ id: 'g', label: 'H', commands: [] }] }] }, /two groups share the id 'g'/],
    ['commands that are not text', { version: 1, tabs: [{ id: 'a', label: 'A', groups: [{ id: 'g', label: 'G', commands: [1] }] }] }, /needs a "commands" list/],
    ['a bad reserved flag', { version: 1, tabs: [{ id: 'a', label: 'A', groups: [{ id: 'g', label: 'G', reserved: 'yes', commands: [] }] }] }, /"reserved" must be true or false/],
    ['a size that is not large or small', group({ sizes: { a: 'huge' } }), /size of 'a' must be "large" or "small"/],
    ['a size for a command the group lacks', group({ sizes: { b: 'large' } }), /"sizes" names 'b'/],
    ['a short title for a command the group lacks', group({ titles: { b: 'B' } }), /"titles" names 'b'/],
    ['an empty short title', group({ titles: { a: '' } }), /title of 'a' must be a non-empty string/],
    ['an icon that is not text', group({ icon: 3 }), /"icon" must be a non-empty string/],
  ])('rejects %s', (_name, json, message) => {
    expect(() => parseRibbonLayout(json)).toThrow(message);
  });
});

// ── the runner ──

/** A stand-in for preset-pagemd's frontmatter: "setting" a property writes `[key]` at the start of the document. */
const fakeProperties = (readable = true): PropertiesProvider & { set: ReturnType<typeof vi.fn> } => ({
  read: () => null,
  set: vi.fn((tr: Transaction, key: string) => (readable ? (tr.insertText(`[${key}]`, 1), true) : false)),
  remove: () => false,
  setText: () => false,
});

function runnerFor(overrides: Partial<GatePolicy> = {}, gateValues: Record<string, unknown> = { fancy_lists: false }, properties?: PropertiesProvider) {
  const registry = build(properties ? { properties } : {});
  const ran: string[] = [];
  const dispatched: Transaction[] = [];
  const run = vi.fn((id: string) => (ran.push(id), true));
  for (const spec of registry.commands.list()) spec.run = (state, dispatch) => (run(spec.id), spec.kind === 'view' ? true : (dispatch(state.tr.insertText('!')), true));
  const log: string[] = [];
  const gate: GatePolicy = {
    mode: () => 'ask',
    confirm: vi.fn(async () => 'add' as const),
    addProperty: vi.fn(async () => void log.push('addProperty')),
    flush: vi.fn(async () => void log.push('flush')),
    notify: vi.fn(),
    ...overrides,
  };
  let state = stateOf();
  const runner = createActionRunner({
    registry,
    target: () => ({ state, dispatch: (tr) => (dispatched.push(tr), (state = state.apply(tr)), log.push('dispatch')), focus: () => void log.push('focus') }),
    context: () => ({ state, editable: true, gates: gateValues }),
    gate,
  });
  const action = (id: string): Action => registry.actions({ surface: 'ribbon', context: { state, editable: true, gates: gateValues } }).concat(registry.actions({ surface: 'slash', context: { state, editable: true, gates: gateValues } })).find((a) => a.id === id)!;
  return { runner, gate, log, ran, dispatched, action, get state() { return state; } };
}

describe('action runner: the gate is decided when the action runs (R-157 review)', () => {
  const gateOf = (id: string, satisfied: boolean): Action => ({ id, kind: 'edit', label: 'Lettered list', keywords: [], toggle: false, enabled: true, active: false, gate: { field: 'fancy_lists', value: true, satisfied } });
  function make(gates: { current: Record<string, unknown> }, confirm: GatePolicy['confirm']) {
    const registry = build();
    const log: string[] = [];
    const policy: GatePolicy = { mode: () => 'ask', confirm, addProperty: async () => void log.push('add'), flush: async () => undefined, notify: () => undefined };
    let state = stateOf();
    const runner = createActionRunner({
      registry,
      target: () => ({ state, dispatch: (tr) => ((state = state.apply(tr)), log.push('insert')), focus: () => undefined }),
      context: () => ({ state, editable: true, gates: gates.current }),
      gate: policy,
    });
    registry.commands.get('fancy.lower')!.run = (st, dispatch) => (dispatch(st.tr.insertText('!')), true);
    return { runner, log };
  }

  it('an action drawn as gated runs without a prompt once the document has the property', async () => {
    const confirm = vi.fn(async () => 'add' as const);
    const { runner, log } = make({ current: { fancy_lists: true } }, confirm);
    await runner(gateOf('fancy.lower', false)); // drawn before the property was added
    expect(confirm).not.toHaveBeenCalled();
    expect(log).toEqual(['insert']);
  });
  it('an action drawn as satisfied asks when the property is gone from the document', async () => {
    const confirm = vi.fn(async () => 'insert' as const);
    const { runner } = make({ current: { fancy_lists: false } }, confirm);
    await runner(gateOf('fancy.lower', true));
    expect(confirm).toHaveBeenCalledOnce();
  });
  it('a second run for the same property while the first waits for the prompt is ignored; later runs work again', async () => {
    let answer!: (c: 'add' | 'insert' | 'cancel') => void;
    const confirm = vi.fn(() => new Promise<'add' | 'insert' | 'cancel'>((resolve) => (answer = resolve)));
    const gates = { current: { fancy_lists: false } as Record<string, unknown> };
    const { runner, log } = make(gates, confirm);
    const first = runner(gateOf('fancy.lower', false));
    await runner(gateOf('fancy.lower', false)); // a double click
    expect(confirm).toHaveBeenCalledOnce();
    answer('add');
    await first;
    expect(log).toEqual(['insert', 'add']); // one insert, one property
    gates.current = { fancy_lists: true };
    await runner(gateOf('fancy.lower', false));
    expect(log).toEqual(['insert', 'add', 'insert']);
  });
  it('prepare returning false (the "/query" is gone) changes nothing and adds no property', async () => {
    const confirm = vi.fn(async () => 'add' as const);
    const { runner, log } = make({ current: { fancy_lists: false } }, confirm);
    await runner(gateOf('fancy.lower', false), { prepare: () => false });
    expect(log).toEqual([]);
  });
});

describe('action runner', () => {
  it('runs an ungated action and gives the focus back to the editor', async () => {
    const t = runnerFor();
    await t.runner(t.action('bold.toggle'));
    expect(t.ran).toEqual(['bold.toggle']);
    expect(t.log).toEqual(['dispatch', 'focus']);
    expect(t.gate.confirm).not.toHaveBeenCalled();
  });
  it('a gated action whose gate is on runs without a prompt', async () => {
    const t = runnerFor({}, { fancy_lists: true });
    await t.runner(t.action('fancy.lower'));
    expect(t.ran).toEqual(['fancy.lower']);
    expect(t.gate.confirm).not.toHaveBeenCalled();
  });
  it('ask: "add" inserts first, then sends the typing and adds the property (two steps, R-155)', async () => {
    const t = runnerFor();
    await t.runner(t.action('fancy.lower'));
    expect(t.gate.confirm).toHaveBeenCalledWith({ label: 'Lettered list', field: 'fancy_lists', value: true });
    expect(t.log).toEqual(['dispatch', 'flush', 'addProperty', 'focus']);
    expect(t.gate.addProperty).toHaveBeenCalledWith('fancy_lists', true);
  });
  it('ask: "insert" inserts and leaves the frontmatter alone; "cancel" does nothing', async () => {
    const insert = runnerFor({ confirm: async () => 'insert' });
    await insert.runner(insert.action('fancy.lower'));
    expect(insert.ran).toEqual(['fancy.lower']);
    expect(insert.gate.addProperty).not.toHaveBeenCalled();
    const cancel = runnerFor({ confirm: async () => 'cancel' });
    await cancel.runner(cancel.action('fancy.lower'));
    expect(cancel.ran).toEqual([]);
    expect(cancel.gate.addProperty).not.toHaveBeenCalled();
  });
  it('auto (after "Don\'t ask again", R-154): adds the property without asking', async () => {
    const t = runnerFor({ mode: () => 'auto' });
    await t.runner(t.action('fancy.lower'));
    expect(t.gate.confirm).not.toHaveBeenCalled();
    expect(t.log).toEqual(['dispatch', 'flush', 'addProperty', 'focus']);
  });
  it('auto with sameStep (P8): the property and the insert are ONE transaction (one undo step, R-155 ended)', async () => {
    const properties = fakeProperties();
    const t = runnerFor({ mode: () => 'auto', sameStep: true }, undefined, properties);
    await t.runner(t.action('fancy.lower'));
    expect(t.log).toEqual(['dispatch', 'focus']);
    expect(t.dispatched).toHaveLength(1);
    expect(t.state.doc.textContent).toBe('[fancy_lists]!hello world');
    expect(properties.set).toHaveBeenCalledWith(expect.anything(), 'fancy_lists', true);
    expect(t.gate.addProperty).not.toHaveBeenCalled();
    expect(t.gate.flush).not.toHaveBeenCalled();
  });
  it('ask + "Add" with sameStep: one transaction too', async () => {
    const t = runnerFor({ sameStep: true }, undefined, fakeProperties());
    await t.runner(t.action('fancy.lower'));
    expect(t.gate.confirm).toHaveBeenCalled();
    expect(t.dispatched).toHaveLength(1);
    expect(t.state.doc.textContent).toBe('[fancy_lists]!hello world');
  });
  it('sameStep with the slash menu: its own edit, the property and the insert are one transaction', async () => {
    const t = runnerFor({ mode: () => 'auto', sameStep: true }, undefined, fakeProperties());
    await t.runner(t.action('fancy.lower'), { prepare: (tr) => void tr.delete(6, 12) });
    expect(t.dispatched).toHaveLength(1);
    expect(t.state.doc.textContent).toBe('[fancy_lists]!hello');
  });
  it('sameStep and a frontmatter that cannot be read: nothing is inserted, the author is told', async () => {
    const t = runnerFor({ mode: () => 'auto', sameStep: true }, undefined, fakeProperties(false));
    await t.runner(t.action('fancy.lower'));
    expect(t.dispatched).toHaveLength(0);
    expect(t.gate.notify).toHaveBeenCalledWith(expect.stringContaining("can't be read"));
  });
  it('sameStep without a properties provider falls back to the two steps', async () => {
    const t = runnerFor({ mode: () => 'auto', sameStep: true });
    await t.runner(t.action('fancy.lower'));
    expect(t.log).toEqual(['dispatch', 'flush', 'addProperty', 'focus']);
  });
  it('warn: inserts, tells the author, adds nothing', async () => {
    const t = runnerFor({ mode: () => 'warn' });
    await t.runner(t.action('fancy.lower'));
    expect(t.ran).toEqual(['fancy.lower']);
    expect(t.gate.notify).toHaveBeenCalledWith(expect.stringContaining('fancy_lists'));
    expect(t.gate.confirm).not.toHaveBeenCalled();
    expect(t.gate.addProperty).not.toHaveBeenCalled();
  });
  it('the property is not added when the insert did not happen (the command cannot run in this state)', async () => {
    const t = runnerFor();
    const registry = build();
    const action = registry.actions({ surface: 'ribbon', context: { state: stateOf(), editable: true, gates: { fancy_lists: false } } }).find((a) => a.id === 'fancy.lower')!;
    registry.commands.get('fancy.lower')!.isEnabled = () => false;
    const runner = createActionRunner({ registry, target: () => ({ state: stateOf(), dispatch: () => undefined, focus: () => undefined }), context: () => ({ state: stateOf(), editable: true }), gate: t.gate });
    await runner(action);
    expect(t.gate.addProperty).not.toHaveBeenCalled();
    expect(t.gate.flush).not.toHaveBeenCalled();
  });
  it('never edits a read-only canvas; view actions still run', async () => {
    const registry = build({ commands: [command('view.draft', { kind: 'view' })] });
    const ran: string[] = [];
    registry.commands.get('view.draft')!.run = () => (ran.push('view'), true);
    registry.commands.get('bold.toggle')!.run = () => (ran.push('bold'), true);
    const runner = createActionRunner({
      registry,
      target: () => ({ state: stateOf(), dispatch: () => undefined, focus: () => undefined }),
      context: () => ({ state: stateOf(), editable: false }),
      gate: { mode: () => 'ask', confirm: async () => 'add', addProperty: async () => undefined, flush: async () => undefined, notify: () => undefined },
    });
    const all = registry.actions({ surface: 'ribbon' });
    await runner(all.find((a) => a.id === 'bold.toggle')!);
    await runner(all.find((a) => a.id === 'view.draft')!);
    expect(ran).toEqual(['view']);
  });
  it('prepare + command are ONE transaction (the slash menu removes its "/query" and inserts in a single undo step)', async () => {
    const t = runnerFor();
    // "hello world" with the cursor after "hello": remove " wor" first, then the command types "!".
    await t.runner(t.action('bold.toggle'), { prepare: (tr) => void tr.delete(6, 10) });
    expect(t.dispatched).toHaveLength(1);
    expect(t.state.doc.textContent).toBe('!hellold');
    expect(t.dispatched[0]!.steps.length).toBeGreaterThanOrEqual(2);
  });
  it('prepare: a command that cannot run after the edit leaves the document untouched', async () => {
    const t = runnerFor();
    const registry = build();
    registry.commands.get('bold.toggle')!.isEnabled = () => false;
    const dispatch = vi.fn();
    const runner = createActionRunner({ registry, target: () => ({ state: stateOf(), dispatch, focus: () => undefined }), context: () => ({ state: stateOf(), editable: true }), gate: t.gate });
    await runner(registry.actions({ surface: 'toolbar' })[0]!, { prepare: (tr) => void tr.delete(1, 3) });
    expect(dispatch).not.toHaveBeenCalled();
  });
});
