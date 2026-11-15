// Runs INSIDE the VS Code that test/vsix/run.mjs started, in the probe extension's host, next to the INSTALLED pagemd Editor.
// It checks only what VS Code itself reports and what is on disk (AD-P13-06); the test-only handles are not unlocked (R-89).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');

const EXTENSION_ID = 'gh4.pagemd-editor';
const VIEW_TYPE = 'pagemd-editor.editor';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(check, what, ms = 30000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await check()) return;
  throw new Error(`Timed out waiting for: ${what}`);
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

exports.run = async function run() {
  const extensions = fs.realpathSync(process.env.PMD_VSIX_EXTENSIONS_DIR);
  const userData = process.env.PMD_VSIX_USER_DATA;
  const version = process.env.PMD_VSIX_VERSION;

  // 1. VS Code found the extension in the clean extensions folder (not a development path), at the packaged version.
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `${EXTENSION_ID} is not installed`);
  const home = fs.realpathSync(extension.extensionPath);
  assert.ok(home.startsWith(extensions + path.sep), `the extension runs from ${home}, not from the extensions folder ${extensions}`);
  assert.equal(extension.packageJSON.version, version);
  assert.equal(extension.packageJSON.private, undefined, 'the manifest is still private');
  // R-234: the generated build-info.json says the same version, with a commit and a date; this is what "pagemd: About this build" shows.
  const buildInfo = JSON.parse(fs.readFileSync(path.join(home, 'dist', 'build-info.json'), 'utf8'));
  assert.equal(buildInfo.version, version);
  assert.match(buildInfo.commit, /^[0-9a-f]{7,}$/);
  assert.match(buildInfo.date, /^\d{4}-\d{2}-\d{2}$/);

  // (vsce stores the README and CHANGELOG under lower-case names.)
  // 2. What was installed: what the host and webview load at run time is there; nothing that must not ship is.
  const files = walk(home).map((f) => path.relative(home, f).split(path.sep).join('/'));
  for (const needed of ['package.json', 'readme.md', 'changelog.md', 'ThirdPartyNotices.txt', 'dist/host/extension.js', 'dist/webview/main.js', 'dist/host/pagemd/runtime.mjs', 'dist/host/pagemd/vendor/paged.polyfill.js', 'dist/host/pagemd/vendor/mermaid.min.js', 'dist/webview/mermaid/mermaid.min.js', 'dist/webview/codicons/codicon.css', 'dist/webview/codicons/codicon.ttf']) {
    assert.ok(files.includes(needed), `${needed} is missing from the installed extension`);
  }
  assert.ok(files.some((f) => f.startsWith('dist/defaults/profiles/')), 'the bundled profiles are missing');
  const forbidden = files.filter((f) => /\.map$|\.tsx?$|(^|\/)node_modules\//.test(f));
  assert.deepEqual(forbidden, [], 'files that must not ship are installed');

  // 3. Open a pagemd document the way a user does (Open With), then look at what VS Code reports.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmd-vsix-doc-'));
  const docPath = path.join(dir, 'probe.md');
  // A profile with a `validation` setting (P14), so step 7 can see the installed host's checks run for real.
  fs.mkdirSync(path.join(dir, 'profiles'), { recursive: true });
  const resources = { template: '${cliPath}/templates/standard_letter.html', layout: '${cliPath}/layouts/letter.css', css: ['${cliPath}/styles/primary.css'] };
  fs.writeFileSync(path.join(dir, 'profiles', 'checked.json'), JSON.stringify({ id: 'checked', resources, validation: { required_fields: ['title', 'owner'] } }, null, 2));
  fs.writeFileSync(docPath, ['---', 'title: Probe', 'profile: ./profiles/checked.json', '---', '', '# Probe', '', 'A paragraph.', '', '<!-- ::PAGEBREAK -->', ''].join('\n'));
  const uri = vscode.Uri.file(docPath);
  await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
  await until(() => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    return input instanceof vscode.TabInputCustom && input.viewType === VIEW_TYPE && input.uri.toString() === uri.toString();
  }, 'the active tab to be the pagemd custom editor');
  await until(() => extension.isActive, 'the extension to activate');

  // 4. The test-only handles are not reachable in the package (R-89).
  assert.equal(extension.exports.viewType, VIEW_TYPE);
  assert.equal(extension.exports.test, undefined, 'a test-only handle answers without PMD_TEST');

  // 5. Every command the manifest names is registered by the running host.
  const registered = new Set(await vscode.commands.getCommands(true));
  const declared = extension.packageJSON.contributes.commands.map((c) => c.command);
  assert.ok(declared.length >= 15, 'the manifest lost commands');
  assert.deepEqual(declared.filter((c) => !registered.has(c)), [], 'commands declared but not registered');

  // 6. pagemd's own runtime loads from the installed folder: Export HTML (VS Code's own file dialog is on: accept its name).
  const target = path.join(dir, 'probe.html');
  const exporting = Promise.resolve(vscode.commands.executeCommand('pagemd.exportToHtml'));
  await sleep(500);
  let accepted = false;
  await until(async () => {
    if (fs.existsSync(target)) return true;
    if (!accepted || Math.random() < 0.2) {
      accepted = true;
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    }
    return false;
  }, 'pagemd.exportToHtml to write probe.html next to the document');
  await exporting.catch(() => undefined);
  const html = fs.readFileSync(target, 'utf8');
  assert.match(html, /<h1[^>]*>Probe<\/h1>/, 'the exported HTML has no heading');
  assert.match(html, /<html/i);

  // 7. The host reports a problem for the document's profile (the validation runs from the installed folder), and
  //    the extension's output channel has no error line.
  const codes = () => vscode.languages.getDiagnostics(uri).map((d) => (typeof d.code === 'object' && d.code ? String(d.code.value) : String(d.code)));
  await until(() => codes().includes('meta/missing-required-field'), 'the missing "owner" property to be reported in the Problems panel');
  const logs = walk(path.join(userData, 'logs')).filter((f) => /pagemd Editor\.log$/.test(f));
  assert.ok(logs.length > 0, 'the extension wrote no output channel log');
  const text = logs.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  assert.match(text, /pagemd Editor activated\./);
  const bad = text.split('\n').filter((l) => /\b(error|failed|could not|not available)\b/i.test(l) && !/pagemd Editor activated/.test(l));
  assert.deepEqual(bad, [], 'the output channel has error lines');

  fs.rmSync(dir, { recursive: true, force: true });
};
