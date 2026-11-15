// VS Code's own Outline (P9, R-164): a DocumentSymbolProvider for markdown documents, from the same outline the Outline
// panel shows (the registry's outline with @pagemd/syntax's figure numbers, D9). VS Code's built-in Markdown extension
// already lists the headings, so this provider adds only what pagemd has on top: the title, figures, tables, boxes,
// callouts, the TOC, includes, sections, the cover and the index (AD-P9-03: headings here would show twice). It works
// for a markdown file open in any editor, the text editor included; it reads the text with the editor's presets.
import * as vscode from 'vscode';
import { createRegistry, ItemRegistry, rawBlockItem, ViewState, type OutlineEntry, type Registry } from '@pagemd-editor/core';
import { commonmarkPreset } from '@pagemd-editor/preset-commonmark';
import { gfmPreset } from '@pagemd-editor/preset-gfm';
import { gateFields, gateKey, numberedOutline, outlineLabel, pagemdPreset, withGateFields } from '@pagemd-editor/preset-pagemd';
import { createTransformer, sourceOf, type Transformer } from '@pagemd-editor/transformer';

/** One symbol, before it becomes VS Code's: the entry's words and kind, and the text range of its block. */
export interface OutlineSymbol {
  name: string;
  kind: string;
  from: number;
  to: number;
}

/** The symbol kind (VS Code's icon) for each kind of entry. */
const KINDS: Readonly<Record<string, vscode.SymbolKind>> = {
  title: vscode.SymbolKind.File,
  heading: vscode.SymbolKind.String,
  figure: vscode.SymbolKind.Object,
  table: vscode.SymbolKind.Struct,
  box: vscode.SymbolKind.Namespace,
  callout: vscode.SymbolKind.Event,
  toc: vscode.SymbolKind.Module,
  include: vscode.SymbolKind.Package,
  section: vscode.SymbolKind.Namespace,
  cover: vscode.SymbolKind.File,
  index: vscode.SymbolKind.Key,
};

/** The reader, the same as the webview's (made on first use: activation stays quick). */
let reading: { registry: Registry; transformers: Map<string, Transformer> } | undefined;

/** The editor's reader for `text` (P9; P10's plain-HTML preview renders with its markdown-it too). */
export function readerFor(text: string): { registry: Registry; transformer: Transformer } {
  if (!reading) {
    const items = new ItemRegistry([rawBlockItem]);
    for (const preset of [commonmarkPreset, gfmPreset, pagemdPreset()]) items.addPreset(preset);
    reading = { registry: createRegistry({ items, view: new ViewState() }), transformers: new Map() };
  }
  // Gated syntax follows the frontmatter, as on the canvas (the profile's own defaults aren't read here: AD-P9-04).
  const fields = gateFields(text);
  const key = gateKey(fields);
  let transformer = reading.transformers.get(key);
  if (!transformer) {
    transformer = createTransformer(withGateFields(reading.registry.items(), fields));
    reading.transformers.set(key, transformer);
  }
  return { registry: reading.registry, transformer };
}

/** The outline entries of `text` that VS Code should list, with the text range of each one's top-level block. */
export function outlineSymbols(text: string, options: { headings?: boolean } = {}): OutlineSymbol[] {
  const { registry, transformer } = readerFor(text);
  const doc = transformer.parse(text);
  const blocks = sourceOf(doc)?.blocks ?? [];
  const keep = (e: OutlineEntry): boolean => options.headings === true || e.kind !== 'heading';
  return numberedOutline(registry, doc)
    .filter(keep)
    .flatMap((entry) => {
      const range = entry.block !== undefined ? blocks[entry.block] : undefined;
      return range ? [{ name: outlineLabel(entry), kind: entry.kind, from: range.from, to: range.to }] : [];
    });
}

export class PagemdSymbolProvider implements vscode.DocumentSymbolProvider {
  provideDocumentSymbols(document: vscode.TextDocument): vscode.DocumentSymbol[] {
    return outlineSymbols(document.getText()).map((symbol) => {
      const range = new vscode.Range(document.positionAt(symbol.from), document.positionAt(symbol.to));
      return new vscode.DocumentSymbol(symbol.name, '', KINDS[symbol.kind] ?? vscode.SymbolKind.Field, range, range);
    });
  }
}

/** Markdown files, in any editor. */
export const SYMBOL_SELECTOR: vscode.DocumentSelector = [{ language: 'markdown' }];
