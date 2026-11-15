// Registry contract tests (P1 "Tests"; ADR-0013 decisions 1–6).
import { Token } from '@lumino/coreutils';
import { EditorState, NodeSelection, TextSelection } from 'prosemirror-state';
import { describe, expect, it, vi } from 'vitest';
import {
  buildSchema,
  CommandRegistry,
  createEditor,
  createRegistry,
  EMPTY_META,
  IAssets,
  IDocumentSync,
  ItemRegistry,
  MORE_TAB_ID,
  RAW_BLOCK,
  rawBlockItem,
  SERVICE_TOKENS,
  ViewState,
  type CommandSpec,
  type EditorPlugin,
  type SyntaxItem,
} from '../src/index.ts';

const command = (id: string, extra: Partial<CommandSpec> = {}): CommandSpec => ({
  id,
  label: id,
  isEnabled: () => true,
  run: () => true,
  ...extra,
});

/** A minimal item for contract tests: one block node named after the id. */
const item = (id: string, extra: Partial<SyntaxItem> = {}): SyntaxItem => ({
  id,
  group: 'text',
  schema: { nodes: { [id]: { content: 'inline*', group: 'block' } } },
  fromTokens: {},
  toMarkdown: {},
  label: id,
  icon: id,
  ...extra,
});

describe('ItemRegistry', () => {
  it('keeps items in registration order', () => {
    expect(new ItemRegistry([item('a'), item('b')]).items().map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('an accidental same id is an error that names the fix', () => {
    expect(() => new ItemRegistry([item('table'), item('table')])).toThrow(/Two items share the id 'table'.*overrides: 'table'/);
  });

  it('an explicit override replaces the item in place', () => {
    const replacement = item('table', { overrides: 'table', label: 'Pagemd table', schema: { nodes: { table: { content: 'inline*', group: 'block' } } } });
    const registry = new ItemRegistry([item('a'), item('table'), item('b')]);
    registry.add(replacement);
    expect(registry.items().map((i) => i.label)).toEqual(['a', 'Pagemd table', 'b']);
  });

  it('an override may use a new id', () => {
    const registry = new ItemRegistry([item('table')]);
    registry.add(item('pagemd-table', { overrides: 'table' }));
    expect(registry.items().map((i) => i.id)).toEqual(['pagemd-table']);
  });

  it('overriding an item that is not registered is an error', () => {
    expect(() => new ItemRegistry([item('x', { overrides: 'missing' })])).toThrow(/no item 'missing'/);
  });

  it('two items declaring the same node or mark name is an error', () => {
    const b = item('b', { schema: { nodes: { a: { group: 'block' } } } });
    expect(() => new ItemRegistry([item('a'), b])).toThrow(/Items 'a' and 'b' both declare 'a'/);
    const m1 = item('m1', { schema: { marks: { em: {} } } });
    const m2 = item('m2', { schema: { marks: { em: {} } } });
    expect(() => new ItemRegistry([m1, m2])).toThrow(/both declare 'em'/);
  });

  it('the core names doc and text are reserved', () => {
    expect(() => new ItemRegistry([item('doc')])).toThrow(/reserves/);
  });

  it('a failed add leaves the registry unchanged', () => {
    const registry = new ItemRegistry([item('a')]);
    expect(() => registry.add(item('b', { schema: { nodes: { a: {} } } }))).toThrow();
    expect(registry.items().map((i) => i.id)).toEqual(['a']);
  });

  it('the editor part can be overridden by id; the syntax part cannot', () => {
    const registry = new ItemRegistry([item('heading')]);
    registry.overrideEditorPart('heading', { label: 'Title', icon: 'star' });
    const heading = registry.get('heading')!;
    expect([heading.label, heading.icon]).toEqual(['Title', 'star']);
    expect(heading.schema.nodes).toHaveProperty('heading');
    expect(() => registry.overrideEditorPart('heading', { schema: {} } as never)).toThrow(/only change the editor part, not: schema/);
    expect(() => registry.overrideEditorPart('nope', { label: 'x' })).toThrow(/No item 'nope'/);
  });

  it('finds the item for a node or mark type name', () => {
    const marks = item('em', { schema: { marks: { em: {} } } });
    const registry = new ItemRegistry([item('a'), marks]);
    expect(registry.itemForType('a')?.id).toBe('a');
    expect(registry.itemForType('em')?.id).toBe('em');
    expect(registry.itemForType('zzz')).toBeUndefined();
  });
});

describe('CommandRegistry', () => {
  it('two commands with the same id are an error', () => {
    expect(() => new CommandRegistry([command('bold'), command('bold')])).toThrow(/Two commands share the id 'bold'/);
  });

  it('runs only enabled commands and answers label, icon, keybinding, active', () => {
    const state = EditorState.create({ schema: buildSchema([item('p'), rawBlockItem]) });
    const run = vi.fn(() => true);
    const registry = new CommandRegistry([
      command('on', { run, icon: 'i', keybinding: 'Mod-b', isActive: () => true }),
      command('off', { isEnabled: () => false, run }),
    ]);
    expect(registry.run('on', state, () => {})).toBe(true);
    expect(registry.run('off', state, () => {})).toBe(false);
    expect(registry.run('missing', state, () => {})).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    expect([registry.label('on'), registry.icon('on'), registry.keybinding('on')]).toEqual(['on', 'i', 'Mod-b']);
    expect([registry.isActive('on', state), registry.isActive('off', state), registry.isEnabled('off', state)]).toEqual([true, false, false]);
  });
});

describe('Registry', () => {
  const heading = item('heading', {
    schema: { nodes: { heading: { content: 'inline*', group: 'block', attrs: { level: { default: 1 } } } } },
    commands: [command('heading.h1'), command('heading.h2')],
    fields: {
      heading: {
        fields: [{ key: 'level', type: 'number', label: 'Level', min: 1, max: 6 }],
        values: (node) => ({ level: node.attrs['level'] }),
        apply: (_node, values) => ({ level: values['level'] }),
      },
    },
    outline: (node, pos) => ({ kind: 'heading', label: node.textContent, level: node.attrs['level'] as number, pos }),
  });
  const para = item('paragraph', { commands: [command('paragraph.set')] });
  const items = new ItemRegistry([para, heading, rawBlockItem]);
  const schema = buildSchema(items.items());
  const registry = createRegistry({
    items,
    view: new ViewState(),
    ribbonLayout: { tabs: [{ id: 'home', label: 'Home', groups: [{ id: 'styles', label: 'Styles', commands: ['heading.h1'] }] }] },
  });
  const doc = schema.node('doc', null, [schema.node('paragraph', null, schema.text('intro')), schema.node('heading', { level: 2 }, schema.text('Part'))]);

  it('collects every item’s commands', () => {
    expect(registry.commands.list().map((c) => c.id)).toEqual(['paragraph.set', 'heading.h1', 'heading.h2']);
  });

  it('puts every unplaced command in "More", so nothing goes missing', () => {
    const ribbon = registry.ribbon();
    expect(ribbon.tabs.map((t) => t.id)).toEqual(['home', MORE_TAB_ID]);
    expect(ribbon.tabs[1]!.groups[0]!.commands).toEqual(['paragraph.set', 'heading.h2']);
    const reachable = new Set(ribbon.tabs.flatMap((t) => t.groups.flatMap((g) => g.commands)));
    expect(registry.commands.list().every((c) => reachable.has(c.id))).toBe(true);
  });

  it('builds the outline from the items, with positions and the top-level block each sits in (P9)', () => {
    expect(registry.outline(doc)).toEqual([{ kind: 'heading', label: 'Part', level: 2, pos: 7, block: 1 }]);
    const three = schema.node('doc', null, [doc.child(0), doc.child(1), schema.node('heading', { level: 3 }, schema.text('Sub'))]);
    expect(registry.outline(three).map((e) => [e.label, e.pos, e.block])).toEqual([
      ['Part', 7, 1],
      ['Sub', 13, 2],
    ]);
  });

  it('answers itemFor and fieldsFor from the selection (P8: targets with sections of fields and values)', () => {
    const at = (selection: (d: typeof doc) => import('prosemirror-state').Selection) => EditorState.create({ doc, selection: selection(doc) });
    expect(registry.itemFor(doc.child(1))?.id).toBe('heading');
    const inHeading = registry.fieldsFor(at((d) => TextSelection.create(d, 9)));
    expect(inHeading).toEqual([{ kind: 'node', name: 'heading', label: 'heading', from: 7, to: 13, sections: [{ id: 'heading', label: 'heading', fields: [expect.objectContaining({ key: 'level' })], values: { level: 2 } }] }]);
    expect(registry.fieldsFor(at((d) => TextSelection.create(d, 2)))).toEqual([]);
    expect(registry.fieldsFor(at((d) => NodeSelection.create(d, 7)))[0]!.from).toBe(7);
  });

  it('applyFields writes a section back as attributes, in one step; a stale target is refused', () => {
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, 9) });
    const [target] = registry.fieldsFor(state);
    const tr = state.tr;
    expect(registry.applyFields(tr, target!, 'heading', { level: 3 })).toBe(true);
    expect(tr.steps).toHaveLength(1);
    expect(tr.doc.child(1).attrs['level']).toBe(3);
    expect(registry.applyFields(state.tr, target!, 'heading', { level: 2 })).toBe(false); // nothing changes
    expect(registry.applyFields(state.tr, target!, 'nobody', { level: 3 })).toBe(false);
    expect(registry.applyFields(state.tr, { ...target!, from: 0 }, 'heading', { level: 3 })).toBe(false); // not a heading there
  });

  it('has an empty property catalogue and no properties for plain markdown', () => {
    expect(registry.properties).toBeNull();
    expect(registry.meta).toEqual(EMPTY_META);
  });
});

describe('buildSchema', () => {
  it('makes the first non-core block the default block and adds raw_block', () => {
    const schema = buildSchema([rawBlockItem, item('paragraph'), item('heading')]);
    expect(schema.topNodeType.createAndFill()!.firstChild!.type.name).toBe('paragraph');
    expect(schema.nodes[RAW_BLOCK]).toBeDefined();
  });
});

describe('ViewState', () => {
  it('starts in Print Layout and notifies on change', () => {
    const view = new ViewState();
    expect(view.value.mode).toBe('print');
    const seen: string[] = [];
    const sub = view.onChange((v) => seen.push(`${v.mode}@${v.zoom}`));
    view.set({ mode: 'draft', zoom: 1.5, panels: { ruler: false } });
    sub.dispose();
    view.set({ mode: 'code' });
    expect(seen).toEqual(['draft@1.5']);
    expect(view.value.panels).toEqual({ outline: true, inspector: true, comments: true, files: true, ruler: false, statusBar: true });
    expect(() => view.set({ zoom: 0 })).toThrow(RangeError);
    // P6 (R-142): page arrangement and fit, defaulting to vertical pages at the chosen zoom.
    expect(view.value.pageArrangement).toBe('vertical');
    expect(view.value.fit).toBe('none');
    view.set({ pageArrangement: 'side-by-side', fit: 'page-width' });
    expect(view.value).toMatchObject({ pageArrangement: 'side-by-side', fit: 'page-width', arrangement: 'side-by-side' });
  });
});

describe('createEditor (Lumino wiring)', () => {
  const preset = { id: 'test', items: [item('paragraph')] };

  it('has seven distinct service tokens', () => {
    expect(new Set(SERVICE_TOKENS.map((t) => t.name)).size).toBe(7);
  });

  it('starts plugins in dependency order and resolves services', async () => {
    const order: string[] = [];
    const sync: IDocumentSync = { applyEdits: async () => 'ok', onExternalChange: () => ({ dispose() {} }) };
    const IFeature = new Token<string>('test:feature');
    const host: EditorPlugin<IDocumentSync> = { id: 'host', provides: IDocumentSync, activate: () => (order.push('host'), sync) };
    const feature: EditorPlugin<string> = {
      id: 'feature',
      autoStart: true,
      requires: [IDocumentSync],
      optional: [IAssets],
      provides: IFeature,
      activate: (app, s: IDocumentSync, assets: IAssets | null) => {
        order.push(`feature(${s === sync}, ${assets})`);
        return app.registry.items().map((i) => i.id).join(',');
      },
    };
    const editor = await createEditor({ presets: [preset], plugins: [feature, host] });
    expect(order).toEqual(['host', 'feature(true, null)']);
    expect(await editor.service(IFeature)).toBe('raw_block,paragraph');
    expect(await editor.required(IDocumentSync)).toBe(sync);
    expect(await editor.service(IAssets)).toBeNull();
    expect(editor.schema.nodes[RAW_BLOCK]).toBeDefined();
  });

  it('a required service nobody provides is an error; an optional one is null', async () => {
    const editor = await createEditor({ presets: [preset] });
    await expect(editor.required(IDocumentSync)).rejects.toThrow();
    expect(await editor.service(IDocumentSync)).toBeNull();
  });

  it('refuses presets that clash', async () => {
    await expect(createEditor({ presets: [preset, preset] })).rejects.toThrow(/Two items share the id 'paragraph'/);
  });
});
