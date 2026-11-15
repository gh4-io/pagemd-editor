// createEditor: builds the registry and schema from presets, then starts the plugins with Lumino's
// PluginRegistry (ADR-0012). Plugins declare `provides`, `requires` and `optional` tokens; the host
// provides the small services (services.ts) as plugins too.
import { PluginRegistry, type IPlugin, type Token } from '@lumino/coreutils';
import type { Schema } from 'prosemirror-model';
import type { Plugin as ProseMirrorPlugin } from 'prosemirror-state';
import { buildSchema, rawBlockItem } from './nodes.ts';
import type { CommandSpec } from './commands.ts';
import { createRegistry, ItemRegistry, type MetaCatalogue, type Preset, type Registry, type RibbonLayout } from './registry.ts';
import { ViewState, type ViewStateChange } from './view-state.ts';
import { groupsPlugin } from './groups.ts';

/**
 * What every plugin's `activate(app, …services)` receives first. `pmPlugins` (P3, OQ-24/ADR-0013 amendment) is
 * the one shared way a feature plugin adds ProseMirror behaviour (a keymap, input rules, clipboard handling) to
 * the canvas: it pushes its own ProseMirror `Plugin` onto this array while starting up. `components/canvas`
 * applies the finished array; it never knows which package contributed which plugin.
 */
export interface EditorApp {
  readonly registry: Registry;
  readonly schema: Schema;
  readonly pmPlugins: ProseMirrorPlugin[];
}

export type EditorPlugin<T = unknown> = IPlugin<EditorApp, T>;

export interface EditorOptions {
  presets: Preset[];
  plugins?: EditorPlugin<any>[];
  ribbonLayout?: RibbonLayout;
  /** Commands that belong to no item, e.g. the app's view commands (P7, R-156). Computed per call by `ribbon()`. */
  commands?: CommandSpec[];
  view?: ViewStateChange;
}

export interface Editor extends EditorApp {
  // `pmPlugins` (from EditorApp) holds every plugin's contribution once every plugin has started;
  // components/canvas takes it from here.
  readonly plugins: PluginRegistry<EditorApp>;
  /** The service behind a token, or null when no plugin provides it (optional services). */
  service<T>(token: Token<T>): Promise<T | null>;
  /** The service behind a token; rejects when no plugin provides it (required services). */
  required<T>(token: Token<T>): Promise<T>;
}

export async function createEditor(options: EditorOptions): Promise<Editor> {
  const items = new ItemRegistry([rawBlockItem]);
  for (const preset of options.presets) items.addPreset(preset);

  const registry = createRegistry({
    items,
    view: new ViewState(options.view),
    meta: mergeMeta(options.presets),
    ...withProperties(options.presets),
    ...(options.ribbonLayout ? { ribbonLayout: options.ribbonLayout } : {}),
    ...(options.commands ? { commands: options.commands } : {}),
  });
  const schema = buildSchema(items.items());

  const plugins = new PluginRegistry<EditorApp>();
  plugins.application = { registry, schema, pmPlugins: [] };
  plugins.registerPlugins(options.plugins ?? []);
  await plugins.activatePlugins('startUp');
  // P18 (R-229): the items' groups (pagemd's SECTION and COVER boxes) stay matched to their markers while editing (after the
  // feature plugins' own, so their places in the list don't move).
  const groupRules = items.items().flatMap((item) => item.groups ?? []);
  if (groupRules.length > 0) plugins.application.pmPlugins.push(groupsPlugin(groupRules));

  return {
    registry,
    schema,
    pmPlugins: plugins.application.pmPlugins,
    plugins,
    service: (token) => plugins.resolveOptionalService(token),
    required: (token) => plugins.resolveRequiredService(token),
  };
}

/** The last preset that models the document's properties (the frontmatter, P8) provides them. */
function withProperties(presets: readonly Preset[]): { properties?: NonNullable<Preset['properties']> } {
  const found = presets.reduce<Preset['properties']>((properties, preset) => preset.properties ?? properties, undefined);
  return found ? { properties: found } : {};
}

/** The last preset that brings a property catalogue wins (only preset-pagemd does, via @pagemd/meta). */
function mergeMeta(presets: readonly Preset[]): MetaCatalogue | undefined {
  return presets.reduce<MetaCatalogue | undefined>((meta, preset) => preset.meta ?? meta, undefined);
}
