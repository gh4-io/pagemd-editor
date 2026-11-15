// Generic nodes every editor has, whatever the preset (layered-architecture.md §3, core card).
// raw_block: anything the editor can't model is kept here as its exact source text (invariant I4).
import { Schema, type MarkSpec, type NodeSpec } from 'prosemirror-model';
import type { MarkWriter, NodeWriter, SyntaxItem, TokenAttrsReader, TokenSpec } from './registry.ts';

export const RAW_BLOCK = 'raw_block';

export const rawBlockItem: SyntaxItem = {
  id: RAW_BLOCK,
  group: 'core',
  schema: {
    nodes: {
      [RAW_BLOCK]: {
        group: 'block',
        content: 'text*',
        marks: '',
        code: true,
        defining: true,
        attrs: { reason: { default: null } },
        parseDOM: [{ tag: 'pre.pmd-raw-block', preserveWhitespace: 'full' }],
        toDOM: () => ['pre', { class: 'pmd-raw-block' }, ['code', 0]],
      },
    },
  },
  // Made by the transformer, never by a markdown-it token.
  fromTokens: {},
  toMarkdown: {
    nodes: {
      [RAW_BLOCK]: (state, node) => {
        state.text(node.textContent, false);
        state.closeBlock(node);
      },
    },
  },
  label: 'Raw markdown',
  icon: 'code',
};

/**
 * One ProseMirror schema from the items, in registration order. The first block node becomes the
 * default block (so presets list `paragraph` first); `core` items (raw_block) come after the others.
 */
export function buildSchema(items: readonly SyntaxItem[]): Schema {
  const ordered = [...items.filter((item) => item.group !== 'core'), ...items.filter((item) => item.group === 'core')];
  const nodes: Record<string, NodeSpec> = { doc: { content: 'block+' } };
  const marks: Record<string, MarkSpec> = {};
  for (const item of ordered) {
    Object.assign(nodes, item.schema.nodes);
    Object.assign(marks, item.schema.marks);
  }
  // Attributes items add to other items' nodes and marks (ADR-0013 amendment, P4).
  for (const item of ordered) {
    for (const [kind, specs] of [['node', nodes], ['mark', marks]] as const) {
      const extensions = kind === 'node' ? item.extend?.nodes : item.extend?.marks;
      for (const [name, extension] of Object.entries(extensions ?? {})) {
        const spec = specs[name];
        if (!spec) continue;
        for (const attr of Object.keys(extension.attrs)) {
          if (spec.attrs && attr in spec.attrs) throw new Error(`Item '${item.id}' adds '${attr}' to the ${kind} '${name}', which already has it.`);
        }
        specs[name] = { ...spec, attrs: { ...spec.attrs, ...extension.attrs } };
      }
    }
  }
  nodes['text'] = { group: 'inline' };
  return new Schema({ nodes, marks });
}

/**
 * The items' read specs and writers with every extension applied (ADR-0013 amendment, P4): an extended node or
 * mark also gets the extension's attributes from its token, and its writer is wrapped. Used by the transformer.
 */
export function extendReadWrite(
  items: readonly SyntaxItem[],
  specs: Record<string, TokenSpec>,
  writers: { nodes: Record<string, NodeWriter>; marks: Record<string, MarkWriter> },
): void {
  for (const item of items) {
    for (const [name, extension] of Object.entries(item.extend?.nodes ?? {})) {
      extendSpecs(specs, (spec) => spec.block === name || spec.node === name, extension.fromToken);
      const writer = writers.nodes[name];
      if (writer && extension.write) writers.nodes[name] = extension.write(writer);
    }
    for (const [name, extension] of Object.entries(item.extend?.marks ?? {})) {
      extendSpecs(specs, (spec) => spec.mark === name, extension.fromToken);
      const writer = writers.marks[name];
      if (writer && extension.write) writers.marks[name] = extension.write(writer);
    }
  }
}

function extendSpecs(specs: Record<string, TokenSpec>, targets: (spec: TokenSpec) => boolean, read: TokenAttrsReader | undefined): void {
  if (!read) return;
  for (const [token, spec] of Object.entries(specs)) {
    if (!targets(spec)) continue;
    const own = spec.getAttrs;
    const fixed = spec.attrs;
    specs[token] = {
      ...spec,
      getAttrs: (tok, tokens, i) => ({ ...(own ? own(tok, tokens, i) : fixed), ...read(tok, tokens, i) }),
    };
  }
}
