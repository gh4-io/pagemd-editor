// Runs INSIDE the VS Code test host. Code engines experiment: the same markdown document in the Code view made of each engine
// (codemirror, monaco-vscode); each loads in the real webview, takes a typed character into the document, and a screenshot
// of the window is kept in test-results/engine-<name>.png for the eye. Run: PMD_SUITE=code-engines.cjs node test/vscode/run.mjs
// (after `npm run build`).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what, ms = 15000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await check()) return;
  throw new Error(`Timed out waiting for: ${what}`);
}

const DOC = [
  '---', 'title: Engine test', '---', '', '# Responsibility Matrix', '', 'Some **bold**, *italic*, `code` and a [link](https://example.com).', '',
  '| Role | Responsible For |', '|---|---|', '| Planner | Downloads the sheet |', '', '## Steps', '',
  '1. Open your web browser and go to the login page', '2. Enter your login details', '', '```js', 'const answer = 42;', '```', '',
  '> A quoted note.', '', 'Final paragraph with `inline` code.', '',
].join('\n');

async function screenshot(name) {
  const portFile = path.join(process.env.PMD_USER_DATA ?? '', 'DevToolsActivePort');
  if (!fs.existsSync(portFile)) return console.log(`[engines] no DevTools port: no screenshot for ${name}`);
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find((t) => t.type === 'page' && /Visual Studio Code|Extension Development Host/.test(`${t.title} ${t.url}`)) ?? targets.find((t) => t.type === 'page');
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
  const dir = path.join(__dirname, '..', '..', 'test-results');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `engine-${name}.png`), png);
  console.log(`[engines] screenshot ${name}: ${png.length} bytes`);
}

exports.run = async function run() {
  const extension = vscode.extensions.getExtension('gh4.pagemd-editor');
  const info = await extension.activate();
  const { test } = info;
  const only = process.env.PMD_ENGINE;
  for (const engine of ['codemirror', 'monaco-vscode'].filter((e) => !only || e === only)) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmd-eng-'));
    const file = path.join(dir, 'doc.md');
    fs.writeFileSync(file, DOC);
    const uri = vscode.Uri.file(file);
    await vscode.workspace.getConfiguration('pagemdEditor').update('codeEngine', engine, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('vscode.openWith', uri, 'pagemd-editor.editor');
    await test.whenReady(uri.toString());
    await vscode.commands.executeCommand('pagemd.switchView', 'code');
    const started = Date.now();
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    // Loaded = the view takes a typed character (it does only once the engine is up); polled every 100 ms.
    let state;
    await until(async () => (state = await test.keys(uri.toString(), 'code', ['X'], 0)).codeText?.startsWith('X'), `${engine}: the Code view loads and takes a typed character`, 60000);
    console.log(`[engines] ${engine}: the Code view took typing ${Date.now() - started} ms after the switch to Code`);
    await until(() => doc.getText().startsWith('X'), `${engine}: the typing reaches the document`, 10000);
    await sleep(1500);
    await screenshot(engine);
    if (engine === 'monaco-vscode') {
      // VS Code's own editor settings reach the view: the minimap goes, the font grows.
      const editorConfig = vscode.workspace.getConfiguration('editor');
      await editorConfig.update('minimap.enabled', false, vscode.ConfigurationTarget.Global);
      await editorConfig.update('fontSize', 20, vscode.ConfigurationTarget.Global);
      await sleep(2500);
      await screenshot('settings');
      await editorConfig.update('minimap.enabled', undefined, vscode.ConfigurationTarget.Global);
      await editorConfig.update('fontSize', undefined, vscode.ConfigurationTarget.Global);
      // The user's own colour theme reaches the view, whichever theme it is.
      const workbench = vscode.workspace.getConfiguration('workbench');
      for (const [name, label] of [['theme-light', 'Light Modern'], ['theme-monokai', 'Monokai']]) {
        await workbench.update('colorTheme', label, vscode.ConfigurationTarget.Global);
        await sleep(3500);
        await screenshot(name);
      }
      await workbench.update('colorTheme', undefined, vscode.ConfigurationTarget.Global);
    }
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  }
  await vscode.workspace.getConfiguration('pagemdEditor').update('codeEngine', undefined, vscode.ConfigurationTarget.Global);
  console.log('[engines] done');
};
