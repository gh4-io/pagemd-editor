// Runs INSIDE the VS Code test host. Split view keeps the code pane and the page scrolled together, for each Code engine: scrolling one
// pane to a place puts the other at the same block (within one), and the two do not keep moving afterwards. Run:
// PMD_SUITE=scroll-sync.cjs node test/vscode/run.mjs (after `npm run build`).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what, ms = 30000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await check()) return;
  throw new Error(`Timed out waiting for: ${what}`);
}

const DOC = Array.from({ length: 150 }, (_, i) => `## Section ${i + 1}\n\nParagraph one of section ${i + 1}, with some words to fill a line or two of the page.\n\nParagraph two of section ${i + 1}: another run of ordinary words, long enough that it wraps on a narrow pane.\n`).join('\n');

exports.run = async function run() {
  const extension = vscode.extensions.getExtension('gh4.pagemd-editor');
  const { test } = await extension.activate();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmd-scroll-'));
  const file = path.join(dir, 'doc.md');
  fs.writeFileSync(file, DOC);
  const uri = vscode.Uri.file(file);
  const only = process.env.PMD_ENGINE;
  for (const engine of ['codemirror', 'monaco-vscode'].filter((e) => !only || e === only)) {
    await vscode.workspace.getConfiguration('pagemdEditor').update('codeEngine', engine, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('vscode.openWith', uri, 'pagemd-editor.editor');
    await test.whenReady(uri.toString());
    await vscode.commands.executeCommand('pagemd.switchView', 'split');
    // The code pane is ready when it takes a scroll (the Monaco view loads when it first shows).
    let state;
    await until(async () => ((state = await test.scroll(uri.toString(), 'code', 0)), state.blocks > 100), `${engine}: Split view is up`);
    for (const [target, fraction] of [['code', 0.5], ['canvas', 0.8], ['code', 0.2], ['canvas', 0.35], ['code', 0.95], ['canvas', 0.0]]) {
      state = await test.scroll(uri.toString(), target, fraction);
      const gap = Math.abs(state.codeBlock - state.canvasBlock);
      console.log(`[scroll ${engine}] ${target} to ${fraction}: code block ${state.codeBlock}, page block ${state.canvasBlock} of ${state.blocks}`);
      assert.ok(gap <= 2, `${engine}: after scrolling the ${target} to ${fraction} the panes are ${gap} blocks apart (${JSON.stringify(state)})`);
      if (fraction > 0.1 && fraction < 0.9) assert.ok(state.codeBlock > 20, `${engine}: the panes did not move together (${JSON.stringify(state)})`);
      await sleep(500);
      const later = await test.scroll(uri.toString(), target, fraction);
      assert.ok(Math.abs(later.codeBlock - state.codeBlock) <= 1 && Math.abs(later.canvasBlock - state.canvasBlock) <= 1, `${engine}: the panes kept moving after the scroll (${JSON.stringify([state, later])})`);
    }
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  }
  await vscode.workspace.getConfiguration('pagemdEditor').update('codeEngine', undefined, vscode.ConfigurationTarget.Global);
  console.log('[scroll sync test] code and page scroll together in Split view, both engines: passed');
};
