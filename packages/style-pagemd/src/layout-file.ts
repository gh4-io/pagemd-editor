/// <reference path="./pagemd-modules.d.ts" />
// Create Layout File (P5, R-129, R-130, ADR-0014 amendment): what to write when the author changes the page (size,
// margins) and confirms. Pure planning: the host shows the confirm prompt, then writes the files and applies the
// frontmatter edit. Never writes into pagemd's own folder (`layout.bundled`) or a shared profile:
// - `.pagemd/layouts/<doc>.css`: a copy of the current layout's text with only the plain `@page` size and margins
//   changed; header/footer boxes and named (landscape) pages stay as they were (R-130). With no layout, pagemd's
//   default layout is the one copied (it is what the document shows, ADR-0014);
// - `.pagemd/profiles/<doc>.doc.json` = { id: "<doc>.doc", extends: <the current profile, as the document names
//   it>, resources: { layout: "../layouts/<doc>.css" } } (R-129; R-138: the `.doc` suffix keeps it from clashing
//   with a profile named `<doc>`, e.g. `sop.md` and pagemd's `sop`. `../` is read from the profile's own folder, an
//   `extends` path from the document's folder, the same folder the document's own `profile:` path is read from;
//   since R-136 the parent's own relative paths keep working under it);
// - the frontmatter gets `profile: ./.pagemd/profiles/<doc>.doc.json`, a path, so pagemd finds it without a search.
// If the frontmatter already points at that file, only the layout file is rewritten.
import postcss, { type AtRule, type Declaration } from 'postcss';
import { buildSearchPaths, findProjectRoot, findResourceWithDuplicateCheck, posix, type FileSystem, type PathFunctions } from '@pagemd/resolver';
import { FALLBACK_PAGE, PAGE_SIZES, pageGeometry } from '@pagemd/theme-kit';
import { normalize } from '@pagemd/meta';
import type { PageGeometry, TextEdit } from '@pagemd-editor/core';
import { frontmatterMatch, yamlObject } from './frontmatter.ts';
import { portsOf } from './ports.ts';
import { resolveStyles } from './resolve.ts';
import type { LayoutBasis, StyleDocument, StyleEnvironment } from './types.ts';

export interface FileWrite {
  path: string;
  text: string;
}

/** A change to the document's text (the frontmatter), in string positions like the core's TextEdit. */
export type FrontmatterEdit = TextEdit;

export interface LayoutFilePlan {
  /** `.pagemd/layouts/<doc>.css` next to the document. */
  layoutPath: string;
  /** `.pagemd/profiles/<doc>.doc.json` next to the document (R-138). */
  profilePath: string;
  /** In order: the layout file, then (unless the document already uses it) the profile. */
  writes: FileWrite[];
  /** The frontmatter change naming the per-document profile; null when the document already names it. */
  edit: FrontmatterEdit | null;
  /** True when the document already used its per-document profile: only the layout file is rewritten. */
  reusesProfile: boolean;
}

/**
 * The per-document names (R-129, R-138): `<doc>` is the document's file name without its extension; the profile's
 * id is `<doc>.doc` and its file `<doc>.doc.json`.
 */
export function perDocumentNames(documentPath: string, P: PathFunctions = posix) {
  const dir = P.dirname(documentPath);
  const name = P.basename(documentPath, P.extname(documentPath));
  const profileId = `${name}.doc`;
  return {
    name,
    profileId,
    layoutPath: P.join(dir, '.pagemd', 'layouts', `${name}.css`),
    profilePath: P.join(dir, '.pagemd', 'profiles', `${profileId}.json`),
    /** How the frontmatter names the profile: a path from the document's folder. */
    profileRef: `./.pagemd/profiles/${profileId}.json`,
    /** How the profile names the layout: a path from the profile's own folder. */
    layoutRef: `../layouts/${name}.css`,
  };
}

function inside(path: string, folder: string, P: PathFunctions): boolean {
  const p = P.normalize(path).replace(/\\/g, '/');
  const f = P.normalize(folder).replace(/\\/g, '/').replace(/\/+$/, '');
  return p === f || p.startsWith(`${f}/`);
}

/**
 * What Create Layout File writes for `page` (see the file header). `basis` is the document's current resolution
 * (StyleResolution.basis). Throws, writing nothing, when it can't be done safely: a target inside pagemd's folder,
 * a frontmatter it can't edit, or a profile already named `<doc>` that the new file would clash with.
 */
export async function planLayoutFile(doc: StyleDocument, basis: LayoutBasis, page: PageGeometry, env: StyleEnvironment): Promise<LayoutFilePlan> {
  const P = env.path ?? posix;
  if (!doc.path) throw new Error('Create Layout File needs a document saved as a file.');
  const names = perDocumentNames(doc.path, P);
  for (const target of [names.layoutPath, names.profilePath]) {
    if (inside(target, env.pagemdPath, P)) throw new Error(`Create Layout File never writes into pagemd's own folder (${env.pagemdPath}).`);
  }
  if (basis.layout?.bundled && P.normalize(basis.layout.path) === P.normalize(names.layoutPath)) {
    throw new Error(`Create Layout File never writes pagemd's own layout (${basis.layout.path}).`);
  }

  const layoutText = rewritePage(basis.layoutText ?? pageCss(page), page);
  const reusesProfile = basis.profilePath !== null && P.normalize(basis.profilePath) === P.normalize(names.profilePath);
  const writes: FileWrite[] = [{ path: names.layoutPath, text: layoutText }];
  const file = { path: doc.path, text: doc.text };
  if (reusesProfile) {
    const plan = { layoutPath: names.layoutPath, profilePath: names.profilePath, writes, edit: null, reusesProfile };
    await checkResult(file, plan, page, env);
    return plan;
  }

  await checkNoClash([names.profileId, `${names.profileId}.json`], names.profilePath, doc.path, env);
  const profile = { id: names.profileId, extends: basis.profileId, resources: { layout: names.layoutRef } };
  writes.push({ path: names.profilePath, text: `${JSON.stringify(profile, null, 2)}\n` });
  const plan = { layoutPath: names.layoutPath, profilePath: names.profilePath, writes, edit: frontmatterProfileEdit(doc.text, names.profileRef), reusesProfile };
  await checkResult(file, plan, page, env);
  return plan;
}

/**
 * Resolves the document again as it would be after the plan (the writes laid over the real files, the frontmatter
 * edited) and refuses a plan that would break it: its styles must still resolve, from the new layout file, with the
 * requested page. It catches what the plan can't see on its own, e.g. a parent profile whose stylesheets are named
 * relative to its own folder (`../styles/x.css`): merged under the per-document profile, they are looked up from
 * `.pagemd/profiles/` instead and not found.
 */
async function checkResult(doc: { path: string; text: string }, plan: LayoutFilePlan, page: PageGeometry, env: StyleEnvironment): Promise<void> {
  const P = env.path ?? posix;
  const text = plan.edit ? doc.text.slice(0, plan.edit.from) + plan.edit.text + doc.text.slice(plan.edit.to) : doc.text;
  const { cache: _shared, ...fresh } = env; // the session's profile cache doesn't know the new profile
  const after = await resolveStyles({ path: doc.path, text }, { ...fresh, fs: overlayFileSystem(env.fs, plan.writes, P) });
  if (!after.styles) {
    throw new Error(`Create Layout File would break this document's styles, so nothing was written: ${after.notes.map((n) => n.message).join('; ')}`);
  }
  if (!after.styles.layout || P.normalize(after.styles.layout.path) !== P.normalize(plan.layoutPath)) {
    throw new Error(`Create Layout File: the document would not use the new layout file (${plan.layoutPath}), so nothing was written.`);
  }
  const got = after.styles.page;
  const ok = same(got.width, page.width) && same(got.height, page.height) && (['top', 'right', 'bottom', 'left'] as const).every((side) => same(got.margins[side], page.margins[side]));
  if (!ok) throw new Error("Create Layout File: another of the profile's stylesheets sets the page after the layout, so the new layout would not change it; nothing was written.");
}

/** `writes` laid over `fs`, without writing anything: files are replaced or added, their folders appear. */
export function overlayFileSystem(fs: FileSystem, writes: readonly FileWrite[], P: PathFunctions = posix): FileSystem {
  const key = (p: string) => P.normalize(p).replace(/\\/g, '/').replace(/\/+$/, '');
  const files = new Map(writes.map((w) => [key(w.path), w.text]));
  const folders = new Map<string, Set<string>>();
  for (const path of files.keys()) {
    for (let child = path, dir = P.dirname(path).replace(/\\/g, '/'); dir !== child; child = dir, dir = P.dirname(dir).replace(/\\/g, '/')) {
      const names = folders.get(key(dir)) ?? new Set<string>();
      names.add(child.slice(child.lastIndexOf('/') + 1));
      folders.set(key(dir), names);
    }
  }
  return {
    exists: async (path) => files.has(key(path)) || folders.has(key(path)) || (await fs.exists(path)),
    readText: async (path) => files.get(key(path)) ?? (await fs.readText(path)),
    async stat(path) {
      const text = files.get(key(path));
      if (text !== undefined) return { isFile: true, isDirectory: false, size: new TextEncoder().encode(text).length };
      const real = await fs.stat(path);
      if (!real && folders.has(key(path))) return { isFile: false, isDirectory: true, size: 0 };
      return real;
    },
    async list(path) {
      const extra = [...(folders.get(key(path)) ?? [])];
      let real: string[] = [];
      try {
        real = await fs.list(path);
      } catch (error) {
        if (extra.length === 0) throw error;
      }
      return [...new Set([...real, ...extra])].sort();
    },
  };
}

/**
 * A safety net (R-138): the resolver looks profiles up by name in `.pagemd/profiles/` too, and a name found twice is
 * an error (R-123, kept). The `.doc` suffix keeps the per-document profile's name apart from ordinary profile
 * names; should a profile by that name (`<doc>.doc`, or the file `<doc>.doc.json`) already exist where this
 * document's lookups see it (its folder, the project root, `~/.pagemd`, pagemd's own), refuse rather than clash.
 */
async function checkNoClash(names: string[], ownPath: string, documentPath: string, env: StyleEnvironment): Promise<void> {
  const P = env.path ?? posix;
  const ports = portsOf(documentPath, env);
  const dir = P.dirname(documentPath);
  const projectRoot = await findProjectRoot(dir, ports);
  const searchPaths = buildSearchPaths('profiles', { workingPath: dir, workspacePath: projectRoot ?? dir, cliPath: env.pagemdPath, sourceType: 'cli' }, ports);
  for (const name of names) {
    const { found, duplicates } = await findResourceWithDuplicateCheck(name, searchPaths, 'profiles', ports);
    const others = [...(found ? [found] : []), ...duplicates].filter((p) => P.normalize(p) !== P.normalize(ownPath));
    if (others.length > 0) {
      throw new Error(
        `A profile named "${name}" already exists (${others.join(', ')}); a per-document profile ${ownPath} would clash with it. Rename the document or that profile first.`,
      );
    }
  }
}

// ── the layout text (R-130) ──

const TOLERANCE_MM = 0.001;
const same = (a: number, b: number) => Math.abs(a - b) < TOLERANCE_MM;
const mm = (n: number) => `${Math.round(n * 1000) / 1000}mm`;

/** A minimal layout for `page`, when there is no layout text to copy. */
export function pageCss(page: PageGeometry): string {
  return `@page {\n  size: ${sizeValue(page)};\n  margin: ${marginValue(page)};\n}\n`;
}

/** `size` for a page: a CSS page-size keyword when one fits (portrait or landscape), else two lengths. */
function sizeValue(page: PageGeometry, previous?: string): string {
  const keywordCase = (keyword: string) => previous?.split(/\s+/).find((w) => w.toLowerCase() === keyword) ?? keyword;
  for (const [keyword, [w, h]] of Object.entries(PAGE_SIZES)) {
    if (same(page.width, w) && same(page.height, h)) return keywordCase(keyword);
    if (same(page.width, h) && same(page.height, w)) return `${keywordCase(keyword)} landscape`;
  }
  return `${mm(page.width)} ${mm(page.height)}`;
}

/** `margin` shorthand, as short as CSS allows. */
function marginValue(page: PageGeometry): string {
  const { top, right, bottom, left } = page.margins;
  if (same(right, left)) {
    if (same(top, bottom)) return same(top, right) ? mm(top) : `${mm(top)} ${mm(right)}`;
    return `${mm(top)} ${mm(right)} ${mm(bottom)}`;
  }
  return `${mm(top)} ${mm(right)} ${mm(bottom)} ${mm(left)}`;
}

const MARGIN = /^margin(-(top|right|bottom|left))?$/i;

/**
 * The layout text with the plain `@page` rule's size and margins set to `page`; everything else is kept byte for
 * byte (comments, margin boxes, `@page :first`, named pages). A declaration already giving the right value is left
 * as written, so an unchanged page gives the same text. Throws when the result wouldn't read back as `page`.
 */
export function rewritePage(layoutText: string, page: PageGeometry): string {
  const root = postcss.parse(layoutText);
  const plainRules: AtRule[] = [];
  root.walkAtRules(/^page$/i, (rule) => {
    if (rule.params.trim() === '') plainRules.push(rule);
  });
  if (plainRules.length === 0) {
    const separator = layoutText === '' || layoutText.endsWith('\n') ? '' : '\n';
    return layoutText + separator + (layoutText === '' ? '' : '\n') + pageCss(page);
  }

  const current = pageGeometry(layoutText, { fallback: FALLBACK_PAGE });
  const declarations = (rule: AtRule, test: (d: Declaration) => boolean): Declaration[] =>
    (rule.nodes ?? []).filter((n): n is Declaration => n.type === 'decl' && test(n));
  const last = plainRules[plainRules.length - 1]!;

  if (!same(current.width, page.width) || !same(current.height, page.height)) {
    const sizes = plainRules.flatMap((rule) => declarations(rule, (d) => d.prop.toLowerCase() === 'size'));
    const size = sizes[sizes.length - 1];
    if (size) size.value = sizeValue(page, size.value);
    else last.prepend({ prop: 'size', value: sizeValue(page) });
  }

  const m = current.margins;
  const p = page.margins;
  if (!same(m.top, p.top) || !same(m.right, p.right) || !same(m.bottom, p.bottom) || !same(m.left, p.left)) {
    const withMargins = plainRules.filter((rule) => declarations(rule, (d) => MARGIN.test(d.prop)).length > 0);
    const target = withMargins[withMargins.length - 1];
    if (target) {
      const old = declarations(target, (d) => MARGIN.test(d.prop));
      old[0]!.cloneBefore({ prop: 'margin', value: marginValue(page) });
      for (const d of old) d.remove();
    } else {
      const size = declarations(last, (d) => d.prop.toLowerCase() === 'size')[0];
      if (size) size.cloneAfter({ prop: 'margin', value: marginValue(page) });
      else last.prepend({ prop: 'margin', value: marginValue(page) });
    }
  }

  const text = root.toString();
  const check = pageGeometry(text, { fallback: FALLBACK_PAGE });
  const ok =
    same(check.width, page.width) &&
    same(check.height, page.height) &&
    (['top', 'right', 'bottom', 'left'] as const).every((side) => same(check.margins[side], page.margins[side]));
  if (!ok) throw new Error('The layout file would not give the requested page; its @page rules are too unusual to change safely.');
  return text;
}

// ── the frontmatter (R-129) ──

/** A YAML value for `text`: plain when that reads back the same, else double-quoted (JSON is valid YAML). */
function yamlScalar(text: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(text) && !/^[-.]{3}/.test(text) ? text : JSON.stringify(text);
}

/**
 * The edit that makes the frontmatter name `profileRef` as its profile: the existing profile line gets the new
 * value (under the key the author wrote: `profile`, `layout_template`, …), else a `profile:` line is added before
 * the closing `---`, else a frontmatter is added at the start. Line endings follow the document.
 */
export function frontmatterProfileEdit(text: string, profileRef: string): FrontmatterEdit {
  return fieldEdit(text, 'pipeline_profile', 'profile', yamlScalar(profileRef), 'the profile line');
}

function fieldEdit(text: string, canonical: string, newKey: string, value: string, what: string): FrontmatterEdit {
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const match = frontmatterMatch(text);
  if (!match) return { from: 0, to: 0, text: `---${eol}${newKey}: ${value}${eol}---${eol}` };

  const body = match[1] ?? '';
  const bodyStart = match[0].indexOf('\n') + 1;
  let raw: unknown;
  try {
    raw = yamlObject(body);
  } catch (error) {
    throw new Error(`The frontmatter can't be read, so ${what} can't be added: ${error instanceof Error ? error.message : String(error)}`);
  }
  const authorKey = normalize(raw as Record<string, unknown>, { applyDefaults: false }).keys[canonical];

  if (authorKey !== undefined) {
    const line = lastKeyLine(body, authorKey);
    if (!line) throw new Error(`The frontmatter's "${authorKey}" line can't be found to change it.`);
    return { from: bodyStart + line.from, to: bodyStart + line.to, text: `${line.key}: ${value}` };
  }

  // Not there yet: a new line before the closing `---`.
  const closing = match[0].search(/---[ \t]*(?:\r?\n)?$/);
  return { from: closing, to: closing, text: `${newKey}: ${value}${eol}` };
}

/**
 * The last top-level line `key: …` in the frontmatter (the value YAML keeps), with the indented lines that
 * continue its value. `key` is returned as written (quotes kept).
 */
function lastKeyLine(body: string, key: string): { from: number; to: number; key: string } | null {
  const lines: { start: number; text: string }[] = [];
  let start = 0;
  for (const text of body.split('\n')) {
    lines.push({ start, text: text.replace(/\r$/, '') });
    start += text.length + 1;
  }
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const keyLine = new RegExp(`^(${escaped}|"${escaped}"|'${escaped}')[ \\t]*:(?=\\s|$)`);
  let found: { from: number; to: number; key: string } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = keyLine.exec(lines[i]!.text);
    if (!m) continue;
    let end = i;
    while (end + 1 < lines.length && /^[ \t]+\S/.test(lines[end + 1]!.text)) end++;
    found = { from: lines[i]!.start, to: lines[end]!.start + lines[end]!.text.length, key: m[1]! };
  }
  return found;
}
