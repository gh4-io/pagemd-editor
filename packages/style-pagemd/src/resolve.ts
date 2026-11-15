/// <reference path="./pagemd-modules.d.ts" />
// resolve → read → build → scope (see index.ts for the whole story, P5 amendment 4).
import { posix, rebaseAssetPaths, resolveDocument, type Ports, type ResolvedDocument, type ResolvedFile } from '@pagemd/resolver';
import { buildStyles, DEFAULTS, isFromProperties, type BuiltStyles, type NamedSide, type Running, type Sheet } from '@pagemd/theme-kit';
import { catalogue, gateFor, normalizeMetadata, requirements } from '@pagemd/meta';
import type { FieldSpec, NamedRunning, PageGeometry, ResolvedStyles, RunningContent, RunningOverride } from '@pagemd-editor/core';
import { frontmatterOf } from './frontmatter.ts';
import { portsOf } from './ports.ts';
import { scopeCss } from './scope.ts';
import { templateParts } from './template.ts';
import { NO_PROPERTIES, type AssetUse, type PropertiesInfo, type StyleDocument, type StyleEnvironment, type StyleNote, type StyleNoteKind, type StyleResolution, type TraceInput, type TraceSheet } from './types.ts';


/** The fields syntax gates read (from @pagemd/meta's catalogue: `fancy_lists`). */
export const GATE_FIELDS: readonly string[] = [
  ...new Set(
    catalogue()
      .flatMap((field) => field.items ?? [])
      .map((item) => gateFor(item)?.field)
      .filter((field): field is string => typeof field === 'string'),
  ),
];

/** Other properties the canvas reads from the profile's defaults (FIX-S50, OQ-68: `hide_first_h1`, not a syntax gate), carried with the gates. */
const CANVAS_DEFAULTS: readonly string[] = ['hide_first_h1'];

/** The profile's defaults for the gate fields, as the profile wrote them (pagemd layers them unnormalized). */
export function gateDefaultsOf(defaults: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of [...GATE_FIELDS, ...CANVAS_DEFAULTS]) if (defaults && Object.hasOwn(defaults, field)) out[field] = defaults[field];
  return out;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * FIX-template-asset-paths (R-259): a template's or stylesheet's relative paths start from its own folder and are written from
 * the document's (the canvas's base address), with @pagemd/resolver's `rebaseAssetPaths`, the function pagemd's page uses.
 * What was found is added to `found` (Files in Use, and the folders the webview may load from).
 */
async function rebased(text: string, file: string | null | undefined, from: AssetUse['from'], documentDir: string, P: typeof posix, ports: Ports, found: AssetUse[]): Promise<string> {
  if (!text || !file) return text;
  try {
    const result = await rebaseAssetPaths(text, { kind: from === 'template' ? 'html' : 'css', fileDir: P.dirname(file), documentDir }, ports);
    for (const asset of result.assets) found.push({ written: asset.written, outcome: asset.outcome, path: asset.path, tried: asset.tried, rewritten: asset.rewritten, file, from });
    return result.text;
  } catch {
    return text; // a path problem never stops the canvas
  }
}

/** The folders of the files a template or stylesheet pulls in from next to itself (the webview must be allowed to load them). */
export function assetFolders(resolution: Pick<StyleResolution, 'trace'>, P: Pick<typeof posix, 'dirname'> = posix): string[] {
  const out: string[] = [];
  for (const asset of resolution.trace?.assets ?? []) {
    if (asset.outcome !== 'file' || !asset.path) continue;
    const folder = P.dirname(asset.path);
    if (!out.includes(folder)) out.push(folder);
  }
  return out;
}

function plain(notes: StyleNote[], sources: string[] = [], properties: PropertiesInfo = NO_PROPERTIES, trace?: TraceInput): StyleResolution {
  return { styles: null, gateDefaults: {}, notes, sources, properties, ...(trace ? { trace } : {}) };
}

/**
 * P25: the layered sheets theme-kit built, lowest priority first, with the frontmatter layer split back into the CSS made from the
 * properties and each `styles:` file (theme-kit joins them: `[generated, files].join('\n')`), so each keeps its own text and lines.
 */
function traceSheets(built: BuiltStyles, frontmatter: Sheet[]): TraceSheet[] {
  const out: TraceSheet[] = [];
  for (const layer of built.layers) {
    if (layer.layer === 'frontmatter') continue;
    out.push({ layer: layer.layer as TraceSheet['layer'], path: layer.path ?? null, content: layer.content, ...(layer.source ? { source: layer.source } : {}) });
  }
  const files = frontmatter.map((s) => s.content).join('\n');
  const all = built.frontmatterCSS ?? '';
  const generated = !files ? all : all === files ? '' : all.endsWith(`\n${files}`) ? all.slice(0, all.length - files.length - 1) : '';
  if (generated.trim()) out.push({ layer: 'frontmatter', path: null, content: generated });
  for (const s of frontmatter) out.push({ layer: 'frontmatter', path: s.path ?? null, content: s.content, ...(s.source ? { source: s.source } : {}) });
  return out;
}

/** The template's text, '' when there is none or it can't be read (template problems never stop the canvas, amendment 9). */
async function templateTextOf(resolved: ResolvedDocument, env: StyleEnvironment): Promise<string> {
  if (!resolved.template.path || resolved.template.error) return '';
  try {
    return await env.fs.readText(resolved.template.path);
  } catch {
    return '';
  }
}

/**
 * The Document tab's hints for a resolved profile (P8, ADR-0016): required (the profile), shown on the page (the
 * template's tokens), the profile's own fields and defaults, all from @pagemd/meta. A template that can't be read
 * shows nothing on the page (template problems are P10's, amendment 9).
 */
function propertiesOf(resolved: ResolvedDocument, template: string): PropertiesInfo {
  const { required, shownOnPage } = requirements(resolved.profile, template);
  const profileFields = catalogue(resolved.profile).filter((field) => field.sources.length === 1 && field.sources[0] === 'profile') as unknown as FieldSpec[];
  return { required, shownOnPage, profileFields, defaults: { ...(resolved.profile.metadata?.defaults ?? {}) } };
}

/** A document's styles (see the file header). Never throws for a document problem: plain styles plus a note. */
export async function resolveStyles(doc: StyleDocument, env: StyleEnvironment): Promise<StyleResolution> {
  if (!doc.path) {
    const note: StyleNote = { kind: 'not-a-file', message: 'This document is not a file, so it has no pagemd profile: plain styles.' };
    return plain([note], [], NO_PROPERTIES, { documentPath: null, frontmatter: null, failure: note });
  }
  const P = env.path ?? posix;

  // What the author wrote, normalized without built-in defaults (pagemd's writtenMetadataOf; amendment 2)
  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = normalizeMetadata(frontmatterOf(doc.text), { applyDefaults: false });
  } catch (error) {
    const note: StyleNote = { kind: 'frontmatter-error', message: `The frontmatter can't be read: ${messageOf(error)}` };
    return plain([note], [], NO_PROPERTIES, { documentPath: doc.path, frontmatter: null, failure: note });
  }

  const ports = portsOf(doc.path, env);

  let resolved: ResolvedDocument;
  try {
    resolved = await resolveDocument(doc.path, { frontmatter, cliPath: env.pagemdPath }, ports);
  } catch (error) {
    const message = messageOf(error);
    const profile = typeof frontmatter['pipeline_profile'] === 'string' ? frontmatter['pipeline_profile'] : undefined;
    const kind: StyleNoteKind = /^Profile not found/.test(message) ? 'profile-not-found' : 'profile-error';
    const note: StyleNote = { kind, message, ...(profile ? { source: profile } : {}) };
    return plain([note], [], NO_PROPERTIES, { documentPath: doc.path, frontmatter, failure: note });
  }

  const templateText = await templateTextOf(resolved, env);
  const properties = propertiesOf(resolved, templateText);
  const assets: AssetUse[] = [];
  const documentDir = P.dirname(doc.path);
  // FIX-template-asset-paths: the template's own pictures, found from its folder (before its tokens are filled)
  const canvasTemplate = await rebased(templateText, resolved.template.path, 'template', documentDir, P, ports, assets);
  const trace: TraceInput = { documentPath: doc.path, frontmatter, resolved, templateText, assets };

  // Template problems are ignored until P10 (amendment 9); every other problem stops pagemd's PDF.
  const problems = resolved.problems.filter((p) => p.kind !== 'template');
  if (problems.length > 0) {
    return plain(
      problems.map((p) => ({ kind: 'missing-stylesheet', message: p.message, source: p.source })),
      resolved.sources,
      properties,
      trace,
    );
  }

  const read = async (path: string): Promise<Sheet> => ({ content: await env.fs.readText(path), path });
  const readFound = async (entry: ResolvedFile): Promise<Sheet> => ({ ...(await read(entry.path!)), source: entry.source });
  // FIX-template-asset-paths: the layout's and the profile CSS's url() paths, found from each stylesheet's own folder
  const readProfileSheet = async (entry: ResolvedFile, from: 'layout' | 'stylesheet'): Promise<Sheet> => {
    const sheet = await readFound(entry);
    return { ...sheet, content: await rebased(sheet.content, sheet.path, from, documentDir, P, ports, assets) };
  };

  let pagemdFiles: { base: Sheet; primary: Sheet; syntax: Sheet; defaultLayout: Sheet };
  const system = resolved.system;
  const defaultLayoutPath = P.join(env.pagemdPath, DEFAULTS.layout);
  try {
    pagemdFiles = {
      base: await read(system.base!),
      primary: await read(system.primary!),
      syntax: await read(system.syntax!),
      defaultLayout: await read(defaultLayoutPath),
    };
  } catch (error) {
    return plain([{ kind: 'missing-pagemd-files', message: `pagemd's own files are missing or incomplete in ${env.pagemdPath}: ${messageOf(error)}`, source: env.pagemdPath }], resolved.sources, properties, trace);
  }

  let layout: Sheet | null;
  let profile: Sheet[];
  let frontmatterSheets: Sheet[];
  try {
    layout = resolved.layout ? await readProfileSheet(resolved.layout, 'layout') : null;
    profile = [];
    for (const entry of resolved.styles.filter((s) => !s.skipped)) profile.push(await readProfileSheet(entry, 'stylesheet'));
    frontmatterSheets = await Promise.all(resolved.frontmatterStyles.map(readFound));
  } catch (error) {
    return plain([{ kind: 'missing-stylesheet', message: messageOf(error) }], resolved.sources, properties, trace);
  }

  const built = buildStyles({
    ...pagemdFiles,
    layout,
    profile,
    frontmatter: frontmatterSheets,
    metadata: resolved.metadata,
    defaultsPath: env.pagemdPath,
    profileId: resolved.profileId,
  });
  trace.sheets = traceSheets(built, frontmatterSheets);
  trace.usingDefault = built.usingDefault;
  trace.defaultLayoutPath = defaultLayoutPath;

  let scoped;
  try {
    scoped = scopeCss(built.css);
  } catch (error) {
    return plain([{ kind: 'css-error', message: `The profile's CSS can't be read: ${messageOf(error)}` }], resolved.sources, properties, trace);
  }

  // P18 (R-228): the template drawn around the text, and its own <style> CSS (OQ-39) after the profile's, as unlayered CSS
  // after pagemd's layered style block wins in pagemd's page too.
  const notes: StyleNote[] = [];
  const parts = canvasTemplate ? templateParts(canvasTemplate, resolved.metadata, resolved.profile) : null;
  let css = scoped.css;
  if (parts?.css) {
    try {
      const own = scopeCss(parts.css);
      css = `${css}\n/* the template's own <style> (P18) */\n${own.css}`;
      scoped.droppedImports.push(...own.droppedImports);
    } catch (error) {
      notes.push({ kind: 'css-error', message: `The template's own CSS can't be read, so it isn't used: ${messageOf(error)}`, ...(resolved.template.path ? { source: resolved.template.path } : {}) });
    }
  }
  if (templateText && parts && !parts.template) notes.push({ kind: 'template-without-content', message: 'The template has no {{content}}: the page shows the text without it.', ...(resolved.template.path ? { source: resolved.template.path } : {}) });

  if (built.usingDefault) notes.push({ kind: 'using-default-layout', message: 'Using default layout', source: defaultLayoutPath });
  for (const params of scoped.droppedImports) notes.push({ kind: 'import-dropped', message: `@import ${params} is not loaded on the canvas.`, source: params });

  const sources = unique([...resolved.sources, ...built.sources]);
  // The status bar shows the profile's own id (R-139), e.g. "academic" for `profile: ../profiles/academic.json`
  const profileName = typeof resolved.profile.id === 'string' && resolved.profile.id ? resolved.profile.id : resolved.profileId;
  const styles = toResolvedStyles(built, css, profileName, sources);
  if (parts?.template) styles.template = parts.template;
  return {
    styles,
    gateDefaults: gateDefaultsOf(resolved.profile.metadata?.defaults),
    notes,
    sources,
    properties,
    trace,
    basis: {
      documentPath: doc.path,
      documentDir: P.dirname(doc.path),
      profileId: resolved.profileId,
      profilePath: resolved.profileChain[0]?.path ?? null,
      layoutText: built.usingDefault ? pagemdFiles.defaultLayout.content : (layout?.content ?? null),
      layout: styles.layout ?? null,
      usingDefault: built.usingDefault,
      page: styles.page,
    },
  };
}

const unique = (paths: string[]): string[] => paths.filter((p, i, all) => p && all.indexOf(p) === i);

function geometry(g: PageGeometry): PageGeometry {
  return { width: g.width, height: g.height, margins: { top: g.margins.top, right: g.margins.right, bottom: g.margins.bottom, left: g.margins.left } };
}

/** theme-kit's per-position running content as the core's RunningContent (R-127). */
export function toRunningContent(running: Running | undefined): RunningContent | undefined {
  if (!running) return undefined;
  const out: RunningContent = {};
  for (const pos of ['left', 'center', 'right', 'inside', 'outside'] as const) {
    const text = running[pos];
    if (typeof text === 'string') out[pos] = text;
  }
  if (running['spansWidth'] === true) out.spansWidth = true;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The running content shown: the layout's own box texts (R-141) over the document's properties, which fill the
 * positions the layout doesn't write. A spanning property text stops spanning once the layout writes left or right.
 */
function fillFrom(metadata: RunningContent | undefined, layout: RunningContent | undefined): RunningContent | undefined {
  if (!layout) return metadata;
  if (!metadata) return layout;
  const out: RunningContent = { ...metadata, ...layout };
  if (out.spansWidth && (layout.left !== undefined || layout.right !== undefined)) delete out.spansWidth;
  return out;
}

/**
 * P21: one side of a named page's boxes as the core's RunningOverride. A box written with the document's properties
 * (`var(--page-header-left, none)`, as pagemd's letter.css does) takes the property for that box's own position (left,
 * center, right; never flipped inside/outside: in pagemd's PDF the page type's rule wins over `:left`/`:right`), or is
 * cleared when the property is not set (the `none` fallback).
 */
function toOverride(side: NamedSide | undefined, properties: RunningContent | undefined): RunningOverride | undefined {
  if (!side) return undefined;
  const out: RunningOverride = {};
  for (const pos of ['left', 'center', 'right'] as const) {
    if (!(pos in side)) continue;
    const value = side[pos];
    if (isFromProperties(value)) {
      const text = properties?.[pos];
      out[pos] = typeof text === 'string' && text !== '' ? text : null;
    } else out[pos] = typeof value === 'string' ? value : null;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** P21: every page type's own header/footer boxes (theme-kit's `layoutRunning.named`), properties filled in. */
export function toNamedRunning(built: Pick<BuiltStyles, 'layoutRunning' | 'header' | 'footer'>): Record<string, NamedRunning> | undefined {
  const named = built.layoutRunning?.named;
  if (!named) return undefined;
  const header = toRunningContent(built.header);
  const footer = toRunningContent(built.footer);
  const out: Record<string, NamedRunning> = {};
  for (const [name, boxes] of Object.entries(named)) {
    const entry: NamedRunning = {};
    const h = toOverride(boxes.header, header);
    const f = toOverride(boxes.footer, footer);
    if (h) entry.header = h;
    if (f) entry.footer = f;
    const fh = toOverride(boxes.first?.header, header);
    const ff = toOverride(boxes.first?.footer, footer);
    if (fh || ff) entry.first = { ...(fh ? { header: fh } : {}), ...(ff ? { footer: ff } : {}) };
    if (Object.keys(entry).length > 0) out[name] = entry;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** buildStyles' answer as the core's ResolvedStyles (R-127), with the scoped CSS. */
export function toResolvedStyles(built: BuiltStyles, css: string, profile: string, sources: string[]): ResolvedStyles {
  const styles: ResolvedStyles = { css, page: geometry(built.page), usingDefault: built.usingDefault, sources, profile };
  // R-141: headers/footers written in the layout's own margin boxes. Where the layout writes a box's text itself,
  // that text is what pagemd's PDF shows (the document's properties only reach boxes written with var()), so the
  // layout's text wins there; the properties fill the rest (P6 build finding, see P6.md "As built (Part 1)").
  const fromLayout = built.layoutRunning;
  const header = fillFrom(toRunningContent(built.header), toRunningContent(fromLayout?.header ?? null));
  const footer = fillFrom(toRunningContent(built.footer), toRunningContent(fromLayout?.footer ?? null));
  if (header) styles.header = header;
  if (footer) styles.footer = footer;
  const metaFirst = built.firstPage;
  const layoutFirst = fromLayout?.firstPage ?? null;
  if (metaFirst === false) styles.firstPage = false;
  else if (metaFirst || layoutFirst) {
    const first: { header?: false | RunningContent; footer?: false | RunningContent } = {};
    for (const part of ['header', 'footer'] as const) {
      const value = layoutFirst && layoutFirst[part] !== undefined ? layoutFirst[part] : metaFirst ? metaFirst[part] : undefined;
      if (value === false) first[part] = false;
      else {
        const content = toRunningContent(value);
        if (content) first[part] = content;
      }
    }
    styles.firstPage = first;
  }
  if (fromLayout && Object.keys(fromLayout.strings).length > 0) styles.strings = { ...fromLayout.strings };
  if (built.marginFontSize) styles.marginFontSize = built.marginFontSize;
  const named = Object.entries(built.namedPages);
  if (named.length > 0) styles.namedPages = Object.fromEntries(named.map(([name, g]) => [name, geometry(g)]));
  const namedRunning = toNamedRunning(built);
  if (namedRunning) styles.namedRunning = namedRunning;
  styles.layout = built.layout?.path ? { path: built.layout.path, bundled: built.layout.bundled } : null;
  return styles;
}
