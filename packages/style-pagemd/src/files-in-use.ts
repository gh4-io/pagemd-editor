/// <reference path="./pagemd-modules.d.ts" />
// Files in Use (P25, R-242): every file that builds a document, in priority order, why each one was chosen, the problems, and the
// index of every style rule for "where did this come from". Built from the last resolution (`StyleResolution.trace`): nothing is
// resolved again and nothing is written. Why a file was chosen is read from the resolver's own folder lists (`buildSearchPaths`,
// one search step at a time) and its own `profileResourceKeys`: no search is re-done here (cohesion checkpoint 3, AD-P25-01).
import postcss, { type AtRule, type Container, type Root, type Rule } from 'postcss';
import { buildSearchPaths, expandTokens, isProfilePath, loadYaml, posix, profileResourceKeys, type PathContext, type PathFunctions, type ResolvedFile } from '@pagemd/resolver';
import type { CssLayer, CssRuleSource, FileUse, FilesInUse, FilesInUseProblem, FoundBy } from '@pagemd-editor/core';
import { CANVAS_SCOPE, scopeRoot } from './scope.ts';
import type { AssetUse, StyleEnvironment, StyleResolution } from './types.ts';

/** The cascade in plain words (shown once at the top of the panel; AD-P25-06). */
export const CASCADE_NOTE =
  'A stylesheet higher in this list wins over one lower down. In the same layer, the more specific selector wins (an id beats a class, a class beats a tag name); ' +
  'if two are equally specific, the later one wins: the later file, or the rule further down the same file. !important turns the layer order around. ' +
  'A profile wins over the profiles it extends where both set the same thing. ' +
  "A file named without a path is looked for in these places, in this order: the document's folder, the profile's folder (only for a file the profile names), " +
  "the project folder, the shared profiles folder (only for a profile: where profile packs are installed), your ~/.pagemd folder and pagemd's own files; " +
  'pagemd looks in all of them, and a name found in two is an error. ' +
  // FIX-FT item 4 (OQ-55, "follow the code"): a ./ or ../ path is not searched, and starts in a profile's folder, also in the document's styles: list.
  "A path that starts with ./ or ../ is not searched: it starts in the folder of the profile that names it, and the document's own styles: list starts in the profile's folder too " +
  "(with no profile set, that is pagemd's own profiles folder, so name the file without a path or write ${workingPath}/ in front).";

/** The resolver's five search steps (R-24), in plain words. */
export const SEARCH_STEPS: Readonly<Record<1 | 2 | 3 | 4 | 5, string>> = {
  1: "the document's folder",
  2: "the profile's folder",
  3: 'the project folder (workspace root)',
  4: 'your ~/.pagemd folder',
  5: "pagemd's own files",
};

/** Phase L2 (F7): a profile's six search steps, the shared profiles folder (profile packs) the fourth. */
export const PROFILE_SEARCH_STEPS: Readonly<Record<1 | 2 | 3 | 4 | 5 | 6, string>> = {
  1: "the document's folder",
  2: "the profile's folder",
  3: 'the project folder (workspace root)',
  4: 'the shared profiles folder (profile packs)',
  5: 'your ~/.pagemd folder',
  6: "pagemd's own files",
};

type ResourceType = 'profiles' | 'templates' | 'layouts' | 'styles';
type SourceType = 'profile' | 'frontmatter' | 'cli';

interface Folders {
  working: string | null;
  workspace: string | null;
  manifest: string | null;
  /** Phase L2: the shared profiles folder (a profile's step 4). */
  shared?: string | null;
  home: string | null;
  cli: string | null;
}

const LAYER_LABEL: Record<CssLayer, string> = {
  base: "Base styles (pagemd's)",
  primary: "Primary styles (pagemd's)",
  layout: 'Page layout',
  syntax: "Code colors (pagemd's)",
  profile: 'Profile stylesheet',
  frontmatter: "The document's own styles",
  template: "The template's own <style>",
};

/** Why pagemd's own system files are there. */
const SYSTEM_WHY: Partial<Record<CssLayer, string>> = {
  base: "pagemd's own reset, always loaded first: every other stylesheet wins over it.",
  primary: "pagemd's own default look, always loaded right after the base styles.",
  syntax: "pagemd's own colors for code blocks, always loaded, after the page layout.",
};

/**
 * Why the resolver picked `path` for `source` (as written): a `${token}` path, a full path, a `./` path, or a name found by one search
 * step. `P` is the host's path functions; the search folders are the resolver's own (buildSearchPaths, one step at a time).
 */
export function foundBy(type: ResourceType, source: string, path: string, folders: Folders, sourceType: SourceType, P: PathFunctions = posix): FoundBy {
  let expanded = source;
  if (/\$\{\w+\}/.test(source)) {
    try {
      expanded = expandTokens(source, { workingPath: folders.working, markdownDir: folders.working, workspacePath: folders.workspace, projectRoot: folders.workspace, workspaceFolder: folders.workspace, manifestPath: folders.manifest, manifestDir: folders.manifest, homePath: folders.home, cliPath: folders.cli }, { env: { path: P } } as never);
    } catch {
      return { kind: 'unknown' };
    }
  }
  if (type === 'profiles' && isProfilePath(source) && !P.isAbsolute(expanded)) return { kind: 'path', base: folders.working };
  if (P.isAbsolute(expanded)) return { kind: 'absolute' };
  if (expanded.startsWith('./') || expanded.startsWith('../')) return { kind: 'path', base: folders.manifest ?? folders.working ?? folders.workspace };
  const dir = P.normalize(P.dirname(path));
  const profiles = type === 'profiles';
  const steps: [1 | 2 | 3 | 4 | 5 | 6, Record<string, unknown> | null][] = [
    [1, folders.working ? { workingPath: folders.working } : null],
    [2, sourceType === 'profile' && folders.manifest ? { manifestPath: folders.manifest, sourceType: 'profile' } : null],
    [3, folders.workspace ? { workspacePath: folders.workspace } : null],
    // Phase L2 (F7): a profile's search has the shared profiles folder as step 4; other files keep five steps
    ...(profiles ? ([[4, folders.shared ? { sharedProfilesPath: folders.shared } : null]] as [4, Record<string, unknown> | null][]) : []),
    [profiles ? 5 : 4, folders.home ? { homePath: folders.home } : null],
    [profiles ? 6 : 5, folders.cli ? { cliPath: folders.cli } : null],
  ];
  // Only the path functions: the resolver adds `env.homePath` to every list when it is in the ports.
  const ports = { env: { path: P } } as never;
  for (const [step, context] of steps) {
    if (!context) continue;
    const list = buildSearchPaths(type, context, ports);
    if (list.includes(dir)) return profiles ? { kind: 'search', step, folder: dir, of: 6 } : { kind: 'search', step, folder: dir };
  }
  return { kind: 'unknown' };
}

/** `foundBy` in plain words. */
export function whyText(found: FoundBy, source: string | undefined, folders: Folders): string {
  const tokens = source && /\$\{(\w+)\}/.exec(source);
  const written = tokens ? `Written as "${source}" (\${${tokens[1]}} is ${tokenMeaning(tokens[1]!)})` : source ? `Written as "${source}"` : '';
  switch (found.kind) {
    case 'search':
      return found.of === 6
        ? `Found by its name "${source}" in ${PROFILE_SEARCH_STEPS[found.step]} (search step ${found.step} of 6).`
        : `Found by its name "${source}" in ${SEARCH_STEPS[found.step as 1 | 2 | 3 | 4 | 5]} (search step ${found.step} of 5).`;
    case 'path':
      return `${written}: a path from ${found.base === folders.manifest && folders.manifest ? "the profile's folder" : found.base === folders.working ? "the document's folder" : 'the project folder'}${found.base ? ` (${found.base})` : ''}, no search.`;
    case 'absolute':
      return `${written || 'Written as a full path'}${tokens ? '' : ' (a full path)'}: used as it is, no search.`;
    case 'system':
      return "pagemd's own file, always loaded.";
    case 'default':
      return "pagemd's default layout: the profile names no layout and no stylesheet has an @page rule (ADR-0014).";
    case 'generated':
      return 'Made by pagemd from the frontmatter (running header and footer, page numbers): CSS variables the layout reads.';
    case 'named':
      return written ? `${written}.` : '';
    default:
      return written ? `${written}; the folder it was found in is not one of the search places.` : 'Where it was found could not be worked out.';
  }
}

function tokenMeaning(token: string): string {
  if (token === 'cliPath') return "pagemd's own folder";
  if (token === 'workingPath' || token === 'markdownDir') return "the document's folder";
  if (token === 'manifestPath' || token === 'manifestDir') return "the profile's folder";
  if (token === 'homePath') return 'your home folder';
  return 'the project folder';
}

/** A profile file's own object (not merged), read from its text; null when it can't be read. */
async function rawProfile(path: string | null, env: StyleEnvironment): Promise<Record<string, unknown> | null> {
  if (!path) return null;
  try {
    const text = await env.fs.readText(path);
    const data = path.toLowerCase().endsWith('.json') ? JSON.parse(text) : loadYaml(text);
    return data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const inside = (path: string | null | undefined, folder: string, P: PathFunctions): boolean => {
  if (!path) return false;
  const f = P.normalize(folder).replace(/[\\/]+$/, '');
  const p = P.normalize(path);
  return p === f || p.startsWith(f + P.sep) || p.startsWith(`${f}/`);
};

/** The Files in Use report for a resolution (see the file header). Never throws for a document problem. */
export async function filesInUse(resolution: StyleResolution, env: StyleEnvironment): Promise<FilesInUse> {
  const P = env.path ?? posix;
  const trace = resolution.trace;
  const files: FileUse[] = [];
  const problems: FilesInUseProblem[] = [];
  let next = 0;
  const add = (row: Omit<FileUse, 'id'>): FileUse => {
    const full = { id: `f${++next}`, ...row } as FileUse;
    files.push(full);
    return full;
  };
  const bundled = (path: string | null | undefined) => inside(path, env.pagemdPath, P);
  const base = (path: string | null | undefined, fallback: string) => (path ? P.basename(path) : fallback);

  const documentPath = trace?.documentPath ?? null;
  const resolved = trace?.resolved;
  const frontmatter = trace?.frontmatter ?? null;
  const profileAsked = typeof frontmatter?.['pipeline_profile'] === 'string' ? (frontmatter['pipeline_profile'] as string) : null;

  if (documentPath) {
    const names: string[] = [];
    if (profileAsked) names.push(`the profile "${profileAsked}"`);
    if (Array.isArray(frontmatter?.['styles'])) names.push('a styles: list');
    add({
      role: 'document',
      path: documentPath,
      name: P.basename(documentPath),
      label: 'This document',
      why: names.length ? `Its frontmatter names ${names.join(' and ')}; its properties are filled into the template and the headers.` : 'Its frontmatter names no profile, so pagemd uses its default profile.',
      foundBy: { kind: 'named' },
      bundled: false,
    });
  }

  if (trace?.failure) problems.push({ kind: trace.failure.kind, message: trace.failure.message, ...(trace.failure.source ? { source: trace.failure.source } : {}) });
  if (!trace || !resolved) {
    return { document: documentPath, profile: profileAsked, files, problems, cascade: CASCADE_NOTE, rules: [], plain: true };
  }

  const ctx: PathContext = resolved.pathContext;
  const docFolders: Folders = { working: ctx?.workingPath ?? resolved.markdownDir, workspace: ctx?.workspacePath ?? resolved.projectRoot, manifest: ctx?.manifestPath ?? null, shared: env.sharedProfilesPath ?? null, home: env.homePath ?? ctx?.homePath ?? null, cli: ctx?.cliPath ?? resolved.cliPath };

  // ── the profile chain: the named profile first (it wins), then each one it extends ──
  const chain = resolved.profileChain;
  const raws = await Promise.all(chain.map((p) => rawProfile(p.path, env)));
  const profileFolders: Folders = { ...docFolders, workspace: docFolders.workspace ?? docFolders.working };
  chain.forEach((entry, i) => {
    const written = i === 0 ? (profileAsked ?? '') : String(raws[i - 1]?.['extends'] ?? entry.id);
    const asked = i === 0 && !profileAsked;
    const found = entry.path ? foundBy('profiles', written || entry.id, entry.path, profileFolders, 'cli', P) : ({ kind: 'unknown' } as FoundBy);
    const by = i === 0 ? (asked ? `No profile in the frontmatter, so pagemd's default profile "${resolved.profileId}". ` : '') : `The profile "${chain[i - 1]!.id}" extends it. `;
    add({
      role: 'profile',
      path: entry.path,
      name: base(entry.path, entry.id),
      label: i === 0 ? (asked ? "Profile (pagemd's default)" : 'Profile you named') : `Profile it extends${chain.length > 2 ? ` (${i})` : ''}`,
      source: written || entry.id,
      why: `${by}${whyText(found, written || entry.id, profileFolders)}`,
      foundBy: found,
      bundled: bundled(entry.path),
    });
  });

  /** The profile in the chain that names a resource (the first one, child first, R-136), and its folder. */
  const namer = (key: 'template' | 'layout' | 'styles'): { id: string; folder: string | null } | null => {
    for (let i = 0; i < chain.length; i++) {
      const raw = raws[i];
      if (raw && profileResourceKeys(raw)[key]) return { id: chain[i]!.id, folder: chain[i]!.path ? P.dirname(chain[i]!.path!) : null };
    }
    return null;
  };
  const namedBy = (key: 'template' | 'layout' | 'styles'): string => {
    const who = namer(key);
    return who ? `Named by the profile "${who.id}". ` : '';
  };
  const folderFor = (key: 'template' | 'layout' | 'styles'): Folders => ({ ...docFolders, manifest: namer(key)?.folder ?? docFolders.manifest });

  // ── the template ──
  const template = resolved.template;
  if (template) {
    const folders = folderFor('template');
    const found = template.path ? foundBy('templates', template.source, template.path, folders, 'profile', P) : ({ kind: 'unknown' } as FoundBy);
    add({
      role: 'template',
      path: template.path ?? null,
      name: base(template.path, P.basename(template.source)),
      label: 'Template (the HTML around the text)',
      source: template.source,
      why: `${template.usedDefault ? "The profile names no template, so pagemd's default. " : namedBy('template')}${template.path ? whyText(found, template.source, folders) : ''}`.trim(),
      foundBy: found,
      bundled: bundled(template.path),
      ...(template.error ? problemOf(template) : {}),
    });
  }

  // ── FIX-template-asset-paths (R-259): the pictures and other files the template, the layout and the profile's CSS pull in ──
  const NAMER: Record<AssetUse['from'], string> = { template: 'the template', layout: 'the page layout', stylesheet: 'a profile stylesheet' };
  const listed = new Set<string>();
  for (const asset of trace.assets ?? []) {
    const key = `${asset.file}\u0000${asset.written}`;
    if (listed.has(key)) continue;
    listed.add(key);
    const inFile = `${NAMER[asset.from]} ${P.basename(asset.file)}`;
    const why =
      asset.outcome === 'file'
        ? `${inFile} names "${asset.written}". A path in a template or stylesheet starts in that file's own folder, and the file is there.`
        : asset.outcome === 'document'
          ? `${inFile} names "${asset.written}". It is not next to ${P.basename(asset.file)}, so it is read from the document's folder, as pagemd always did.`
          : `${inFile} names "${asset.written}", but it is neither next to ${P.basename(asset.file)} nor in the document's folder: the page shows nothing there.`;
    add({
      role: 'asset',
      path: asset.path,
      name: P.basename(asset.path ?? asset.written.split(/[?#]/)[0]!),
      label: asset.from === 'template' ? 'Picture or file the template uses' : `File ${asset.from === 'layout' ? 'the page layout' : 'a stylesheet'} uses`,
      source: asset.written,
      why: `${why.charAt(0).toUpperCase()}${why.slice(1)}`,
      foundBy: asset.path ? { kind: 'path', base: P.dirname(asset.outcome === 'file' ? asset.file : (documentPath ?? asset.file)) } : { kind: 'unknown' },
      bundled: bundled(asset.path),
      ...(asset.outcome === 'missing' ? { problem: `Not found: looked in ${asset.tried.join(' and ')}`, candidates: asset.tried } : {}),
    });
    if (asset.outcome === 'missing') problems.push({ kind: 'template-asset-missing', message: `File not found: ${asset.written}, named in ${inFile} (looked in ${asset.tried.join(' and ')})`, source: asset.written, paths: asset.tried });
  }

  // ── stylesheets: built list (cascade order, lowest first), else what the resolver found ──
  type Sheet = { layer: CssLayer; path: string | null; content: string | null; source?: string; row: Omit<FileUse, 'id' | 'rank'> };
  const sheets: Sheet[] = [];
  const rowFor = (layer: CssLayer, path: string | null, source: string | undefined, entry?: ResolvedFile, index?: { n: number; of: number }): Omit<FileUse, 'id' | 'rank'> => {
    let found: FoundBy;
    let why: string;
    const count = index && index.of > 1 ? ` ${index.n} of ${index.of}` : '';
    let label = `${LAYER_LABEL[layer]}${count}`;
    if (layer === 'base' || layer === 'primary' || layer === 'syntax') {
      found = { kind: 'system' };
      why = SYSTEM_WHY[layer]!;
    } else if (layer === 'frontmatter' && !path && !entry) {
      found = { kind: 'generated' };
      why = whyText(found, source, docFolders);
      label = "The document's properties";
    } else if (layer === 'layout' && trace.usingDefault && path === trace.defaultLayoutPath && !resolved.layout) {
      found = { kind: 'default' };
      why = whyText(found, source, docFolders);
      label = "Page layout (pagemd's default)";
    } else if (layer === 'frontmatter') {
      const own = Array.isArray(frontmatter?.['styles']);
      const folders = docFolders;
      found = path && source ? foundBy('styles', source, path, folders, 'frontmatter', P) : { kind: 'unknown' };
      why = `${own ? "Listed in this document's styles:" : "Listed in the profile's default styles: (metadata.defaults)"}. ${path && source ? whyText(found, source, folders) : ''}`.trim();
      label = `The document's styles: file${count}`;
    } else {
      const key = layer === 'layout' ? 'layout' : 'styles';
      const folders = folderFor(key);
      found = path && source ? foundBy(layer === 'layout' ? 'styles' : 'styles', source, path, folders, 'profile', P) : { kind: 'unknown' };
      why = `${namedBy(key)}${path && source ? whyText(found, source, folders) : ''}`.trim();
    }
    return { role: 'stylesheet', path, name: path ? P.basename(path) : found.kind === 'generated' ? 'CSS made from the properties' : P.basename(source ?? layer), label, ...(source ? { source } : {}), why, foundBy: found, layer, bundled: bundled(path), ...(entry?.error ? problemOf(entry) : {}) };
  };

  if (trace.sheets) {
    const profileCount = trace.sheets.filter((s) => s.layer === 'profile').length;
    const fmCount = trace.sheets.filter((s) => s.layer === 'frontmatter' && s.path).length;
    let profileN = 0;
    let fmN = 0;
    for (const s of trace.sheets) {
      const entry = s.layer === 'profile' ? resolved.styles.filter((e) => !e.skipped)[profileN] : s.layer === 'frontmatter' && s.path ? resolved.frontmatterStyles[fmN] : s.layer === 'layout' ? (resolved.layout ?? undefined) : undefined;
      const index = s.layer === 'profile' ? { n: ++profileN, of: profileCount } : s.layer === 'frontmatter' && s.path ? { n: ++fmN, of: fmCount } : undefined;
      sheets.push({ layer: s.layer, path: s.path, content: s.content, ...(s.source ? { source: s.source } : {}), row: rowFor(s.layer, s.path, s.source ?? entry?.source, entry, index) });
    }
  } else {
    // The CSS was not built (a stylesheet missing, pagemd's own files missing): list what the resolver found, in layer order.
    const system = resolved.system;
    const push = (layer: CssLayer, path: string | null, source?: string, entry?: ResolvedFile, index?: { n: number; of: number }) => sheets.push({ layer, path, content: null, ...(source ? { source } : {}), row: rowFor(layer, path, source, entry, index) });
    if (system.base) push('base', system.base);
    if (system.primary) push('primary', system.primary);
    if (resolved.layout) push('layout', resolved.layout.path ?? null, resolved.layout.source, resolved.layout);
    if (system.syntax) push('syntax', system.syntax);
    const own = resolved.styles.filter((e) => !e.skipped);
    own.forEach((e, i) => push('profile', e.path ?? null, e.source, e, { n: i + 1, of: own.length }));
    resolved.frontmatterStyles.forEach((e, i) => push('frontmatter', e.path ?? null, e.source, e, { n: i + 1, of: resolved.frontmatterStyles.length }));
  }
  // The template's own <style> CSS (P18): outside any layer, so above all of them.
  const templateCss = templateStyles(trace.templateText ?? '');
  if (templateCss.length > 0 && template?.path) {
    sheets.push({
      layer: 'template',
      path: template.path,
      content: null,
      row: { role: 'stylesheet', path: template.path, name: P.basename(template.path), label: "The template's own <style>", why: "CSS written inside the template's <style> tags. It is outside pagemd's layers, so it wins over every stylesheet below.", foundBy: { kind: 'named' }, layer: 'template', bundled: bundled(template.path) },
    });
  }

  // ── the rule index (lowest priority first, the cascade's own order) ──
  const rules: CssRuleSource[] = [];
  const ruleCount = new Map<Sheet, number>();
  sheets.forEach((sheet, index) => {
    let found: CssRuleSource[] = [];
    if (sheet.layer === 'template') {
      for (const block of templateCss) found.push(...indexCss(block.css, '', sheet.layer, index, block.line, block.media));
    } else if (sheet.content !== null) {
      found = indexCss(sheet.content, '', sheet.layer, index, 0);
    }
    ruleCount.set(sheet, found.length);
    rules.push(...found.map((r) => ({ ...r, file: String(index) })));
  });

  // Shown highest priority first; the ranks number the stylesheets 1 (wins) … n.
  const shown = [...sheets].reverse();
  const idOf = new Map<number, string>();
  shown.forEach((sheet, i) => {
    const row = add({ ...sheet.row, rank: i + 1, ...(sheet.content !== null || sheet.layer === 'template' ? { rules: ruleCount.get(sheet) ?? 0 } : {}) });
    idOf.set(sheets.indexOf(sheet), row.id);
  });
  for (const rule of rules) rule.file = idOf.get(Number(rule.file)) ?? rule.file;

  // ── skipped profile entries and problems ──
  for (const entry of resolved.styles.filter((e) => e.skipped)) {
    problems.push({ kind: 'skipped', message: `The profile lists "${entry.source}", but pagemd already loads its own ${P.basename(entry.source)} at the bottom, so this entry is skipped.`, source: entry.source });
  }
  for (const p of resolved.problems) {
    if (p.kind === 'template') continue; // the canvas ignores template problems (amendment 9); the template row says it
    const entry = [...resolved.styles, ...resolved.frontmatterStyles, ...(resolved.layout ? [resolved.layout] : [])].find((e) => e.source === p.source && e.error);
    const duplicates = (entry?.error as { duplicates?: string[] } | undefined)?.duplicates;
    problems.push({ kind: duplicates ? 'duplicate' : 'missing', message: p.message, source: p.source, ...(duplicates ? { paths: duplicates } : {}) });
  }
  for (const note of resolution.notes) {
    if (note.kind === 'missing-stylesheet' || note.kind === 'using-default-layout') continue; // already a row or a problem
    if (!problems.some((p) => p.message === note.message)) problems.push({ kind: note.kind, message: note.message, ...(note.source ? { source: note.source } : {}) });
  }

  return { document: documentPath, profile: resolved.profileId, files, problems, cascade: CASCADE_NOTE, rules, plain: resolution.styles === null };
}

function problemOf(entry: ResolvedFile): Pick<FileUse, 'problem' | 'candidates'> {
  const error = entry.error as (Error & { duplicates?: string[]; searchedPaths?: string[] }) | undefined;
  if (!error) return {};
  const candidates = error.duplicates ?? error.searchedPaths;
  return { problem: error.message.split('\n')[0]!, ...(candidates ? { candidates } : {}) };
}

/** The template's own `<style>` blocks, with the line each starts on in the template file and its `media` attribute (comments skipped). */
export function templateStyles(text: string): { css: string; line: number; media?: string }[] {
  const out: { css: string; line: number; media?: string }[] = [];
  // Comments become blank text of the same length, so line numbers stay the file's.
  const page = text.replace(/<!--[\s\S]*?(?:-->|$)/g, (m) => m.replace(/[^\n]/g, ' '));
  for (const m of page.matchAll(/<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi)) {
    if (!m[2]!.trim()) continue;
    const start = m.index! + m[0].indexOf('>') + 1;
    const line = page.slice(0, start).split('\n').length - 1;
    const media = /(?:^|\s)media\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(m[1]!);
    const value = media ? (media[1] ?? media[2] ?? media[3] ?? '').trim() : '';
    out.push({ css: m[2]!, line, ...(value && value.toLowerCase() !== 'all' ? { media: value } : {}) });
  }
  return out;
}

const NESTED = new Set(['media', 'supports', 'layer', 'container']);

/**
 * Every style rule of one sheet, scoped exactly as the canvas scopes it (scope.ts), with its line in the file (`lineOffset` lines
 * before the text: a template's `<style>`). Rules the canvas drops (`@page`, dark mode) are not there; rules inside `@keyframes` and
 * nested rules are left out. `media`: a `<style media>` condition around the whole sheet. A sheet that can't be read gives none.
 */
export function indexCss(css: string, file: string, layer: CssLayer, sheetIndex: number, lineOffset = 0, media?: string): CssRuleSource[] {
  let root: Root;
  try {
    root = postcss.parse(media ? `@media ${media} {\n${css}\n}` : css);
  } catch {
    return [];
  }
  const shift = media ? lineOffset - 1 : lineOffset;
  const written = new Map<Rule, { selector: string; line: number; column: number }>();
  root.walkRules((rule) => {
    written.set(rule, { selector: rule.selector, line: (rule.source?.start?.line ?? 1) + shift, column: rule.source?.start?.column ?? 1 });
  });
  try {
    scopeRoot(root, CANVAS_SCOPE);
  } catch {
    return [];
  }
  const out: CssRuleSource[] = [];
  let n = 0;
  root.walkRules((rule) => {
    const origin = written.get(rule);
    const parent = rule.parent as Container | undefined;
    if (!origin || parent?.type === 'rule') return;
    const conditions = { media: [] as string[], supports: [] as string[], layer: undefined as string | undefined, keyframes: false };
    for (let p: Container | undefined = parent; p && p.type !== 'root'; p = p.parent as Container | undefined) {
      if (p.type !== 'atrule') continue;
      const at = p as AtRule;
      const name = at.name.toLowerCase();
      if (/keyframes$/.test(name)) conditions.keyframes = true;
      else if (name === 'media') conditions.media.unshift(at.params);
      else if (name === 'supports') conditions.supports.unshift(at.params);
      else if (name === 'layer') conditions.layer = conditions.layer ? `${at.params}.${conditions.layer}` : at.params || '(anonymous)';
      else if (!NESTED.has(name)) conditions.keyframes = true; // any other at-rule: not a style rule the canvas applies to elements
    }
    if (conditions.keyframes) return;
    const declarations = (rule.nodes ?? []).filter((node) => node.type === 'decl').map((d) => ({ property: d.prop.toLowerCase(), value: d.value, important: d.important === true }));
    if (declarations.length === 0) return;
    out.push({
      file,
      line: origin.line,
      column: origin.column,
      selector: origin.selector.replace(/\s+/g, ' ').trim(),
      selectors: rule.selectors,
      layer,
      ...(conditions.layer ? { nestedLayer: conditions.layer } : {}),
      ...(conditions.media.length ? { media: conditions.media } : {}),
      ...(conditions.supports.length ? { supports: conditions.supports } : {}),
      order: sheetIndex * 100000 + n++,
      declarations,
    });
  });
  return out;
}
