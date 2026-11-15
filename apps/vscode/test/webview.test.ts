// The webview's logic without a browser: the channel, the service stand-ins, the document session and views.
import { describe, expect, it, vi } from 'vitest';
import { Fragment, type Node } from 'prosemirror-model';
import { IAssets, IDocumentSync, ILinks, IStyles, createEditor, type ResolvedStyles, type TextEdit } from '@pagemd-editor/core';
import { applyEdits } from '@pagemd-editor/lossless';
import { commonmarkPreset } from '@pagemd-editor/preset-commonmark';
import { pagemdItems } from '@pagemd-editor/preset-pagemd';
import { defaultStyles } from '@pagemd-editor/style-default';
import { createTransformer, sourceOf } from '@pagemd-editor/transformer';
import { Channel } from '../shared/channel.ts';
import type { HostEvents, HostRequests, StylesPayload, WebviewEvents, WebviewRequests } from '../shared/protocol.ts';
import { createClients, DocumentSyncClient, servicePlugins, StylesClient } from '../webview/services.ts';
import { DocumentSession, mapCursor } from '../webview/sync.ts';
import { recipeFor, START_MODE } from '../webview/views.ts';
import { OUTSIDE_CHANGE_META, PRINT_CLASS as PAGINATION_PRINT_CLASS } from '@pagemd-editor/pagination';
import { OUTSIDE_META } from '@pagemd-editor/canvas';
import { PRINT_CLASS as STYLE_PRINT_CLASS } from '@pagemd-editor/style-pagemd';

const tick = () => new Promise((r) => setTimeout(r, 0));

const PLAIN: StylesPayload = { styles: null, gateDefaults: {}, notes: [], properties: { required: [], shownOnPage: [], profileFields: [], defaults: {} } };
const RESOLVED: StylesPayload = {
  styles: {
    css: '.pmd-canvas h1 { color: navy }',
    page: { width: 215.9, height: 279.4, margins: { top: 25.4, right: 25.4, bottom: 25.4, left: 25.4 } },
    header: { left: 'Acme' },
    footer: { center: ':::PAGE of :::PAGES' },
    layout: { path: '/pagemd/layouts/letter.css', bundled: true },
    profile: 'standard_letter',
    usingDefault: false,
    sources: ['/pagemd/profiles/standard_letter.json'],
  },
  gateDefaults: { fancy_lists: true },
  notes: [],
  properties: { required: [], shownOnPage: [], profileFields: [], defaults: {} },
};

/** A connected pair, as the real postMessage would carry it (structured clone, asynchronous). */
function pair() {
  const host = new Channel<WebviewRequests, HostRequests, WebviewEvents, HostEvents>((m) => queueMicrotask(() => webview.receive(structuredClone(m))));
  const webview = new Channel<HostRequests, WebviewRequests, HostEvents, WebviewEvents>((m) => queueMicrotask(() => host.receive(structuredClone(m))));
  return { host, webview };
}

describe('Channel', () => {
  it('matches responses to requests by id, both ways', async () => {
    const { host, webview } = pair();
    host.handle('pickFile', ({ filter }) => `picked ${filter?.join(',')}`);
    webview.handle('flush', () => undefined);
    const [a, b] = await Promise.all([webview.request('pickFile', { filter: ['png'] }), webview.request('pickFile', { filter: ['jpg'] })]);
    expect([a, b]).toEqual(['picked png', 'picked jpg']);
    await expect(host.request('flush', {})).resolves.toBeUndefined();
  });

  it('carries binary data as binary (C5)', async () => {
    const { host, webview } = pair();
    let got: unknown;
    host.handle('writeAsset', ({ bytes }) => ((got = bytes), 'ok'));
    await webview.request('writeAsset', { bytes: new Uint8Array([1, 2, 255]), name: 'a.png' });
    expect(got).toBeInstanceOf(Uint8Array);
    expect([...(got as Uint8Array)]).toEqual([1, 2, 255]);
  });

  it('turns handler errors and unknown methods into rejected requests', async () => {
    const { host, webview } = pair();
    host.handle('pickFile', () => {
      throw new Error('no dialog');
    });
    await expect(webview.request('pickFile', {})).rejects.toThrow('no dialog');
    await expect(webview.request('writeAsset', { bytes: new Uint8Array(), name: 'x' })).rejects.toThrow("No handler for 'writeAsset'.");
  });

  it('routes events, ignores junk, and rejects pending requests on close', async () => {
    const { host, webview } = pair();
    const links: string[] = [];
    host.on('openLink', ({ href }) => links.push(href));
    webview.emit('openLink', { href: 'a.md' });
    for (const junk of [null, 42, 'x', { kind: 'response', id: 999, ok: true }, { kind: 'event' }, { kind: 'request', id: 'x' }]) host.receive(junk);
    await tick();
    expect(links).toEqual(['a.md']);

    const pending = webview.request('pickFile', {});
    webview.close();
    await expect(pending).rejects.toThrow('Channel closed.');
    await expect(webview.request('pickFile', {})).rejects.toThrow(/closed/);
  });
});

describe('service stand-ins (R-87 amendment 2)', () => {
  it('provide IDocumentSync, IAssets, ILinks and (P5) IStyles to the editor', async () => {
    const { webview } = pair();
    const clients = createClients(webview, 1, PLAIN);
    const editor = await createEditor({ presets: [commonmarkPreset], plugins: servicePlugins(clients) });
    expect(await editor.required(IDocumentSync)).toBe(clients.sync);
    expect(await editor.service(IAssets)).toBe(clients.assets);
    expect(await editor.service(ILinks)).toBe(clients.links);
    expect(await editor.service(IStyles)).toBe(clients.styles);
  });

  it('StylesClient (protocol v2): plain styles are style-default\'s; getStyles asks the host; stylesChanged updates and notifies', async () => {
    const { host, webview } = pair();
    const client = new StylesClient(webview, PLAIN);
    expect(client.styles).toEqual(defaultStyles());
    expect(client.payload).toEqual(PLAIN);

    host.handle('getStyles', () => RESOLVED);
    expect(await client.getStyles()).toEqual(RESOLVED.styles);
    expect(client.payload).toEqual(RESOLVED);

    const seen: ResolvedStyles[] = [];
    const payloads: StylesPayload[] = [];
    client.onChange((styles) => seen.push(styles));
    const sub = client.onPayload((payload) => payloads.push(payload));
    host.emit('stylesChanged', PLAIN);
    await tick();
    expect(seen).toEqual([defaultStyles()]);
    expect(payloads).toEqual([PLAIN]);
    sub.dispose();
    host.emit('stylesChanged', RESOLVED);
    await tick();
    expect(payloads).toHaveLength(1);
    expect(seen.at(-1)).toEqual(RESOLVED.styles);
  });

  it('StylesClient.createLayoutFile asks the host with the page; createLayout tells created from declined', async () => {
    const { host, webview } = pair();
    const client = new StylesClient(webview, PLAIN);
    const asked: unknown[] = [];
    host.handle('createLayoutFile', ({ page }) => (asked.push(page), asked.length === 1 ? 'created' : 'declined'));
    await expect(client.createLayoutFile(RESOLVED.styles!.page)).resolves.toBeUndefined();
    await expect(client.createLayout(RESOLVED.styles!.page)).resolves.toBe('declined');
    expect(asked).toEqual([RESOLVED.styles!.page, RESOLVED.styles!.page]);
    host.handle('createLayoutFile', () => {
      throw new Error('A profile named "sop" already exists');
    });
    await expect(client.createLayoutFile(RESOLVED.styles!.page)).rejects.toThrow('already exists');
  });

  it('DocumentSyncClient tracks the version and turns stale into an outside change', async () => {
    const { host, webview } = pair();
    const sync = new DocumentSyncClient(webview, 3);
    const seen: [string, number][] = [];
    sync.onExternalChange((text, version) => seen.push([text, version]));

    let hostVersion = 3;
    host.handle('applyEdits', ({ version }) => (version === hostVersion ? { status: 'ok', version: ++hostVersion } : { status: 'stale', text: 'NOW', version: 9 }));
    expect(await sync.applyEdits([], 3)).toBe('ok');
    expect(sync.version).toBe(4);
    expect(await sync.applyEdits([], 3)).toBe('stale');
    expect(sync.version).toBe(9);
    expect(seen).toEqual([['NOW', 9]]);

    host.emit('externalChange', { text: 'LATER', version: 10 });
    await tick();
    expect(sync.version).toBe(10);
    expect(seen.at(-1)).toEqual(['LATER', 10]);
  });

  it('DocumentSyncClient (protocol v11) knows the file\'s line ending and counts the news from the host', async () => {
    const { host, webview } = pair();
    const sync = new DocumentSyncClient(webview, 1, '\r\n');
    expect(sync.eol).toBe('\r\n');
    expect(sync.changes).toBe(0);
    host.handle('applyEdits', () => ({ status: 'stale', text: 'NOW', version: 5, eol: '\n' }));
    expect(await sync.applyEdits([], 1)).toBe('stale');
    expect([sync.eol, sync.changes]).toEqual(['\n', 1]);
    host.emit('externalChange', { text: 'A\r\nB', version: 6, eol: '\r\n' });
    await tick();
    expect([sync.eol, sync.changes]).toEqual(['\r\n', 2]);
    host.emit('externalChange', { text: 'C', version: 7 }); // a host that doesn't say keeps the last one known
    await tick();
    expect([sync.eol, sync.changes]).toEqual(['\r\n', 3]);
    expect(new DocumentSyncClient(webview, 1).eol).toBeUndefined();
  });
});

// ── the document session ──

const transformer = createTransformer(commonmarkPreset.items);
const schema = transformer.schema;

/** A host in memory: keeps the text, checks versions, applies edits like VS Code. */
function fakeHost(initial: string) {
  let text = initial;
  let version = 1;
  /** The version the webview has heard of (DocumentSyncClient only learns it from messages). */
  let heard = 1;
  const listeners = new Set<(t: string, v: number) => void>();
  const sent: TextEdit[][] = [];
  const sync = {
    get version() {
      return heard;
    },
    async applyEdits(edits: TextEdit[], v: number): Promise<'ok' | 'stale'> {
      sent.push(edits);
      await tick();
      heard = version;
      if (v !== version) {
        for (const l of listeners) l(text, version);
        return 'stale';
      }
      text = applyEdits(text, edits);
      heard = ++version;
      return 'ok';
    },
    onExternalChange(cb: (t: string, v: number) => void) {
      listeners.add(cb);
      return { dispose: () => listeners.delete(cb) };
    },
    /** The text changes, but the news hasn't reached the webview yet. */
    silent(next: string) {
      text = next;
      version++;
    },
    /** Another editor, git, or VS Code's undo changes the text. */
    external(next: string) {
      text = next;
      heard = ++version;
      for (const l of listeners) l(text, version);
    },
    get text() {
      return text;
    },
  };
  return { sync, sent };
}

/** Types at the end of top-level block `index`, as the canvas would: every other block keeps its identity. */
function appendText(doc: Node, index: number, typed: string): Node {
  const block = doc.child(index);
  return doc.copy(doc.content.replaceChild(index, block.copy(block.content.append(Fragment.from(schema.text(typed))))));
}

const TEXT = '# Title\n\nFirst para.\n\nSecond para.\n\nThird para.\n';

function session(text = TEXT, delay = 20, lineEnding?: string) {
  const host = fakeHost(text);
  const shown: { doc: Node | undefined; cursor: number } = { doc: undefined, cursor: 0 };
  const s = new DocumentSession(text, {
    transformer,
    sync: host.sync,
    delay,
    ...(lineEnding ? { lineEnding: () => lineEnding } : {}),
    replace: (doc, cursor) => void Object.assign(shown, { doc, cursor }),
    cursor: () => shown.cursor,
  });
  shown.doc = s.doc;
  return { s, host, shown };
}

describe('DocumentSession', () => {
  it('sends one minimal edit after the pause, then the host has the text', async () => {
    vi.useFakeTimers();
    try {
      const { s, host } = session();
      let doc = s.doc;
      doc = appendText(doc, 2, ' A');
      s.changed(doc);
      doc = appendText(doc, 2, 'B');
      s.changed(doc);
      expect(host.sent).toEqual([]); // still typing
      await vi.advanceTimersByTimeAsync(25);
      expect(host.sent).toEqual([[{ from: 22, to: 34, text: 'Second para. AB' }]]);
      expect(host.sync.text).toBe('# Title\n\nFirst para.\n\nSecond para. AB\n\nThird para.\n');
      expect(s.pending).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('flush sends at once (save) and the next edit diffs against what was sent (R-85 C)', async () => {
    const { s, host } = session(TEXT, 10_000);
    const one = appendText(s.doc, 1, '!');
    s.changed(one);
    await s.flush();
    expect(host.sync.text).toContain('First para.!');
    const two = appendText(one, 3, '?');
    s.changed(two);
    await s.flush();
    expect(host.sent.at(-1)).toEqual([{ from: 37, to: 48, text: 'Third para.?' }]);
    expect(host.sync.text).toBe('# Title\n\nFirst para.!\n\nSecond para.\n\nThird para.?\n');
  });

  it('an outside change is re-read, pending typing is dropped (VS Code wins), and the cursor keeps its block', async () => {
    const { s, host, shown } = session(TEXT, 10_000);
    // cursor inside "Third para." (block 3), 4 characters in
    let pos = 0;
    for (let i = 0; i < 3; i++) pos += s.doc.child(i).nodeSize;
    shown.cursor = pos + 1 + 4;
    s.changed(appendText(s.doc, 3, ' unsent'));

    host.sync.external('# Title\n\nInserted.\n\nFirst para.\n\nSecond para.\n\nThird para.\n');
    expect(s.pending).toBe(false);
    expect(shown.doc!.childCount).toBe(5);
    expect(shown.doc!.textContent).not.toContain('unsent');
    // "Third para." is now block 4; the cursor follows it
    let newPos = 0;
    for (let i = 0; i < 4; i++) newPos += shown.doc!.child(i).nodeSize;
    expect(shown.cursor).toBe(newPos + 1 + 4);
    await s.flush();
    expect(host.sent).toEqual([]);
  });

  it('reread (R-124): sends pending typing, then reads the text again with the reader chosen now, cursor kept', async () => {
    const text = 'Intro.\n\na. one\nb. two\n';
    let fields = { fancy_lists: false };
    const readers = new Map<boolean, ReturnType<typeof createTransformer>>();
    const reader = () => {
      if (!readers.has(fields.fancy_lists)) readers.set(fields.fancy_lists, createTransformer([...commonmarkPreset.items, ...pagemdItems({ fields })]));
      return readers.get(fields.fancy_lists)!;
    };
    const host = fakeHost(text);
    const shown: { doc: Node | undefined; cursor: number } = { doc: undefined, cursor: 0 };
    const s = new DocumentSession(text, { transformer: reader, sync: host.sync, delay: 10_000, replace: (doc, cursor) => void Object.assign(shown, { doc, cursor }), cursor: () => shown.cursor });
    shown.doc = s.doc;
    expect(s.doc.child(1).type.name).toBe('paragraph');

    const typed = s.doc.copy(s.doc.content.replaceChild(0, s.doc.child(0).copy(s.doc.child(0).content.append(Fragment.from(s.doc.type.schema.text('!'))))));
    s.changed(typed);
    shown.cursor = 3;
    fields = { fancy_lists: true };
    await s.reread();
    expect(host.sync.text).toBe('Intro.!\n\na. one\nb. two\n');
    expect(s.text).toBe(host.sync.text);
    expect(s.pending).toBe(false);
    expect(shown.doc).toBe(s.doc);
    expect(s.doc.child(1).type.name).toBe('ordered_list');
    expect(shown.cursor).toBe(3);
  });

  it('an outside change that only echoes what the webview has is ignored', () => {
    const { s, host, shown } = session();
    const before = shown.doc;
    host.sync.external(TEXT);
    expect(shown.doc).toBe(before);
    expect(s.doc).toBe(before);
  });

  it('stale edits are not retried; the document is re-read from the host', async () => {
    const { s, host, shown } = session(TEXT, 10_000);
    s.changed(appendText(s.doc, 1, ' mine'));
    host.sync.silent('# Elsewhere\n'); // the outside-change event is still on its way
    await s.flush();
    expect(host.sent).toHaveLength(1); // not retried
    expect(shown.doc!.textContent).toBe(transformer.parse(host.sync.text).textContent);
    expect(s.pending).toBe(false);
  });

  it('after VS Code undoes an edit, the next edit is computed against the undone text', async () => {
    const { s, host } = session(TEXT, 10_000);
    const edited = appendText(s.doc, 2, ' X');
    s.changed(edited);
    await s.flush();
    host.sync.external(TEXT); // VS Code's undo
    expect(host.sync.text).toBe(TEXT);
    const again = appendText(s.doc, 0, ' Y');
    s.changed(again);
    await s.flush();
    expect(host.sent.at(-1)).toEqual([{ from: 0, to: 7, text: '# Title Y' }]);
  });
});

describe('DocumentSession: an outside change patched into the canvas (FIX-PGF, item 3)', () => {
  /** What the canvas's patchDocument shows: the blocks equal to the new ones stay the very nodes shown before; the others are new. */
  const patched = (before: Node, next: Node): Node => next.copy(Fragment.fromArray(Array.from({ length: next.childCount }, (_, i) => (i < before.childCount && before.child(i).eq(next.child(i)) ? before.child(i) : next.child(i)))));
  // `*   odd   list` is kept byte for byte only when its block is reused, not written again (the writer spaces it `* odd   list`).
  const ODD = '# Title\n\nFirst para.\n\n*   odd   list\n\nSecond para.\n\nThird para.\n';

  it('holds the document the canvas shows, so two edits after an undo still keep every block between them byte for byte', async () => {
    const host = fakeHost(ODD);
    let canvas: Node | undefined;
    const s = new DocumentSession(ODD, {
      transformer,
      sync: host.sync,
      delay: 10_000,
      replace: (doc) => (canvas = patched(canvas!, doc)),
      cursor: () => 0,
    });
    canvas = s.doc;
    canvas = appendText(canvas, 4, ' X');
    s.changed(canvas);
    await s.flush();
    host.sync.external(ODD); // VS Code's undo: the canvas patches block 4 only
    expect(s.doc).toBe(canvas);
    expect(sourceOf(s.doc)?.text).toBe(ODD);
    // Then the author types in block 0 and block 3; the list between them is not touched.
    canvas = appendText(appendText(canvas, 0, ' Y'), 3, ' Z');
    s.changed(canvas);
    await s.flush();
    // Before the fix the session held the re-read document, not the one shown: no block between the two edits was the same node, so
    // the list was written again ("* odd   list").
    expect(host.sync.text).toBe('# Title Y\n\nFirst para.\n\n*   odd   list\n\nSecond para. Z\n\nThird para.\n');
  });

  it('a replace that shows something else than the document read (not equal) is not taken over', () => {
    const host = fakeHost(TEXT);
    const s = new DocumentSession(TEXT, { transformer, sync: host.sync, replace: () => transformer.parse('# Other\n'), cursor: () => 0 });
    host.sync.external('# Title\n\nChanged.\n');
    expect(s.text).toBe('# Title\n\nChanged.\n');
    expect(s.doc.textContent).toBe('TitleChanged.');
  });
});

describe('DocumentSession: the file\'s line ending (fix-sync-bugs, bug 5)', () => {
  const heading = schema.node('heading', { level: 1 }, schema.text('hello world'));
  const twoBlocks = () => schema.node('doc', null, [heading, schema.node('paragraph', null, schema.text('next line'))]);

  it('a blank file that VS Code keeps as CRLF gets CRLF from the canvas, so VS Code has nothing to change and report back', async () => {
    const { s, host } = session('', 10_000, '\r\n');
    s.changed(twoBlocks());
    await s.flush();
    expect(host.sync.text).toBe('# hello world\r\n\r\nnext line');
    expect(s.text).toBe(host.sync.text);
  });

  it('without the host saying (before protocol v11) a blank file gets \'\\n\' (what bug 5 tripped on)', async () => {
    const { s, host } = session('', 10_000);
    s.changed(twoBlocks());
    await s.flush();
    expect(host.sync.text).toBe('# hello world\n\nnext line');
  });

  it('the host\'s line ending wins over the text\'s first one, and unchanged blocks keep their bytes', async () => {
    const { s, host } = session('# Title\r\n\r\nBody.\r\n', 10_000, '\r\n');
    s.changed(appendText(s.doc, 1, ' More'));
    await s.flush();
    expect(host.sync.text).toBe('# Title\r\n\r\nBody. More\r\n');
  });
});

describe('mapCursor', () => {
  const doc = transformer.parse(TEXT);
  const start = (d: Node, index: number) => {
    let p = 0;
    for (let i = 0; i < index; i++) p += d.child(i).nodeSize;
    return p;
  };

  it('keeps a block before the change, shifts a block after it, clamps inside it', () => {
    const edited = '# Title\n\nFirst para.\n\nNEW\n\nNEW 2\n\nThird para.\n';
    const newDoc = transformer.parse(edited);
    expect(mapCursor(doc, start(doc, 1) + 3, doc, TEXT, edited, newDoc)).toBe(start(newDoc, 1) + 3);
    expect(mapCursor(doc, start(doc, 3) + 5, doc, TEXT, edited, newDoc)).toBe(start(newDoc, 4) + 5);
    expect(mapCursor(doc, start(doc, 2) + 12, doc, TEXT, edited, newDoc)).toBe(start(newDoc, 2) + newDoc.child(2).nodeSize - 1);
  });

  it('copes with everything deleted', () => {
    const newDoc = transformer.parse('');
    expect(mapCursor(doc, start(doc, 3) + 2, doc, TEXT, '', newDoc)).toBeGreaterThanOrEqual(0);
  });

});

describe('views', () => {
  it('starts in Print Layout (P6, amendment 2); Draft, Web Layout, Print Layout, Read, Code, Split and (P10) Print Preview exist', () => {
    expect(START_MODE).toBe('print');
    expect(recipeFor('draft')).toEqual({ mode: 'draft', components: ['canvas', 'status-bar'], styles: 'default', editable: true, paged: false, ribbonTabs: 'all', slash: true, toolbar: true, show: 'canvas', diagrams: false });
    expect(recipeFor('web')).toEqual({ mode: 'web', components: ['canvas', 'status-bar'], styles: 'pagemd', editable: true, paged: false, ribbonTabs: 'all', slash: true, toolbar: true, show: 'canvas', diagrams: true });
    expect(recipeFor('print')).toEqual({ mode: 'print', components: ['canvas', 'status-bar'], styles: 'pagemd', editable: true, paged: true, ribbonTabs: 'all', slash: true, toolbar: true, show: 'canvas', diagrams: true });
    // Read (amendment 10): the paginated canvas, not editable.
    expect(recipeFor('read')).toEqual({ mode: 'read', components: ['canvas', 'status-bar'], styles: 'pagemd', editable: false, paged: true, ribbonTabs: ['view'], slash: false, toolbar: false, show: 'canvas', diagrams: true });
    // Code and Split (P9, R-164): the Code view alone (Document and View tabs, the cohesion matrix), or next to the canvas
    // styled like Web Layout, without pages (AD-P9-05).
    expect(recipeFor('code')).toEqual({ mode: 'code', components: ['code-view', 'status-bar'], styles: 'default', editable: true, paged: false, ribbonTabs: ['document', 'view'], slash: false, toolbar: false, show: 'code', diagrams: false });
    expect(recipeFor('split')).toEqual({ mode: 'split', components: ['code-view', 'canvas', 'status-bar'], styles: 'pagemd', editable: true, paged: false, ribbonTabs: 'all', slash: true, toolbar: true, show: 'both', diagrams: false });
    // Print Preview (P10, R-170): the preview frame, read-only, the Document and View tabs; diagrams drawn on the canvas only in
    // Print Layout, Web Layout and Read (Q9).
    expect(recipeFor('preview')).toEqual({ mode: 'preview', components: ['preview-frame', 'status-bar'], styles: 'pagemd', editable: false, paged: false, ribbonTabs: ['document', 'view'], slash: false, toolbar: false, show: 'preview', diagrams: false });
  });

  it("the print class matches on both sides: style-pagemd's print rules need what the paged canvas carries (amendment 5)", () => {
    expect(PAGINATION_PRINT_CLASS).toBe(STYLE_PRINT_CLASS);
  });

  it("FIX-PGF: the canvas's outside-change meta is the one the pagination measures whole again for", () => {
    expect(OUTSIDE_META).toBe(OUTSIDE_CHANGE_META);
  });
});

