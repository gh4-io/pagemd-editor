/// <reference path="./pagemd-modules.d.ts" />
// The document's frontmatter as pagemd reads it (P5): a YAML block between `---` lines at the very start, read with
// the resolver's YAML reader (js-yaml 4's rules, as pagemd's own). Shared by index.ts and layout-file.ts.
import { loadYaml } from '@pagemd/resolver';

/**
 * The frontmatter at the start of `text`, as pagemd's reader (gray-matter) finds it, in the plain form the editor
 * recognises (P8): the file starts with a `---` line, and the first line after it that starts with `---` closes it; both
 * lines are `---` with nothing but spaces after them. Anything else is no frontmatter for the editor. The same rule as
 * preset-pagemd's `frontmatterBlock` (the webview's), checked against the same cases in both packages' tests.
 * Returns `[whole block with its last line ending, the YAML between the lines (undefined when there is none)]`.
 */
export function frontmatterMatch(text: string): [string, string | undefined] | null {
  if (!text.startsWith('---') || text[3] === '-') return null;
  const openEnd = lineEnd(text, 0);
  if (!DELIMITER.test(text.slice(0, openEnd)) || openEnd >= text.length) return null;
  const closeAt = text.indexOf('\n---', openEnd);
  if (closeAt < 0) return null;
  const closeEnd = lineEnd(text, closeAt + 1);
  if (!DELIMITER.test(text.slice(closeAt + 1, closeEnd))) return null;
  const end = text.startsWith('\r\n', closeEnd) ? closeEnd + 2 : closeEnd < text.length ? closeEnd + 1 : closeEnd;
  const bodyStart = text.startsWith('\r\n', openEnd) ? openEnd + 2 : openEnd + 1;
  const bodyEnd = text[closeAt - 1] === '\r' ? closeAt - 1 : closeAt;
  return [text.slice(0, end), bodyStart <= closeAt ? text.slice(bodyStart, Math.max(bodyStart, bodyEnd)) : undefined];
}

const DELIMITER = /^---[ \t]*$/;

function lineEnd(text: string, from: number): number {
  const n = text.indexOf('\n', from);
  const end = n < 0 ? text.length : n;
  return end > from && text[end - 1] === '\r' ? end - 1 : end;
}

/** The YAML text of a frontmatter block as an object ({} for none or a non-object). Throws on a YAML error. */
export function yamlObject(yaml: string): Record<string, unknown> {
  const data = loadYaml(yaml);
  return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
}

/** The frontmatter as written ({} when there is none). Throws on a YAML error, as pagemd does. */
export function frontmatterOf(text: string): Record<string, unknown> {
  const match = frontmatterMatch(text);
  return match ? yamlObject(match[1] ?? '') : {};
}
