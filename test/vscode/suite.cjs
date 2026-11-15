// Runs INSIDE the VS Code test host (loaded by @vscode/test-electron). A rejected promise = failure.
// Plain CommonJS on purpose: VS Code loads this file directly, without a build step.
// P2: the real round trip. A throwaway git repo in a temp folder; each file is opened in the custom editor,
// "typed" into through the test-only message (R-89, PMD_TEST=1 set by run.mjs), saved by VS Code, and
// checked with `git diff`.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');

const EXTENSION_ID = 'gh4.pagemd-editor';
const VIEW_TYPE = 'pagemd-editor.editor';

/**
 * Top-level blocks: 0 heading · 1 wrapped paragraph · 2 list · 3 list with another marker · 4 fence · 5 paragraph ·
 * 6 numbered list. A fresh rewrite would pad block 6 as `9.  nine`, so only reused original text keeps it as is.
 */
const DOC = ['# Guide', '', 'Intro paragraph that', 'wraps over two lines.', '', '- one', '- two', '', '+ other marker', '', '```js', 'const x  =  1;', '```', '', 'Final paragraph.', '', '9. nine', '10. ten', ''].join('\n');

/**
 * P4: a pagemd document. Top-level blocks: 0 heading · 1 TOC · 2 callout · 3 paragraph · 4 table with a `{…}` line ·
 * 5 page break · 6 box.
 */
const PAGEMD_DOC = [
  '# Pagemd', '', '<!-- ::TOC levels=\'2\' -->', '', '[[WARNING]]', 'Check the valve.', '[[/WARNING]]', '', 'Paragraph to edit.', '',
  '| A  | B |', '|:---|--:|', '| 1  | 2 |', '{.grid}', '', '<!-- ::PAGEBREAK -->', '', ':::note Title', 'Boxed.', ':::', '',
].join('\n');
/** pagemd's own corpus, read in place (R-75): the SOP the P4 plan names. */
const SOP = path.join(__dirname, '..', '..', '..', 'pagemd', 'tests', 'corpus', 'pagemd-examples', 'examples', 'corporate-sop-uofo', 'uofo-field-safety-sop.md');

/** Budgets of step 19 (ms): 3 x the dearest run under 16 busy loops (open 1.07 s, symbols 0.41 s); normal runs take 0.15-0.23 s and 0.15-0.19 s. AD-P13-19. */
const BUDGET = { openMs: 3000, symbolsMs: 1500 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(check, what, ms = 10000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (await check()) return;
  throw new Error(`Timed out waiting for: ${what}`);
}

/** `until`, for something VS Code's file watcher has to notice: `nudge()` runs at once and again every 2 s (a fresh write of the same file). */
async function untilNudged(check, what, nudge, ms = 30000) {
  nudge();
  let again = Date.now() + 2000;
  await until(async () => {
    if (Date.now() > again) {
      nudge();
      again = Date.now() + 2000;
    }
    return check();
  }, what, ms);
}

exports.run = async function run() {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `extension ${EXTENSION_ID} is not loaded`);
  const info = await extension.activate();
  assert.equal(extension.isActive, true, 'extension did not become active');
  assert.equal(info.viewType, VIEW_TYPE);
  assert.ok(info.test, 'test handles missing: PMD_TEST=1 not passed to the extension host');
  const { test } = info;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmd-p2-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'P2 test');
  git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(dir, 'doc.md'), DOC);
  fs.writeFileSync(path.join(dir, 'crlf.md'), DOC.replace(/\n/g, '\r\n'));
  fs.writeFileSync(path.join(dir, 'mixed.md'), '# Mixed\r\n\r\nCRLF paragraph.\r\n\nLF paragraph.\n\nLast.\n');
  fs.writeFileSync(path.join(dir, 'pagemd.md'), PAGEMD_DOC);
  fs.copyFileSync(SOP, path.join(dir, 'sop.md'));
  git('add', '.');
  git('commit', '-q', '-m', 'start');

  const diffLines = (file) => git('diff', '-U0', '--', file).split('\n');
  const hunks = (file) => diffLines(file).filter((l) => l.startsWith('@@'));
  const changed = (file) => diffLines(file).filter((l) => /^[-+](?![-+]{2} )/.test(l));

  async function open(file) {
    const uri = vscode.Uri.file(path.join(dir, file));
    await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
    await test.whenReady(uri.toString());
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    assert.ok(doc, `${file}: no text document behind the custom editor`);
    return { uri: uri.toString(), doc, type: (text, block) => test.type(uri.toString(), text, block) };
  }

  // 1. Edit → save → git diff shows only the edited block; the dirty mark comes from VS Code.
  const d = await open('doc.md');
  assert.equal(d.doc.isDirty, false, 'dirty right after opening');
  await d.type(' EDITED', 2);
  await until(() => d.doc.isDirty, 'VS Code marks the file dirty after typing');
  assert.ok(await d.doc.save(), 'save failed');
  assert.deepEqual(hunks('doc.md').length, 1, `expected one hunk:\n${git('diff', '--', 'doc.md')}`);
  assert.deepEqual(changed('doc.md'), ['-- two', '+- two EDITED']);
  git('commit', '-q', '-am', 'edit 1');

  // 2. Save straight after more typing (inside the 300 ms pause) on a dirty file: the save waits for it.
  //    (A save on a file VS Code doesn't yet know is dirty goes through the webview's Ctrl+S: test/e2e.)
  await d.type(' SLOW', 5);
  await until(() => d.doc.isDirty, 'dirty before the fast save');
  await d.type(' FAST', 5);
  assert.ok(await d.doc.save(), 'save failed');
  assert.deepEqual(changed('doc.md'), ['-Final paragraph.', '+Final paragraph. SLOW FAST'], 'the last keystrokes before save were lost');
  git('commit', '-q', '-am', 'edit 2');

  // 3. VS Code owns undo: undo puts the text back and clears the dirty mark; the webview re-reads it, so the
  //    next edit is still minimal.
  const saved = d.doc.getText();
  await d.type(' UNDO ME', 0);
  await until(() => d.doc.isDirty, 'dirty before undo');
  await vscode.commands.executeCommand('undo');
  await until(() => d.doc.getText() === saved && !d.doc.isDirty, 'undo restores the saved text and clears the dirty mark');
  await d.type(' AFTER UNDO', 1);
  await until(() => d.doc.isDirty, 'dirty after the next edit');
  assert.ok(await d.doc.save());
  assert.deepEqual(changed('doc.md'), ['-wraps over two lines.', '+wraps over two lines. AFTER UNDO'], `after undo:\n${git('diff', '--', 'doc.md')}`);
  git('commit', '-q', '-am', 'edit 3');

  // 4. An outside change (git checkout of an older version) reaches the canvas; the next edit applies on top.
  // Flake fix: under CPU load VS Code's file watcher can lag or drop the one event for this write (the temp dir is on the
  // Linux disk, so the slow /mnt/c theory was wrong; reproduced with 16 busy loops, 1 run in 3). So: let the save's own
  // events settle first, and if the document has not reloaded in 2 s, write the same bytes again (a fresh real outside
  // change on disk, the same path under test; VS Code itself still has to notice it and reload).
  await sleep(500);
  git('checkout', 'HEAD~2', '--', 'doc.md');
  const docPath = path.join(dir, 'doc.md');
  const checkedOut = fs.readFileSync(docPath, 'utf8');
  // P13 (AD-P13-08): the nudge was not always enough (1 run in 10 timed out after 30 s of nudges: the watcher never delivered). After two
  // nudges, ask VS Code to re-read the file itself (File > Revert File): the path under test, VS Code's text change reaching
  // the canvas, is the same; only the file-watcher's notice is replaced by VS Code's own re-read.
  let nudgeAt = Date.now() + 2000;
  let nudges = 0;
  await until(async () => {
    if (d.doc.getText() !== checkedOut && Date.now() > nudgeAt) {
      if (nudges < 2) fs.writeFileSync(docPath, checkedOut);
      else await vscode.commands.executeCommand('workbench.action.files.revert');
      nudges++;
      nudgeAt = Date.now() + 2000;
    }
    return d.doc.getText() === checkedOut;
  }, 'VS Code reloads the checked-out file', 30000);
  await sleep(200); // the externalChange message reaches the webview
  await d.type(' ON TOP', 0);
  await until(() => d.doc.isDirty, 'dirty after editing the checked-out text');
  assert.ok(await d.doc.save());
  const onTop = fs.readFileSync(path.join(dir, 'doc.md'), 'utf8');
  assert.equal(onTop, checkedOut.replace('# Guide', '# Guide ON TOP'), 'the edit did not apply cleanly on top of the checked-out text');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');

  // 5. A CRLF file keeps CRLF in the edited block, one hunk.
  const c = await open('crlf.md');
  await c.type(' CRLF', 1);
  await until(() => c.doc.isDirty, 'crlf.md dirty');
  assert.ok(await c.doc.save());
  assert.equal(hunks('crlf.md').length, 1, git('diff', '--', 'crlf.md'));
  assert.ok(fs.readFileSync(path.join(dir, 'crlf.md'), 'utf8').includes('wraps over two lines. CRLF\r\n'), 'CRLF lost in the edited block');
  assert.ok(!/[^\r]\n/.test(fs.readFileSync(path.join(dir, 'crlf.md'), 'utf8')), 'a bare LF appeared in a CRLF file');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');

  // 6. Mixed line endings (R-87 amendment 12): record what VS Code does; no workaround without asking.
  const m = await open('mixed.md');
  const onDisk = fs.readFileSync(path.join(dir, 'mixed.md'), 'utf8');
  const normalizedOnOpen = m.doc.getText() !== onDisk;
  await m.type(' EDIT', 3);
  await until(() => m.doc.isDirty, 'mixed.md dirty');
  assert.ok(await m.doc.save());
  const mixedHunks = hunks('mixed.md').length;
  console.log(`[P2 finding] mixed line endings: VS Code normalized the text on open: ${normalizedOnOpen}; hunks after a one-block edit: ${mixedHunks}`);
  console.log(`[P2 finding] mixed.md after save: ${JSON.stringify(fs.readFileSync(path.join(dir, 'mixed.md'), 'utf8'))}`);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');

  // 7. P4: a pagemd document. Opening changes nothing (the SOP from pagemd's corpus: no edit sent, not dirty);
  //    an edit next to pagemd items (TOC, callout, table with `{…}`, page break, box) changes only its block, and
  //    one inside the callout changes only the callout's lines.
  const sop = await open('sop.md');
  await sleep(800);
  assert.equal(sop.doc.isDirty, false, 'opening the SOP made it dirty');
  assert.equal(git('diff', '--', 'sop.md'), '', 'opening the SOP changed it');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');

  const p = await open('pagemd.md');
  await p.type(' EDITED', 3);
  await until(() => p.doc.isDirty, 'pagemd.md dirty');
  assert.ok(await p.doc.save());
  assert.deepEqual(changed('pagemd.md'), ['-Paragraph to edit.', '+Paragraph to edit. EDITED'], git('diff', '--', 'pagemd.md'));
  git('commit', '-q', '-am', 'pagemd edit 1');
  await p.type(' now', 2);
  await until(() => p.doc.isDirty, 'pagemd.md dirty again');
  assert.ok(await p.doc.save());
  assert.equal(hunks('pagemd.md').length, 1, git('diff', '--', 'pagemd.md'));
  assert.deepEqual(changed('pagemd.md'), ['-Check the valve.', '+Check the valve. now'], git('diff', '--', 'pagemd.md'));
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  console.log('[P4 test] pagemd document: open unchanged (SOP), one-block edits next to and inside pagemd items: passed');

  // 8. P5 (amendment 11): a changed image file on disk makes the canvas reload it, with a `?v=` cache-busting
  //    suffix on the src — the plan flagged whether webview resource URIs accept that suffix as unverified.
  const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  fs.writeFileSync(path.join(dir, 'photo.png'), PNG_1X1);
  fs.writeFileSync(path.join(dir, 'image.md'), '# Image\n\n![photo](photo.png)\n');
  git('add', '.');
  git('commit', '-q', '-m', 'image doc');
  const im = await open('image.md');
  await until(async () => {
    const state = await test.imageState(im.uri, 'photo');
    return Boolean(state && state.complete && state.naturalWidth > 0);
  }, 'the image loads at all');
  const before = await test.imageState(im.uri, 'photo');
  // P13 flake fix (found under CPU load, 1 run in 3): the watcher can deliver the event of the file written before the editor opened
  // late, so the src may already carry a ?v= suffix here. The src must still be the document text plus at most that suffix; what the
  // test proves is that the NEXT change gives a different suffix.
  assert.equal(before.src.replace(/\?v=\d+$/, ''), 'photo.png', 'the src is the document text (at most with a ?v= suffix) before the refresh under test');
  await sleep(300); // past the watcher's own debounce, so the coming write is seen as its own change
  fs.writeFileSync(path.join(dir, 'photo.png'), PNG_1X1); // a real file-system change (mtime, at least)
  let writeAgain = Date.now() + 2000; // same watcher lag under load as step 4: write again if it has not been seen
  const reloaded = (state) => Boolean(state && /\?v=\d+$/.test(state.src) && state.src !== before.src);
  // P13: once in about 35 runs the watcher of a VS Code instance never delivered at all (step 4 then needed its Revert). If no refresh
  // arrives within 10 s, the document is closed and opened again (new watchers are registered, as a user reopening the file would), once.
  const giveUp = Date.now() + 10000;
  let reopened = false;
  await until(async () => {
    if (!reopened && Date.now() > giveUp) {
      reopened = true;
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await open('image.md');
      return false;
    }
    const state = await test.imageState(im.uri, 'photo');
    if (!reloaded(state) && Date.now() > writeAgain) {
      fs.writeFileSync(path.join(dir, 'photo.png'), PNG_1X1);
      writeAgain = Date.now() + 2000;
    }
    return reloaded(state);
  }, 'the canvas reloads the image with a new ?v= suffix (P5, amendment 11)', 30000);
  const after = await test.imageState(im.uri, 'photo');
  assert.ok(after.complete && after.naturalWidth > 0, 'the cache-busted src still loads: webview resource URIs accept a ?v= suffix');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  console.log('[P5 test] image refresh (?v= cache-busting on a webview resource URI): confirmed working');

  // 9. P6 (amendments 2, 4): documents open in Print Layout; the view commands are registered and switch the
  //    active editor's view; after a round trip through Read and Web Layout the canvas still saves a one-block edit.
  const commands = await vscode.commands.getCommands(true);
  for (const id of ['pagemd.printLayout', 'pagemd.webLayout', 'pagemd.draft', 'pagemd.read', 'pagemd.switchView']) assert.ok(commands.includes(id), `${id} is not registered`);
  const v = await open('doc.md');
  for (const id of ['pagemd.read', 'pagemd.webLayout', 'pagemd.draft', 'pagemd.printLayout']) {
    await vscode.commands.executeCommand(id);
    await sleep(150);
  }
  await vscode.commands.executeCommand('pagemd.switchView', 'read'); // given a mode, the picker is skipped
  await sleep(150);
  await vscode.commands.executeCommand('pagemd.switchView', 'print');
  await sleep(150);
  await v.type(' VIEWS', 5);
  await until(() => v.doc.isDirty, 'doc.md dirty after switching views');
  assert.ok(await v.doc.save());
  assert.deepEqual(changed('doc.md'), ['-Final paragraph.', '+Final paragraph. VIEWS'], git('diff', '--', 'doc.md'));
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  console.log('[P6 test] view commands (Print Layout, Web Layout, Draft, Read, Switch View) switch the active editor; an edit still saves after: passed');

  // 10. P7: the ribbon is drawn in the real webview, the setting is contributed with its default, and a gated insert
  //     with the setting on `auto` inserts the lettered list and adds `fancy_lists: true` to the frontmatter. Since P8
  //     (R-161, ending R-155's two steps) they are ONE undo step: a single undo takes both out (ADR-0016 M3).
  const settings = vscode.workspace.getConfiguration('pagemdEditor');
  assert.equal(settings.get('gatedInsert'), 'ask', 'pagemdEditor.gatedInsert is not contributed with the default "ask"');
  const GATE_DOC = 'Intro paragraph.\n';
  fs.writeFileSync(path.join(dir, 'gate.md'), GATE_DOC);
  git('add', '.');
  git('commit', '-q', '-m', 'gate doc');
  const g = await open('gate.md');
  const ribbon = await test.ribbon(g.uri);
  assert.deepEqual(ribbon.tabs, ['Home', 'Insert', 'Table', 'Layout', 'Document', 'Review', 'View'], 'the ribbon tabs (P20: no Image tab without a picture selected)');
  assert.equal(ribbon.selected, 'Home');
  assert.ok(ribbon.buttons > 10, `the Home tab drew ${ribbon.buttons} buttons`);
  await settings.update('gatedInsert', 'auto', vscode.ConfigurationTarget.Global);
  await sleep(300); // the settingsChanged event reaches the webview
  assert.equal(await test.runAction(g.uri, 'fancy-lists.lower-alpha'), true, 'no such action');
  await until(() => /fancy_lists: true/.test(g.doc.getText()) && /^a\.\s+Intro paragraph\./m.test(g.doc.getText()), 'the list and the property reach the document', 15000);
  assert.ok(g.doc.getText().startsWith('---\nfancy_lists: true\n---\n'), `the frontmatter: ${JSON.stringify(g.doc.getText())}`);
  await vscode.commands.executeCommand('undo');
  await until(() => g.doc.getText() === GATE_DOC, 'ONE undo takes the property and the list out together (P8, R-161)', 8000);
  await vscode.commands.executeCommand('redo');
  await until(() => /fancy_lists: true/.test(g.doc.getText()) && /^a\.\s+Intro paragraph\./m.test(g.doc.getText()), 'one redo brings both back');
  await vscode.commands.executeCommand('undo');
  await until(() => g.doc.getText() === GATE_DOC, 'and one undo takes both out again');
  await settings.update('gatedInsert', undefined, vscode.ConfigurationTarget.Global);
  // R-157 / R-158: no shortcut of ours may be one of VS Code's own default keybindings (the workbench also sees keys pressed in
  // a webview), EXCEPT the Word-style keys the user chose to win while the cursor is in the document (R-158): each is listed
  // here with the VS Code command it shadows. A clash that is not on this list fails. VS Code writes its defaults into a document
  // on request; ours are converted from ProseMirror notation ("Mod" is Ctrl here, Cmd on a Mac); modifier order doesn't matter.
  const DELIBERATE = {
    'Mod-b': 'workbench.action.toggleSidebarVisibility',
    'Mod-i': 'inlineChat.start',
    'Mod-e': 'workbench.action.quickOpen',
    'Mod-k': 'ctrl+k chords', // the chord prefix: every default `ctrl+k …` binding
    'Mod-Shift-x': 'workbench.view.extensions',
    'Mod-Shift-.': 'breadcrumbs.focusAndSelect',
    'Mod-Alt-c': 'copyFilePath',
    // P11 (R-175): Find and Replace on the canvas, while the cursor is in it (Code view and Print Preview keep VS Code's own find).
    'Mod-f': 'actions.find',
    'Mod-h': 'editor.action.startFindReplaceAction',
  };
  await vscode.commands.executeCommand('workbench.action.openDefaultKeybindingsFile');
  await until(() => vscode.window.activeTextEditor && /"key":/.test(vscode.window.activeTextEditor.document.getText()), 'the default keybindings file opens', 15000);
  const text = vscode.window.activeTextEditor.document.getText();
  const defaults = [...text.matchAll(/"key":\s*"([^"]+)"/g)].map((m) => m[1].toLowerCase());
  const commandsOf = [...text.matchAll(/"key":\s*"([^"]+)",\s*"command":\s*"([^"]+)"/g)].map((m) => [m[1].toLowerCase(), m[2]]);
  assert.ok(defaults.length > 200, `only ${defaults.length} default keybindings were read`);
  const first = (key) => { const bits = key.split(' ')[0].split('+'); const k = bits.pop(); return [...bits.sort(), k].join('+'); };
  const ours = (binding) => first(binding.split(/-(?=.)/).map((p) => (p === 'Mod' ? 'ctrl' : p.toLowerCase())).join('+'));
  const clashing = new Set(ribbon.keybindings.filter((binding) => defaults.some((d) => first(d) === ours(binding))));
  const unlisted = [...clashing].filter((binding) => !(binding in DELIBERATE));
  assert.deepEqual(unlisted, [], 'shortcuts that clash with a VS Code default and are not on the deliberate list (R-158)');
  // The list stays honest: every listed override really shadows the VS Code command named, and is a shortcut we still have.
  for (const [binding, shadowed] of Object.entries(DELIBERATE)) {
    assert.ok(ribbon.keybindings.includes(binding), `${binding} is on the deliberate list but no command has it`);
    // (copyFilePath is ctrl+alt+c on Linux and shift+alt+c on Windows: there the key shadows another command, or none)
    const platformOnly = process.platform === 'win32' && shadowed === 'copyFilePath';
    const hit = platformOnly || (shadowed === 'ctrl+k chords' ? defaults.some((d) => d.startsWith('ctrl+k ')) : commandsOf.some(([k, c]) => first(k) === ours(binding) && c === shadowed));
    assert.ok(hit, `${binding} no longer shadows ${shadowed}: update the list (the defaults for that key: ${JSON.stringify(commandsOf.filter(([k]) => first(k) === ours(binding)).map(([, c]) => c))})`);
  }
  // P13b (R-208): F6 / Shift+F6 move between the editor's regions while the focus is in the editor; a handled key stops there (R-158's
  // rule) and past the last region it is left to VS Code. They are not commands in the registry, so they are listed and checked here.
  for (const [key, shadowed] of [['f6', 'workbench.action.focusNextPart'], ['shift+f6', 'workbench.action.focusPreviousPart']]) {
    assert.ok(commandsOf.some(([k, c]) => k === key && c === shadowed), `${key} no longer is VS Code's ${shadowed}: the region key (R-208) shadows something else now`);
  }
  console.log(`[P7 test] ${ribbon.keybindings.length} shortcuts checked against ${defaults.length} VS Code default keybindings: ${Object.keys(DELIBERATE).length} deliberate overrides (R-158), no other clash`);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  console.log('[P7/P8 test] ribbon drawn in the real webview; gated insert (auto) adds the list and the property as ONE undo step: passed');

  // 11. P8: a property changed as the Document tab changes it reaches the file as one changed value (comments, key order
  //     and the author's nickname kept, ADR-0016 M4), and one undo takes it back.
  const PROPS_DOC = '---\n# The guide\ntitle: Old title  # keep\ndoc_id: X-1\n---\n\nBody.\n';
  fs.writeFileSync(path.join(dir, 'props.md'), PROPS_DOC);
  git('add', '.');
  git('commit', '-q', '-m', 'props doc');
  const pr = await open('props.md');
  assert.equal(await test.setProperty(pr.uri, 'document_id', 'X-2'), true, 'setProperty refused');
  await until(() => /doc_id: X-2/.test(pr.doc.getText()), 'the property edit reaches the document');
  await vscode.commands.executeCommand('undo');
  await until(() => pr.doc.getText() === PROPS_DOC && !pr.doc.isDirty, 'one undo takes the property edit back');
  await vscode.commands.executeCommand('redo');
  await until(() => /doc_id: X-2/.test(pr.doc.getText()), 'redo');
  assert.ok(await pr.doc.save());
  assert.deepEqual(changed('props.md'), ['-doc_id: X-1', '+doc_id: X-2'], git('diff', '--', 'props.md'));
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  console.log('[P8 test] a property edit is one changed line under the author\'s own key; one undo takes it back: passed');

  // 12. P9: VS Code's own Outline (the symbol provider), the Code view's typing (one change, one undo) and a section moved in
  //     the Outline (exactly those lines, one undo).
  const OUT_DOC = '---\ntitle: Moving guide\n---\n\n# Alpha\n\nAlpha text.\n\n<!-- ::FIGURE src="a.png" caption="Login" -->\n\n# Beta\n\nBeta text.\n';
  fs.writeFileSync(path.join(dir, 'outline.md'), OUT_DOC);
  git('add', '.');
  git('commit', '-q', '-m', 'outline doc');
  const o = await open('outline.md');
  const flat = (list) => (list || []).flatMap((s) => [s, ...flat(s.children)]);
  const symbols = flat(await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', vscode.Uri.parse(o.uri)));
  const names = symbols.map((s) => s.name);
  console.log(`[P9 finding] the document's symbols (every provider): ${JSON.stringify(names)}`);
  assert.ok(names.includes('Moving guide') && names.includes('Figure 1: Login'), `pagemd's items are missing: ${JSON.stringify(names)}`);
  for (const heading of ['Alpha', 'Beta']) assert.ok(names.filter((n) => n.replace(/^#+\s*/, '') === heading).length <= 1, `the heading ${heading} is listed twice: ${JSON.stringify(names)}`);
  console.log(`[P9 finding] headings come from VS Code's Markdown extension: ${names.some((n) => /Alpha/.test(n)) ? 'yes' : 'no'}`);
  console.log(`[P9 finding] VS Code's active text editor while the pagemd editor is active: ${vscode.window.activeTextEditor ? vscode.window.activeTextEditor.document.uri.toString() : 'none'}`);
  await vscode.commands.executeCommand('pagemd.code');
  await sleep(300);
  const end = OUT_DOC.indexOf('Beta text.') + 'Beta text.'.length;
  await test.codeType(o.uri, ' EDITED', end);
  await until(() => o.doc.getText() === OUT_DOC.replace('Beta text.', 'Beta text. EDITED'), 'the Code view typing reaches the document');
  await vscode.commands.executeCommand('undo');
  await until(() => o.doc.getText() === OUT_DOC && !o.doc.isDirty, 'one undo takes the Code view typing back');
  await vscode.commands.executeCommand('pagemd.printLayout');
  await sleep(300);
  assert.equal(await test.moveSection(o.uri, 'Beta', 'up'), true, 'Move up refused');
  const MOVED = '---\ntitle: Moving guide\n---\n\n# Beta\n\nBeta text.\n\n# Alpha\n\nAlpha text.\n\n<!-- ::FIGURE src="a.png" caption="Login" -->\n';
  await until(() => o.doc.getText() === MOVED, 'the moved section reaches the document');
  await vscode.commands.executeCommand('undo');
  await until(() => o.doc.getText() === OUT_DOC && !o.doc.isDirty, 'one undo takes the move back');
  await vscode.commands.executeCommand('redo');
  await until(() => o.doc.getText() === MOVED, 'redo');
  assert.ok(await o.doc.save());
  // git diff: only moved lines (each removed line is added back elsewhere), and the file is the moved text.
  const lines = changed('outline.md');
  const removed = lines.filter((l) => l.startsWith('-')).map((l) => l.slice(1)).sort();
  const added = lines.filter((l) => l.startsWith('+')).map((l) => l.slice(1)).sort();
  assert.ok(removed.length > 0 && JSON.stringify(removed) === JSON.stringify(added), git('diff', '--', 'outline.md'));
  assert.equal(fs.readFileSync(path.join(dir, 'outline.md'), 'utf8'), MOVED);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  console.log('[P9 test] native Outline (pagemd items, no doubled headings); Code view typing and a moved section are one change and one undo each: passed');

  // 13. P10: Print Preview is pagemd's own page in the real webview (the runtime file loaded in the extension host, Paged.js's
  //     pages, the diagram drawn, a script written in the document NOT run: the frame inherits the webview's CSP); diagrams are
  //     drawn on the canvas in Print Layout; Export writes the text VS Code has (unsaved typing included) as PDF, HTML and PNG;
  //     the profile picker writes `profile:` as one undo step.
  const EXPORT_DOC = '---\ntitle: Export guide\ndocument_id: EX-1\n---\n\n# Export\n\nFirst paragraph.\n\n```mermaid\ngraph LR\n  A --> B\n```\n\n<script>window.__pmdDocumentScript = true;</script>\n';
  fs.writeFileSync(path.join(dir, 'export.md'), EXPORT_DOC);
  git('add', '.');
  git('commit', '-q', '-m', 'export doc');
  const ex = await open('export.md');
  await until(async () => (await test.preview(ex.uri)).drawnOnCanvas === 1, 'the diagram is drawn on the canvas (Print Layout)', 20000);
  ex.type(' UNSAVED', 2); // block 0 is the frontmatter, 1 the heading
  await until(() => ex.doc.getText().includes('First paragraph. UNSAVED'), 'the typing reaches VS Code');
  await vscode.commands.executeCommand('pagemd.printPreview');
  let shown;
  await until(async () => {
    shown = await test.preview(ex.uri);
    return shown.visible && !shown.busy && shown.provider !== null;
  }, 'the Print Preview is rendered', 60000);
  console.log(`[P10 finding] Print Preview in VS Code ${vscode.version}: ${JSON.stringify(shown)}`);
  assert.equal(shown.provider, 'pagemd', `the preview fell back: ${shown.message}`);
  assert.ok(shown.pages >= 1, 'Paged.js made no pages');
  assert.equal(shown.diagrams, 1, 'the diagram was not drawn in the preview');
  assert.equal(shown.documentScriptRan, false, "the document's own script ran in the preview");
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pmd-p10-out-'));
  const pdf = await test.exportTo(ex.uri, 'pdf', path.join(out, 'export.pdf'));
  if (pdf.ok) {
    assert.ok(fs.statSync(path.join(out, 'export.pdf')).size > 1000, 'the PDF is empty');
    try {
      const text = execFileSync('pdftotext', [path.join(out, 'export.pdf'), '-'], { encoding: 'utf8' });
      assert.ok(text.includes('First paragraph. UNSAVED'), 'the PDF lacks the unsaved typing');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const png = await test.exportTo(ex.uri, 'png', path.join(out, 'export.png'));
    assert.ok(png.ok && fs.statSync(path.join(out, 'export.png')).size > 1000, `PNG export failed: ${png.message}`);
  } else {
    console.log(`[P10 finding] no browser for PDF/PNG on this machine: ${pdf.message}`);
  }
  const html = await test.exportTo(ex.uri, 'html', path.join(out, 'export.html'));
  assert.ok(html.ok, `HTML export failed: ${html.message}`);
  const written = fs.readFileSync(path.join(out, 'export.html'), 'utf8');
  assert.ok(written.includes('First paragraph. UNSAVED'), 'the HTML lacks the unsaved typing');
  if (pdf.ok) assert.ok(/<figure class="mermaid-diagram">\s*<svg/.test(written), 'the HTML export has no drawn diagram');
  assert.ok(ex.doc.isDirty, 'exporting must not save the document');
  assert.equal(fs.readFileSync(path.join(dir, 'export.md'), 'utf8'), EXPORT_DOC, 'exporting must not touch the file');
  fs.rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); // Windows keeps files locked a moment after VS Code's watchers close
  await vscode.commands.executeCommand('pagemd.printLayout');
  await sleep(300);
  const beforeProfile = ex.doc.getText();
  assert.equal(await test.chooseProfile(ex.uri, 'sop'), 'sop');
  await until(() => /\nprofile: sop\n/.test(ex.doc.getText()), 'the profile line reaches the document');
  await vscode.commands.executeCommand('undo');
  await until(() => ex.doc.getText() === beforeProfile, 'one undo takes the profile line back');
  await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  console.log('[P10 test] Print Preview (pagemd, Paged.js pages, diagram drawn, document script blocked); canvas diagram; PDF/PNG/HTML export of unsaved text; profile picker as one undo step: passed');


  // 14. P11: a pasted picture and a dropped one reach the real host: the file is written into the image folder (the default,
  //     then the one the setting names), a figure goes into the document as ONE edit that one undo takes back (the file stays:
  //     R-174); find and replace on the canvas, Replace all as one undo step; the setting that makes chosen files open in the
  //     pagemd editor, and the "Reopen with pagemd Editor" command.
  const PASTE_DOC = '# Paste guide\n\nFirst paragraph here.\n\nSecond paragraph here.\n';
  fs.writeFileSync(path.join(dir, 'paste.md'), PASTE_DOC);
  git('add', '.');
  git('commit', '-q', '-m', 'paste doc');
  const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
  // The figure is written as the one-line comment the steps below check; since R-254 the default is the readable `![alt](src)` style.
  await vscode.workspace.getConfiguration('pagemdEditor').update('figureStyle', 'native', vscode.ConfigurationTarget.Global);
  const pa = await open('paste.md');
  assert.equal(await test.paste(pa.uri, { name: 'image.png', type: 'image/png', bytes: PNG }), true, 'the canvas did not take the paste');
  await until(() => /<!-- ::FIGURE src="\.pagemd\/assets\/img\/image-\d{8}-\d{6}\.png" -->/.test(pa.doc.getText()), 'the pasted picture becomes a figure in the document', 15000);
  const pasted = fs.readdirSync(path.join(dir, '.pagemd', 'assets', 'img')).filter((f) => /^image-\d{8}-\d{6}\.png$/.test(f));
  assert.equal(pasted.length, 1, `the file in the image folder: ${pasted}`);
  assert.deepEqual([...fs.readFileSync(path.join(dir, '.pagemd', 'assets', 'img', pasted[0]))], [...PNG], 'the bytes written differ from the picture');
  assert.ok(pa.doc.getText().replace(/<!-- ::FIGURE[^>]*-->\n\n/, '') === PASTE_DOC, `only the figure was added:\n${pa.doc.getText()}`);
  await vscode.commands.executeCommand('undo');
  await until(() => pa.doc.getText() === PASTE_DOC && !pa.doc.isDirty, 'ONE undo takes the figure back');
  assert.ok(fs.existsSync(path.join(dir, '.pagemd', 'assets', 'img', pasted[0])), 'the file stays after undo (R-174)');
  await vscode.commands.executeCommand('redo');
  await until(() => /::FIGURE/.test(pa.doc.getText()), 'redo');
  await vscode.commands.executeCommand('undo');
  await until(() => pa.doc.getText() === PASTE_DOC, 'and undo again');
  // a dropped file keeps its own (cleaned) name; a name taken is never overwritten
  assert.equal(await test.paste(pa.uri, { name: 'Login screen.png', type: 'image/png', bytes: PNG }, { drop: true }), true);
  await until(() => /::FIGURE src="\.pagemd\/assets\/img\/Login-screen\.png"/.test(pa.doc.getText()), 'the dropped picture becomes a figure');
  await test.paste(pa.uri, { name: 'Login screen.png', type: 'image/png', bytes: PNG }, { drop: true });
  await until(() => /::FIGURE src="\.pagemd\/assets\/img\/Login-screen-1\.png"/.test(pa.doc.getText()), 'the same name again gets -1');
  assert.ok(fs.existsSync(path.join(dir, '.pagemd', 'assets', 'img', 'Login-screen.png')) && fs.existsSync(path.join(dir, '.pagemd', 'assets', 'img', 'Login-screen-1.png')));
  // the folder the setting names
  const config = vscode.workspace.getConfiguration('pagemdEditor');
  await config.update('imageFolder', 'media/shots', vscode.ConfigurationTarget.Global);
  await sleep(300);
  await test.paste(pa.uri, { name: 'chart.png', type: 'image/png', bytes: PNG });
  await until(() => /::FIGURE src="media\/shots\/chart\.png"/.test(pa.doc.getText()), 'the picture goes to the folder the setting names');
  assert.ok(fs.existsSync(path.join(dir, 'media', 'shots', 'chart.png')));
  await config.update('imageFolder', undefined, vscode.ConfigurationTarget.Global);
  await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  fs.rmSync(path.join(dir, '.pagemd'), { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); // Windows keeps files locked a moment after VS Code's watchers close
  fs.rmSync(path.join(dir, 'media'), { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); // Windows keeps files locked a moment after VS Code's watchers close
  console.log('[P11 test] a pasted and a dropped picture: file in the image folder (default and setting), one figure edit, one undo, never overwritten: passed');

  const fd = await open('paste.md');
  let bar = await test.find(fd.uri, { key: 'h' });
  assert.ok(bar.open && bar.replaceRow, 'Ctrl+H did not open the find bar with its replace row');
  bar = await test.find(fd.uri, { query: 'paragraph' });
  assert.equal(bar.matches, 2, `matches: ${JSON.stringify(bar)}`);
  bar = await test.find(fd.uri, { query: '#', replacement: 'x' });
  assert.equal(bar.matches, 0, 'markup characters are not text');
  await test.find(fd.uri, { query: 'paragraph', replacement: 'section' });
  await test.find(fd.uri, { do: 'replaceAll' });
  const REPLACED = PASTE_DOC.replace(/paragraph/g, 'section');
  await until(() => fd.doc.getText() === REPLACED, 'Replace all reaches the document');
  await vscode.commands.executeCommand('undo');
  await until(() => fd.doc.getText() === PASTE_DOC && !fd.doc.isDirty, 'ONE undo takes every replacement back');
  bar = await test.find(fd.uri, { do: 'close' });
  assert.equal(bar.open, false);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  console.log('[P11 test] find and replace on the canvas: Ctrl+H, visible text only, Replace all is one undo step: passed');

  // The files that open in the pagemd editor by themselves (R-176): the setting is copied into workbench.editorAssociations.
  const workbench = vscode.workspace.getConfiguration('workbench');
  const tabInput = () => vscode.window.tabGroups.activeTabGroup.activeTab && vscode.window.tabGroups.activeTabGroup.activeTab.input;
  fs.writeFileSync(path.join(dir, 'guide.pagemdtest.md'), '# Guide\n');
  fs.writeFileSync(path.join(dir, 'plain.md'), '# Plain\n');
  await config.update('openByDefault', ['*.pagemdtest.md'], vscode.ConfigurationTarget.Global);
  await until(() => (workbench.inspect('editorAssociations') || {}).globalValue && (workbench.inspect('editorAssociations').globalValue)['*.pagemdtest.md'] === VIEW_TYPE, 'the setting reaches workbench.editorAssociations');
  await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(dir, 'guide.pagemdtest.md')));
  await until(() => tabInput() instanceof vscode.TabInputCustom && tabInput().viewType === VIEW_TYPE, 'a listed file opens in the pagemd editor by itself', 15000);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(dir, 'plain.md')));
  await until(() => tabInput() instanceof vscode.TabInputText, 'a file not listed opens in the text editor as before');
  // "pagemd: Reopen with pagemd Editor": the active text tab becomes the pagemd editor
  await vscode.commands.executeCommand('pagemd.reopenWithEditor');
  await until(() => tabInput() instanceof vscode.TabInputCustom && tabInput().viewType === VIEW_TYPE, 'the command reopens the file in the pagemd editor', 15000);
  const textTabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputText && t.input.uri.path.endsWith('/plain.md'));
  assert.equal(textTabs.length, 0, 'the text editor tab for the file was left open');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  // emptied: our entry goes (and only ours)
  await workbench.update('editorAssociations', { ...((workbench.inspect('editorAssociations') || {}).globalValue), '*.mine.md': 'default' }, vscode.ConfigurationTarget.Global);
  await config.update('openByDefault', [], vscode.ConfigurationTarget.Global);
  await until(() => { const v = (vscode.workspace.getConfiguration('workbench').inspect('editorAssociations') || {}).globalValue || {}; return !('*.pagemdtest.md' in v); }, 'emptying the setting takes our entry out again');
  assert.equal((vscode.workspace.getConfiguration('workbench').inspect('editorAssociations').globalValue || {})['*.mine.md'], 'default', "the author's own association was touched");
  await workbench.update('editorAssociations', undefined, vscode.ConfigurationTarget.Global);
  await config.update('openByDefault', undefined, vscode.ConfigurationTarget.Global);
  await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(dir, 'guide.pagemdtest.md')));
  await until(() => tabInput() instanceof vscode.TabInputText, 'with the setting empty the same file opens as text again');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  console.log('[P11 test] openByDefault copies patterns into workbench.editorAssociations (only ours, removed again); a listed file opens in the pagemd editor; the Reopen command: passed');

  // 15. P12 (R-178–R-181): review comments in the real host. A new comment adds exactly ONE line to the document (the anchor,
  //     no blank line) and creates `.pagemd/comments/<doc>.json`; reply / resolve change only that file; the PDF (and the HTML) are
  //     the same with and without the anchor; one undo takes the anchor out and the thread is then listed as an orphan; a change
  //     to the side file on disk reaches the panel; a side file that is not JSON is never overwritten; Delete takes the thread
  //     and its anchor line away.
  {
  const COMMENT_DOC = '# Comment guide\n\nFirst paragraph here.\n\nSecond paragraph here.\n\nThird paragraph here.\n';
  fs.writeFileSync(path.join(dir, 'comments.md'), COMMENT_DOC);
  fs.writeFileSync(path.join(dir, 'comments-plain.md'), COMMENT_DOC);
  git('add', '.');
  git('commit', '-q', '-m', 'comment docs');
  const sidecarPath = path.join(dir, '.pagemd', 'comments', 'comments.json');
  const readSidecar = () => JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
  const cm = await open('comments.md');
  let cs = await test.comments(cm.uri, { do: 'open' });
  assert.equal(cs.open, true);
  assert.equal(cs.status, 'ready', `the side file was not ready: ${JSON.stringify(cs)}`);
  assert.equal(fs.existsSync(sidecarPath), false, 'looking at comments must not create the side file');
  cs = await test.comments(cm.uri, { do: 'new', text: 'Please check this.', block: 2 });
  await until(() => cm.doc.getText().includes('<!-- ::COMMENT id="c1" -->'), 'the anchor reaches the document');
  await until(() => fs.existsSync(sidecarPath) && readSidecar().threads.length === 1, 'the side file is written');
  assert.equal(cm.doc.getText(), COMMENT_DOC.replace('Second paragraph here.', '<!-- ::COMMENT id="c1" -->\nSecond paragraph here.'), 'the document changed by more than the anchor line');
  assert.ok(await cm.doc.save());
  assert.deepEqual(changed('comments.md'), ['+<!-- ::COMMENT id="c1" -->'], `the diff of a new comment:\n${git('diff', '--', 'comments.md')}`);
  assert.equal(hunks('comments.md').length, 1);
  const sc1 = readSidecar();
  assert.equal(sc1.version, 1);
  assert.equal(sc1.threads[0].id, 'c1');
  assert.equal(sc1.threads[0].quote, 'Second paragraph here.');
  assert.equal(sc1.threads[0].comments[0].text, 'Please check this.');
  assert.ok(sc1.threads[0].comments[0].author.length > 0, 'the comment has no author');
  assert.ok(fs.readFileSync(sidecarPath, 'utf8').endsWith('}\n') && fs.readFileSync(sidecarPath, 'utf8').includes('\n  "threads": ['), 'the side file is not two-space JSON with a final newline');
  git('add', '.');
  git('commit', '-q', '-m', 'comment 1');
  // reply and resolve change the side file only
  await test.comments(cm.uri, { do: 'reply', id: 'c1', text: 'A reply' });
  await until(() => readSidecar().threads[0].comments.length === 2, 'the reply is written');
  cs = await test.comments(cm.uri, { do: 'resolve', id: 'c1' });
  await until(() => readSidecar().threads[0].resolved === true, 'resolve is written');
  assert.equal(cm.doc.isDirty, false, 'reply and resolve must not touch the document');
  assert.deepEqual(changed('comments.md'), []);
  // the PDF and the HTML are the same with and without the anchor (pagemd prints the anchor as an HTML comment only)
  const plain = await open('comments-plain.md');
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmd-p12-out-'));
  const withHtml = await test.exportTo(cm.uri, 'html', path.join(outDir, 'with.html'));
  const withoutHtml = await test.exportTo(plain.uri, 'html', path.join(outDir, 'without.html'));
  assert.ok(withHtml.ok && withoutHtml.ok, `HTML export failed: ${withHtml.message} ${withoutHtml.message}`);
  const visible = (file) => fs.readFileSync(path.join(outDir, file), 'utf8').replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ');
  assert.equal(visible('with.html'), visible('without.html'), 'the anchor changed what the HTML shows');
  const pdfWith = await test.exportTo(cm.uri, 'pdf', path.join(outDir, 'with.pdf'));
  if (pdfWith.ok) {
    await test.exportTo(plain.uri, 'pdf', path.join(outDir, 'without.pdf'));
    const pageCount = (f) => (fs.readFileSync(path.join(outDir, f)).toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
    assert.equal(pageCount('with.pdf'), pageCount('without.pdf'), 'the anchor changed the number of PDF pages');
    try {
      const a = execFileSync('pdftotext', ['-layout', path.join(outDir, 'with.pdf'), '-'], { encoding: 'utf8' });
      const b = execFileSync('pdftotext', ['-layout', path.join(outDir, 'without.pdf'), '-'], { encoding: 'utf8' });
      assert.equal(a, b, 'the anchor changed the text of the PDF');
      assert.ok(!a.includes('COMMENT'), 'the anchor is visible in the PDF');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  } else {
    console.log(`[P12 finding] no browser for PDF on this machine, the HTML export was compared: ${pdfWith.message}`);
  }
  fs.rmSync(outDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); // Windows keeps files locked a moment after VS Code's watchers close
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  // one undo takes the anchor line out; the thread is then listed as an orphan (the side file is not part of VS Code's undo)
  const cm2 = await open('comments.md');
  await test.comments(cm2.uri, { do: 'new', text: 'Second one', block: 4 });
  await until(() => cm2.doc.getText().includes('id="c2"'), 'the second anchor reaches the document');
  await until(() => readSidecar().threads.length === 2, 'the second thread is written');
  assert.ok(cm2.doc.getText().includes('<!-- ::COMMENT id="c2" -->\nThird paragraph here.'));
  await vscode.commands.executeCommand('undo');
  await until(() => !cm2.doc.getText().includes('id="c2"') && !cm2.doc.isDirty, 'ONE undo takes the anchor line back');
  cs = await test.comments(cm2.uri, {});
  assert.deepEqual(cs.orphans, ['c2'], `the thread of the undone comment should be listed: ${JSON.stringify(cs)}`);
  assert.equal(readSidecar().threads.length, 2, 'undo must not edit the side file');
  // a change to the side file on disk (git checkout, another window) reaches the panel
  const onDisk = readSidecar();
  onDisk.threads.push({ id: 'c7', quote: 'from outside', resolved: false, created: '2026-10-05T10:00:00.000Z', comments: [{ author: 'Ann', created: '2026-10-05T10:00:00.000Z', text: 'Added by hand' }] });
  // P13 flake fix (AD-P13-08, found under CPU load, 2 runs in 3): the watcher can lose the one event, so the same bytes are written again
  // every 2 s (a fresh real change on disk; the host still has to notice it and the panel to read it).
  await untilNudged(async () => (await test.comments(cm2.uri, {})).orphans.includes('c7'), 'a change to the side file on disk reaches the panel', () => fs.writeFileSync(sidecarPath, JSON.stringify(onDisk, null, 2) + '\n'));
  // a delete takes the thread and its anchor line away
  cs = await test.comments(cm2.uri, { do: 'delete', id: 'c1' });
  await until(() => !cm2.doc.getText().includes('id="c1"'), 'Delete removes the anchor line');
  await until(() => !readSidecar().threads.some((t) => t.id === 'c1'), 'Delete removes the thread');
  assert.equal(cm2.doc.getText(), COMMENT_DOC, 'the document should be back to its first text');
  // a side file that is not JSON is never overwritten
  await untilNudged(async () => (await test.comments(cm2.uri, {})).status === 'unreadable', 'the broken side file is noticed', () => fs.writeFileSync(sidecarPath, 'this is not json'));
  try {
    await test.comments(cm2.uri, { do: 'new', text: 'Must not be saved', block: 1 });
  } catch {
    /* the pretend button press may find no box: that is the point */
  }
  await sleep(500);
  assert.equal(fs.readFileSync(sidecarPath, 'utf8'), 'this is not json', 'a side file that is not understood was overwritten');
  assert.equal(cm2.doc.getText(), COMMENT_DOC, 'a comment was added although the side file could not be used');
  await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  console.log('[P12 test] review comments: one anchor line in git diff, the side file written, reply/resolve touch only it, the HTML/PDF are the same with the anchor, undo leaves an orphan, outside change seen, Delete, a broken side file never overwritten: passed');
  }

  // 16. P14 (R-189): the profile's checks in the real host. A profile with a `validation` setting: the Problems panel lists its
  //     results (the missing property on the first line, the unknown directive on its own line) and the canvas marks the
  //     directive's block; fixing the property in the Document tab removes that problem once typing stops; the setting
  //     pagemdEditor.showProblems hides everything; "Check Document" answers the counts; a profile without the setting gives
  //     nothing; closing the editor clears the Problems panel. Checking never touches the document.
  {
  fs.mkdirSync(path.join(dir, 'profiles'), { recursive: true });
  const resources = { template: '${cliPath}/templates/standard_letter.html', layout: '${cliPath}/layouts/letter.css', css: ['${cliPath}/styles/primary.css'] };
  fs.writeFileSync(path.join(dir, 'profiles', 'checked.json'), JSON.stringify({ id: 'checked', resources, validation: { required_fields: ['title', 'owner'] } }, null, 2));
  fs.writeFileSync(path.join(dir, 'profiles', 'quiet.json'), JSON.stringify({ id: 'quiet', resources }, null, 2));
  const CHECKED = ['---', 'profile: ./profiles/checked.json', 'title: Checked', '---', '# Checked', '', 'Some text.', '', '<!-- ::BREAK -->', '', 'More text.', ''].join('\n');
  fs.writeFileSync(path.join(dir, 'checked.md'), CHECKED);
  fs.writeFileSync(path.join(dir, 'quiet.md'), CHECKED.replace('checked.json', 'quiet.json'));
  git('add', '.');
  git('commit', '-q', '-m', 'p14');
  const ck = await open('checked.md');
  const codes = () => test.problems(ck.uri).map((p) => `${p.code}@${p.line}`).sort();
  await until(() => codes().length === 2, 'the Problems panel lists the checks', 20000);
  assert.deepEqual(codes(), ['meta/missing-required-field@0', 'syntax/unknown-directive@8']);
  assert.equal(test.problems(ck.uri).find((p) => p.code === 'meta/missing-required-field').severity, 0, 'a missing property is an error');
  assert.equal(test.problems(ck.uri).find((p) => p.code === 'syntax/unknown-directive').severity, 1, 'an unknown directive is a warning');
  await until(async () => (await test.hints(ck.uri)).hints.length === 1, 'the canvas marks the directive');
  const hints = await test.hints(ck.uri);
  assert.deepEqual(hints.hints.map((h) => [h.block, h.severity]), [[3, 'warning']], JSON.stringify(hints));
  assert.equal(ck.doc.isDirty, false, 'checking must not change the document');
  // fixing the property (the Document tab's way) removes that problem once typing stops
  assert.equal(await test.setProperty(ck.uri, 'owner', 'Ann'), true);
  await until(() => /owner: .?Ann/.test(ck.doc.getText()), 'the property reaches the document').catch((error) => {
    throw new Error(`${error.message}; the document is now ${JSON.stringify(ck.doc.getText())}`);
  });
  await until(() => codes().join() === 'syntax/unknown-directive@9', 'the fixed problem goes (the directive moved down a line)', 20000);
  // the setting can only hide
  await vscode.workspace.getConfiguration('pagemdEditor').update('showProblems', false, vscode.ConfigurationTarget.Global);
  await until(async () => test.problems(ck.uri).length === 0 && (await test.hints(ck.uri)).hints.length === 0, 'showProblems off hides everything');
  let summary = await test.checkNow(ck.uri);
  assert.deepEqual(summary, { enabled: false, shown: false, errors: 0, warnings: 0, infos: 0 });
  await vscode.workspace.getConfiguration('pagemdEditor').update('showProblems', undefined, vscode.ConfigurationTarget.Global);
  await until(() => test.problems(ck.uri).length === 1, 'showProblems back on shows them again');
  summary = await test.checkNow(ck.uri);
  assert.deepEqual(summary, { enabled: true, shown: true, errors: 0, warnings: 1, infos: 0 });
  assert.ok(vscode.commands.getCommands && (await vscode.commands.getCommands(true)).includes('pagemd.checkDocument'), 'pagemd.checkDocument is not registered');
  // R-234: "pagemd: About this build" is registered, and a run from source is a dev build (no dist/build-info.json).
  assert.ok((await vscode.commands.getCommands(true)).includes('pagemd.about'), 'pagemd.about is not registered');
  assert.ok(!fs.existsSync(path.join(extension.extensionPath, 'dist', 'build-info.json')), 'a development run has a build-info.json: it should say dev build');
  await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await until(() => test.problems(ck.uri).length === 0, 'closing the editor clears its problems');
  // a profile without a validation setting: no checks at all
  const qt = await open('quiet.md');
  summary = await test.checkNow(qt.uri);
  assert.deepEqual(summary, { enabled: false, shown: true, errors: 0, warnings: 0, infos: 0 });
  assert.deepEqual(test.problems(qt.uri), []);
  assert.deepEqual(changed('quiet.md'), []);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  console.log('[P14 test] the profile\'s checks in the Problems panel and as a hint on the canvas; a fixed property drops its problem; showProblems only hides; Check Document; no validation setting = no checks; closing clears: passed');
  }

  // 17. P27 (ADR-0019, R-249, R-251; was P15's pixel edits): picture edits are keys in the markdown. Rotate right on a FIGURE is ONE edit
  //     (git diff: that line only, rotate="90"), one undo takes it back, and NO file is written (the image folder stays empty, the
  //     picture is untouched). Flip on an annotated image mirrors its marker in the same edit. A document with a redaction exports to
  //     HTML (and PDF when a browser is there) through pagemd's bake: the output holds no byte of the original picture and names no
  //     path to it (fail closed otherwise).
  {
    const WIDE = fs.readFileSync(path.join(__dirname, '..', 'e2e', 'fixtures', 'wide.png'));
    const PIC_DOC = '# Pictures\n\n<!-- ::FIGURE src="shots/wide.png" caption="Shot" -->\n\n::: annotated-image shots/wide.png\n# kept\nmarkers:\n  - { id: 1, x: 25, y: 50, label: "Left" }\n:::\n\nEnd.\n';
    fs.mkdirSync(path.join(dir, 'shots'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'shots', 'wide.png'), WIDE);
    fs.writeFileSync(path.join(dir, 'pictures.md'), PIC_DOC);
    git('add', '.');
    git('commit', '-q', '-m', 'pictures');
    const imageFolder = path.join(dir, '.pagemd', 'assets', 'img');
    const filesBefore = fs.existsSync(imageFolder) ? fs.readdirSync(imageFolder).sort() : [];
    const pc = await open('pictures.md');
    assert.equal(await test.selectNode(pc.uri, 'pmd_figure'), true, 'no figure to select');
    assert.equal(await test.runAction(pc.uri, 'image.rotate-right'), true, 'Rotate right is not on the ribbon');
    await until(() => pc.doc.getText().includes('<!-- ::FIGURE src="shots/wide.png" caption="Shot" rotate="90" -->'), 'the figure gets rotate="90"', 15000);
    await vscode.commands.executeCommand('workbench.action.files.save');
    await until(() => !pc.doc.isDirty, 'saved');
    assert.deepEqual(changed('pictures.md'), ['-<!-- ::FIGURE src="shots/wide.png" caption="Shot" -->', '+<!-- ::FIGURE src="shots/wide.png" caption="Shot" rotate="90" -->']);
    assert.equal(hunks('pictures.md').length, 1);
    assert.deepEqual(fs.existsSync(imageFolder) ? fs.readdirSync(imageFolder).sort() : [], filesBefore, 'a picture file was written');
    assert.deepEqual(fs.readFileSync(path.join(dir, 'shots', 'wide.png')), WIDE, 'the original picture was changed');
    await vscode.commands.executeCommand('undo');
    await until(() => pc.doc.getText() === PIC_DOC, 'ONE undo takes the edit back');
    // the annotated image: flipped, its marker mirrored in the same edit
    assert.equal(await test.selectNode(pc.uri, 'pmd_annotated_image'), true);
    assert.equal(await test.runAction(pc.uri, 'image.flip-horizontal'), true);
    await until(() => /flip: "?h"?/.test(pc.doc.getText()) && pc.doc.getText().includes('# kept\n') && pc.doc.getText().includes('  - { id: 1, x: 75, y: 50, label: "Left" }'), 'flip: "h" and the marker mirrored', 15000);
    await vscode.commands.executeCommand('undo');
    await until(() => pc.doc.getText() === PIC_DOC, 'ONE undo takes the flip back');
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    // redaction: exported through pagemd's bake; no byte of the original, no path to it
    const RED_DOC = '# Redacted\n\n::: annotated-image shots/wide.png\nredact:\n  - { x: 0, y: 0, width: 50, height: 100 }\n:::\n\nEnd.\n';
    fs.writeFileSync(path.join(dir, 'redacted.md'), RED_DOC);
    const rd = await open('redacted.md');
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pmd-p27-out-'));
    const html = await test.exportTo(rd.uri, 'html', path.join(out, 'redacted.html'));
    if (html.ok) {
      const written = fs.readFileSync(path.join(out, 'redacted.html'));
      const text = written.toString('utf8');
      assert.ok(!text.includes('shots/wide.png'), 'the HTML names the original picture');
      assert.ok(!text.includes(WIDE.toString('base64').slice(0, 200)), 'the HTML holds the original picture');
      assert.ok(written.indexOf(WIDE.subarray(16, 64)) < 0, "the HTML holds the original picture's bytes");
      assert.ok(/<img src="data:image\/png;base64,/.test(text), 'the HTML has no baked picture');
      assert.ok(!text.includes('Redacted picture not prepared'), 'the bake did not run');
      const pdf = await test.exportTo(rd.uri, 'pdf', path.join(out, 'redacted.pdf'));
      if (pdf.ok) assert.ok(!fs.readFileSync(path.join(out, 'redacted.pdf')).includes(WIDE.subarray(16, 64)), "the PDF holds the original picture's bytes");
      console.log(`[P27 test] redacted export: HTML baked (${written.length} bytes), PDF ${pdf.ok ? 'baked' : `not made: ${pdf.message}`}`);
    } else {
      // fail closed: no browser for the bake → an error and no file
      assert.ok(!fs.existsSync(path.join(out, 'redacted.html')), 'a failed export left a file');
      console.log(`[P27 finding] the bake could not run here (export refused, no file written): ${html.message}`);
    }
    fs.rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    console.log('[P27 test] Rotate and Flip in the real host: keys, ONE edit, one undo, no file written, shapes moved; a redacted document exports with no original bytes: passed');
  }

  // 18. P16 (R-198–R-202): table editing in the real host. With the cursor in a cell, "Add row below" (the Table tab's command) adds
  //     ONE row: the saved file differs from the committed one in that table's lines only (git diff: one hunk, the new row), and
  //     ONE undo takes it back (VS Code owns the undo). A column's alignment changes only the separator line.
  {
    const TBL = '# Tables\n\nBefore.\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nAfter.\n';
    fs.writeFileSync(path.join(dir, 'tables.md'), TBL);
    git('add', '.');
    git('commit', '-q', '-m', 'tables');
    const tb = await open('tables.md');
    assert.equal(await test.selectNode(tb.uri, 'table_cell', 0, true), true, 'no table cell to put the cursor in');
    assert.equal(await test.runAction(tb.uri, 'table.add-row-below'), true, 'Add row below is not on the ribbon');
    await until(() => tb.doc.getText() === TBL.replace('| 1 | 2 |\n', '| 1 | 2 |\n|  |  |\n'), 'the new row reaches the document', 15000).catch((error) => {
      throw new Error(`${error.message}; the document is now ${JSON.stringify(tb.doc.getText())}`);
    });
    await vscode.commands.executeCommand('workbench.action.files.save');
    await until(() => !tb.doc.isDirty, 'saved');
    assert.deepEqual(changed('tables.md'), ['+|  |  |']);
    assert.equal(hunks('tables.md').length, 1);
    await vscode.commands.executeCommand('undo');
    await until(() => tb.doc.getText() === TBL, 'ONE undo takes the row back');
    assert.equal(await test.selectNode(tb.uri, 'table_cell', 1, true), true);
    assert.equal(await test.runAction(tb.uri, 'table.align-center'), true, 'Align center is not on the ribbon');
    await until(() => tb.doc.getText() === TBL.replace('| --- | --- |', '| --- | :---: |'), 'the alignment reaches the separator line only', 15000);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    console.log('[P16 test] a table row added in the real host: one edit (git diff: that row), one undo; alignment changes only the separator line: passed');
  }

  // 19. P13 (acceptance 4): host-side times on a generated 100+ page document (run.mjs writes it from test/e2e/fixtures/large.ts): the
  //     time from "open with" to the webview having the document (`whenReady`), and the symbol provider's time on the same text (VS Code's
  //     Outline; it re-reads the text on every change). The budgets are 2 x the first measurement (Windows when there is one, else the
  //     slower of the machines measured), written here; the numbers are printed so a drift shows before a budget breaks.
  {
    const bigPath = process.env.PMD_LARGE_DOC;
    assert.ok(bigPath && fs.existsSync(bigPath), 'PMD_LARGE_DOC: test/vscode/run.mjs writes the large document and names it here');
    const big = vscode.Uri.file(bigPath);
    const opened = Date.now();
    await vscode.commands.executeCommand('vscode.openWith', big, VIEW_TYPE);
    await test.whenReady(big.toString());
    const openMs = Date.now() - opened;
    const timeSymbols = async () => {
      const started = Date.now();
      const symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', big);
      return { ms: Date.now() - started, count: symbols.length };
    };
    const first = await timeSymbols();
    const second = await timeSymbols();
    console.log(`[P13 timing] 100+ page document (${fs.statSync(bigPath).size} bytes): open to the webview's ready ${openMs} ms; symbol provider ${first.ms} ms first, ${second.ms} ms second (${second.count} symbols)`);
    assert.ok(second.count > 100, `the symbol provider listed ${second.count} symbols for a document with 120 sections`);
    assert.ok(openMs < BUDGET.openMs, `open to ready took ${openMs} ms, budget ${BUDGET.openMs} ms`);
    assert.ok(Math.max(first.ms, second.ms) < BUDGET.symbolsMs, `the symbol provider took ${Math.max(first.ms, second.ms)} ms, budget ${BUDGET.symbolsMs} ms`);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    console.log('[P13 test] host-side times on a 100+ page document are inside their budgets: passed');
  }

  // 20. P13b (amendment 8f): VS Code's high-contrast theme. The editor's own UI uses only `--vscode-*` colors, so the ribbon, the
  //     Inspector and the status bar follow the theme; the webview measures the contrast of each (WCAG: at least 4.5 to 1, the
  //     level AA wants for text) and a screenshot of the window is kept for the eye (test-results/vscode-high-contrast.png, taken through the
  //     window's own DevTools port that run.mjs opens; skipped, with the reason printed, where there is none).
  {
    const workbench = vscode.workspace.getConfiguration('workbench');
    const before = workbench.inspect('colorTheme')?.globalValue;
    fs.writeFileSync(path.join(dir, 'contrast.md'), '---\ntitle: High contrast\n---\n\n# High contrast\n\nSome text to look at.\n');
    git('add', '.');
    git('commit', '-q', '-m', 'contrast doc');
    const hc = await open('contrast.md');
    assert.equal(await test.runAction(hc.uri, 'view.inspector'), true, 'View > Inspector is not on the ribbon');
    await workbench.update('colorTheme', 'Default High Contrast', vscode.ConfigurationTarget.Global);
    let state;
    await until(async () => (state = await test.contrast(hc.uri)).highContrast && state.missing.length === 0, 'the page to be drawn in the high-contrast theme with the ribbon, the status bar and the Inspector', 20000).catch((error) => {
      throw new Error(`${error.message}; the page says ${JSON.stringify(state)}`);
    });
    const low = state.probes.filter((p) => p.ratio < 4.5);
    assert.deepEqual(low, [], `parts of the editor's UI under 4.5 : 1 in the high-contrast theme: ${JSON.stringify(state.probes)}`);
    // The screenshot: the workbench window through its own DevTools port (Page.captureScreenshot), where this run has one.
    try {
      const portFile = path.join(process.env.PMD_USER_DATA ?? '', 'DevToolsActivePort');
      assert.ok(fs.existsSync(portFile), 'no DevToolsActivePort file');
      const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const target = targets.find((t) => t.type === 'page' && /Visual Studio Code|Extension Development Host/.test(`${t.title} ${t.url}`)) ?? targets.find((t) => t.type === 'page');
      assert.ok(target, 'no window to take a screenshot of');
      const socket = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => ((socket.onopen = resolve), (socket.onerror = () => reject(new Error('DevTools socket'))))); 
      const png = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('screenshot timed out')), 20000);
        socket.onmessage = (event) => {
          const message = JSON.parse(String(event.data));
          if (message.id === 1) (clearTimeout(timer), message.error ? reject(new Error(message.error.message)) : resolve(Buffer.from(message.result.data, 'base64')));
        };
        socket.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } }));
      });
      socket.close();
      const shots = path.join(__dirname, '..', '..', 'test-results');
      fs.mkdirSync(shots, { recursive: true });
      const shot = path.join(shots, 'vscode-high-contrast.png');
      fs.writeFileSync(shot, png);
      assert.ok(png.length > 10000, 'the screenshot is empty');
      console.log(`[P13b screenshot] ${shot} (${png.length} bytes)`);
    } catch (error) {
      console.log(`[P13b screenshot] skipped: ${String(error.message).split('\n')[0]}`);
    }
    console.log(`[P13b contrast] high-contrast theme: ${state.probes.map((p) => `${p.name} ${p.ratio}`).join(', ')}`);
    await workbench.update('colorTheme', before, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    console.log('[P13b test] the ribbon, the Inspector and the status bar are readable (4.5 : 1 or better) in the high-contrast theme: passed');
  }

  /** Counts VS Code's own changes to `doc`'s text (each applied edit is one) until `dispose()`. */
  const countWrites = (doc) => {
    const counter = { writes: 0 };
    const sub = vscode.workspace.onDidChangeTextDocument((e) => e.document === doc && e.contentChanges.length > 0 && counter.writes++);
    counter.dispose = () => sub.dispose();
    return counter;
  };

  // 21. fix-sync-bugs (bug 7): a Windows (CRLF) file in the Code view and in Split. Backspace on the empty `>` line inside the callout
  //     (line 8) is ONE change to exactly that line, the Code view keeps the file's line endings, and the next key is one more
  //     change: nothing is written twice, nothing duplicated. (Before the fix the Code view read the file as '\n' lines, so its
  //     first edit rewrote the whole file and VS Code's own line endings then put every later edit in the wrong place.)
  {
    const CALLOUT = ['# Hello World', '', 'hello world', '', '> [!NOTE]', '>', '>   ', '>', '>   ', '', 'test test test', '', '> Note', '>', '> quote this', ''].join('\r\n');
    const lines = CALLOUT.split('\r\n');
    const lineEnd = (n) => lines.slice(0, n).reduce((at, l) => at + l.length + 2, 0) + lines[n].length; // end of 0-based line n
    const AFTER = [...lines.slice(0, 7), '', ...lines.slice(8)].join('\r\n');
    const AFTER_X = [...lines.slice(0, 7), 'x', ...lines.slice(8)].join('\r\n');
    fs.writeFileSync(path.join(dir, 'callout.md'), CALLOUT);
    git('add', '.');
    git('commit', '-q', '-m', 'callout doc');
    for (const command of ['pagemd.code', 'pagemd.split']) {
      const cl = await open('callout.md');
      assert.equal(cl.doc.eol, vscode.EndOfLine.CRLF, 'callout.md should open as a CRLF file');
      await vscode.commands.executeCommand(command);
      await sleep(400);
      const counter = countWrites(cl.doc);
      const shown = await test.keys(cl.uri, 'code', ['Backspace'], lineEnd(7));
      assert.equal(shown.codeText, AFTER, `${command}: the Code view lost the file's line endings`);
      await until(() => cl.doc.getText() === AFTER, `${command}: Backspace on line 8 reaches the document as exactly that change`);
      await sleep(1200); // two sync pauses: anything sent back would arrive now
      assert.equal(counter.writes, 1, `${command}: one Backspace made ${counter.writes} changes to the document`);
      assert.equal(cl.doc.getText(), AFTER, `${command}: the text changed again after the Backspace`);
      await test.keys(cl.uri, 'code', ['x']);
      await until(() => cl.doc.getText() === AFTER_X, `${command}: the next key reaches the document in the right place`);
      await sleep(1200);
      assert.equal(counter.writes, 2, `${command}: the next key made ${counter.writes - 1} changes`);
      assert.equal(cl.doc.getText(), AFTER_X, `${command}: the text changed again (duplicated) after the next key`);
      counter.dispose();
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
    console.log('[fix test] CRLF callout: Backspace on line 8 and the next key in Code and Split are one change each, line endings kept: passed');
  }

  // 22. fix-sync-bugs (bug 5): a blank file where VS Code keeps Windows line endings (files.eol \r\n, the Windows default). In Print
  //     Layout, Web Layout and Draft, "# hello world", Enter, "next line" gives a heading and a paragraph with the cursor in the
  //     paragraph, one change per pause. (Before the fix the canvas wrote '\n', VS Code made it '\r\n' and reported that as an outside
  //     change, and the canvas read the text again under the cursor: the empty paragraph went and the cursor was back in the title.)
  {
    const files = vscode.workspace.getConfiguration('files');
    const eolBefore = files.inspect('eol')?.globalValue;
    await files.update('eol', '\r\n', vscode.ConfigurationTarget.Global);
    try {
      for (const [command, name] of [['pagemd.printLayout', 'print'], ['pagemd.webLayout', 'web'], ['pagemd.draft', 'draft']]) {
        fs.writeFileSync(path.join(dir, `blank-${name}.md`), '');
        const b = await open(`blank-${name}.md`);
        assert.equal(b.doc.eol, vscode.EndOfLine.CRLF, `blank-${name}.md should open with CRLF (files.eol)`);
        await vscode.commands.executeCommand(command);
        await sleep(400);
        const counter = countWrites(b.doc);
        await test.keys(b.uri, 'canvas', [...'# hello world']);
        await until(() => b.doc.getText() === '# hello world', `${name}: the heading reaches the document`);
        await sleep(600);
        let state = await test.keys(b.uri, 'canvas', ['Enter']);
        assert.deepEqual(state.blocks, ['heading:hello world', 'paragraph:'], `${name}: Enter after the heading`);
        await sleep(1200); // the pause: Enter's empty paragraph is sent, and nothing may come back to reset the canvas
        state = await test.keys(b.uri, 'canvas', []);
        assert.equal(state.cursorBlock, 1, `${name}: the cursor went back into the heading after Enter (${JSON.stringify(state)})`);
        assert.deepEqual(state.blocks, ['heading:hello world', 'paragraph:'], `${name}: the canvas changed under the cursor after Enter`);
        state = await test.keys(b.uri, 'canvas', [...'next line']);
        await until(() => b.doc.getText() === '# hello world\r\n\r\nnext line', `${name}: the paragraph reaches the document with the file's line endings`);
        await sleep(1200);
        state = await test.keys(b.uri, 'canvas', []);
        assert.deepEqual(state.blocks, ['heading:hello world', 'paragraph:next line'], `${name}: blocks after typing`);
        assert.equal(state.cursorBlock, 1, `${name}: the cursor left the paragraph`);
        assert.equal(counter.writes, 3, `${name}: three pauses made ${counter.writes} changes to the document`);
        counter.dispose();
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      }
    } finally {
      await files.update('eol', eolBefore, vscode.ConfigurationTarget.Global);
    }
    console.log('[fix test] blank CRLF file: heading, Enter, paragraph in Print, Web and Draft; the cursor leaves the title; one change per pause: passed');
  }

  // 23. FIX-preview: Print Preview shows the document's pictures and draws its diagrams, in a project shaped like the user's (a folder
  //     with spaces in its path, the project's own profile.json, pictures in .pagemd/assets/img, a FIGURE, a plain picture with
  //     attributes and an annotated picture). Before the fix VS Code refused every file the preview frame asked for (the frame is a
  //     `srcdoc` page, which VS Code's webview can't tell apart from a stranger): no picture showed and no diagram was drawn.
  {
    const project = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pmd fix preview ')), 'My Docs', 'Delay Reporter');
    const img = path.join(project, '.pagemd', 'assets', 'img');
    fs.mkdirSync(img, { recursive: true });
    // A 4 x 3 PNG (opaque blue).
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAD0lEQVR4nGNgYPiPhHBxAN1JC/U39qNPAAAAAElFTkSuQmCC', 'base64');
    for (const name of ['login screen.png', 'menu.png', 'annotated.png']) fs.writeFileSync(path.join(img, name), png);
    fs.writeFileSync(path.join(project, 'profile.json'), JSON.stringify({ id: 'delay-report', extends: 'standard_letter' }, null, 2));
    const PICTURES_DOC = [
      '---', 'title: Pictures', 'pipeline_profile: profile.json', '---', '', '# Pictures', '',
      '<!-- ::FIGURE src="./.pagemd/assets/img/login screen.png" caption="Login page" id="fig-login" width="full" -->', '',
      'Click ![Menu](./.pagemd/assets/img/menu.png){style="width:15%"} to open it.', '',
      '::: annotated-image ./.pagemd/assets/img/annotated.png', '- { id: 1, x: 10, y: 15, label: "Main menu" }', ':::', '',
      '```mermaid', 'graph LR', '  A --> B', '```', '',
    ].join('\n');
    const file = path.join(project, 'pictures.md');
    fs.writeFileSync(file, PICTURES_DOC);
    const uri = vscode.Uri.file(file);
    await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
    await test.whenReady(uri.toString());
    await vscode.commands.executeCommand('pagemd.printPreview');
    let shown;
    await until(async () => {
      shown = await test.preview(uri.toString());
      return shown.visible && !shown.busy && shown.provider !== null && shown.images.total >= 3 && shown.images.loaded === shown.images.total && shown.drawnInPreview >= 1;
    }, 'the preview shows every picture and the drawn diagram', 60000).catch((error) => {
      throw new Error(`${error.message}; the preview: ${JSON.stringify(shown)}`);
    });
    console.log(`[FIX-preview finding] ${JSON.stringify(shown)}`);
    assert.equal(shown.provider, 'pagemd', `the preview fell back: ${shown.message}`);
    assert.equal(shown.message, null, `the preview reported: ${shown.message}`);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    console.log('[FIX-preview test] Print Preview in a folder with spaces shows the FIGURE, the plain and the annotated picture, and draws the diagram: passed');
  }

  // 24. P19: table column widths in the real host. "Equal widths" (the Table tab's Width group) adds the table's hidden
  //     `<!-- ::TABLE widths="equal" -->` comment (round 3) as ONE edit (git diff: that line), and ONE undo takes it back; "Wider" on a
  //     table without widths starts from the columns the canvas shows and writes every column's width, whole percentages adding up to
  //     100, in that one comment line.
  {
    const WD = '# Widths\n\nBefore.\n\n| Item | Notes |\n| --- | --- |\n| Bolts | Stainless, M8 |\n\nAfter.\n';
    fs.writeFileSync(path.join(dir, 'widths.md'), WD);
    git('add', '.');
    git('commit', '-q', '-m', 'widths');
    const wd = await open('widths.md');
    assert.equal(await test.selectNode(wd.uri, 'table_cell', 0, true), true, 'no table cell to put the cursor in');
    assert.equal(await test.runAction(wd.uri, 'table.equal-widths'), true, 'Equal widths is not on the ribbon');
    await until(() => wd.doc.getText() === WD.replace('| Bolts | Stainless, M8 |\n', '| Bolts | Stainless, M8 |\n<!-- ::TABLE widths="equal" -->\n'), 'the TABLE comment reaches the document', 15000).catch((error) => {
      throw new Error(`${error.message}; the document is now ${JSON.stringify(wd.doc.getText())}`);
    });
    await vscode.commands.executeCommand('workbench.action.files.save');
    await until(() => !wd.doc.isDirty, 'saved');
    assert.deepEqual(changed('widths.md'), ['+<!-- ::TABLE widths="equal" -->']);
    assert.equal(hunks('widths.md').length, 1);
    await vscode.commands.executeCommand('undo');
    await until(() => wd.doc.getText() === WD, 'ONE undo takes the line back');
    assert.equal(await test.selectNode(wd.uri, 'table_cell', 0, true), true);
    assert.equal(await test.runAction(wd.uri, 'table.column-wider'), true, 'Wider is not on the ribbon');
    let widths;
    await until(() => {
      const m = /\n<!-- ::TABLE widths="(\d+)% (\d+)%" -->\n/.exec(wd.doc.getText());
      widths = m && [Number(m[1]), Number(m[2])];
      return !!m;
    }, 'the widths line reaches the document', 15000);
    assert.equal(widths[0] + widths[1], 100, `the widths add up to 100: ${widths}`);
    assert.equal(wd.doc.getText().replace(/<!-- ::TABLE widths="[^"]*" -->\n/, ''), WD, 'only the widths line was added');
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    console.log(`[P19 test] table widths in the real host: Equal widths is one hidden comment line, one edit, one undo; Wider writes ${widths} from the canvas's columns: passed`);
  }

  // 25. Fix run undo-bg-table-split. Bug 1: VS Code's undo (Ctrl+Z) and redo in Print Layout (the default view) keep the pages: the
  //     paper sheets are drawn again for the text the canvas reads (before, the pages went off until a view switch). Bug 2: a merged
  //     block spanning columns and rows, written the way the merge now writes it (`| tall x p || y |` / `| ^^ || q |`), reads back
  //     as a table in standard form: Split is on in it and writes the cells back.
  {
    const LONG = ['# Pages', '', ...Array.from({ length: 70 }, (_, i) => [`Paragraph ${i + 1} with enough words to fill a line or two on the page.`, '']).flat()].join('\n');
    fs.writeFileSync(path.join(dir, 'pages.md'), LONG);
    const MERGED = '# Split\n\n| A | B | C |\n| --- | --- | --- |\n| wide || 3 |\n| tall x p || y |\n| ^^ || q |\n<!-- ::TABLE widths="20% 30% 50%" -->\n\nAfter.\n';
    fs.writeFileSync(path.join(dir, 'split.md'), MERGED);
    git('add', '.');
    git('commit', '-q', '-m', 'undo and split');
    const pg = await open('pages.md');
    let before;
    await until(async () => (before = await test.pages(pg.uri)).papers >= 3, 'Print Layout draws three pages or more', 15000);
    assert.equal(before.on, true);
    await pg.type(' ADDED', 1);
    await until(() => pg.doc.getText().includes('page. ADDED'), 'the typing reaches the document', 15000);
    await vscode.commands.executeCommand('undo');
    await until(() => pg.doc.getText() === LONG, 'undo puts the text back', 15000);
    let after;
    await until(async () => !(after = await test.pages(pg.uri)).text.includes('ADDED') && after.papers === before.papers, 'the pages are drawn again after undo', 15000).catch((error) => {
      throw new Error(`${error.message}; pages before ${JSON.stringify({ ...before, text: undefined })}, now ${JSON.stringify({ ...after, text: undefined })}`);
    });
    assert.equal(after.on, true, 'the pagination is on after undo');
    await vscode.commands.executeCommand('redo');
    await until(() => pg.doc.getText().includes('page. ADDED'), 'redo', 15000);
    await until(async () => (after = await test.pages(pg.uri)).text.includes('ADDED') && after.on && after.papers === before.papers, 'the pages are drawn again after redo', 15000);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    const sp = await open('split.md');
    assert.equal(await test.selectNode(sp.uri, 'table_cell', 2, true), true, 'no merged cell to put the cursor in'); // body cells: wide, 3, tall x p, …
    let ribbon;
    await until(async () => !(ribbon = await test.ribbon(sp.uri, 'table')).disabled.includes('table.split-cell'), 'Split is on in the merged cell', 10000).catch((error) => {
      throw new Error(`${error.message}; off: ${JSON.stringify(ribbon && ribbon.disabled)}`);
    });
    assert.equal(await test.runAction(sp.uri, 'table.split-cell'), true, 'Split is not on the ribbon');
    const want = MERGED.replace('| tall x p || y |\n| ^^ || q |', '| tall x p |  | y |\n|  |  | q |');
    await until(() => sp.doc.getText() === want, 'the split reaches the document', 15000).catch((error) => {
      throw new Error(`${error.message}; the document is now ${JSON.stringify(sp.doc.getText())}`);
    });
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    console.log(`[FIX-undo-bg-table-split test] undo and redo keep the ${before.papers} pages in Print Layout; a merged block reads back with Split on, and Split writes the cells back: passed`);
  }

  // 26. P20: the Image tab in the real host. No picture selected: no Image tab in the strip. A FIGURE selected: the strip has Image,
  //     after Table, and it is the selected tab, holding Rotate right (on); Rotate right run from it writes rotate="90" on the FIGURE
  //     (P27: a key, no file) as ONE edit, and ONE undo takes it back (the saved file is then the committed one). The cursor in
  //     the text: the Image tab is gone. Read: never an Image tab, even with the figure selected.
  {
    const IMG_DOC = '# Image tab\n\nSome text.\n\n<!-- ::FIGURE src="shots/wide.png" caption="Shot" -->\n\nEnd.\n';
    fs.writeFileSync(path.join(dir, 'imagetab.md'), IMG_DOC);
    git('add', '.');
    git('commit', '-q', '-m', 'image tab');
    const it = await open('imagetab.md');
    let r = await test.ribbon(it.uri);
    assert.ok(!r.tabs.includes('Image'), `no picture selected, yet the strip has ${JSON.stringify(r.tabs)}`);
    assert.equal(await test.selectNode(it.uri, 'pmd_figure'), true, 'no figure to select');
    await until(async () => (r = await test.ribbon(it.uri)).selected === 'Image', 'the Image tab comes forward', 10000).catch((error) => {
      throw new Error(`${error.message}; the strip: ${JSON.stringify(r && r.tabs)}, selected ${r && r.selected}`);
    });
    assert.deepEqual(r.tabs, ['Home', 'Insert', 'Table', 'Image', 'Layout', 'Document', 'Review', 'View'], 'the strip with a picture selected');
    assert.ok(r.commands.includes('image.rotate-right') && !r.disabled.includes('image.rotate-right'), `Rotate right on the Image tab: ${JSON.stringify(r.commands)}, off: ${JSON.stringify(r.disabled)}`);
    assert.equal(await test.runAction(it.uri, 'image.rotate-right'), true, 'Rotate right is not on the ribbon');
    await until(() => it.doc.getText().includes('<!-- ::FIGURE src="shots/wide.png" caption="Shot" rotate="90" -->'), 'the figure is turned (rotate="90")', 15000);
    assert.equal(it.doc.getText().split('\n').filter((l, i) => l !== IMG_DOC.split('\n')[i]).length, 1, 'one line changed');
    await vscode.commands.executeCommand('undo');
    await until(() => it.doc.getText() === IMG_DOC, 'ONE undo takes the rotation back');
    await vscode.commands.executeCommand('workbench.action.files.save');
    await until(() => !it.doc.isDirty, 'saved');
    assert.equal(fs.readFileSync(path.join(dir, 'imagetab.md'), 'utf8'), IMG_DOC, 'the file on disk after undo and save');
    assert.deepEqual(changed('imagetab.md'), [], 'git diff after undo');
    assert.equal(await test.selectNode(it.uri, 'paragraph', 0, true), true, 'no paragraph to put the cursor in');
    await until(async () => !(r = await test.ribbon(it.uri)).tabs.includes('Image'), 'the Image tab goes when the cursor is in the text', 10000);
    await vscode.commands.executeCommand('pagemd.read');
    await sleep(500);
    assert.equal(await test.selectNode(it.uri, 'pmd_figure'), true);
    await sleep(300);
    r = await test.ribbon(it.uri);
    assert.deepEqual(r.tabs, ['View'], 'Read shows the View tab only, never Image');
    await vscode.commands.executeCommand('pagemd.printLayout');
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    console.log('[P20 test] the Image tab: absent without a picture, forward with a FIGURE selected, Rotate right from it is one edit and one undo, gone in the text, never in Read: passed');
  }

  // 27. P24: Split on a cell that is not merged adds a column, as Word's Split Cells does: one edit (the new empty cell, the span on the
  //     other rows, the halved width, git diff in that table's lines only) and ONE undo takes it all back.
  {
    const SPL = '# Split column\n\nBefore.\n\n| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n<!-- ::TABLE widths="20% 30% 50%" -->\n\nAfter.\n';
    fs.writeFileSync(path.join(dir, 'splitcol.md'), SPL);
    git('add', '.');
    git('commit', '-q', '-m', 'split column');
    const sc = await open('splitcol.md');
    assert.equal(await test.selectNode(sc.uri, 'table_cell', 4, true), true, 'no table cell to put the cursor in'); // body cells: 1 2 3 4 5 6 after the headers A B C
    let ribbon;
    await until(async () => !(ribbon = await test.ribbon(sc.uri, 'table')).disabled.includes('table.split-cell'), 'Split is on in a plain cell', 10000).catch((error) => {
      throw new Error(`${error.message}; off: ${JSON.stringify(ribbon && ribbon.disabled)}`);
    });
    assert.equal(await test.runAction(sc.uri, 'table.split-cell'), true, 'Split is not on the ribbon');
    const want = SPL.replace('| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n<!-- ::TABLE widths="20% 30% 50%" -->', '| A | B || C |\n| --- | --- | --- | --- |\n| 1 | 2 || 3 |\n| 4 | 5 |  | 6 |\n<!-- ::TABLE widths="20% 15% 15% 50%" -->');
    await until(() => sc.doc.getText() === want, 'the split reaches the document', 15000).catch((error) => {
      throw new Error(`${error.message}; the document is now ${JSON.stringify(sc.doc.getText())}`);
    });
    await vscode.commands.executeCommand('workbench.action.files.save');
    await until(() => !sc.doc.isDirty, 'saved');
    assert.equal(hunks('splitcol.md').length, 1, 'one hunk: the table only');
    await vscode.commands.executeCommand('undo');
    await until(() => sc.doc.getText() === SPL, 'ONE undo takes the column back', 15000);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    console.log('[P24 test] Split on a plain cell in the real host: a column added (empty cell, spans on the other rows, the width halved) as one edit in one hunk, one undo: passed');
  }

  // 28. P21: page types with their own headers and footers, in the real host. The e2e fixture (test/e2e/fixtures/page-types/, its
  //     own profile and layout) opened in Print Layout: page 3, the first page of a run of the `wide` type, shows WIDE FIRST (from
  //     `@page wide:first`), MAIN RIGHT (inherited from the plain page, box by box) and "Wide page 3", as pagemd's PDF does; page 2
  //     is the plain page. Nothing is written to the file.
  {
    fs.cpSync(path.join(__dirname, '..', 'e2e', 'fixtures', 'page-types'), path.join(dir, 'page-types'), { recursive: true });
    const before = fs.readFileSync(path.join(dir, 'page-types', 'cascade.md'), 'utf8');
    const pt = await open('page-types/cascade.md');
    let pages;
    await until(async () => (pages = await test.pages(pt.uri)).papers >= 8 && pages.running && pages.running[2] && pages.running[2].header[0] !== '', 'Print Layout draws the page types', 20000).catch((error) => {
      throw new Error(`${error.message}; pages: ${JSON.stringify(pages && { papers: pages.papers, running: pages.running })}`);
    });
    assert.deepEqual(pages.running[2], { header: ['WIDE FIRST', '', 'MAIN RIGHT'], footer: ['', 'Wide page 3', ''] }, 'page 3: the wide type, first of its run');
    assert.deepEqual(pages.running[3].header, ['WIDE HEADER', '', 'MAIN RIGHT'], 'page 4: the wide type');
    assert.deepEqual(pages.running[1], { header: ['MAIN HEADER', '', 'MAIN RIGHT'], footer: ['', 'Page 2 of 8', ''] }, 'page 2: the plain page');
    assert.equal(pt.doc.isDirty, false, 'nothing written');
    assert.equal(fs.readFileSync(path.join(dir, 'page-types', 'cascade.md'), 'utf8'), before, 'the file is unchanged');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    console.log('[P21 test] page-type headers and footers in the real host: page 3 WIDE FIRST / MAIN RIGHT / Wide page 3, page 4 WIDE HEADER, page 2 plain: passed');
  }

  // 29. P25 (R-242): Files in Use in the real host. The e2e fixture (test/e2e/fixtures/files-in-use/: a profile that extends another,
  //     its own CSS, a layout, a `styles:` file) opened: the panel lists every file in priority order (the host's report over the real
  //     files); Open on a row opens that profile in a text editor beside the document; the winning rule of a heading's alignment opens
  //     its stylesheet at that line. Nothing is written to the document.
  {
    fs.cpSync(path.join(__dirname, '..', 'e2e', 'fixtures', 'files-in-use'), path.join(dir, 'files-in-use'), { recursive: true });
    const before = fs.readFileSync(path.join(dir, 'files-in-use', 'docs', 'report.md'), 'utf8');
    const fu = await open('files-in-use/docs/report.md');
    let state;
    await until(async () => (state = await test.files(fu.uri, {})).rows.length > 0, 'the Files in Use panel lists the files', 20000).catch((error) => {
      throw new Error(`${error.message}; panel: ${JSON.stringify(state)}`);
    });
    assert.deepEqual(state.rows, ['report.md', 'report-child.json', 'report-base.json', 'standard_letter.json', 'standard_letter.html', 'extra.css', 'report.css', 'shiki-base.css', 'report-layout.css', 'primary.css', 'base.css'], 'every file, in priority order');
    const shownFile = (name) => vscode.window.visibleTextEditors.find((e) => e.document.uri.fsPath.replace(/\\/g, '/').endsWith(name));
    await test.files(fu.uri, { click: 'report-child.json' });
    await until(() => !!shownFile('/profiles/report-child.json'), 'Open shows the profile in a text editor', 15000);
    state = await test.files(fu.uri, { heading: 2, rule: 'text-align' });
    const align = state.where.find((w) => w.property === 'text-align');
    assert.ok(align && align.rule.startsWith('report.css:2 h2 text-align: center'), `the heading's alignment comes from report.css line 2: ${JSON.stringify(align)}`);
    await until(() => {
      const editor = shownFile('/profiles/report.css');
      return !!editor && editor.selection.active.line === 1;
    }, 'the rule opens report.css at line 2', 15000);
    assert.equal(fu.doc.isDirty, false, 'nothing written');
    assert.equal(fs.readFileSync(path.join(dir, 'files-in-use', 'docs', 'report.md'), 'utf8'), before, 'the file is unchanged');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    console.log('[P25 test] Files in Use in the real host: every file in priority order, Open shows the profile beside the document, a heading\'s alignment opens report.css at line 2, nothing written: passed');
  }

  // 30. P26 (R-244, R-245): footnotes and task lists in the real host. A document with both opens without writing anything (each note,
  //     reference and box reads back byte for byte); Insert ▸ Footnote adds the reference and a numbered note at the end as ONE change
  //     (git diff: the paragraph's line and the new note), and ONE undo takes both out.
  {
    const FN_DOC = 'Some text here.\n\n- [x] Done\n- [ ] Open\n\nA note[^a].\n\n[^a]: The note.\n';
    fs.writeFileSync(path.join(dir, 'notes.md'), FN_DOC);
    git('add', '.');
    git('commit', '-q', '-m', 'notes doc');
    const fn = await open('notes.md');
    await sleep(500);
    assert.equal(fn.doc.isDirty, false, 'opening a document with footnotes and tasks writes nothing');
    assert.equal(fn.doc.getText(), FN_DOC);
    assert.equal(await test.runAction(fn.uri, 'footnotes.insert'), true, 'no footnotes.insert action');
    await until(() => fn.doc.getText().endsWith('[^a]: The note.\n\n[^1]:\n') && fn.doc.getText().includes('[^1]'), 'the reference and the note reach the document', 15000);
    await fn.doc.save();
    const lines = changed('notes.md');
    assert.ok(lines.length >= 2 && lines.every((l) => /\[\^1\]/.test(l) || /^[-+]\s*$/.test(l) || /^-Some text here\.$/.test(l)), `only the paragraph and the new note changed: ${JSON.stringify(lines)}`);
    await vscode.commands.executeCommand('undo');
    await until(() => fn.doc.getText() === FN_DOC, 'ONE undo takes the reference and the note out together', 8000);
    await fn.doc.save();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    console.log('[P26 test] footnotes and tasks in the real host: opened without a write, Insert Footnote is one change, one undo takes it out: passed');
  }

  // 31. FIX-PGF (item 1, the user's report: "Web, then Preview: stuck in render; Print, then Preview again, does not correct it"). Not
  //     reproduced here (see docs/phases/FIX-preview-greyouts-flicker.md); this keeps the exact path in the real host: the ribbon's Web
  //     Layout, then Print Preview (with typing just before it), then Print Layout and Print Preview again, each finishing with pages and
  //     the stage named while it ran.
  {
    const PV_DOC = '# Web then Preview\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [ ] task\n\nA note[^1].\n\n[^1]: The note.\n\n```mermaid\ngraph LR\n  A --> B\n```\n';
    fs.writeFileSync(path.join(dir, 'web-preview.md'), PV_DOC);
    const pv = await open('web-preview.md');
    await sleep(500);
    const finished = async (what) => {
      let shown;
      await until(async () => {
        shown = await test.preview(pv.uri);
        return shown.visible && !shown.busy && shown.provider !== null;
      }, what, 60000);
      assert.equal(shown.provider, 'pagemd', `${what}: the preview fell back: ${shown.message}`);
      assert.ok(shown.pages >= 1, `${what}: no pages`);
      assert.ok(!/stopped/.test(shown.message ?? ''), `${what}: ${shown.message}`);
      return shown;
    };
    assert.equal(await test.runAction(pv.uri, 'view.web'), true);
    await sleep(300);
    await pv.type(' typed', 1);
    assert.equal(await test.runAction(pv.uri, 'view.preview'), true);
    const first = await finished('Web → Print Preview');
    assert.equal(first.diagrams, 1, 'the diagram was not drawn in the preview');
    assert.equal(await test.runAction(pv.uri, 'view.print'), true);
    await sleep(300);
    assert.equal(await test.runAction(pv.uri, 'view.preview'), true);
    await finished('Print → Print Preview');
    // Left mid-render and opened again at once: it starts clean and finishes.
    assert.equal(await test.runAction(pv.uri, 'view.web'), true);
    assert.equal(await test.runAction(pv.uri, 'view.preview'), true);
    assert.equal(await test.runAction(pv.uri, 'view.print'), true);
    assert.equal(await test.runAction(pv.uri, 'view.preview'), true);
    await finished('Web → Preview → Print → Preview at once');
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    console.log('[FIX-PGF test] Web → Print Preview, Print → Print Preview and a preview left mid-render, in the real host: passed');
  }

  // 32. FIX-PGF (item 3, "heavy flicker with Ctrl+Z"): VS Code's undo and redo in Print Layout, on the 110-section benchmark document,
  //     traced frame by frame in the page (test:trace): the changed blocks are patched into the same editor state (no new state), the
  //     paper sheets and the page gaps never leave the screen, one layout pass; undo is still ONE VS Code step (back to the saved text).
  {
    fs.copyFileSync(process.env.PMD_LARGE_DOC, path.join(dir, 'flicker.md'));
    const fl = await open('flicker.md');
    await sleep(2500);
    const saved = fl.doc.getText();
    const papers = (await test.pages(fl.uri)).papers;
    assert.ok(papers >= 100, `the benchmark document should have 100+ pages (${papers})`);
    await fl.type(' Typed words', 300);
    await until(() => fl.doc.getText() !== saved, 'the typing reaches VS Code');
    await sleep(1500);
    for (const command of ['undo', 'redo']) {
      const version = fl.doc.version;
      await test.trace(fl.uri, 'start');
      await vscode.commands.executeCommand(command);
      await until(() => fl.doc.version !== version, `${command} reaches the document`);
      await sleep(1500);
      const seen = await test.trace(fl.uri, 'stop');
      console.log(`[FIX-PGF finding] ${command} on ${papers} pages: ${JSON.stringify(seen)}`);
      assert.equal(seen.rebuilds, 0, `${command}: the canvas built a new editor state`);
      assert.equal(seen.patches, 1, `${command}: the change was not patched in`);
      assert.equal(seen.layerRemovals, 0, `${command}: the paper sheets were taken off the page`);
      assert.equal(seen.framesWithoutPages, 0, `${command}: frames without the paper or the page gaps`);
      assert.ok(seen.runs <= 1, `${command}: ${seen.runs} layout passes`);
      assert.deepEqual(seen.after, seen.before, `${command}: the pages are not as before`);
      if (command === 'undo') assert.equal(fl.doc.getText(), saved, 'ONE undo takes the typing back');
    }
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    console.log('[FIX-PGF test] undo and redo in Print Layout on 100+ pages: no new state, the pages never leave the screen, one layout pass: passed');
  }

  // FIX-template-asset-paths (R-259, OQ-80): an invented shared-profile example (test/vscode/fixtures/shared-profile-uofo, SAN-0b), its
  //     profile named by its full path in a folder beside the document's ("Field Reports", with a space), outside every folder the webview may load
  //     from at first. The template's logo is written `../assets/img/…` (from the template's folder): the canvas loads it, so the path
  //     was rewritten from the document's folder AND the host let the webview read the profile's picture folder.
  {
    const example = path.join(__dirname, 'fixtures', 'shared-profile-uofo');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pmd-tap-'));
    fs.cpSync(example, root, { recursive: true });
    const file = path.join(root, 'Field Reports', 'UOFO-FR-001.md');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^pipeline_profile: .*$/m, `pipeline_profile: ${path.join(root, 'std-how-to', 'profile.json')}`));
    const uri = vscode.Uri.file(file);
    await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
    await test.whenReady(uri.toString());
    let state = null;
    // VS Code may load the page again once the folder is allowed: each look gives up after 2 s and is asked again
    const look = () => Promise.race([test.imageState(uri.toString(), 'UOFO-LOGO'), sleep(2000).then(() => null)]);
    await until(async () => (state = await look()) !== null && state.complete && state.naturalWidth > 0, 'the template logo next to the outside profile loads on the canvas', 30000).catch((error) => {
      throw new Error(`${error.message}: ${JSON.stringify(state)}`);
    });
    assert.equal(state.src, '../std-how-to/assets/img/uofo-logo.png');
    assert.equal(state.naturalWidth, 300);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    console.log('[FIX-TAP test] the invented shared-profile example: the template logo beside an outside profile loads on the canvas: passed');
  }

  // Phase L2-8 (R-263): a profile pack in the shared profiles folder (test/vscode/profile-packs.cjs)
  await require('./profile-packs.cjs').profilePacksStep(test);
  // Phase L3 (R-263, R-264): pagemd: Get Profile Packs on a folder source (test/vscode/get-profile-packs.cjs)
  await require('./get-profile-packs.cjs').getProfilePacksStep(test);

  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {
    /* Windows: VS Code still holds the folder; it is a temp folder and removing it is not what is tested */
  }
  console.log(`[P2 test] edit→save→git diff, flush before save, undo, outside change, CRLF: passed in VS Code ${vscode.version}`);
};
