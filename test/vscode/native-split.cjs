// Runs INSIDE the VS Code test host. Native split: Split view opens VS Code's own text editor beside the page, leaving Split closes
// it, and the setting turns it off. Run on its own: PMD_SUITE=native-split.cjs node test/vscode/run.mjs (after `npm run build`).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what, ms = 15000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (await check()) return;
  throw new Error(`Timed out waiting for: ${what}`);
}

exports.run = async function run() {
  const extension = vscode.extensions.getExtension('gh4.pagemd-editor');
  const info = await extension.activate();
  const { test } = info;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmd-ns-'));
  const file = path.join(dir, 'doc.md');
  fs.writeFileSync(file, '# Guide\n\nFirst paragraph.\n\nSecond paragraph.\n');
  const uri = vscode.Uri.file(file);
  const textTabs = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs.filter((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === uri.toString()).map((t) => ({ tab: t, column: g.viewColumn })));
  const customTabs = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs.filter((t) => t.input && t.input.viewType === 'pagemd-editor.editor').map(() => g.viewColumn));

  const config = vscode.workspace.getConfiguration('pagemdEditor');
  await config.update('nativeSplit', true, vscode.ConfigurationTarget.Global); // off by default
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('vscode.openWith', uri, 'pagemd-editor.editor');
  await test.whenReady(uri.toString());
  assert.equal(textTabs().length, 0, 'no text editor before Split');

  await vscode.commands.executeCommand('pagemd.switchView', 'split');
  await until(() => textTabs().length === 1, 'the text editor opens beside the page in Split view');
  const [custom] = customTabs();
  assert.notEqual(textTabs()[0].column, custom, 'the text editor is in another column than the page');
  const find = () => vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString());
  await until(() => find(), 'the text editor is visible');
  const editor = find();

  // One document: typing in the text editor changes the document the page shows.
  await editor.edit((b) => b.insert(new vscode.Position(4, 0), 'Typed natively. '));
  assert.match(editor.document.getText(), /Typed natively\. Second paragraph\./);

  // The page's cursor follows the text editor's: line 3 is the first paragraph (block 1), line 5 the second (block 2).
  for (const [line, block] of [[2, 1], [4, 2], [2, 1]]) {
    const at = new vscode.Position(line, 3);
    editor.selection = new vscode.Selection(at, at);
    await until(async () => (await test.keys(uri.toString(), 'canvas', [])).cursorBlock === block, `the page's cursor follows to block ${block}`);
  }
  assert.equal(textTabs().length, 1, 'still open after cursor moves');

  await vscode.commands.executeCommand('pagemd.switchView', 'print');
  await until(() => textTabs().length === 0, 'the text editor closes when Split is left');
  assert.equal(customTabs().length, 1, 'the page stays');

  await config.update('nativeSplit', false, vscode.ConfigurationTarget.Global);
  try {
    await vscode.commands.executeCommand('pagemd.switchView', 'split');
    await sleep(1500);
    assert.equal(textTabs().length, 0, 'setting off: the built-in Code pane is used, no text editor opens');
    await vscode.commands.executeCommand('pagemd.switchView', 'print');
  } finally {
    await config.update('nativeSplit', undefined, vscode.ConfigurationTarget.Global);
  }
  await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  console.log('[native split test] opens beside in Split, shares the document, closes on leaving, off by setting: passed');
};
