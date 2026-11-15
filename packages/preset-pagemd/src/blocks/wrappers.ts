// Wrapper items: blocks around other blocks. Each keeps the data its token carried (itemOccurrences, C3) and is
// written by its @pagemd/syntax write rule, which gets the children's markdown as `content`. The canvas draws
// the renderer's elements and classes (I3); labels the author doesn't type (a callout's WARNING) are not editable.
import type { Node, NodeSpec } from 'prosemirror-model';
import type { DOMOutputSpec } from 'prosemirror-model';
import { CONTAINER_TYPES } from '@pagemd/syntax';
import { wrapCommand, type SyntaxItem, type TokenSpec } from '@pagemd-editor/core';
import { wrapperWriter } from '../shared/write.ts';
import { classes } from '../shared/dom.ts';

const dataOf = (node: Node): Record<string, unknown> => node.attrs['data'] as Record<string, unknown>;
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const titleCase = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1).replace(/-/g, ' ');
const ALERT_KINDS = ['note', 'tip', 'important', 'warning', 'caution'] as const;
const wrapperSpec = (node: string): TokenSpec => ({
  block: node,
  getAttrs: (tok) => {
    const meta = tok.meta as { pmd?: { data: Record<string, unknown> }; closed?: boolean } | null;
    return { data: { ...(meta?.pmd?.data ?? {}) }, closed: meta?.closed !== false };
  },
});

/** `closed`: false when the author's text has no closing line (C2's `meta.closed`; see wrapperWriter). */
function wrapper(dom: (node: Node) => DOMOutputSpec): NodeSpec {
  return { content: 'block*', group: 'block', defining: true, attrs: { data: {}, closed: { default: true } }, toDOM: dom };
}

/** `[[WARNING]]` / `[[DANGER]]` callouts. */
export const callouts: SyntaxItem = {
  id: 'callouts',
  group: 'blocks',
  schema: {
    nodes: {
      pmd_callout: wrapper((node) => {
        const type = str(dataOf(node)['type']).toUpperCase() === 'DANGER' ? 'danger' : 'warning';
        return ['div', { class: `callout callout-${type}` }, ['span', { class: 'callout-label', contenteditable: 'false' }, type.toUpperCase()], ['div', { class: 'callout-content' }, 0]];
      }),
    },
  },
  fromTokens: { callout: wrapperSpec('pmd_callout') },
  toMarkdown: { nodes: { pmd_callout: wrapperWriter('callouts') } },
  commands: (['WARNING', 'DANGER'] as const).map((type) =>
    wrapCommand(
      { id: `callouts.${type.toLowerCase()}`, label: `Callout: ${type[0]}${type.slice(1).toLowerCase()}`, icon: 'warning', keywords: [type.toLowerCase(), 'callout', 'warning', 'danger'] },
      'pmd_callout',
      { data: { type, typeText: type, form: 'multi' }, closed: true },
      (node) => str(dataOf(node)['type']).toUpperCase() === type,
    ),
  ),
  label: 'Callout',
  icon: 'warning',
  slash: { keywords: ['callout', 'warning', 'danger'] },
  outline: (node, pos) => ({ kind: 'callout', label: str(dataOf(node)['type']).toUpperCase() || 'Callout', level: 0, pos }),
};

/** The 15 named containers `:::name Title` … `:::`. */
export const containers: SyntaxItem = {
  id: 'containers',
  group: 'blocks',
  schema: {
    nodes: {
      pmd_container: wrapper((node) => {
        const data = dataOf(node);
        const title = str(data['title']);
        return ['div', { class: `container container-${str(data['name'])}`, ...(title ? { 'data-title': title } : {}) }, 0];
      }),
    },
  },
  fromTokens: Object.fromEntries(CONTAINER_TYPES.map((name) => [`container_${name}`, wrapperSpec('pmd_container')])),
  toMarkdown: { nodes: { pmd_container: wrapperWriter('containers') } },
  commands: CONTAINER_TYPES.map((name) =>
    wrapCommand(
      { id: `containers.${name}`, label: `Box: ${titleCase(name)}`, icon: 'symbol-structure', keywords: ['box', 'container', name, name.replace(/-/g, ' ')] },
      'pmd_container',
      { data: { name, title: '' }, closed: true },
      (node) => dataOf(node)['name'] === name,
    ),
  ),
  label: 'Box',
  icon: 'symbol-structure',
  slash: { keywords: ['box', 'container', ...CONTAINER_TYPES] },
  outline: (node, pos) => {
    const data = dataOf(node);
    return { kind: 'box', label: str(data['title']) || str(data['name']), level: 0, pos };
  },
};

/** `::: {.class #id key="value"}` … `:::`: a div with the author's attributes. */
export const attributeContainer: SyntaxItem = {
  id: 'attribute-container',
  group: 'blocks',
  schema: {
    nodes: {
      pmd_div: wrapper((node) => {
        const dom: Record<string, string> = {};
        for (const [key, value] of (dataOf(node)['attrs'] as [string, string][] | undefined) ?? []) {
          if (/^[A-Za-z_:][\w:.-]*$/.test(key) && !/^on/i.test(key)) dom[key] = String(value);
        }
        return ['div', { ...dom, class: classes(dom['class'], 'pmd-div') }, 0];
      }),
    },
  },
  fromTokens: { div: wrapperSpec('pmd_div') },
  toMarkdown: { nodes: { pmd_div: wrapperWriter('attribute-container') } },
  commands: [
    wrapCommand({ id: 'attribute-container.insert', label: 'Box: Custom', icon: 'symbol-structure', keywords: ['box', 'custom', 'div', 'class'] }, 'pmd_div', { data: { attrs: [['class', 'custom']] }, closed: true }, () => true),
  ],
  label: 'Custom box',
  icon: 'symbol-structure',
  slash: { keywords: ['box', 'custom', 'div'] },
};

/**
 * GitHub alerts `> [!NOTE]`, read by @pagemd/syntax's `github-alerts` item. It replaces preset-gfm's own `alert`
 * item (amendment 6, R-99 finding): with pagemd, only the dialect reads alerts, and the canvas shows pagemd's
 * `markdown-alert` classes.
 */
export const githubAlerts: SyntaxItem = {
  id: 'github-alerts',
  overrides: 'alert',
  group: 'blocks',
  schema: {
    nodes: {
      alert: wrapper((node) => {
        const data = dataOf(node);
        const type = str(data['type']).toLowerCase() || 'note';
        const title = str(data['title']) || type.charAt(0).toUpperCase() + type.slice(1);
        return ['div', { class: `markdown-alert markdown-alert-${type}` }, ['p', { class: 'markdown-alert-title', contenteditable: 'false' }, title], ['div', { class: 'pmd-alert-body' }, 0]];
      }),
    },
  },
  fromTokens: { alert: wrapperSpec('alert') },
  toMarkdown: { nodes: { alert: wrapperWriter('github-alerts') } },
  commands: ALERT_KINDS.map((kind) =>
    wrapCommand(
      { id: `alert.${kind}`, label: `Callout: ${titleCase(kind)}`, icon: 'info', keywords: [kind, 'alert', 'callout'] },
      'alert',
      { data: { type: kind, title: titleCase(kind) }, closed: true },
      (node) => str(dataOf(node)['type']).toLowerCase() === kind,
    ),
  ),
  label: 'Alert',
  icon: 'info',
  slash: { keywords: ['alert', 'note', 'tip', 'warning', 'caution', 'important', 'callout'] },
  outline: (node, pos) => ({ kind: 'callout', label: str(dataOf(node)['title']) || str(dataOf(node)['type']).toUpperCase(), level: 0, pos }),
};

export const blockItems: readonly SyntaxItem[] = [githubAlerts, attributeContainer, containers, callouts];
