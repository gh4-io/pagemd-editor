// P7 acceptance: "every action in the cohesion matrix appears on its surface" (roadmap checkpoint 4). The matrix's §4
// lists every command with its ribbon tab, Slash and Toolbar; this test builds the real editor (three presets, the
// app's view commands, the shipped layout file) and proves the table and the registry say the same thing, in both
// directions. It also checks §1's pagemd rows (the Ribbon tab letter, Slash and Toolbar) item by item.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createEditor, parseRibbonLayout, type Editor } from '@pagemd-editor/core';
import { commonmarkPreset } from '@pagemd-editor/preset-commonmark';
import { gfmPreset } from '@pagemd-editor/preset-gfm';
import { pagemdPreset } from '@pagemd-editor/preset-pagemd';
import { OUTLINE_ICONS } from '@pagemd-editor/outline-panel';
import ribbonLayoutFile from '../webview/ribbon.layout.json';
import { commentsActions, documentActions, filesActions, viewActions, quickAccessActions } from '../webview/view-actions.ts';
import { imageToolCommands, pictureFieldCommands } from '../webview/image-tools.ts';

/** P15: the image tools with nothing behind them (only their ids and surfaces are checked). */
const IMAGE_HOST = { state: () => undefined, editable: () => true, dispatch: () => undefined, assets: { readAsset: async () => new Uint8Array(), writeAsset: async () => '' }, flash: () => undefined, flush: async () => undefined, document: null as unknown as Document };

const MATRIX = fileURLToPath(new URL('../../../test/cohesion/cohesion-matrix.md', import.meta.url));
const markdown = readFileSync(MATRIX, 'utf8');

async function build(): Promise<Editor> {
  let editor: Editor | undefined;
  editor = await createEditor({ presets: [commonmarkPreset, gfmPreset, pagemdPreset()], ribbonLayout: parseRibbonLayout(ribbonLayoutFile), commands: [...viewActions(() => editor!.registry.view, () => undefined), ...documentActions(() => undefined), ...filesActions({ isOpen: () => false, toggle: () => undefined }), ...commentsActions({ canChange: () => true, active: () => null, hasThreads: () => false, create: () => undefined, reply: () => undefined, toggleResolved: () => undefined, step: () => undefined }), ...imageToolCommands(IMAGE_HOST), ...pictureFieldCommands(() => undefined), ...quickAccessActions(() => undefined)] });
  return editor;
}

/** The cells of a markdown table that follows `heading`, one array per body row. */
function table(source: string, heading: string, until?: string): { header: string[]; rows: string[][] } {
  const start = source.indexOf(heading);
  const end = until ? source.indexOf(until, start) : source.length;
  const lines = source.slice(start, end).split('\n').filter((line) => line.startsWith('|'));
  const cells = (line: string) => line.split('|').slice(1, -1).map((c) => c.trim());
  return { header: cells(lines[0]!), rows: lines.slice(2).map(cells) };
}

interface CommandRow {
  patterns: string[];
  tab: string;
  slash: boolean;
  toolbar: boolean;
}

const commandRows = (source: string): CommandRow[] => {
  const { header, rows } = table(source, '## 4. Commands by surface');
  const col = (name: string) => header.indexOf(name);
  return rows.map((cells) => ({
    patterns: [...cells[col('Command')]!.matchAll(/`([^`]+)`/g)].map((m) => m[1]!),
    tab: cells[col('Ribbon tab')]!,
    slash: cells[col('Slash')]!.startsWith('✓'),
    toolbar: cells[col('Toolbar')]!.startsWith('✓'),
  }));
};

const matches = (pattern: string, id: string): boolean => (pattern.endsWith('.*') ? id.startsWith(pattern.slice(0, -1)) : id === pattern);

describe('cohesion matrix §4 ↔ the real registry and layout', () => {
  const rows = commandRows(markdown);

  it('the table names exactly the commands that exist, each in one row', async () => {
    const editor = await build();
    const ids = editor.registry.commands.list().map((c) => c.id);
    expect(rows.length).toBeGreaterThan(20);
    const claimed = ids.map((id) => ({ id, rows: rows.filter((r) => r.patterns.some((p) => matches(p, id))).length }));
    expect(claimed.filter((c) => c.rows === 0).map((c) => `${c.id}: no row`)).toEqual([]);
    expect(claimed.filter((c) => c.rows > 1).map((c) => `${c.id}: in ${c.rows} rows`)).toEqual([]);
    const dangling = rows.flatMap((r) => r.patterns).filter((p) => !ids.some((id) => matches(p, id)));
    expect(dangling).toEqual([]); // a row naming a command that is gone
  });

  it('every command appears on the surfaces its row says, and on no other', async () => {
    const editor = await build();
    const registry = editor.registry;
    const ribbonTab = new Map<string, string>();
    for (const tab of registry.ribbon().tabs) for (const id of registry.actions({ surface: 'ribbon', tab: tab.id }).map((a) => a.id)) ribbonTab.set(id, tab.id);
    const slash = new Set(registry.actions({ surface: 'slash' }).map((a) => a.id));
    const toolbar = new Set(registry.actions({ surface: 'toolbar' }).map((a) => a.id));
    const problems: string[] = [];
    for (const command of registry.commands.list()) {
      const row = rows.find((r) => r.patterns.some((p) => matches(p, command.id)))!;
      if (ribbonTab.get(command.id) !== row.tab) problems.push(`${command.id}: ribbon tab is ${ribbonTab.get(command.id) ?? 'none'}, the matrix says ${row.tab}`);
      if (slash.has(command.id) !== row.slash) problems.push(`${command.id}: slash is ${slash.has(command.id)}, the matrix says ${row.slash}`);
      if (toolbar.has(command.id) !== row.toolbar) problems.push(`${command.id}: toolbar is ${toolbar.has(command.id)}, the matrix says ${row.toolbar}`);
    }
    expect(problems).toEqual([]);
  });

  it('control: a wrong cell and a missing row are both caught', async () => {
    const editor = await build();
    const wrongTab = commandRows(markdown.replace('| `toc.insert` · `index.insert` | `toc` · `index` | document |', '| `toc.insert` · `index.insert` | `toc` · `index` | insert |'));
    const row = wrongTab.find((r) => r.patterns.includes('toc.insert'))!;
    const actual = editor.registry.actions({ surface: 'ribbon', tab: 'document' }).some((a) => a.id === 'toc.insert');
    expect(actual && row.tab !== 'document').toBe(true); // the registry says document; this row says insert: the test above would fail
    const withoutRow = commandRows(markdown.replace(/^\| `rule\.insert`.*\n/m, ''));
    expect(withoutRow.some((r) => r.patterns.some((p) => matches(p, 'rule.insert')))).toBe(false);
  });
});

describe('cohesion matrix §1 (pagemd rows) ↔ the registry: Ribbon tab, Slash and Toolbar', () => {
  // P20: "Img" is the Image tab (shown only with a picture selected).
  const TABS: Record<string, string> = { H: 'home', I: 'insert', T: 'table', Img: 'image', L: 'layout', D: 'document', R: 'review', V: 'view' };

  it('each item has a command on the ribbon tab its row names, and on Slash and Toolbar exactly where a ✓ says', async () => {
    const editor = await build();
    const registry = editor.registry;
    const { header, rows } = table(markdown, '### pagemd (', '### Core safety net');
    const col = (name: string) => header.indexOf(name);

    // Per item id: the tab letters, and whether any of its rows has a ✓.
    const claims = new Map<string, { tabs: Set<string>; slash: boolean; toolbar: boolean }>();
    for (const cells of rows) {
      for (const [, id] of (cells[col('Item id')] ?? '').matchAll(/`([^`]+)`/g)) {
        const claim = claims.get(id!) ?? { tabs: new Set<string>(), slash: false, toolbar: false };
        // One cell can name several tabs ("I: Table · T: Table tab").
        for (const [, letter] of (cells[col('Ribbon')] ?? '').matchAll(/(?:^|·\s*)(Img|[HILDRTV]):/g)) claim.tabs.add(TABS[letter!]!);
        claim.slash ||= (cells[col('Slash')] ?? '').startsWith('✓');
        claim.toolbar ||= (cells[col('Toolbar')] ?? '').startsWith('✓');
        claims.set(id!, claim);
      }
    }

    const tabOf = new Map<string, string>();
    for (const tab of registry.ribbon().tabs) for (const a of registry.actions({ surface: 'ribbon', tab: tab.id })) tabOf.set(a.id, tab.id);
    const slash = new Set(registry.actions({ surface: 'slash' }).map((a) => a.id));
    const toolbar = new Set(registry.actions({ surface: 'toolbar' }).map((a) => a.id));

    const problems: string[] = [];
    for (const item of registry.items()) {
      const claim = claims.get(item.id);
      if (!claim) continue; // CommonMark, GFM and the safety net: §4
      const own = (item.commands ?? []).map((c) => c.id);
      const onTabs = new Set(own.map((id) => tabOf.get(id)).filter((t): t is string => t !== undefined));
      for (const tab of claim.tabs) if (!onTabs.has(tab)) problems.push(`${item.id}: the matrix puts it on the ${tab} tab, but none of its commands is there`);
      if (claim.tabs.size === 0 && own.length > 0) problems.push(`${item.id}: has commands, but its Ribbon cell names no tab`);
      if (claim.slash !== own.some((id) => slash.has(id))) problems.push(`${item.id}: slash ${claim.slash ? '✓ but no slash command' : '— but it has a slash command'}`);
      if (claim.toolbar !== own.some((id) => toolbar.has(id))) problems.push(`${item.id}: toolbar ${claim.toolbar ? '✓ but no toolbar command' : '— but it has a toolbar command'}`);
    }
    expect(problems).toEqual([]);
  });
});

describe('cohesion matrix §1 (pagemd rows) ↔ the registry: the Inspector column (P8)', () => {
  /** Item ids whose Inspector cell says it has Element fields (true) or none (false, a cell starting with "—"). */
  const claims = (source: string): Map<string, boolean> => {
    const { header, rows } = table(source, '### pagemd (', '### Core safety net');
    const col = (name: string) => header.indexOf(name);
    const out = new Map<string, boolean>();
    for (const cells of rows) {
      const cell = cells[col('Inspector fields')] ?? '';
      if (cell.includes('Document tab')) continue; // the frontmatter: its properties are the Document tab's
      for (const [, id] of (cells[col('Item id')] ?? '').matchAll(/`([^`]+)`/g)) out.set(id!, (out.get(id!) ?? false) || !cell.startsWith('—'));
    }
    return out;
  };
  /** True when any node or mark of the item has fields: its own, or ones it adds to other items' nodes. */
  const hasFields = (editor: Editor, id: string): boolean => {
    const item = editor.registry.items().find((i) => i.id === id)!;
    const ext = [...Object.values(item.extend?.nodes ?? {}), ...Object.values(item.extend?.marks ?? {})];
    return Object.keys(item.fields ?? {}).length > 0 || ext.some((e) => e.fields !== undefined);
  };

  it('an item has Element fields exactly where its row says', async () => {
    const editor = await build();
    const problems = [...claims(markdown)].filter(([id, says]) => hasFields(editor, id) !== says).map(([id, says]) => `${id}: the matrix says ${says ? 'fields' : 'none'}`);
    expect(problems).toEqual([]);
  });

  it('control: a row that claims fields its item lacks (or the reverse) is caught', async () => {
    const editor = await build();
    const wrong = claims(markdown.replace('| L: Section | ✓ | — | CSS class, id |', '| L: Section | ✓ | — | — |'));
    expect(hasFields(editor, 'section') !== wrong.get('section')).toBe(true);
  });
});

describe("every icon a command or item names is one of VS Code's own (codicons, R-162)", () => {
  it('all names exist in @vscode/codicons', async () => {
    const { createRequire } = await import('node:module');
    const css = createRequire(import.meta.url).resolve('@vscode/codicons/dist/codicon.css');
    const mapping = JSON.parse(readFileSync(css.replace(/dist[\\/]codicon\.css$/, 'src/template/mapping.json'), 'utf8')) as Record<string, string[]>;
    const known = new Set(Object.values(mapping).flat());
    const editor = await build();
    // P9: the Outline panel's icons per kind of entry, and its buttons, too.
    const outline = [...Object.values(OUTLINE_ICONS), 'arrow-up', 'arrow-down', 'close'];
    const names = new Set([...editor.registry.commands.list().map((c) => c.icon), ...editor.registry.items().map((i) => i.icon), ...outline].filter((n): n is string => !!n));
    const missing = [...names].filter((name) => !known.has(name));
    expect(missing).toEqual([]);
    expect(names.size).toBeGreaterThan(30);
  });
});
