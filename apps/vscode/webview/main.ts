// Webview entry point (browser). Builds the editor from the P1 packages in Draft view (P2): connects to the
// host, waits for the document, then shows it on the canvas and keeps VS Code's text document in step.
// Never import 'vscode' in this folder; only messaging.ts talks to the host.
import { canvasCss, Canvas, fullSrcOf, setFullSrc, PDF_LOOK_CLASS } from '@pagemd-editor/canvas';
import { TemplateFrame, templateFrameCss } from '@pagemd-editor/template-frame';
import { CodeView as CodeMirrorView, codeViewCss as codeMirrorCss, type CodeCommand, type CodeViewOptions } from '@pagemd-editor/code-view';
import { CodeView as MonacoView, codeViewCss as monacoCss, type CodeTheme, type MonacoCodeViewOptions } from '@pagemd-editor/code-view-monaco';
import { movedCleanly, moveDown, moveEdit, moveUp, OutlinePanel, outlinePanelCss, sectionHeads, type SectionMove } from '@pagemd-editor/outline-panel';
import { blockAtOffset, blockAtPos, blockStart, offsetToPos, posToOffset } from '@pagemd-editor/plugin-source-map';
import { SplitView, splitViewCss } from '@pagemd-editor/split-view';
import { paginationCss, Pagination, sizeNoteText, type PaginationOptions } from '@pagemd-editor/pagination';
import { clipboardPlugin } from '@pagemd-editor/plugin-clipboard';
import { FindBar, findBarCss } from '@pagemd-editor/plugin-find';
import { imagePastePlugin } from '@pagemd-editor/plugin-image-paste';
import { imageEditorCss } from '@pagemd-editor/image-editor';
import { createActionRunner, createEditor, parseRibbonLayout, topBlocks, type Action, type ActionContext, type GatePolicy, type PageGeometry, type ResolvedStyles, type RunOptions, type ViewMode, type ViewState } from '@pagemd-editor/core';
import { historyPlugin, type HistoryCallbacks } from '@pagemd-editor/plugin-history';
import { inputRulesPlugin } from '@pagemd-editor/plugin-input-rules';
import { commonmarkPreset } from '@pagemd-editor/preset-commonmark';
import { gfmPreset } from '@pagemd-editor/preset-gfm';
import { ANNOUNCE_EVENT, annotatedTarget, setFigureStyle, cropModePlugin, cursorInTransaction, drawModePlugin, firstHeadingPlugin, hideFirstH1, FLUSH_EVENT, forgetPictureSizes, footnotesPlugin, refOfField, requestShape, selectNodeTransaction, SHAPE_ADDED_EVENT, SHAPE_SELECT_EVENT, shapeEditingPlugin, tableEditingPlugins, taskListsPlugin } from '@pagemd-editor/preset-pagemd';
import { commentAnchorId, diagramCss, diagramEditingPlugin, FRONTMATTER_NODE, frontmatterBlock, gateFields, gateKey, insertCommentAnchor, insertFigures, isDiagram, MERMAID_CONFIG, numberedOutline, outlineLabel, pageMarkerOf, pagemdCanvasCss, pagemdPreset, removeCommentAnchor, removeCommentAnchorAt, tocFields, tocPluginWith, withGateFields } from '@pagemd-editor/preset-pagemd';
import { PreviewFrame, previewFrameCss } from '@pagemd-editor/preview-frame';
import { CommentsPanel, commentsPanelCss, type PanelData } from '@pagemd-editor/comments-margin';
import { diagnosticsPlugin, hintsCss, hintsOf, showHints } from '@pagemd-editor/plugin-diagnostics';
import { anchorsOf, commentsKey, commentsPlugin, CommentsStore, nextThreadId, quoteFor, reconcile, refreshComments, setActiveComment, type AnchorInfo } from '@pagemd-editor/plugin-comments';
import { FilesPanel, filesPanelCss, type InspectTarget } from '@pagemd-editor/files-panel';
import { frontmatterCards, Inspector, inspectorCss, NO_HINTS, type InspectorOptions, type PropertyHints } from '@pagemd-editor/inspector';
import { commandKeymap } from '@pagemd-editor/plugin-keymap';
import { rawBlockNodeView } from '@pagemd-editor/raw-block-editor';
import { Ribbon, ribbonCss } from '@pagemd-editor/ribbon';
import { SelectionToolbar, selectionToolbarCss } from '@pagemd-editor/selection-toolbar';
import { SlashMenu, slashMenuCss } from '@pagemd-editor/slash-menu';
import { statusBarCss, StatusBar, type StatusControls } from '@pagemd-editor/status-bar';
import { defaultStyles } from '@pagemd-editor/style-default';
import { createTransformer, sourceOf, type Transformer } from '@pagemd-editor/transformer';
import type { OutlineEntry, TextEdit } from '@pagemd-editor/core';
import { PROTOCOL_VERSION, type ContrastTestState, type DocumentInit, type StyleNote, type TraceTestState } from '../shared/protocol.ts';
import { codeBlocks } from './code-blocks.ts';
import { imageToolCommands, pictureFieldCommands } from './image-tools.ts';
import { Announcer, announceCss } from './announce.ts';
import { cursorTabs } from './context-tabs.ts';
import { createDiagramDrawer } from './diagrams.ts';
import { blockChain, type InspectView } from './inspect.ts';
import { firstFocusable, isShown, RegionKeys, type Region } from './regions.ts';
import { connect, pageState, savePageState, type WebviewChannel } from './messaging.ts';
import { createClients, servicePlugins } from './services.ts';
import { DocumentSession, SYNC_DELAY_MS } from './sync.ts';
import { PagedView, pagedViewCss } from './paged-view.ts';
import ribbonLayoutFile from './ribbon.layout.json';
import { commentsActions, documentActions, filesActions, findActions, quickAccessActions, viewActions } from './view-actions.ts';
import { RECIPES, recipeFor, START_MODE, type ViewRecipe } from './views.ts';

/** The page's CSP nonce (the host puts it on our script tag); our own style elements need it too. */
const nonce = (document.currentScript as HTMLScriptElement | null)?.nonce ?? '';

const channel = connect();
let started = false;
channel.on('init', (init) => {
  if (started) return; // one document per page
  started = true;
  start(channel, init).catch((error: unknown) => fail(error));
});
channel.emit('ready', { protocol: PROTOCOL_VERSION });

async function start(channel: WebviewChannel, init: DocumentInit): Promise<void> {
  if (init.protocol !== PROTOCOL_VERSION) throw new Error(`The host speaks protocol ${init.protocol}, this page ${PROTOCOL_VERSION}.`);

  // Relative image paths resolve against the document's folder (C1).
  const base = document.createElement('base');
  base.href = init.documentBase;
  document.head.prepend(base);

  const clients = createClients(channel, init.version, init.styles, init.eol);
  // R-94 (OQ-23): VS Code owns undo/redo; `historyCallbacks` reads `session` lazily (it's created below,
  // after the editor, since it needs `editor.schema`) — plugins activate synchronously inside createEditor.
  let session: DocumentSession | undefined;
  const historyCallbacks: HistoryCallbacks = {
    isPending: () => session?.pending ?? false,
    flushThenRun: (command) => void session?.flush().then(() => channel.emit('runCommand', { command })),
  };
  // pagemd's items on top (P4): gated syntax follows the document's frontmatter (fancy_lists), layered over the
  // profile's defaults (R-124; the host sends them with the styles, protocol v2).
  const gateDefaults = () => clients.styles.payload.gateDefaults;
  // P10 (R-170 Q9): ```mermaid fences are drawn in Print Layout, Web Layout and Read, with pagemd's mermaid version and
  // settings; the view and the pagination are known further down (read lazily).
  let drawsDiagrams = (): boolean => false;
  let afterDrawing = (): void => undefined;
  const diagrams = createDiagramDrawer({ scriptUrl: init.mermaidScript, nonce, config: MERMAID_CONFIG, enabled: () => drawsDiagrams(), drawn: () => afterDrawing() });
  const presets = [commonmarkPreset, gfmPreset, pagemdPreset({ fields: gateFields(init.text, gateDefaults()), diagrams })];
  // The live TOC lists what pagemd's would (R-148): the frontmatter's toc_levels / toc_min_level, never the
  // frontmatter's own blocks. Read lazily: the session and the frontmatter count are set up further down.
  let tocKey = '';
  let tocValues: { levels?: number; minLevel?: number } = {};
  const tocPlugin = tocPluginWith((doc) => {
    const text = session?.text ?? init.text;
    const fm = frontmatterText(text);
    if (fm !== tocKey) {
      tocKey = fm;
      tocValues = tocFields(text, gateDefaults());
    }
    return { ...tocValues, bodyFrom: tocBodyFrom ? tocBodyFrom(doc) : 0 };
  });
  let tocBodyFrom: ((doc: PMNode) => number) | undefined;
  // The editor's settings (protocol v4): `pagemdEditor.gatedInsert`; the host tells us when it changes.
  let settings = init.settings;
  setFigureStyle(settings.figureStyle); // R-254: how a new figure is written
  // The View tab's commands close over the editor's own ViewState, which exists once createEditor has returned.
  let viewOf: (() => ViewState) | undefined;
  // The Inspector (P8) is built after the canvas; "Properties" opens it on its Document tab.
  let openProperties = (): void => undefined;
  // P11: after a figure is pasted or dropped the Inspector opens on its Element tab with the caption box focused.
  let showCaption = (): void => undefined;
  // P20: the Image tab's Caption and Details buttons open the Inspector on the selected picture's box (built with the Inspector).
  let showPictureField = (_field: string | undefined): void => undefined;
  // Review comments (P12): the threads live in the side file (ISidecar, R-180); the anchors are in the text. The store reads
  // `settings` lazily for the author's name; the panel and the commands are built below, once the canvas exists.
  const comments = new CommentsStore({ sidecar: clients.sidecar, author: () => settings.commentAuthor });
  let commentsApi!: Parameters<typeof commentsActions>[0];
  // The find bar (P11, R-175) is built with the canvas's pane; the commands that open it exist before (the ribbon's buttons).
  let find!: FindBar;
  const editor = await createEditor({
    presets,
    plugins: [
      ...servicePlugins(clients),
      inputRulesPlugin,
      clipboardPlugin(),
      historyPlugin(historyCallbacks),
      tocPlugin,
      // P11 (R-174): a pasted or dropped image becomes a figure in one edit; its caption box in the Inspector gets the focus.
      // `flash` and `showCaption` exist by the time anything is pasted.
      imagePastePlugin({ insert: insertFigures, onInserted: () => showCaption(), onProblem: (message) => flash(message) }),
    ],
    ribbonLayout: parseRibbonLayout(ribbonLayoutFile),
    commands: [
      // OQ-67: Save, Undo, Redo at the start of the Home tab (the Code view's typing goes first: codeCommand).
      ...quickAccessActions((command) => codeCommand(command)),
      ...viewActions(() => viewOf!(), (command) => channel.emit('runCommand', { command })),
      ...findActions((replace) => find.open({ replace })),
      ...commentsActions({
        canChange: () => commentsApi.canChange(),
        active: () => commentsApi.active(),
        hasThreads: () => commentsApi.hasThreads(),
        create: () => commentsApi.create(),
        reply: () => commentsApi.reply(),
        toggleResolved: () => commentsApi.toggleResolved(),
        step: (direction) => commentsApi.step(direction),
      }),
      // P27 (ADR-0019): Image ▸ Edit picture: Crop (crop mode), Rotate, Flip, Redact, Reset picture: keys in the markdown, no file
      // written; the shape commands are preset-pagemd's.
      ...imageToolCommands({
        state: () => canvas?.view.state,
        editable: () => canvas?.editable ?? false,
        dispatch: (tr) => canvas?.view.dispatch(tr),
        flash: (message) => flash(message),
        document,
      }),
      ...pictureFieldCommands((field) => showPictureField(field), (message) => flash(message)),
      // P25 (R-242): Document ▸ Files in Use opens and closes the panel (ViewState's `panels.files`, read lazily: the editor makes it).
      ...filesActions({ isOpen: () => viewOf?.().value.panels.files ?? false, toggle: () => viewOf?.().set({ panels: { files: !viewOf!().value.panels.files } }) }),
      ...documentActions(() => openProperties(), {
        formats: () => init.output.flatMap((provider) => provider.formats),
        hasProfiles: () => clients.styles.payload.styles !== null,
        runCommand: (command) => channel.emit('runCommand', { command }),
      }),
    ],
    // The Inspector and the Outline start closed (R-160 amendment 8, AD-P9-08) unless this editor tab had them open.
    view: { mode: START_MODE, panels: { inspector: pageState().inspector === true, outline: pageState().outline === true, comments: pageState().comments === true, files: pageState().files === true } },
  });
  viewOf = () => editor.registry.view;
  let recipe = recipeFor(editor.registry.view.value.mode, settings.nativeSplit);
  // Structural CSS (editor UI + item chrome) never changes with the view. Content CSS does: Draft shows
  // style-default's look (the VS Code theme) whatever the profile; Web Layout shows the document's resolved
  // styles (R-131), read fresh on every view switch and every stylesChanged (gate changes aside).
  addStyle(APP_CSS + canvasCss + pagemdCanvasCss + diagramCss + paginationCss + pagedViewCss + statusBarCss + ribbonCss + slashMenuCss + selectionToolbarCss + inspectorCss + outlinePanelCss + codeMirrorCss + monacoCss + splitViewCss + previewFrameCss + findBarCss + commentsPanelCss + filesPanelCss + hintsCss + imageEditorCss + announceCss + templateFrameCss);
  const frontmatterStyle = addStyle('');
  const contentCssFor = (mode: ViewMode): string => (recipeFor(mode).styles === 'pagemd' ? clients.styles.styles.css : defaultStyles().css);
  const contentStyle = addStyle(contentCssFor(recipe.mode));

  // One reader per set of gate values: a re-read after an outside change follows the frontmatter then (the
  // schema is the same for all of them, so the canvas keeps working).
  const transformers = new Map<string, Transformer>();
  const transformer = (text: string): Transformer => {
    const fields = gateFields(text, gateDefaults());
    const key = gateKey(fields);
    let found = transformers.get(key);
    if (!found) {
      found = createTransformer(withGateFields(editor.registry.items(), fields), { schema: editor.schema });
      transformers.set(key, found);
    }
    return found;
  };
  let canvas: Canvas | undefined;
  // P14: the last checks' results (IDiagnostics), shown again whenever the canvas gets a new state (a re-read).
  const applyHints = (): void => {
    const last = clients.diagnostics.last;
    if (canvas && last) showHints(canvas.view, last.text, last.shown ? last.items : []);
  };
  session = new DocumentSession(init.text, {
    transformer,
    sync: clients.sync,
    replace: (doc, cursor) => {
      // FIX-PGF (item 3, AD-FIX-PGF-09): only the changed blocks are patched (the pages stay on screen); a new state only when that
      // can't give exactly `doc`.
      const shown = canvas?.patchDocument(doc, cursor);
      applyHints(); // P14: (a new state starts without hints)
      refreshCode(); // P9: the Code view shows the text VS Code has
      return shown;
    },
    cursor: () => canvas?.cursor ?? 0,
    onError: (error) => console.error('pagemd Editor: sync failed', error),
    onSynced: () => synced(),
    lineEnding: () => clients.sync.eol, // protocol v11: the file's own (fix-sync-bugs)
  });
  // P8: the host has the canvas's edits. A property changed on the card or in the Inspector (or added with a gated
  // insert) may switch a gate on or off: the buttons follow, and the text is read again with the matching reader.
  let synced = (): void => undefined;
  // P9: the Code view, made the first time Code or Split is shown (see "the Code view" below).
  let code: CodeViewApi | undefined;
  /** The user's colour theme for the Code view (the host sends it after init and when it changes). */
  let codeTheme: CodeTheme | null = null;

  // Print Layout's pages (P6, amendment 6): the plugin is always there, switched on by paged recipes.
  // The frontmatter shows on the canvas but not in pagemd's output: it takes no room on page 1. Since P8 it is one
  // node (the properties card) at the start of the document.
  const hasFrontmatter = (doc: PMNode): boolean => doc.firstChild?.type.name === FRONTMATTER_NODE;
  const frontmatterBlocks = (): number => (hasFrontmatter(canvas?.doc ?? session!.doc) ? 1 : 0);
  const excludedUpTo = (doc: PMNode): number => (hasFrontmatter(doc) ? doc.firstChild!.nodeSize : 0);
  tocBodyFrom = excludedUpTo;
  // `gap` is changed by PagedView (0 for pages in columns and in Read), so the options object is kept.
  const paginationOptions: PaginationOptions = { markerOf: (node, pos, doc) => (pos < excludedUpTo(doc) ? { kind: 'excluded' } : pageMarkerOf(node)) };
  const pagination = new Pagination(paginationOptions);

  // The page: ribbon, then a row (the Outline on the left, P9; the main column; the Inspector on the right, P8), then the
  // status bar. The main column holds Split view's frame (P9): the Code view's pane and the canvas's pane, one or both shown.
  const root = document.createElement('div');
  root.className = 'pmd-app';
  const row = document.createElement('div');
  row.className = 'pmd-row';
  const main = document.createElement('div');
  main.className = 'pmd-main';
  const split = new SplitView(main, { arrangement: editor.registry.view.value.arrangement, onResize: () => code?.refresh() });
  const scroller = document.createElement('div');
  scroller.className = 'pmd-scroll';
  split.canvasPane.append(scroller);
  // Find and replace (P11, R-175): visible text only; a drawn diagram's source is not visible, so it isn't searched.
  find = new FindBar(split.canvasPane, {
    view: () => canvas?.view,
    editable: () => canvas?.editable ?? false,
    searchable: (node) => !(recipe.diagrams && isDiagram(node)),
  });
  // Print Preview (P10, R-170 Q5): pagemd's page for the text VS Code has (the canvas's typing is sent first).
  // FIX-PGF: sending the typing is its own stage (with its own limit), and every stage is written to the host's log at debug level.
  const preview = new PreviewFrame(main, {
    send: () => session!.flush(),
    request: () => channel.request('preview', { nonce }),
    onStage: ({ attempt, stage, event, ms, detail }) =>
      channel.emit('log', { level: 'debug', message: `Print Preview #${attempt}: ${stage} ${event}${event === 'start' ? '' : ` after ${ms} ms`}${detail ? ` (${detail})` : ''}` }),
    onState: () => updateStatusBar(),
    onLink: (href) => clients.links.open(href),
  });
  row.append(main);
  root.append(row);
  document.body.append(root);
  // P13b (amendment 8a/e): the page's main landmark and the one polite live region (AD-P13-10).
  main.setAttribute('role', 'main');
  main.setAttribute('aria-label', 'Document area');
  const announcer = new Announcer(root);
  const announce = (message: string): void => announcer.announce(message);
  // P19 follow-up: the table column tools say their result through the one live region (a bubbling event from the canvas).
  document.addEventListener(ANNOUNCE_EVENT, (event) => announce(String((event as CustomEvent<{ message?: unknown }>).detail?.message ?? '')));

  // Ribbon, slash menu and selection toolbar (P7): every button is an Action from the registry; the one action
  // runner runs them all and applies the gated-insert policy (ADR-0016 M3, R-154, R-155). `canvas` and `flash`
  // exist by the time anything is clicked.
  const mac = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);
  let gatesFor = { text: '', defaults: {} as Record<string, unknown>, value: {} as Record<string, unknown> };
  const context = (): ActionContext | undefined => {
    if (!canvas) return undefined;
    // The gate values of the text the host has; read again only when that text or the profile's defaults change.
    const text = session!.text;
    const defaults = gateDefaults();
    if (gatesFor.text !== text || gatesFor.defaults !== defaults) gatesFor = { text, defaults, value: gateFields(text, defaults) };
    return { state: canvas.view.state, editable: canvas.editable, gates: gatesFor.value };
  };
  // P8 (R-161): "Add property" goes into the insert's own transaction (the frontmatter node), so the property and the
  // item are one edit and one undo step (ADR-0016 M3; R-155's two steps are over).
  const gate: GatePolicy = {
    mode: () => settings.gatedInsert,
    sameStep: true,
    confirm: (info) => channel.request('confirmGatedInsert', info),
    notify: (message) => flash(message),
  };
  const runner = createActionRunner({
    registry: editor.registry,
    target: () => ({ state: canvas!.view.state, dispatch: (tr) => canvas!.view.dispatch(tr), focus: () => canvas!.focus() }),
    context: () => context()!,
    gate,
  });
  const run = (action: Action, options?: RunOptions): void => {
    runner(action, options).catch((error: unknown) => flash(`${action.label}: ${error instanceof Error ? error.message : String(error)}`));
  };
  // P19 round 3 (the user's answer): the cursor going into a table brings the Table tab forward; leaving it, the earlier tab comes back.
  // P20 (AD-P20-02): a selected picture brings the Image tab, which is in the strip only then (and never in a read-only view);
  // the rules are in order, first match wins, so a picture selected in a table cell shows Image, and the cell's text Table.
  const tabRules = cursorTabs(() => canvas?.editable ?? false);
  const imageTab = tabRules.contextTabs['image']!;
  const ribbon = new Ribbon(root, { registry: editor.registry, run: (action) => run(action), context, mac, tabs: recipe.ribbonTabs, exit: () => focusDocument(), ...tabRules });
  // The shortcut keys go through the same runner (and the same gate) as the buttons (R-157).
  const keys = commandKeymap({ registry: editor.registry, run: (action) => run(action), context });
  const slash = new SlashMenu({ registry: editor.registry, run, context });
  const toolbar = new SelectionToolbar({ registry: editor.registry, run: (action) => run(action), context, mac });
  slash.setActive(recipe.slash);
  toolbar.setActive(recipe.toolbar);
  // The Comments panel (P12, R-181), between the page and the Inspector. `canvas` exists by the time anything is drawn or clicked.
  let chosenThread: string | null = null; // selected on purpose (a click in the panel or on a flag, Previous / Next)
  let cursorThread: string | null = null; // the thread whose block holds the cursor
  const activeThread = (): string | null => chosenThread ?? cursorThread;
  const anchorList = (): AnchorInfo[] => (canvas ? anchorsOf(canvas.view.state) : []);
  const commentsReady = (): boolean => comments.status === 'ready';
  const commentsData = (): PanelData => {
    const anchors = anchorList();
    // Until the file is read (or when it can't be) the anchors are not judged: nothing is called an orphan by mistake.
    const rec = commentsReady() ? reconcile(comments.file, anchors.map((a) => a.id)) : { attached: [], orphans: [], bare: [] };
    const known = new Set(comments.file.threads.map((t) => t.id));
    return {
      status: comments.status,
      message: comments.message,
      editable: canvas?.editable ?? false,
      attached: rec.attached,
      orphans: rec.orphans,
      bare: rec.bare.map((index) => ({ index, id: anchors[index]!.id, duplicate: known.has(anchors[index]!.id) })),
      active: activeThread(),
      quote: canvas ? quoteFor(canvas.view.state) : '',
    };
  };
  const commentsPanel = new CommentsPanel(row, {
    data: commentsData,
    create: (text) => createComment(text),
    reply: (id, text) => comments.reply(id, text),
    setResolved: (id, resolved) => comments.resolve(id, resolved).catch(reportComment),
    remove: (id) => removeComment(id).catch(reportComment),
    reveal: (id) => revealThread(id),
    reattach: (id) => reattachComment(id).catch(reportComment),
    removeAnchor: (index) => removeMarker(index),
    onClose: () => editor.registry.view.set({ panels: { comments: false } }),
  });
  // The Inspector and the properties card (P8): the same forms, edits as one transaction each.
  const hints = (): PropertyHints => clients.styles.payload.properties ?? NO_HINTS;
  const pickFile = (extensions?: readonly string[]): Promise<string | undefined> => clients.assets.pickFile(extensions ? [...extensions] : undefined);
  const edit: InspectorOptions['edit'] = (change) => {
    if (!canvas) return;
    const tr = canvas.view.state.tr;
    if (change(tr)) canvas.view.dispatch(tr);
  };
  // Why nothing can be changed, in plain words, at the top of the Inspector and the card (Print Preview and Read are read-only by design).
  const readOnlyNote = (): string | undefined =>
    recipe.editable ? undefined : `${recipe.mode === 'preview' ? 'Print Preview' : 'Read'} is read-only. Switch to Print Layout to edit.`;
  const inspector = new Inspector(row, {
    registry: editor.registry,
    state: () => canvas?.view.state,
    editable: () => canvas?.editable ?? false,
    readOnlyNote,
    edit,
    hints,
    pickFile,
    onClose: () => editor.registry.view.set({ panels: { inspector: false } }),
    // P15: a shape's row focused in the Inspector selects that shape on the canvas (without taking the focus).
    onFocusField: (field) => {
      const ref = refOfField(field);
      const state = canvas?.view.state;
      const target = state && annotatedTarget(state);
      if (ref && state && target) canvas!.view.dispatch(requestShape(state.tr, target.pos, ref, false));
    },
  });
  const cards = frontmatterCards({ registry: editor.registry, hints, readOnlyNote, pickFile });
  // Files in Use (P25, R-242): every file that builds the document, in priority order, and where the block at the cursor gets its look
  // from. Read-only: the host answers the report and opens a file of it (protocol v12). The canvas's typing is sent first, so the host
  // resolves the text VS Code has (the frontmatter may have changed).
  const filesPanel = new FilesPanel(row, {
    load: async () => {
      await session!.flush();
      return channel.request('filesInUse', {});
    },
    open: (path, line) => channel.emit('openFile', { path, ...(line ? { line } : {}) }),
    reveal: (path) => channel.emit('openFile', { path, reveal: true }),
    inspect: () => inspectTarget(),
    announce: (message) => announce(message),
    onClose: () => editor.registry.view.set({ panels: { files: false } }),
  });
  /** What "where did this come from" looks at (AD-P25-05): the canvas's blocks, where the canvas shows the profile's look. */
  const inspectTarget = (): InspectTarget => {
    if (!canvas || !canvasShows()) return { note: 'Shown where the page is: Print Layout, Web Layout, Read and Split.', chain: [] };
    if (recipe.styles !== 'pagemd') return { note: "Draft shows the text in VS Code's colors, not the profile's look. Switch to Print Layout or Web Layout to see where a block's look comes from.", chain: [] };
    if (clients.styles.payload.styles === null) return { note: 'The page shows plain styles (see Problems above), so no rule from these files applies.', chain: [] };
    return { chain: blockChain(canvas.view as unknown as InspectView) };
  };
  // The Outline (P9, R-164): the registry's outline with @pagemd/syntax's figure numbers (D9); a move is one text edit.
  const outline = new OutlinePanel(row, {
    state: () => canvas?.view.state,
    entries: (state) => numberedOutline(editor.registry, state.doc),
    label: outlineLabel,
    editable: () => canvas?.editable ?? false,
    reveal: (entry) => revealEntry(entry),
    move: (move) => void moveSection(move),
    onClose: () => editor.registry.view.set({ panels: { outline: false } }),
  });
  // The tint on commented blocks, the flags' clicks and "which comment is the cursor in" (P12). The anchor node is preset-pagemd's.
  const commentsPm = commentsPlugin({
    anchorOf: commentAnchorId,
    statusOf: (id) => {
      const thread = comments.file.threads.find((t) => t.id === id);
      return thread ? (thread.resolved ? 'resolved' : 'open') : undefined;
    },
    onActivate: (id) => {
      editor.registry.view.set({ panels: { comments: true } });
      revealThread(id);
    },
    onCursor: (id) => {
      cursorThread = id;
      if (chosenThread !== null && chosenThread !== id) chosenThread = null;
      syncActive();
      ribbon.update();
    },
    onUpdate: () => commentsPanel.refresh(),
  });
  // P14 (R-189): the profile's checks as hints on the blocks they are about (the host runs them; IDiagnostics).
  const hintsPm = diagnosticsPlugin();
  canvas = new Canvas(scroller, {
    schema: editor.schema,
    doc: session.doc,
    registry: editor.registry,
    nodeViews: { raw_block: rawBlockNodeView(), [FRONTMATTER_NODE]: cards.nodeView },
    // P26: footnote numbers and task boxes on the canvas
    pmPlugins: [firstHeadingPlugin(), shapeEditingPlugin(), cropModePlugin(), drawModePlugin(), ...tableEditingPlugins(), footnotesPlugin(), taskListsPlugin(), ...editor.pmPlugins, keys, find.plugin, commentsPm, pagination.plugin, ribbon.plugin, slash.plugin, toolbar.plugin, inspector.plugin, outline.plugin, diagramEditingPlugin(isDiagram), hintsPm],
    editable: recipe.editable,
    onDocChange: (doc) => {
      session!.changed(doc);
      filesPanel.update(); // P25: the block at the cursor may look different now
    },
    onOpenLink: (href) => clients.links.open(href),
    readImage: (path) => clients.assets.readAsset(path), // P13b: a picture over 4000 px is shown from a smaller copy
    onSelectionChange: (head, byAuthor) => {
      filesPanel.update(); // P25: "where did this come from" follows the cursor
      if (byAuthor) {
        followCanvas(head);
        announcePicture();
      }
    },
  });
  // P18 (R-228): the profile's template drawn around the text in the views styled by the profile (Web Layout, Print Layout, Read,
  // Split's canvas); the text area takes the place of the template's content element and carries its classes. The text is
  // drawn as the PDF draws it there: soft line breaks as spaces (the text keeps them), tight lists without paragraph gaps.
  const frame = new TemplateFrame(canvas.element, canvas.view.dom as HTMLElement, { onMoved: (hadFocus) => (hadFocus ? canvas!.focus() : undefined) });
  paginationOptions.frame = () => (frame.active ? frame.pieces() : null);
  const applyFrame = (): void => {
    const styled = recipe.styles === 'pagemd' && recipe.show !== 'code' && recipe.show !== 'preview';
    frame.set(styled ? (clients.styles.styles.template ?? null) : null);
    canvas!.setContentAttributes(frame.hostAttributes);
    canvas!.element.classList.toggle(PDF_LOOK_CLASS, styled);
    // OQ-68: `hide_first_h1` (the properties or the profile's default) hides the first level-1 heading in the styled views.
    canvas!.element.classList.toggle('pmd-hide-first-h1', hideFirstH1(session?.text ?? init.text, gateDefaults()));
  };
  applyFrame();
  // P10: diagrams follow the view; a finished drawing changes a block's height, so the pages are laid out again.
  drawsDiagrams = () => recipe.diagrams;
  afterDrawing = () => pagination.schedule();
  canvas.element.classList.toggle('pmd-draw-diagrams', recipe.diagrams);
  diagrams.refresh(); // the blocks were made with the canvas, before the view was known
  // Print Layout and Read (P6): headers/footers, columns, zoom, rulers, Read's window; "Page N of M" for the status bar.
  let statusBar: StatusBar | undefined;
  let layoutNote = '';
  let layoutNoteTimer: ReturnType<typeof setTimeout> | undefined;
  let sizeNote = ''; // P21: the page types pagemd's PDF prints at another size (until C11)
  const flash = (message: string): void => {
    layoutNote = message;
    clearTimeout(layoutNoteTimer);
    layoutNoteTimer = setTimeout(() => {
      layoutNote = '';
      updateStatusBar();
    }, 8000);
    updateStatusBar();
  };
  const view = editor.registry.view;
  // A picture selected with the keyboard (an arrow key onto it) says what it is and what Enter does (P13b, amendment 10).
  // P20 (AD-P20-06): and, once as it appears, that the Image tab holds its tools (nothing is said when the tab goes).
  let pictureShown: unknown = null;
  function announcePicture(): void {
    const selection = canvas?.view.state.selection as { node?: { type: { name: string }; attrs: Record<string, unknown> } } | undefined;
    const node = selection?.node;
    if (node === pictureShown) return;
    pictureShown = node ?? null;
    if (!node) return;
    const tabs = recipe.ribbonTabs;
    const tab = canvas && imageTab(canvas.view.state) && (tabs === 'all' || tabs.includes('image')) ? ' Image tools available on the Image tab.' : '';
    if (node.type.name === 'pmd_annotated_image') announce(`Picture with shapes selected. Press Enter to edit its shapes.${tab}`);
    else if (node.type.name === 'pmd_figure' || node.type.name === 'image' || node.type.name === 'pmd_embed') {
      const raw = node.attrs['data'] as (Record<string, unknown> & { attrs?: Record<string, unknown> }) | undefined;
      const data = (raw?.attrs ?? (node.type.name === 'pmd_embed' ? raw : undefined) ?? node.attrs) as Record<string, unknown>;
      const name = [data['alt'], data['caption']].find((v): v is string => typeof v === 'string' && v !== '');
      announce(`Picture selected${name ? `: ${name}` : ''}.${tab || ' Its alt text and caption are in the Inspector.'}`);
    }
  }
  // Amendment 9: a margin drag ends in a layout file. For the document's own file the host rewrites it without
  // asking (R-143), so the status bar says what happened; for any other layout the host asks first.
  const changeMargins = async (page: PageGeometry): Promise<void> => {
    const own = isOwnLayout(clients.styles.styles.layout, init.fileName);
    try {
      const result = await clients.styles.createLayout(page);
      if (result === 'created') flash(own ? `Layout file updated: ${layoutFileName(init.fileName)}` : 'Layout file created for this document');
    } catch (error) {
      flash(`Margins not saved: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  let page: { current: number; total: number } | null = null;
  const paged = new PagedView({
    scroller,
    app: split.canvasPane,
    canvas,
    pagination,
    paginationOptions,
    flow: () => frame.flowRoot(),
    view,
    styles: () => clients.styles.styles,
    setup: () => pageSetup(clients.styles.styles),
    canCreateLayout: () => clients.styles.payload.styles !== null,
    frontmatterBlocks,
    hideFrontmatter: (css) => void (frontmatterStyle.textContent = css),
    onPage: (next) => {
      if (next?.current === page?.current && next?.total === page?.total) return;
      const turned = recipe.mode === 'read' && next && next.current !== page?.current;
      page = next;
      updateStatusBar();
      if (turned) announce(`Page ${next.current} of ${next.total}`); // Read: a page turn (P13b, amendment 8e)
    },
    onMarginChange: changeMargins,
    onSizeNotes: (notes) => {
      const next = sizeNoteText(notes);
      if (next === sizeNote) return;
      sizeNote = next;
      updateStatusBar();
    },
  });
  // R-132: clicking the status bar's view name opens the view picker ("pagemd: Switch View", P6).
  const controls = (): StatusControls | undefined =>
    !recipe.paged
      ? undefined
      : recipe.mode === 'read'
        ? { onArrangement: (pageArrangement) => view.set({ pageArrangement }) }
        : { onFit: (fit) => view.set({ fit }), onZoom: (zoom) => view.set({ fit: 'none', zoom }), onArrangement: (pageArrangement) => view.set({ pageArrangement }) };
  statusBar = recipe.components.includes('status-bar')
    ? new StatusBar(root, view, { styles: clients.styles.styles, onSelectView: () => channel.emit('runCommand', { command: 'pagemd.switchView' }) })
    : undefined;
  function updateStatusBar(): void {
    const notes = [...notesFor(clients.styles.payload.notes), ...(sizeNote ? [sizeNote] : []), ...(layoutNote ? [layoutNote] : [])];
    const info: Parameters<StatusBar['update']>[0] = { styles: clients.styles.styles, notes, page: recipe.show === 'preview' ? undefined : (page ?? undefined) };
    const c = controls();
    info.controls = c;
    statusBar?.update(info);
  }
  updateStatusBar(); // the notes init.styles carried (amendment 9)
  paged.setMode(recipe.mode, recipe.paged, recipe.editable);

  // ── the Code view, Split view and the Outline's moves (P9, R-164) ──
  // Edits made in this page outside the canvas (the Code view's typing, a moved section) go to VS Code as text edits
  // through the same applyEdits path (VS Code owns the file, the dirty mark and undo); VS Code doesn't echo them back, so
  // the canvas reads the new text itself (`session.accept`, the outside-change path). They are sent one after another.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = (job: () => Promise<void>): Promise<void> => {
    const next = chain.then(job).catch((error: unknown) => console.error('pagemd Editor: sync failed', error));
    chain = next;
    return next;
  };
  /** Sends `edits` (against the text VS Code has); the canvas and the Code view show `text` once VS Code has it. */
  async function sendText(edits: TextEdit[], text: string): Promise<boolean> {
    const seen = clients.sync.changes;
    const result = await clients.sync.applyEdits(edits, clients.sync.version);
    if (result !== 'ok') {
      // Refused as stale: VS Code's text wins (the canvas has re-read it already), the Code view too.
      code?.reset(session!.text);
      return false;
    }
    // Unless VS Code reported a change while applying it (it changed the edit, or something else changed the file): then the
    // canvas has read the text VS Code really has, which `text` (what we expected) must not overwrite (fix-sync-bugs, bug 7).
    // The Code view takes VS Code's text either way, with any newer typing kept on top.
    if (clients.sync.changes === seen) session!.accept(text);
    refreshCode();
    return true;
  }
  let codeTimer: ReturnType<typeof setTimeout> | undefined;
  /** The Code view's typing goes to VS Code after a pause, like the canvas's (one undo step per pause). */
  function sendCode(): Promise<void> {
    clearTimeout(codeTimer);
    codeTimer = undefined;
    return serial(async () => {
      if (!code?.pending) return;
      await session!.flush(); // the canvas's own edits first (Split); the Code view keeps its typing on top of them
      const taken = code.takeEdits();
      if (!taken) return;
      if (taken.base !== session!.text) {
        code.reset(session!.text);
        return;
      }
      await sendText(taken.edits, taken.text);
    });
  }
  /** Undo, redo and save from the Code view: VS Code's, after the typing is sent (R-94). */
  const codeCommand = (command: CodeCommand): void => {
    void sendCode()
      .then(() => session!.flush())
      .then(() => channel.emit('runCommand', { command }));
  };
  function ensureCode(): CodeViewApi {
    if (code) return code;
    // Code engines experiment (protocol v16): the setting says which editor the Code view is made of; changing it needs the editor reopened.
    const options: CodeViewOptions & Omit<MonacoCodeViewOptions, keyof CodeViewOptions> = {
      text: session!.text,
      lineEnding: () => clients.sync.eol, // the file's own: the view keeps it (fix-sync-bugs, bug 7)
      nonce,
      editable: recipe.editable,
      onChange: () => {
        clearTimeout(codeTimer);
        codeTimer = setTimeout(() => void sendCode(), SYNC_DELAY_MS);
      },
      onCursor: (offset) => followCode(offset),
      onCommand: codeCommand,
      onBlur: () => void sendCode(),
      onScroll: () => syncScrollFromCode(),
      theme: codeTheme,
      editorOptions: settings.editorOptions,
      debug: init.testing,
    };
    const made: CodeViewApi = settings.codeEngine === 'monaco-vscode' ? new MonacoView(split.codePane, options) : new CodeMirrorView(split.codePane, options);
    code = made;
    made.setBlocks(codeBlocks(session!.synced), session!.text);
    return made;
  }
  /** The Code view shows the text VS Code has (typing not yet sent stays on top), colored by the canvas's blocks. */
  function refreshCode(): void {
    if (!code || !showsCode(recipe)) return; // hidden: brought up to date when it shows again (setView)
    const text = session!.text;
    code.receive(text);
    code.setBlocks(codeBlocks(session!.synced), text);
  }
  // Split view keeps the two panes scrolled together: the pane the author scrolls drives the other, by block (the top block and how
  // far into it). The pane that was just driven ignores its own scroll event for a moment, and a cursor move that scrolls the other
  // pane (followCanvas, followCode) claims the scroll too, so the two never chase each other.
  let scrollOwner: 'code' | 'canvas' | null = null;
  let scrollRelease: ReturnType<typeof setTimeout> | undefined;
  const claimScroll = (who: 'code' | 'canvas'): boolean => {
    if (scrollOwner && scrollOwner !== who) return false;
    scrollOwner = who;
    clearTimeout(scrollRelease);
    scrollRelease = setTimeout(() => (scrollOwner = null), 150);
    return true;
  };
  /** The block's element on the canvas and its box, relative to the canvas's scrolling area. */
  const blockBox = (index: number): { top: number; height: number } | null => {
    const dom = canvas?.view.nodeDOM(blockStart(canvas.doc, index)) as HTMLElement | null | undefined;
    if (!dom?.getBoundingClientRect) return null;
    const r = dom.getBoundingClientRect();
    return { top: r.top - scroller.getBoundingClientRect().top + scroller.scrollTop, height: r.height };
  };
  /** The block at the top edge of the canvas and how far into it (0..1). */
  function canvasTop(count: number): { index: number; fraction: number } {
    let lo = 0;
    let hi = count - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const box = blockBox(mid);
      if (box && box.top + box.height > scroller.scrollTop + 1) hi = mid;
      else lo = mid + 1;
    }
    const box = blockBox(lo);
    return { index: lo, fraction: box && box.height > 0 ? Math.min(1, Math.max(0, (scroller.scrollTop - box.top) / box.height)) : 0 };
  }
  let scrollFrame = 0;
  function syncScrollFromCode(): void {
    if (recipe.show !== 'both' || !code || !canvas || !claimScroll('code')) return;
    cancelAnimationFrame(scrollFrame);
    scrollFrame = requestAnimationFrame(() => {
      const source = sourceOf(session!.synced);
      if (!source || source.blocks.length === 0 || !code || !canvas) return;
      const offset = code.topOffset();
      const index = Math.min(blockAtOffset(source, offset), source.blocks.length - 1);
      const block = source.blocks[index]!;
      const box = blockBox(index);
      if (box) scroller.scrollTop = box.top + Math.min(1, Math.max(0, (offset - block.from) / Math.max(1, block.to - block.from))) * box.height;
    });
  }
  function syncScrollFromCanvas(): void {
    if (recipe.show !== 'both' || !code || !canvas || !claimScroll('canvas')) return;
    cancelAnimationFrame(scrollFrame);
    scrollFrame = requestAnimationFrame(() => {
      const source = sourceOf(session!.synced);
      if (!source || source.blocks.length === 0 || !code || !canvas) return;
      const { index, fraction } = canvasTop(source.blocks.length);
      const block = source.blocks[index]!;
      code.scrollToOffset(block.from + Math.floor(fraction * (block.to - block.from)));
    });
  }
  scroller.addEventListener('scroll', () => syncScrollFromCanvas());
  /** Split view: the canvas's cursor moved; the Code view's follows, in the same block (plugin-source-map). */
  function followCanvas(head: number): void {
    if (nativeSplitOn() && canvas) {
      const source = sourceOf(session!.synced);
      if (!source || source.blocks.length === 0) return;
      const block = source.blocks[Math.min(blockAtPos(canvas.doc, head).index, source.blocks.length - 1)]!;
      channel.emit('splitCursor', { offset: posToOffset(canvas.doc, source, head), from: block.from, to: block.to, move: true });
      return;
    }
    if (recipe.show !== 'both' || !code || !canvas) return;
    const source = sourceOf(session!.synced);
    if (!source || source.blocks.length === 0) return;
    claimScroll('canvas'); // the Code view scrolls to the cursor: that is not the author scrolling it
    const index = Math.min(blockAtPos(canvas.doc, head).index, source.blocks.length - 1);
    code.reveal(posToOffset(canvas.doc, source, head), source.blocks[index]);
  }
  /** Native split: Split is showing and VS Code's own text editor is the Code side. */
  function nativeSplitOn(): boolean {
    return settings.nativeSplit && recipe.mode === 'split';
  }
  /** Native split: the text editor's cursor moved (the author's); the canvas follows, and the host marks the block. */
  channel.on('nativeCursor', ({ offset }) => {
    if (!nativeSplitOn() || !canvas) return;
    const source = sourceOf(session!.synced);
    if (!source || source.blocks.length === 0) return;
    canvas.reveal(offsetToPos(canvas.doc, source, offset));
    const block = source.blocks[blockAtOffset(source, offset)]!;
    channel.emit('splitCursor', { offset, from: block.from, to: block.to, move: false });
  });
  /** Split view: the Code view's cursor moved; the canvas's follows, in the same block. */
  function followCode(offset: number): void {
    if (recipe.show !== 'both' || !code || !canvas || code.pending) return;
    const source = sourceOf(session!.synced);
    if (!source || source.blocks.length === 0) return;
    claimScroll('code'); // the canvas scrolls to the cursor: that is not the author scrolling it
    canvas.reveal(offsetToPos(canvas.doc, source, offset));
    // OQ-66: only the block mark; `reveal` would collapse a selection being dragged in the Code view to one point.
    code.mark(source.blocks[blockAtOffset(source, offset)]!);
  }
  /** An Outline entry was clicked: go there in the views that show. */
  function revealEntry(entry: OutlineEntry): void {
    const source = sourceOf(session!.synced);
    const range = source && entry.block !== undefined ? source.blocks[entry.block] : undefined;
    if (showsCode(recipe) && code && range) {
      code.reveal(range.from, range);
      if (recipe.show === 'code') code.focus();
    }
    if (recipe.show !== 'code') {
      canvas!.reveal(entry.pos, true);
      paged.showPos(entry.pos); // Read: turn to its page
    }
  }
  /**
   * The Outline moved a section (drag, Move up / Move down): one text edit that swaps two runs of whole blocks, checked by
   * reading the new text (a move that would change how other text reads is refused), sent at once: one VS Code undo step.
   */
  async function moveSection(move: SectionMove): Promise<void> {
    await sendCode();
    await serial(async () => {
      await session!.flush();
      if (session!.pending) return;
      const source = sourceOf(session!.synced)!;
      const edit = moveEdit(source.text, source.blocks, move);
      if (!edit) return;
      const text = source.text.slice(0, edit.from) + edit.text + source.text.slice(edit.to);
      const again = sourceOf(transformer(text).parse(text))!;
      const before = source.blocks.map((r) => source.text.slice(r.from, r.to));
      const after = again.blocks.map((r) => text.slice(r.from, r.to));
      if (!movedCleanly(before, after, move)) {
        flash('The section wasn’t moved: the text around it would read differently there.');
        return;
      }
      if (!(await sendText([edit], text))) return;
      // The cursor goes to the moved heading.
      const first = move.before < move.section.first ? move.before : move.before - (move.section.end - move.section.first);
      const pos = blockStart(canvas!.doc, first); // (P18: blocks counted as the ranges count them, groups looked through)
      if (recipe.show !== 'code') canvas!.reveal(pos);
      const moved = sourceOf(session!.synced)?.blocks[first];
      if (code && moved && showsCode(recipe)) code.reveal(moved.from, moved);
    });
  }
  showFrame(recipe);
  if (showsCode(recipe)) ensureCode();
  /** Which part of the main column shows (P9's frame, or P10's preview). */
  function showFrame(r: ViewRecipe): void {
    const previewing = r.show === 'preview';
    split.element.style.display = previewing ? 'none' : ''; // (the frame's own CSS sets display, so `hidden` isn't enough)
    if (!previewing) {
      preview.hide();
      split.setShow(r.show === 'preview' ? 'canvas' : r.show);
    }
  }

  ribbon.refresh(); // the canvas exists now: enabled and active states
  // ── review comments (P12, R-178–R-181) ──
  const canvasShows = (): boolean => recipe.show === 'canvas' || recipe.show === 'both';
  const threadOf = (id: string | null) => (id === null ? undefined : comments.file.threads.find((t) => t.id === id));
  commentsApi = {
    canChange: () => commentsReady() && (canvas?.editable ?? false) && canvasShows(),
    active: () => {
      const thread = threadOf(activeThread());
      return thread && anchorList().some((a) => a.id === thread.id) ? { id: thread.id, resolved: thread.resolved } : null;
    },
    hasThreads: () => canvasShows() && commentsReady() && anchorList().some((a) => threadOf(a.id) !== undefined),
    // (After the runner has given the focus back to the canvas: the box takes it.)
    create: () => {
      editor.registry.view.set({ panels: { comments: true } });
      setTimeout(() => commentsPanel.startCompose(), 0);
    },
    reply: () => {
      const active = commentsApi.active();
      if (!active) return;
      editor.registry.view.set({ panels: { comments: true } });
      setTimeout(() => commentsPanel.focusReply(active.id), 0);
    },
    toggleResolved: () => {
      const active = commentsApi.active();
      if (active) void comments.resolve(active.id, !active.resolved).catch((error: unknown) => flash(`Comment not saved: ${error instanceof Error ? error.message : String(error)}`));
    },
    step: (direction) => stepThread(direction),
  };
  function reportComment(error: unknown): void {
    flash(`Comment: ${error instanceof Error ? error.message : String(error)}`);
  }
  /** The tint follows what each thread says, and the panel and the buttons follow the threads. */
  comments.onChange(() => {
    if (canvas) refreshComments(canvas.view);
    commentsPanel.refresh();
    ribbon.update();
  });
  clients.sidecar.onChanged(() => void comments.load());
  void comments.load();
  /** The selected thread's block is tinted stronger; dispatched after the update that changed it (never inside one). */
  function syncActive(): void {
    const want = activeThread();
    queueMicrotask(() => {
      if (canvas && commentsKey.getState(canvas.view.state)?.active !== want) setActiveComment(canvas.view, want);
      commentsPanel.refresh();
    });
  }
  /** A new comment: the anchor line above the block at the cursor (one edit, one undo step) and the thread in the side file. */
  async function createComment(text: string): Promise<void> {
    if (!canvas) return;
    if (!comments.writable) throw new Error(comments.message || 'Comments cannot be changed now.');
    if (!canvas.editable) throw new Error('This view is read-only.');
    const state = canvas.view.state;
    const id = nextThreadId(comments.file, anchorList().map((a) => a.id));
    const tr = insertCommentAnchor(state, id);
    if (!tr) throw new Error('Put the cursor in the text you want to comment on (the properties card cannot be commented).');
    const quote = quoteFor(state);
    canvas.view.dispatch(tr);
    chosenThread = id;
    syncActive();
    await comments.add(id, quote, text);
  }
  /** Deletes a thread and its anchor line (one edit). VS Code's undo brings the line back, which then shows as a marker with no thread. */
  async function removeComment(id: string): Promise<void> {
    await comments.remove(id);
    if (chosenThread === id) chosenThread = null;
    if (!canvas?.editable) return;
    const tr = removeCommentAnchor(canvas.view.state, id);
    if (tr) canvas.view.dispatch(tr);
    syncActive();
  }
  /** "Re-attach here": the orphaned thread's anchor goes above the block at the cursor. */
  async function reattachComment(id: string): Promise<void> {
    if (!canvas) return;
    const tr = insertCommentAnchor(canvas.view.state, id);
    if (!tr) throw new Error('Put the cursor in the text first.');
    canvas.view.dispatch(tr);
    chosenThread = id;
    syncActive();
  }
  /** Takes a marker with no thread out of the text. */
  function removeMarker(index: number): void {
    const anchor = anchorList()[index];
    const tr = canvas && anchor ? removeCommentAnchorAt(canvas.view.state, anchor.pos) : null;
    if (tr) canvas!.view.dispatch(tr);
  }
  /** Goes to a thread's block and selects the thread (panel, tint, buttons). */
  function revealThread(id: string): void {
    const anchor = anchorList().find((a) => a.id === id);
    if (!anchor || !canvas) return;
    chosenThread = id;
    const at = anchor.block?.from ?? anchor.pos;
    canvas.reveal(at);
    paged.showPos(at);
    syncActive();
    commentsPanel.refresh();
    commentsPanel.scrollTo(id);
    ribbon.update();
  }
  /** Previous / Next comment: the next thread's block below (or above) the block at the cursor, round the end. */
  function stepThread(direction: 1 | -1): void {
    if (!canvas) return;
    const list = anchorList().filter((a) => a.block && threadOf(a.id) !== undefined);
    if (list.length === 0) return;
    const { $from } = canvas.view.state.selection;
    const here = $from.depth >= 1 ? $from.before(1) : $from.pos;
    const pick = direction === 1 ? (list.find((a) => a.block!.from > here) ?? list[0]!) : ([...list].reverse().find((a) => a.block!.from < here) ?? list[list.length - 1]!);
    editor.registry.view.set({ panels: { comments: true } });
    revealThread(pick.id);
  }
  // The Comments panel follows ViewState's `panels.comments` (View ▸ Show ▸ Comments, its close button, New comment), but only
  // where the canvas shows: not in Code or Print Preview. Remembered for this editor tab.
  let commentsFlag = view.value.panels.comments;
  const showComments = (): void => {
    const open = view.value.panels.comments;
    if (open !== commentsFlag) {
      commentsFlag = open;
      savePageState({ comments: open });
    }
    const visible = open && canvasShows();
    if (visible === commentsPanel.visible) {
      if (visible) commentsPanel.refresh();
      return;
    }
    if (visible) commentsPanel.show();
    else commentsPanel.hide();
  };
  showComments();
  // The Inspector follows ViewState's `panels.inspector` (the View tab's button, its own close button), remembered for
  // this editor tab (VS Code's webview state).
  const showInspector = (): void => {
    const open = view.value.panels.inspector;
    if (open === inspector.visible) return;
    if (open) inspector.show();
    else inspector.hide();
    savePageState({ inspector: open });
  };
  if (view.value.panels.inspector) inspector.show();
  else inspector.hide();
  // P9: the Outline on the left, the same way (closed at first, AD-P9-08).
  const showOutline = (): void => {
    const open = view.value.panels.outline;
    if (open === outline.visible) return;
    if (open) outline.show();
    else outline.hide();
    savePageState({ outline: open });
  };
  if (view.value.panels.outline) outline.show();
  else outline.hide();
  // P25: the Files in Use panel, the same way (closed at first; in every view, AD-P25-05).
  const showFiles = (): void => {
    const open = view.value.panels.files;
    if (open === filesPanel.visible) return;
    if (open) filesPanel.show();
    else filesPanel.hide();
    savePageState({ files: open });
  };
  if (view.value.panels.files) filesPanel.show();
  showCaption = () => {
    view.set({ panels: { inspector: true } });
    inspector.show('element', 'caption');
  };
  // P20: the action runner puts the focus back on the page after a button, so the box is focused just after that.
  showPictureField = (field) => {
    view.set({ panels: { inspector: true } });
    inspector.show('element');
    if (field) setTimeout(() => inspector.show('element', field), 0);
  };
  openProperties = () => {
    view.set({ panels: { inspector: true } });
    inspector.show('document');
  };
  view.onChange(() => {
    ribbon.update();
    showInspector();
    showOutline();
    showComments();
    showFiles();
    split.setArrangement(view.value.arrangement); // Split: side by side or stacked
  });
  channel.on('codeTheme', (theme) => {
    codeTheme = theme;
    code?.setTheme?.(theme);
  });
  channel.on('settingsChanged', (next) => {
    const nativeChanged = next.nativeSplit !== settings.nativeSplit;
    settings = next;
    setFigureStyle(next.figureStyle);
    ribbon.update();
    code?.setEditorOptions?.(next.editorOptions); // the Monaco views follow VS Code's editor.* settings as they change
    if (nativeChanged && editor.registry.view.value.mode === 'split') switchView('split'); // the Code side moves between the pane and the editor beside
  });

  // R-124: when the profile's gate defaults change the gate values for this text, re-read it with the new reader.
  let gates = gateKey(gateFields(init.text, gateDefaults()));
  synced = () => {
    ribbon.update();
    canvas!.element.classList.toggle('pmd-hide-first-h1', hideFirstH1(session!.text, gateDefaults())); // OQ-68
    refreshCode(); // P9: the canvas's edits reach the Code view
    const now = gateKey(gateFields(session!.text, gateDefaults()));
    if (now === gates) return;
    gates = now;
    void session!.reread();
  };
  clients.styles.onPayload(() => {
    updateStatusBar();
    ribbon.update(); // the profile's gate defaults may change which buttons are gated
    inspector.refresh(); // and the properties' hints (required, shown on the page)
    cards.refresh();
    if (recipe.styles === 'pagemd') contentStyle.textContent = contentCssFor(recipe.mode);
    applyFrame(); // P18: the template follows the properties (and the profile)
    paged.restyle();
    refreshCode();
    void filesPanel.refresh(); // P25: another profile, layout or stylesheet: read the files again (only marked out of date while closed)
    const text = session!.text;
    const now = gateKey(gateFields(text, gateDefaults()));
    if (now === gates) return;
    gates = now;
    void session!.reread();
  });

  // "pagemd: Print Layout" / "Web Layout" / "Draft" / "Read": switches the recipe, so the content CSS, the pages and
  // the editable state follow.
  const switchView = (mode: ViewMode): void => {
    if (!RECIPES[mode]) return; // not built yet (Print Preview, P10): ignore
    const leaving = recipe;
    editor.registry.view.set({ mode });
    recipe = recipeFor(mode, settings.nativeSplit);
    // P9: the Code view's typing reaches VS Code before it hides; it shows the text VS Code has when it appears.
    if (showsCode(leaving) && !showsCode(recipe)) void sendCode();
    if (showsCode(recipe)) {
      ensureCode().setEditable(recipe.editable);
      refreshCode();
    }
    showFrame(recipe);
    // P10: diagrams drawn in this view or not; Print Preview renders when it shows.
    canvas!.element.classList.toggle('pmd-draw-diagrams', recipe.diagrams);
    diagrams.refresh();
    if (recipe.show === 'preview') void preview.show();
    contentStyle.textContent = contentCssFor(mode);
    applyFrame(); // P18: the template frame shows in the views styled by the profile
    paged.setMode(mode, recipe.paged, recipe.editable);
    // P11: the find bar belongs to the canvas: gone with it (Code, Print Preview), and its matches follow what is visible.
    if (recipe.show === 'code' || recipe.show === 'preview') find.close();
    else find.refresh();
    ribbon.setTabs(recipe.ribbonTabs);
    slash.setActive(recipe.slash);
    toolbar.setActive(recipe.toolbar);
    inspector.refresh(); // read-only in Read
    cards.refresh();
    outline.refresh(); // nothing moves in Read
    showComments(); // P12: the Comments panel shows where the canvas shows (read-only in Read)
    commentsPanel.refresh();
    filesPanel.update(); // P25: "where did this come from" works where the profile's look is drawn
    updateStatusBar();
    if (recipe.show === 'code') code!.focus();
    else if (leaving.show === 'code' && recipe.show !== 'preview') canvas!.focus();
    channel.emit('viewMode', { mode }); // native split: the host opens or closes VS Code's text editor beside this page
  };
  channel.on('setView', ({ mode }) => switchView(mode));
  // P10 (R-10, R-170 Q5): the preview is on demand; a save renders it again while it shows.
  channel.on('saved', () => {
    if (preview.visible) void preview.refresh();
  });

  // Image files changed on disk (C9, amendment 11): reload the matching <img> elements. `?v=` cache-busts the
  // webview resource URI the browser resolves the (unchanged, document-relative) src through via <base href>.
  channel.on('assetsChanged', ({ paths }) => {
    const changed = new Set(paths);
    forgetPictureSizes(); // P27: a changed picture may have another size (a picture turned a quarter is drawn from it)
    for (const img of canvas!.element.querySelectorAll('img')) {
      const src = fullSrcOf(img); // (a very large picture is shown from a copy, P13b: it is the file's own src that names it)
      if (src && changed.has(src.replace(/^\.\//, ''))) setFullSrc(img, cacheBust(src));
    }
  });

  // P14 (R-189, protocol v9): the checks' results. The hints show on the canvas when it shows the text that was checked;
  // otherwise the hints already there follow the edits until the next results.
  clients.diagnostics.onPayload(() => applyHints());
  applyHints(); // results that arrived while the page was being built

  // VS Code owns save (R-87 amendment 4); undo/redo go through plugin-history's keymap instead (R-94, P3),
  // which already flushes pending typing first the same way. VS Code doesn't save a file it doesn't know is
  // dirty: send the typing first, then ask for the command.
  canvas.element.addEventListener('keydown', (event) => {
    if (!isSaveKey(event) || !session!.pending) return;
    event.preventDefault();
    event.stopPropagation();
    void session!.flush().then(() => channel.emit('runCommand', { command: 'save' }));
  });
  // Leaving the editor (another tab, auto-save on focus change): send what's pending.
  canvas.element.addEventListener('focusout', () => void session!.flush());
  // P15: a shape dragged, nudged or deleted is one change, sent at once (one undo step); its row in the Inspector follows.
  canvas.element.addEventListener(FLUSH_EVENT, () => void session!.flush());
  // FIX-S50 (issue 3): a new marker, arrow or other shape opens the Inspector on it.
  canvas.element.addEventListener(SHAPE_ADDED_EVENT, () => showPictureField(undefined));
  canvas.element.addEventListener(SHAPE_SELECT_EVENT, (event) => inspector.mark((event as CustomEvent<{ field: string | null }>).detail.field));

  channel.handle('flush', () => session!.flush());
  if (init.testing) {
    // Test-only (R-89): Playwright's pagination checks and benchmark reach the canvas and the pages directly.
    (window as unknown as { __pmd?: unknown }).__pmd = {
      canvas,
      pagination,
      paged,
      view,
      inspector,
      outline,
      files: filesPanel,
      split,
      preview,
      diagrams,
      get code() {
        return code;
      },
    };
    // P10: what the preview and the canvas's diagrams show (test:vscode).
    channel.handle('test:preview', async ({ refresh }) => {
      if (refresh) await preview.refresh();
      const win = preview.frame.contentWindow as (Window & { __pmdDocumentScript?: boolean }) | null;
      return {
        visible: preview.visible,
        ...preview.state,
        documentScriptRan: win?.__pmdDocumentScript === true,
        drawnOnCanvas: canvas!.element.querySelectorAll('.pmd-diagram-block[data-state="drawn"]').length,
        images: imagesOf(preview.frame.contentDocument),
        drawnInPreview: preview.frame.contentDocument?.querySelectorAll('figure.mermaid-diagram svg').length ?? 0,
      };
    });
    channel.handle('test:type', ({ text, block }) => {
      canvas!.typeAtEndOfBlock(block, text);
    });
    channel.handle('test:ribbon', async ({ tab }) => {
      if (tab) document.getElementById(`pmd-ribbon-tab-${tab}`)?.click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))); // the buttons' state is applied in a frame
      return {
        tabs: [...ribbon.element.querySelectorAll('.pmd-ribbon-tab')].map((t) => t.textContent ?? ''),
        selected: ribbon.element.querySelector('.pmd-ribbon-tab[aria-selected="true"]')?.textContent ?? null,
        buttons: ribbon.element.querySelectorAll('.pmd-ribbon-panel button').length,
        keybindings: editor.registry.commands.list().flatMap((c) => (c.keybinding ? [c.keybinding] : [])),
        disabled: [...ribbon.element.querySelectorAll<HTMLButtonElement>('.pmd-ribbon-panel button[data-command]')].filter((b) => b.getAttribute('aria-disabled') === 'true').map((b) => b.dataset['command']!),
        // P20: every command on the selected tab (a folded group's too), so the real host can check what the Image tab holds.
        commands: [...ribbon.element.querySelectorAll<HTMLButtonElement>('.pmd-ribbon-panel button[data-command]')].map((b) => b.dataset['command']!),
      };
    });
    channel.handle('test:runAction', async ({ id }) => {
      const ctx = context();
      const action = editor.registry.actions({ surface: 'ribbon', ...(ctx ? { context: ctx } : {}) }).find((a) => a.id === id);
      if (!action) return false;
      await runner(action);
      return true;
    });
    // `inside`: the cursor goes into the node's first text (a table cell), not a node selection (P16's real-host test).
    channel.handle('test:selectNode', ({ name, nth, inside }) => {
      const view = canvas!.view;
      let at = -1;
      let seen = 0;
      view.state.doc.descendants((node, pos) => {
        if (at < 0 && node.type.name === name && seen++ === (nth ?? 0)) at = pos;
        return at < 0;
      });
      const tr = at < 0 ? null : inside ? cursorInTransaction(view.state, at) : selectNodeTransaction(view.state, at);
      if (tr) view.dispatch(tr);
      return !!tr;
    });
    // P13b (amendment 8f): the colors of the editor's own UI in the theme VS Code gave the page (a high-contrast theme, in test:vscode).
    channel.handle('test:contrast', () => contrastProbes());
    channel.handle('test:statusText', () => document.querySelector('.pmd-status-bar')?.textContent ?? '');
    // FIX-PGF (item 3): the frame-by-frame trace of an undo (an outside change) in Print Layout.
    let trace: { stop(): TraceTestState } | undefined;
    channel.handle('test:trace', ({ action }) => {
      if (action === 'start') {
        trace?.stop();
        trace = startTrace(canvas!, pagination);
        return null;
      }
      const result = trace?.stop() ?? null;
      trace = undefined;
      return result;
    });
    channel.handle('test:pages', async () => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 50)))); // after a layout run
      const papers = [...canvas!.element.querySelectorAll(':scope > .pmd-pages > .pmd-page')];
      const boxes = (paper: Element, cls: string) => ['left', 'center', 'right'].map((b) => paper.querySelector(`:scope > .${cls} > [data-box="${b}"]`)?.textContent ?? '');
      const running = papers.map((paper) => ({ header: boxes(paper, 'pmd-page-header'), footer: boxes(paper, 'pmd-page-footer') })); // P21
      return { on: pagination.enabled, papers: papers.length, text: canvas!.view.dom.textContent ?? '', running };
    });
    channel.handle('test:setProperty', ({ key, value }) => {
      let done = false;
      edit((tr) => (done = editor.registry.properties?.set(tr, key, value) ?? false));
      return done;
    });
    // P9: typing into the Code view as the author would (it sends after the pause), and the Outline's Move up / Move down.
    channel.handle('test:codeType', ({ text, at }) => {
      ensureCode().insertAt(at, text);
    });
    // fix-sync-bugs: keys pressed through the canvas's or the Code view's own handling (no real key reaches the page from VS Code).
    channel.handle('test:scroll', async ({ target, fraction }) => {
      const source = sourceOf(session!.synced)!;
      const view = ensureCode();
      if (target === 'code') view.scrollToOffset(Math.floor(session!.text.length * fraction));
      else scroller.scrollTop = fraction * (scroller.scrollHeight - scroller.clientHeight);
      await new Promise((resolve) => setTimeout(resolve, 500));
      return { codeBlock: blockAtOffset(source, view.topOffset()), canvasBlock: canvasTop(source.blocks.length).index, blocks: source.blocks.length };
    });
    channel.handle('test:keys', ({ target, keys, at }) => {
      if (target === 'code') {
        const view = ensureCode();
        if (at !== undefined) view.reveal(at);
        view.focus();
        for (const key of keys) view.press(key);
      } else {
        const view = canvas!.view;
        if (at !== undefined) canvas!.reveal(at);
        canvas!.focus();
        for (const key of keys) {
          if ([...key].length === 1) {
            const { from, to } = view.state.selection;
            const typed = (): ReturnType<typeof view.state.tr.insertText> => view.state.tr.insertText(key, from, to);
            if (!view.someProp('handleTextInput', (f) => f(view, from, to, key, typed))) view.dispatch(typed());
          } else {
            view.someProp('handleKeyDown', (f) => f(view, new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));
          }
        }
      }
      const doc = canvas!.view.state.doc;
      const blocks: string[] = [];
      for (const { node } of topBlocks(doc)) blocks.push(`${node.type.name}:${node.textContent}`);
      return { blocks, cursorBlock: blockAtPos(doc, canvas!.view.state.selection.head).index, codeText: code?.text ?? null };
    });
    channel.handle('test:moveSection', async ({ heading, direction }) => {
      const doc = canvas!.doc;
      const heads = sectionHeads(doc, numberedOutline(editor.registry, doc));
      const head = heads.find((h) => h.entry.label === heading);
      const move = head ? (direction === 'up' ? moveUp : moveDown)(heads, head, topBlocks(doc).length) : null;
      if (!move) return false;
      await moveSection(move);
      return true;
    });
    // P11: the browser's own paste and drop events, with a real File, so the plugin runs exactly as for an author.
    channel.handle('test:paste', ({ name, type, bytes, drop, text }) => {
      const data = new DataTransfer();
      data.items.add(new File([bytes as BlobPart], name, { type }));
      if (text !== undefined) data.setData('text/plain', text);
      const rect = canvas!.element.getBoundingClientRect();
      const event = drop
        ? new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true, clientX: rect.left + 40, clientY: rect.top + 40 })
        : new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
      canvas!.view.dom.dispatchEvent(event);
      return event.defaultPrevented;
    });
    channel.handle('test:find', ({ key, query, replacement, do: press }) => {
      const input = (label: string): HTMLInputElement => find.element.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
      const button = (label: string): HTMLButtonElement => find.element.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
      if (key) canvas!.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true }));
      if (query !== undefined) {
        const box = input('Find');
        box.value = query;
        box.dispatchEvent(new Event('input', { bubbles: true }));
      }
      if (replacement !== undefined) input('Replace').value = replacement;
      const buttons = { next: 'Next match', previous: 'Previous match', replace: 'Replace', replaceAll: 'Replace all', close: 'Close' } as const;
      if (press) button(buttons[press]).click();
      const { from, to } = canvas!.view.state.selection;
      return {
        open: find.visible,
        count: find.element.querySelector('.pmd-find-count')?.textContent ?? '',
        matches: find.state?.ranges.length ?? 0,
        replaceRow: !find.element.querySelector<HTMLElement>('.pmd-find-replace-row')!.hidden,
        selected: canvas!.doc.textBetween(from, to, ' '),
      };
    });
    // P14: the problem hints on the canvas now.
    channel.handle('test:hints', () => ({
      hints: hintsOf(canvas!.view.state).map((h) => ({ block: h.block, severity: h.severity, messages: h.messages })),
      enabled: clients.diagnostics.last?.enabled ?? false,
      shown: clients.diagnostics.last?.shown ?? true,
    }));
    // P25: the Files in Use panel as the author uses it (its own buttons), and what it shows.
    channel.handle('test:files', async ({ heading, click, rule }) => {
      const frames = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (!filesPanel.visible) editor.registry.view.set({ panels: { files: true } });
      await filesPanel.settled();
      if (heading !== undefined) {
        let at = -1;
        canvas!.view.state.doc.descendants((node, pos) => {
          if (at < 0 && node.type.name === 'heading' && node.attrs['level'] === heading) at = pos + 1;
          return at < 0;
        });
        if (at >= 0) canvas!.reveal(at);
      }
      await frames();
      await frames();
      const root = filesPanel.element;
      if (click) [...root.querySelectorAll<HTMLButtonElement>('.pmd-files-open')].find((b) => b.querySelector('.pmd-files-name')?.textContent === click)?.click();
      if (rule) root.querySelector<HTMLButtonElement>(`.pmd-files-where dd[data-property="${rule}"] > .pmd-files-rule`)?.click();
      return {
        visible: filesPanel.visible,
        rows: [...root.querySelectorAll('.pmd-files-row .pmd-files-name')].map((e) => e.textContent ?? ''),
        where: [...root.querySelectorAll<HTMLElement>('.pmd-files-where dd')].map((dd) => ({
          property: dd.dataset['property'] ?? '',
          source: dd.dataset['source'] ?? '',
          rule: (dd.querySelector(':scope > .pmd-files-rule')?.textContent ?? '').replace(/\s*\([^)]*\)$/, ''),
        })),
      };
    });
    // P12: drives the Comments panel as the author would (its own buttons and boxes), and says what it shows.
    channel.handle('test:comments', async ({ do: press, id, text, index, block }) => {
      const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));
      for (let i = 0; i < 150 && comments.status === 'loading'; i++) await pause(); // the side file is read
      const root = commentsPanel.element;
      const thread = (threadId: string): HTMLElement => {
        let found = root.querySelector<HTMLElement>(`[data-thread="${threadId}"]`);
        if (!found) {
          // A resolved thread is hidden: tick "Show resolved", as the author would.
          const toggle = root.querySelector<HTMLInputElement>('.pmd-comments-foot input')!;
          toggle.checked = true;
          toggle.dispatchEvent(new Event('change'));
          found = root.querySelector<HTMLElement>(`[data-thread="${threadId}"]`);
        }
        if (!found) throw new Error(`The panel has no card for ${threadId}. It shows: ${root.textContent}`);
        return found;
      };
      const button = (scope: ParentNode, role: string): HTMLButtonElement => scope.querySelector<HTMLButtonElement>(`[data-role="${role}"]`)!;
      if (block !== undefined) {
        canvas!.reveal(blockStart(canvas!.doc, block));
      }
      if (press === 'open') editor.registry.view.set({ panels: { comments: true } });
      if (press === 'new') {
        commentsApi.create();
        root.querySelector<HTMLTextAreaElement>('.pmd-comments-compose textarea')!.value = text ?? '';
        button(root, 'compose-add').click();
      }
      if (press === 'reply') {
        const box = thread(id!).querySelector<HTMLTextAreaElement>('textarea')!;
        box.value = text ?? '';
        box.dispatchEvent(new Event('input', { bubbles: true }));
        button(thread(id!), 'reply').click();
      }
      if (press === 'resolve') button(thread(id!), 'resolve').click();
      if (press === 'delete') button(thread(id!), 'delete').click();
      if (press === 'reattach') button(thread(id!), 'reattach').click();
      if (press === 'remove-marker') button(root.querySelector<HTMLElement>(`[data-anchor="${index}"]`)!, 'remove-marker').click();
      if (press === 'select') revealThread(id!);
      if (press) await pause();
      await pause();
      const data = commentsData();
      return {
        open: commentsPanel.visible,
        status: data.status,
        note: data.message,
        threads: data.attached.map((t) => ({ id: t.id, resolved: t.resolved, messages: t.comments.length, active: t.id === data.active })),
        orphans: data.orphans.map((t) => t.id),
        bare: data.bare.map((b) => b.id),
        composing: !root.querySelector<HTMLElement>('.pmd-comments-compose')!.hidden,
      };
    });
    channel.handle('test:imageState', ({ alt }) => {
      const img = canvas!.element.querySelector<HTMLImageElement>(`img[alt=${JSON.stringify(alt)}]`);
      if (img) return { src: img.getAttribute('src') ?? '', complete: img.complete, naturalWidth: img.naturalWidth };
      // phase L2 (test only): a picture drawn by CSS (a template's `<span role="img" aria-label="…">` with a background-image, as the
      // library's profile packs draw their logo): that url loaded in this webview, so the webview's own rules about folders apply
      const el = canvas!.element.querySelector<HTMLElement>(`[role="img"][aria-label=${JSON.stringify(alt)}]`);
      const url = el ? /url\("?([^")]+)"?\)/.exec(getComputedStyle(el).backgroundImage)?.[1] : undefined;
      if (!url) return null;
      return new Promise((resolve) => {
        const probe = new Image();
        const done = () => resolve({ src: url, complete: probe.complete, naturalWidth: probe.naturalWidth });
        probe.onload = done;
        probe.onerror = done;
        setTimeout(done, 5000);
        probe.src = url;
      });
    });
  }

  // ── regions (P13b, R-208): F6 / Shift+F6 between the ribbon, the panels, the document and the status bar, in screen order ──
  /** Puts the focus back where the author types: the canvas, or the Code view in Code (Print Preview has no text box: its frame). */
  function focusDocument(): void {
    if (recipe.show === 'code') code?.focus();
    else if (recipe.show === 'preview') preview.frame.focus();
    else canvas?.focus();
  }
  const panelRegion = (name: string, panel: { element: HTMLElement; visible: boolean }): Region => ({
    name,
    element: () => panel.element,
    shown: () => panel.visible && isShown(panel.element),
    focus: () => {
      const target = firstFocusable(panel.element);
      target?.focus();
      return !!target;
    },
  });
  const regionList = (): Region[] => [
    { name: 'Ribbon', element: () => ribbon.element, shown: () => isShown(ribbon.element), focus: () => ribbon.focusEntry() },
    panelRegion('Outline', outline),
    // Split: the Code pane is on the left (or above), the page after it, as in the DOM
    { name: 'Code', element: () => split.codePane, shown: () => showsCode(recipe) && isShown(split.codePane), focus: () => (code?.focus(), !!code) },
    { name: 'Document', element: () => split.canvasPane, shown: () => canvasShows() && isShown(canvas!.element), focus: () => (canvas!.focus(), true) },
    { name: 'Print Preview', element: () => preview.element, shown: () => preview.visible, focus: () => (preview.frame.focus(), true) },
    panelRegion('Comments', commentsPanel),
    panelRegion('Inspector', inspector),
    panelRegion('Files in use', filesPanel),
    {
      name: 'Status bar',
      element: () => statusBar?.element ?? null,
      shown: () => !!statusBar && isShown(statusBar.element),
      focus: () => {
        const bar = statusBar?.element;
        if (!bar) return false;
        (firstFocusable(bar) ?? Object.assign(bar, { tabIndex: -1 })).focus();
        return true;
      },
    },
  ];
  new RegionKeys(document, regionList, announce);
  // Print Preview is a frame of its own: keys pressed inside it do not reach this page, so the same key listener goes into each loaded preview.
  let previewKeys: RegionKeys | undefined;
  preview.frame.addEventListener('load', () => {
    previewKeys?.destroy();
    const inner = preview.frame.contentDocument;
    previewKeys = inner ? new RegionKeys(inner, regionList, announce, document) : undefined;
  });
  canvas.focus();
  document.body.dataset['pmdWebview'] = 'ready';
}

/** The editor's own UI that `test:contrast` looks at, by name. */
const CONTRAST_PROBES: Record<string, string> = {
  'ribbon tab': '.pmd-ribbon-tab[aria-selected="true"]',
  'ribbon button': '.pmd-ribbon-button:not([aria-disabled="true"])',
  'ribbon group name': '.pmd-ribbon-group-label',
  'status bar': '.pmd-status-bar',
  'inspector tab': '.pmd-insp-tab[aria-selected="true"]',
  'inspector text': '.pmd-insp-empty, .pmd-insp-title, .pmd-insp-label',
};

/** Colors and WCAG contrast ratios of `CONTRAST_PROBES` as drawn now (test-only). */
function contrastProbes(): ContrastTestState {
  type Rgba = [number, number, number, number];
  const parse = (css: string): Rgba => {
    const m = /rgba?\(([^)]+)\)/.exec(css);
    const [r = 0, g = 0, b = 0, a = 1] = m ? m[1]!.split(/[ ,/]+/).filter(Boolean).map(Number) : [];
    return [r, g, b, a];
  };
  const over = (top: Rgba, bottom: Rgba): Rgba => {
    const a = top[3] + bottom[3] * (1 - top[3]);
    const mix = (i: 0 | 1 | 2): number => (a === 0 ? 0 : (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / a);
    return [mix(0), mix(1), mix(2), a];
  };
  /** The background an element really sits on: its own and its ancestors', layered. */
  const backgroundOf = (el: Element): Rgba => {
    let result: Rgba = [0, 0, 0, 0];
    for (let node: Element | null = el; node && result[3] < 1; node = node.parentElement) result = over(result, parse(getComputedStyle(node).backgroundColor));
    return result[3] < 1 ? over(result, [255, 255, 255, 1]) : result;
  };
  const luminance = ([r, g, b]: Rgba): number => {
    const lin = (v: number): number => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  };
  const probes: ContrastTestState['probes'] = [];
  const missing: string[] = [];
  for (const [name, selector] of Object.entries(CONTRAST_PROBES)) {
    const el = [...document.querySelectorAll(selector)].find((e) => (e as HTMLElement).offsetWidth > 0);
    if (!el) {
      missing.push(name);
      continue;
    }
    const background = backgroundOf(el);
    const color = over(parse(getComputedStyle(el).color), background);
    const [hi, lo] = [luminance(color), luminance(background)].sort((a, b) => b - a) as [number, number];
    probes.push({ name, color: `rgb(${color.slice(0, 3).map(Math.round).join(', ')})`, background: `rgb(${background.slice(0, 3).map(Math.round).join(', ')})`, ratio: Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100 });
  }
  return { highContrast: document.body.classList.contains('vscode-high-contrast') || document.body.classList.contains('vscode-high-contrast-light'), probes, missing };
}

/** What the app uses of a Code view, whichever engine it is made of (CodeMirror, Monaco, Monaco with VS Code's services). */
interface CodeViewApi {
  readonly element: HTMLElement;
  readonly text: string;
  readonly pending: boolean;
  readonly focused: boolean;
  readonly cursor: number;
  takeEdits(): { edits: TextEdit[]; base: string; text: string } | null;
  receive(text: string): void;
  reset(text: string): void;
  setBlocks(blocks: Parameters<CodeMirrorView['setBlocks']>[0], text: string): void;
  setEditable(editable: boolean): void;
  reveal(offset: number, block?: { from: number; to: number }): void;
  mark(block: { from: number; to: number }): void;
  focus(): void;
  press(key: string): boolean;
  refresh(): void;
  insertAt(offset: number, text: string): void;
  topOffset(): number;
  scrollToOffset(offset: number): void;
  setEditorOptions?(options: Record<string, unknown>): void;
  setTheme?(theme: CodeTheme | null): void;
}

/** Whether a recipe shows the Code view (Code, Split). */
function showsCode(recipe: ViewRecipe): boolean {
  return recipe.show === 'code' || recipe.show === 'both';
}

/** A ProseMirror node (the type preset-pagemd's pageMarkerOf takes; the app has no prosemirror-model of its own). */
type PMNode = Parameters<typeof pageMarkerOf>[0];

/** Page geometry for the pagination, from the document's styles (or style-default's page). */
function pageSetup(styles: ResolvedStyles): { page: ResolvedStyles['page']; namedPages?: Record<string, ResolvedStyles['page']>; strings?: Record<string, string> } {
  return { page: styles.page, ...(styles.namedPages ? { namedPages: styles.namedPages } : {}), ...(styles.strings ? { strings: styles.strings } : {}) };
}

/** The document's own layout file (`.pagemd/layouts/<doc>.css`, R-129, R-143), as opposed to a shared or bundled one. */
function isOwnLayout(layout: ResolvedStyles['layout'], fileName: string): boolean {
  return !!layout && !layout.bundled && layout.path.replace(/\\/g, '/').endsWith(`/.pagemd/layouts/${layoutFileName(fileName)}`);
}

/** `a.md` → `a.css` */
const layoutFileName = (fileName: string): string => `${fileName.replace(/\.[^.]*$/, '')}.css`;

/** The frontmatter block's text ('' for none), as preset-pagemd recognises it (P8: the one rule, `frontmatterBlock`). */
function frontmatterText(text: string): string {
  const block = frontmatterBlock(text);
  return block ? text.slice(0, block.end) : '';
}

/** VS Code's save shortcut: Ctrl/Cmd+S. Undo/redo (Ctrl/Cmd+Z, Ctrl+Y, Ctrl/Cmd+Shift+Z) go through
 *  plugin-history's keymap instead (R-94), which flushes the same way. */
function isSaveKey(event: KeyboardEvent): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 's';
}

/** The page layout: the canvas scrolls, the status bar stays at the bottom. Editor UI, so VS Code's variables. */
const APP_CSS = `
html, body { height: 100%; margin: 0; padding: 0; background: var(--vscode-editor-background); }
.pmd-app { display: flex; flex-direction: column; height: 100%; }
.pmd-scroll { flex: 1; overflow: auto; }
.pmd-split-canvas { position: relative; }
.pmd-error { margin: 16px; white-space: pre-wrap; color: var(--vscode-errorForeground); }
`;

function addStyle(css: string): HTMLStyleElement {
  const style = document.createElement('style');
  style.nonce = nonce;
  style.setAttribute('nonce', nonce);
  style.textContent = css;
  document.head.append(style);
  return style;
}

/** `notes` as plain status-bar text, minus "using-default-layout" (already shown from `styles.usingDefault`). */
function notesFor(notes: readonly StyleNote[]): string[] {
  return notes.filter((n) => n.kind !== 'using-default-layout').map((n) => n.message);
}

/** Adds (or refreshes) a `?v=` query so the browser re-fetches the resource the relative `src` resolves to via
 *  `<base href>` (C9, amendment 11); any earlier `?v=…` is replaced rather than piling up. */
function cacheBust(src: string): string {
  const stripped = src.replace(/([?&])v=\d+(?=&|$)/, '$1').replace(/[?&]$/, '');
  return `${stripped}${stripped.includes('?') ? '&' : '?'}v=${Date.now()}`;
}

function fail(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error('pagemd Editor:', error);
  const box = document.createElement('pre');
  box.className = 'pmd-error';
  box.textContent = `pagemd Editor could not open this document.\n\n${message}`;
  document.body.append(box);
  document.body.dataset['pmdWebview'] = 'error';
}

/**
 * Test-only (FIX-PGF, item 3): counts full rebuilds (setDocument), patches (patchDocument), pagination runs, the paper layer taken
 * out, and samples every frame until stopped: the sheets and gaps on the canvas.
 */
function startTrace(canvas: Canvas, pagination: Pagination): { stop(): TraceTestState } {
  const element = canvas.element;
  const count = () => ({ papers: element.querySelectorAll(':scope > .pmd-pages > .pmd-page').length, gaps: element.querySelectorAll('.pmd-page-gap').length });
  const before = count();
  const m = { rebuilds: 0, patches: 0, runs: 0, runMs: [] as number[], layerRemovals: 0 };
  const frames: { t: number; papers: number; gaps: number; layer: boolean; scroll: number }[] = [];
  const scroller = element.closest('.pmd-scroll') as HTMLElement | null;
  const scroll0 = scroller?.scrollTop ?? 0;
  const target = canvas as unknown as Record<string, (...args: unknown[]) => unknown>;
  const wrap = (name: string, counter: 'rebuilds' | 'patches') => {
    const original = target[name]!;
    target[name] = (...args: unknown[]) => {
      m[counter]++;
      return original.apply(canvas, args);
    };
    return () => (target[name] = original);
  };
  const undo = [wrap('setDocument', 'rebuilds'), ...(typeof target['patchDocument'] === 'function' ? [wrap('patchDocument', 'patches')] : [])];
  const run = pagination.run;
  pagination.run = (options) => {
    const t = performance.now();
    const layout = run.call(pagination, options);
    m.runs++;
    m.runMs.push(Math.round(performance.now() - t));
    return layout;
  };
  const observer = new MutationObserver((records) => {
    for (const r of records) for (const n of r.removedNodes) if (n instanceof HTMLElement && n.classList.contains('pmd-pages')) m.layerRemovals++;
  });
  observer.observe(element, { childList: true });
  const t0 = performance.now();
  let stopped = false;
  const frame = () => {
    if (stopped) return;
    frames.push({ t: Math.round(performance.now() - t0), ...count(), layer: !!element.querySelector(':scope > .pmd-pages'), scroll: scroller?.scrollTop ?? 0 });
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  return {
    stop: () => {
      stopped = true;
      observer.disconnect();
      undo.forEach((u) => u());
      pagination.run = run;
      const after = count();
      const bad = frames.filter((f) => !f.layer || f.papers < before.papers - 1 || f.gaps < before.gaps - 1);
      const back = frames.findIndex((f, i) => frames.slice(i).every((g) => g.papers === after.papers && g.gaps === after.gaps));
      const steps = frames.slice(1).map((f, i) => f.t - frames[i]!.t);
      const scrollMovedPx = Math.round(Math.max(0, ...frames.map((f) => Math.abs(f.scroll - scroll0))));
      return { ...m, frames: frames.length, framesWithoutPages: bad.length, pagesBackAtMs: back >= 0 ? frames[back]!.t : null, longestFrameGapMs: steps.length ? Math.max(...steps) : 0, scrollMovedPx, before, after };
    },
  };
}

/** Test-only (test:preview): the preview's pictures, loaded or not (a picture whose address is wrong never loads). */
function imagesOf(doc: Document | null): { total: number; loaded: number; broken: string[] } {
  const images = [...(doc?.querySelectorAll('img') ?? [])];
  const broken = images.filter((img) => !(img.complete && img.naturalWidth > 0));
  return { total: images.length, loaded: images.length - broken.length, broken: broken.slice(0, 5).map((img) => img.getAttribute('src') ?? '') };
}
