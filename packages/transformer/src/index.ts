// @pagemd-editor/transformer: read and write (layered-architecture.md §3).
// markdown-it tokens → ProseMirror (every top-level block keeps its source range), and
// ProseMirror → markdown for changed blocks via the items' writers.
import MarkdownItFactory, { type MarkdownIt, type MarkdownItOptions } from 'markdown-it';
import type { Node, Schema } from 'prosemirror-model';
import { buildSchema, extendReadWrite, ItemRegistry, rawBlockItem, RAW_BLOCK, type SyntaxItem, type TokenSpec } from '@pagemd-editor/core';
import { createParser } from './parse.ts';
import { createSerializer } from './serialize.ts';

export { sourceOf, recordSource, detectLineEnding, type BlockRange, type SourceInfo, type RawReason } from './parse.ts';
export { escapeLine } from './serialize.ts';

export interface TransformerOptions {
  /** On top of markdown-it's strict 'commonmark' preset; items add or enable rules themselves. */
  markdownItOptions?: MarkdownItOptions;
  /** Use this schema instead of building one (it must contain every item's nodes and marks). */
  schema?: Schema;
}

export interface Transformer {
  readonly schema: Schema;
  readonly markdownIt: MarkdownIt;
  /** Reads a whole file; the result remembers its source (see `sourceOf`). */
  parse(text: string): Node;
  /** Writes a node fresh: a document gives the whole file, a block gives that block (no reuse). */
  serialize(node: Node): string;
}

export function createTransformer(items: readonly SyntaxItem[], options: TransformerOptions = {}): Transformer {
  // The same rules as the editor's registry: explicit overrides, no id or name clashes; raw_block always there.
  const registry = new ItemRegistry(items.some((item) => item.id === RAW_BLOCK) ? [] : [rawBlockItem]);
  // The list may be the presets' items or an editor registry's (overrides already applied, e.g. a plugin's
  // `app.registry.items()`): an override whose target isn't in the list has been applied already (P4: the first
  // preset with overrides; createEditor's registry still reports a target that is really missing).
  const ids = new Set(items.map((item) => item.id));
  for (const item of items) registry.add(item.overrides !== undefined && !ids.has(item.overrides) ? withoutOverride(item) : item);
  const all = registry.items();

  const schema = options.schema ?? buildSchema(all);
  const md = MarkdownItFactory('commonmark', options.markdownItOptions ?? {});
  for (const item of all) item.markdownIt?.(md);

  const specs: Record<string, TokenSpec> = {};
  for (const item of all) Object.assign(specs, item.fromTokens);
  // Attributes some items add to other items' nodes and marks are read from the same tokens (ADR-0013, P4).
  extendReadWrite(all, specs, { nodes: {}, marks: {} });

  const serializer = createSerializer(all, schema);
  // P26: items that can write a changed block by editing its old text (a ticked task box); such a text is kept only when it reads
  // back exactly as the changed block, so a patch can never change what the document says.
  const patches = all.flatMap((item) => (item.patch ? [item.patch.bind(item)] : []));
  const tokensOf = (text: string) => md.parse(text, {});
  const patchBlock =
    patches.length === 0
      ? undefined
      : (before: Node, after: Node, text: string): string | null => {
          for (const patch of patches) {
            let out: string | null;
            try {
              out = patch(before, after, text, tokensOf);
            } catch {
              out = null;
            }
            if (typeof out !== 'string') continue;
            const again = parser.parse(out);
            if (again.childCount === 1 && again.child(0).eq(after)) return out;
          }
          return null;
        };
  const parser = createParser(md, schema, specs, serializer.serializeBlock, all.flatMap((item) => item.groups ?? []), patchBlock);

  return {
    schema,
    markdownIt: md,
    parse: (text) => parser.parse(text),
    serialize: (node) => (node.type === schema.topNodeType ? serializer.serializeDoc(node) : serializer.serializeBlock(node)),
  };
}

function withoutOverride(item: SyntaxItem): SyntaxItem {
  const { overrides: _applied, ...rest } = item;
  return rest;
}
