// Items and the registry (ADR-0013 decisions 1, 2, 3, 5).
// markdown-it and prosemirror-markdown are TYPE-ONLY imports here (R-74 e): the core never runs them.
import type { MarkdownIt, MarkdownItOptions, Token } from 'markdown-it';
import type { MarkSpec, Node, NodeSpec, Schema } from 'prosemirror-model';
import type { InputRule } from 'prosemirror-inputrules';
import type { EditorState, Transaction } from 'prosemirror-state';
import type { NodeViewConstructor } from 'prosemirror-view';
import type { MarkdownSerializer, MarkdownSerializerState, ParseSpec } from 'prosemirror-markdown';
import { toAction, type Action, type ActionBase, type ActionContext, type ActionQuery } from './actions.ts';
import { CommandRegistry, type CommandSpec } from './commands.ts';
import type { ViewState } from './view-state.ts';
import { applyFieldValues, fieldTargets, type FieldBinding, type FieldTarget } from './fields.ts';
import type { PropertiesProvider } from './properties.ts';
import { topBlocks, type GroupRule } from './groups.ts';

// ── read and write (R-74 a) ──

/** How one markdown-it token becomes ProseMirror content (prosemirror-markdown's ParseSpec). */
export type TokenSpec = ParseSpec;
/** Writes one node of a CHANGED block back to markdown. */
export type NodeWriter = (state: MarkdownSerializerState, node: Node, parent: Node, index: number) => void;
/** Opens and closes one mark (prosemirror-markdown's mark spec). */
export type MarkWriter = MarkdownSerializer['marks'][string];

export type ItemGroup = 'text' | 'lists' | 'tables' | 'blocks' | 'media' | 'page' | 'document' | 'core';

// ── document properties: the core's own copy of @pagemd/meta's shapes (R-74 d) ──

export interface FieldSpec {
  key: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'enum' | 'list' | 'path';
  label: string;
  help: string;
  default?: unknown;
  normalize?: { type: string; trim?: boolean; coerce?: boolean; items?: string };
  aliases: string[];
  validation?: Record<string, unknown>;
  formats?: string[];
  values?: string[];
  accepts?: string[];
  items?: string[];
  filenameToken?: boolean;
  generated?: boolean;
  sources: string[];
}

export interface MetaCatalogue {
  version: string;
  fields: FieldSpec[];
  aliases: Record<string, string>;
  gates: Record<string, { field: string; value: unknown }>;
}

// ── one object per item (DQ-1) ──

export interface OutlineEntry {
  kind: string;
  label: string;
  level: number;
  /** Document position of the node. */
  pos: number;
  /**
   * The figure's number (P9, R-164; R-84 additive growth): set only for numbered figures, from `@pagemd/syntax`'s own
   * numbering rule (preset-pagemd's `numberedOutline`), never recounted by the editor (I1, D9).
   */
  number?: number;
  /**
   * The index of the top-level block the entry sits in (P9, R-164; R-84 additive growth): the link to that block's
   * source range (the transformer's `sourceOf(doc).blocks[block]`), for the Code and Split views and the native Outline.
   * Filled in by `Registry.outline(doc)`.
   */
  block?: number;
}

export interface SyntaxItem {
  // syntax part (for pagemd items: imported from @pagemd/syntax by preset-pagemd, never copied)
  id: string;
  /** Explicit replacement of another item's id; an accidental same id is an error. */
  overrides?: string;
  group: ItemGroup;
  /** Read rule: adds or enables markdown-it rules. */
  markdownIt?(md: MarkdownIt): void;
  schema: { nodes?: Record<string, NodeSpec>; marks?: Record<string, MarkSpec> };
  /** Per markdown-it token name (without `_open`/`_close`). */
  fromTokens: Record<string, TokenSpec>;
  /** Per node / mark name; used for CHANGED blocks only. */
  toMarkdown: { nodes?: Record<string, NodeWriter>; marks?: Record<string, MarkWriter> };
  /**
   * P26 (ADR-0013 amendment, additive): writes a changed top-level block by editing its old `text` instead of writing it fresh,
   * when only something this item owns changed (a ticked task box: one character, the rest of the list as written). `tokens`
   * reads a text with the editor's own markdown-it. Null: the block is written fresh, as any other. The transformer keeps the
   * edited text only when it reads back exactly as `after`.
   */
  patch?(before: Node, after: Node, text: string, tokens: (text: string) => Token[]): string | null;
  /** e.g. fancy lists need `fancy_lists: true` (ADR-0016). */
  gate?: { field: string; value: unknown };
  /** How it looks on the canvas, per node name. */
  nodeViews?: Record<string, NodeViewConstructor>;
  /** Attributes this item adds to other items' nodes and marks (ADR-0013 amendment, P4, R-114). */
  extend?: ItemExtensions;
  /**
   * P18 (R-229): boxes around the blocks between two of this item's markers (pagemd's SECTION and COVER), as transparent group
   * nodes: drawn as the renderer draws them, invisible to reading and saving (groups.ts). Additive (ADR-0013 amendment, P18).
   */
  groups?: GroupRule[];

  // editor part (can be overridden by id without touching the syntax part)
  label: string;
  icon: string;
  /**
   * Inspector Element tab (P8, R-161): per node or mark name this item declares, the fields it shows and how they are
   * read from and written to the attributes. Not @pagemd/meta's FieldSpec (that is the Document tab's).
   */
  fields?: Record<string, FieldBinding>;
  /** Placed by the ribbon layout file; unplaced ones go to "More". */
  commands?: CommandSpec[];
  slash?: { keywords: string[] };
  outline?(node: Node, pos: number): OutlineEntry | null;
  /**
   * Typing shortcuts (P3, `plugin-input-rules`). A function, not a plain array (a change from the field's
   * P1 shape, session 13 finding: an `InputRule` for a node like heading or a list needs that node's concrete
   * `NodeType`, which only exists once the whole schema is built from every item — after items are defined.
   * `plugin-input-rules` calls this with the assembled schema and collects every item's rules).
   */
  inputRules?: (schema: Schema) => InputRule[];
}

/** The markdown-it token (and its stream) a node or mark is read from: prosemirror-markdown's `getAttrs` arguments. */
export type TokenAttrsReader = (...args: Parameters<NonNullable<ParseSpec['getAttrs']>>) => Record<string, unknown>;

/**
 * What one item adds to ANOTHER item's node (ADR-0013 amendment, P4, R-114): extra attributes, read from the
 * same markdown-it token, and written back by wrapping that node's writer. Example: pagemd's `{.class #id}`
 * attributes on a CommonMark heading.
 */
export interface NodeExtension {
  /** Added to the node's attributes; each needs a default (the node is also made without the extension's token). */
  attrs: Record<string, { default: unknown }>;
  /** Values for `attrs`, merged over what the node's own reader gives. */
  fromToken?: TokenAttrsReader;
  /** The node's writer with the extension's part added. */
  write?(original: NodeWriter): NodeWriter;
  /** Inspector fields for what the extension adds (P8: pagemd's classes, id and key=value pairs). */
  fields?: FieldBinding;
}

/** What one item adds to another item's mark (see NodeExtension). */
export interface MarkExtension {
  attrs: Record<string, { default: unknown }>;
  fromToken?: TokenAttrsReader;
  write?(original: MarkWriter): MarkWriter;
  fields?: FieldBinding;
}

/** Extensions of other items' nodes and marks, by node / mark name. Names no item declares are skipped. */
export interface ItemExtensions {
  nodes?: Record<string, NodeExtension>;
  marks?: Record<string, MarkExtension>;
}

/** The editor part of an item: what `ItemRegistry.overrideEditorPart` may change. */
export type EditorPart = Pick<SyntaxItem, 'label' | 'icon' | 'fields' | 'commands' | 'slash' | 'outline' | 'inputRules'>;

export interface Preset {
  id: string;
  items: SyntaxItem[];
  markdownItOptions?: MarkdownItOptions;
  meta?: MetaCatalogue;
  /** The document's properties (P8): the preset that models the frontmatter provides it. */
  properties?: PropertiesProvider;
}

// ── the ribbon layout file (DQ-2) ──

export interface RibbonGroup {
  id: string;
  label: string;
  commands: string[];
  /**
   * A slot kept for commands a later phase adds (P7, R-150: "Image tools" for P15). While no command in it exists
   * the group is empty and `ribbon()` leaves it out, so nothing shows; the layout test lets a reserved group name
   * commands nobody has registered yet.
   */
  reserved?: boolean;
  /** P17: a codicon for the group, used when it is drawn as one drop-down button (a long group, or a narrow window). Optional. */
  icon?: string;
  /** P17: which commands are drawn large (a big icon over a short title) or small (stacked three high); a command not named is small. Optional. */
  sizes?: Record<string, RibbonButtonSize>;
  /** P17: a short ribbon title per command id (the full label stays the tooltip and the accessible name). Optional. */
  titles?: Record<string, string>;
  /**
   * P20: the fold order in a narrow window (P17's fold). A group with a higher number folds into its drop-down button
   * first; equal numbers fold last group first (the default, 0, keeps P17's order). Optional.
   */
  fold?: number;
  /**
   * P27 (R-252, ADR-0013 note): false keeps a group of more than six commands as buttons (P17's fold still folds it into its
   * drop-down button when the ribbon is too narrow); true always draws it as a drop-down. Absent: a drop-down only above six
   * commands (MENU_THRESHOLD). Optional.
   */
  menu?: boolean;
}

export type RibbonButtonSize = 'large' | 'small';

export interface RibbonTab {
  id: string;
  label: string;
  groups: RibbonGroup[];
}

export interface RibbonLayout {
  /** The layout file's format version (P7, R-156). Only 1 exists. */
  version?: 1;
  tabs: RibbonTab[];
}

/**
 * Checks a parsed ribbon layout file (`ribbon.layout.json`, ADR-0013 decision 3) and returns it typed. Throws, naming
 * the problem, for a wrong shape, an unknown `version`, or a duplicate tab or group id (P7, R-156). A command id
 * that no command has is NOT an error here (a preset may be absent); `Registry.ribbon()` drops it.
 */
export function parseRibbonLayout(json: unknown): RibbonLayout {
  const fail = (message: string): never => {
    throw new Error(`Ribbon layout: ${message}`);
  };
  const object = (value: unknown, where: string): Record<string, unknown> => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${where} must be an object.`);
    return value as Record<string, unknown>;
  };
  const text = (value: unknown, where: string): string => {
    if (typeof value !== 'string' || value === '') fail(`${where} must be a non-empty string.`);
    return value as string;
  };
  const root = object(json, 'the file');
  if (root['version'] !== 1) fail(`"version" must be 1, got ${JSON.stringify(root['version'])}.`);
  if (!Array.isArray(root['tabs'])) fail('"tabs" must be a list.');
  const tabIds = new Set<string>();
  const groupIds = new Set<string>();
  const tabs = (root['tabs'] as unknown[]).map((rawTab, t): RibbonTab => {
    const tab = object(rawTab, `tab ${t + 1}`);
    const id = text(tab['id'], `tab ${t + 1} "id"`);
    if (tabIds.has(id)) fail(`two tabs share the id '${id}'.`);
    tabIds.add(id);
    if (!Array.isArray(tab['groups'])) fail(`tab '${id}' needs a "groups" list.`);
    const groups = (tab['groups'] as unknown[]).map((rawGroup, g): RibbonGroup => {
      const group = object(rawGroup, `group ${g + 1} of tab '${id}'`);
      const groupId = text(group['id'], `group ${g + 1} of tab '${id}' "id"`);
      if (groupIds.has(groupId)) fail(`two groups share the id '${groupId}'.`);
      groupIds.add(groupId);
      const commands = group['commands'];
      if (!Array.isArray(commands) || commands.some((c) => typeof c !== 'string' || c === '')) fail(`group '${groupId}' needs a "commands" list of command ids.`);
      if (group['reserved'] !== undefined && typeof group['reserved'] !== 'boolean') fail(`group '${groupId}': "reserved" must be true or false.`);
      const named = commands as string[];
      let icon: string | undefined;
      if (group['icon'] !== undefined) icon = text(group['icon'], `group '${groupId}' "icon"`);
      let sizes: Record<string, RibbonButtonSize> | undefined;
      if (group['sizes'] !== undefined) {
        sizes = {};
        for (const [id, size] of Object.entries(object(group['sizes'], `group '${groupId}' "sizes"`))) {
          if (!named.includes(id)) fail(`group '${groupId}': "sizes" names '${id}', which is not one of its commands.`);
          if (size !== 'large' && size !== 'small') fail(`group '${groupId}': the size of '${id}' must be "large" or "small", got ${JSON.stringify(size)}.`);
          sizes[id] = size as RibbonButtonSize;
        }
      }
      let titles: Record<string, string> | undefined;
      if (group['titles'] !== undefined) {
        titles = {};
        for (const [id, title] of Object.entries(object(group['titles'], `group '${groupId}' "titles"`))) {
          if (!named.includes(id)) fail(`group '${groupId}': "titles" names '${id}', which is not one of its commands.`);
          titles[id] = text(title, `group '${groupId}' title of '${id}'`);
        }
      }
      if (group['fold'] !== undefined && (typeof group['fold'] !== 'number' || !Number.isInteger(group['fold']))) fail(`group '${groupId}': "fold" must be a whole number.`);
      if (group['menu'] !== undefined && typeof group['menu'] !== 'boolean') fail(`group '${groupId}': "menu" must be true or false.`);
      return {
        id: groupId,
        label: text(group['label'], `group '${groupId}' "label"`),
        commands: named,
        ...(group['reserved'] === true ? { reserved: true } : {}),
        ...(icon !== undefined ? { icon } : {}),
        ...(sizes ? { sizes } : {}),
        ...(titles ? { titles } : {}),
        ...(group['fold'] !== undefined ? { fold: group['fold'] as number } : {}),
        ...(group['menu'] !== undefined ? { menu: group['menu'] as boolean } : {}),
      };
    });
    return { id, label: text(tab['label'], `tab '${id}' "label"`), groups };
  });
  return { version: 1, tabs };
}

// ── the only thing components may ask ──

export interface Registry {
  items(): SyntaxItem[];
  itemFor(node: Node): SyntaxItem | undefined;
  /**
   * What the Inspector's Element tab shows for the selection (P8, R-161): a mark at the cursor (a link), the selected
   * node, then its ancestors, innermost first; only those with fields.
   */
  fieldsFor(state: EditorState): FieldTarget[];
  /** Writes one section's changed values back onto the target, in `tr`. False when the target is gone or nothing changes. */
  applyFields(tr: Transaction, target: FieldTarget, section: string, values: Record<string, unknown>): boolean;
  /** The document's properties (the frontmatter), or null when no preset models them (P8). */
  properties: PropertiesProvider | null;
  commands: CommandRegistry;
  /**
   * The app's layout file with the commands that exist: ids no command has are dropped, then empty groups and tabs,
   * then a "More" tab holds every unplaced command. Computed on each call (a plugin may add commands later).
   */
  ribbon(): RibbonLayout;
  /** What a surface draws (P7, R-156): the actions for the ribbon (a tab), the slash menu (a search) or the selection toolbar. */
  actions(query: ActionQuery): Action[];
  /** One command as an Action, whatever surface it is on (the keyboard shortcuts use this); undefined for an unknown id. */
  action(id: string, context?: ActionContext): Action | undefined;
  outline(doc: Node): OutlineEntry[];
  meta: MetaCatalogue;
  view: ViewState;
}

// ── ItemRegistry: the list of items, with explicit overrides (ADR-0013 decision 2) ──

export class ItemRegistry {
  readonly #items: SyntaxItem[] = [];

  constructor(items: Iterable<SyntaxItem> = []) {
    for (const item of items) this.add(item);
  }

  /**
   * Adds an item. An item with `overrides` replaces that item in place; any other id clash is an
   * error, and so is a node or mark name that another item already declares.
   */
  add(item: SyntaxItem): void {
    const index = this.#items.findIndex((existing) => existing.id === (item.overrides ?? item.id));
    if (item.overrides !== undefined) {
      if (index < 0) throw new Error(`Item '${item.id}' overrides '${item.overrides}', but no item '${item.overrides}' is registered.`);
      if (item.id !== item.overrides && this.#items.some((existing) => existing.id === item.id)) {
        throw new Error(`Two items share the id '${item.id}'.`);
      }
    } else if (index >= 0) {
      throw new Error(`Two items share the id '${item.id}'. To replace an item on purpose, set overrides: '${item.id}'.`);
    }
    const next = [...this.#items];
    if (index >= 0 && item.overrides !== undefined) next[index] = item;
    else next.push(item);
    checkNames(next);
    this.#items.splice(0, this.#items.length, ...next);
  }

  addPreset(preset: Preset): void {
    for (const item of preset.items) this.add(item);
  }

  /** Changes an item's editor part (label, icon, fields, …) by id; the syntax part stays as it is. */
  overrideEditorPart(id: string, part: Partial<EditorPart>): void {
    const index = this.#items.findIndex((item) => item.id === id);
    const item = this.#items[index];
    if (!item) throw new Error(`No item '${id}' to override.`);
    const allowed: readonly string[] = EDITOR_PART_KEYS;
    const stray = Object.keys(part).filter((key) => !allowed.includes(key));
    if (stray.length > 0) throw new Error(`overrideEditorPart('${id}') may only change the editor part, not: ${stray.join(', ')}.`);
    this.#items[index] = { ...item, ...part };
  }

  items(): SyntaxItem[] {
    return [...this.#items];
  }

  get(id: string): SyntaxItem | undefined {
    return this.#items.find((item) => item.id === id);
  }

  /** The item that declares a node or mark type of this name. */
  itemForType(name: string): SyntaxItem | undefined {
    return this.#items.find((item) => (item.schema.nodes && name in item.schema.nodes) || (item.schema.marks && name in item.schema.marks));
  }
}

const EDITOR_PART_KEYS = ['label', 'icon', 'fields', 'commands', 'slash', 'outline', 'inputRules'] as const satisfies readonly (keyof EditorPart)[];

/** Node and mark names the core schema always has. */
export const RESERVED_NAMES: readonly string[] = ['doc', 'text'];

function checkNames(items: readonly SyntaxItem[]): void {
  const owner = new Map<string, string>();
  for (const item of items) {
    for (const name of [...Object.keys(item.schema.nodes ?? {}), ...Object.keys(item.schema.marks ?? {})]) {
      if (RESERVED_NAMES.includes(name)) throw new Error(`Item '${item.id}' declares '${name}', which the core schema reserves.`);
      const other = owner.get(name);
      if (other !== undefined) throw new Error(`Items '${other}' and '${item.id}' both declare '${name}'.`);
      owner.set(name, item.id);
    }
  }
}

// ── the Registry components ask (ADR-0013 decision 5) ──

export const EMPTY_META: MetaCatalogue = Object.freeze({ version: '0', fields: [], aliases: {}, gates: {} });

export const MORE_TAB_ID = 'more';

export interface RegistryOptions {
  items: ItemRegistry;
  view: ViewState;
  meta?: MetaCatalogue;
  properties?: PropertiesProvider;
  ribbonLayout?: RibbonLayout;
  /** Commands that belong to no item (the app's view commands, P7): added after the items' own. */
  commands?: readonly CommandSpec[];
}

export function createRegistry(options: RegistryOptions): Registry {
  const { items, view } = options;
  const commands = new CommandRegistry([...items.items().flatMap((item) => item.commands ?? []), ...(options.commands ?? [])]);
  const layout = options.ribbonLayout ?? { tabs: [] };

  const itemFor = (node: Node): SyntaxItem | undefined => items.itemForType(node.type.name);

  /** The field bindings for a node or mark type: its own item's, then every extension's (P8). */
  const bindingsFor = (name: string, kind: 'node' | 'mark'): { id: string; label: string; binding: FieldBinding }[] => {
    const out: { id: string; label: string; binding: FieldBinding }[] = [];
    const owner = items.itemForType(name);
    const own = owner?.fields?.[name];
    if (owner && own) out.push({ id: owner.id, label: owner.label, binding: own });
    for (const item of items.items()) {
      const extension = kind === 'node' ? item.extend?.nodes?.[name] : item.extend?.marks?.[name];
      if (extension?.fields) out.push({ id: item.id, label: item.label, binding: extension.fields });
    }
    return out;
  };

  // command id → the item that declares it, built from the items as they are now (a plugin may add commands).
  const ownerOf = (): Map<string, SyntaxItem> => {
    const owners = new Map<string, SyntaxItem>();
    for (const item of items.items()) for (const command of item.commands ?? []) owners.set(command.id, item);
    return owners;
  };

  const ribbon = (): RibbonLayout => {
    const known = new Set(commands.list().map((command) => command.id));
    const placed = new Set<string>();
    const tabs: RibbonTab[] = [];
    for (const tab of layout.tabs) {
      const groups: RibbonGroup[] = [];
      for (const group of tab.groups) {
        const ids = group.commands.filter((id) => known.has(id));
        for (const id of ids) placed.add(id);
        if (ids.length > 0) groups.push({ ...group, commands: ids });
      }
      if (groups.length > 0) tabs.push({ ...tab, groups });
    }
    // Commands the layout file lists in a group that was dropped (empty) can't exist, so placed is complete here.
    const unplaced = commands.list().map((command) => command.id).filter((id) => !placed.has(id));
    if (unplaced.length > 0) tabs.push({ id: MORE_TAB_ID, label: 'More', groups: [{ id: MORE_TAB_ID, label: 'More', commands: unplaced }] });
    return { ...(layout.version ? { version: layout.version } : {}), tabs };
  };

  // Static facts per surface/tab/search, rebuilt when the set of commands changes.
  let revision = -1;
  let cache = new Map<string, { base: ActionBase; command: CommandSpec }[]>();
  const cached = (key: string, build: () => { base: ActionBase; command: CommandSpec }[]): { base: ActionBase; command: CommandSpec }[] => {
    if (revision !== commands.list().length) {
      revision = commands.list().length;
      cache = new Map();
    }
    let found = cache.get(key);
    if (!found) cache.set(key, (found = build()));
    return found;
  };

  const baseOf = (command: CommandSpec, owner: SyntaxItem | undefined, group?: { id: string; label: string }): ActionBase => ({
    id: command.id,
    kind: command.kind ?? 'edit',
    label: command.label,
    ...(command.icon !== undefined ? { icon: command.icon } : {}),
    ...(command.keybinding !== undefined ? { keybinding: command.keybinding } : {}),
    ...(command.description !== undefined ? { description: command.description } : {}),
    keywords: command.keywords ?? owner?.slash?.keywords ?? [],
    toggle: command.isActive !== undefined,
    ...(group ? { group } : {}),
    ...(owner?.gate ? { gate: { field: owner.gate.field, value: owner.gate.value, satisfied: true } } : {}),
  });

  const action = (id: string, context?: ActionContext): Action | undefined => {
    const command = commands.get(id);
    if (!command) return undefined;
    return toAction(baseOf(command, ownerOf().get(id)), command, context, context?.gates);
  };

  const actions = (query: ActionQuery): Action[] => {
    const { surface, context } = query;
    const gates = context?.gates;
    const search = (query.search ?? '').trim().toLowerCase();
    // A search is typed text: its results are computed each time, never cached (the cache would grow with every query).
    const lookup = surface === 'slash' && search !== '' ? (build: () => { base: ActionBase; command: CommandSpec }[]) => build() : (build: () => { base: ActionBase; command: CommandSpec }[]) => cached(`${surface}|${query.tab ?? ''}`, build);
    const list = lookup(() => {
      const owners = ownerOf();
      const out: { base: ActionBase; command: CommandSpec }[] = [];
      if (surface === 'ribbon') {
        for (const tab of ribbon().tabs) {
          if (query.tab !== undefined && tab.id !== query.tab) continue;
          for (const group of tab.groups) {
            for (const id of group.commands) {
              const command = commands.get(id);
              if (command) out.push({ base: baseOf(command, owners.get(id), { id: group.id, label: group.label }), command });
            }
          }
        }
      } else if (surface === 'toolbar') {
        for (const command of commands.list()) if (command.toolbar) out.push({ base: baseOf(command, owners.get(command.id)), command });
      } else {
        const ranked: { entry: { base: ActionBase; command: CommandSpec }; rank: number }[] = [];
        for (const command of commands.list()) {
          const owner = owners.get(command.id);
          if (!(command.slash === true || (command.slash !== false && owner?.slash))) continue;
          const base = baseOf(command, owner);
          const label = base.label.toLowerCase();
          let rank = 0;
          if (search) {
            if (label.startsWith(search)) rank = 0;
            else if (label.includes(search)) rank = 1;
            else if (base.keywords.some((word) => word.toLowerCase().includes(search))) rank = 2;
            else continue;
          }
          ranked.push({ entry: { base, command }, rank });
        }
        ranked.sort((a, b) => a.rank - b.rank); // stable: equal ranks keep the registry's order
        out.push(...ranked.map((r) => r.entry));
      }
      return out;
    });
    return list.map(({ base, command }) => toAction(base, command, context, gates));
  };

  return {
    items: () => items.items(),
    itemFor,
    fieldsFor: (state) => fieldTargets(state, bindingsFor, (name) => items.itemForType(name)?.label ?? name),
    applyFields(tr, target, section, values) {
      const found = bindingsFor(target.name, target.kind).find((b) => b.id === section);
      return found ? applyFieldValues(tr, target, found.binding, values) : false;
    },
    properties: options.properties ?? null,
    commands,
    ribbon,
    actions,
    action,
    outline(doc: Node): OutlineEntry[] {
      // Each entry links to the top-level block it sits in (P9): block i spans [start, start + nodeSize). Groups (P18) are
      // looked through: block i is the i-th of `topBlocks(doc)`, as in the block ranges.
      const entries: OutlineEntry[] = [];
      const blocks = topBlocks(doc);
      let block = -1;
      let end = 0;
      doc.descendants((node, pos) => {
        while (block + 1 < blocks.length && pos >= end) {
          block++;
          end = blocks[block]!.pos + blocks[block]!.node.nodeSize;
        }
        if (block < 0 || pos < blocks[block]!.pos) return; // a group's own node (its blocks come next)
        const entry = itemFor(node)?.outline?.(node, pos);
        if (entry) entries.push({ ...entry, block });
      });
      return entries;
    },
    meta: options.meta ?? EMPTY_META,
    view,
  };
}
