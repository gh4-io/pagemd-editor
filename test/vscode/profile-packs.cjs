// Runs INSIDE the VS Code test host. Phase L2-8 (R-263): a real profile pack (pagemd-common's fixture uofo-sop, the library's fictional company, made by
// pagemd-library) installed by @pagemd/packs into the shared profiles folder of this run (run.mjs sets PAGEMD_CONFIG_DIR to a
// temporary folder, so the user's real one is never touched). A document names it by name only: the profile picker lists it
// ("library 0.1.0"), Files in Use says "search step 4 of 6", and its logo (a CSS background from the pack's theme.css) loads in
// the real webview, so the host let the webview read the pack's folder. Part of suite.cjs (its last step) and runnable alone:
// PMD_SUITE=profile-packs.cjs node test/vscode/run.mjs (after `npm run build`).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const vscode = require('vscode');

const VIEW_TYPE = 'pagemd-editor.editor';
const COMMON = path.join(__dirname, '..', '..', '..', 'pagemd-common');
const ZIP = path.join(COMMON, 'packages', 'packs', 'test', 'fixtures', 'library', 'uofo-sop-0.1.0.zip');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what, ms = 15000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await check()) return;
  throw new Error(`Timed out waiting for: ${what}`);
}

async function profilePacksStep(test) {
  const configDir = process.env.PAGEMD_CONFIG_DIR;
  assert.ok(configDir && configDir.startsWith(os.tmpdir()), `PAGEMD_CONFIG_DIR must be a temporary folder in a test run (it is ${configDir})`);
  const shared = path.join(configDir, 'profiles');
  const packs = await import(pathToFileURL(path.join(COMMON, 'packages', 'packs', 'src', 'index.js')).href);
  const zip = fs.readFileSync(ZIP);
  packs.installPack(packs.verifyPack(zip, packs.sha256(zip)), shared);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pmd-l2-'));
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  const file = path.join(root, 'sop.md');
  fs.writeFileSync(file, '---\nprofile: uofo-sop\ntitle: A pack by name\ndocument_id: SOP-1\n---\n# A pack by name\n\nText.\n');
  const uri = vscode.Uri.file(file);
  await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
  await test.whenReady(uri.toString());

  const choices = await test.profiles(uri.toString());
  const pack = choices.find((c) => c.name === 'uofo-sop');
  assert.ok(pack, `the picker does not list the pack: ${JSON.stringify(choices.map((c) => c.name))}`);
  assert.equal(pack.source, 'library');
  assert.equal(pack.version, '0.1.0');
  assert.deepEqual(pack.duplicates, []);

  await vscode.commands.executeCommand('pagemd.printLayout');
  let state = null;
  const look = () => Promise.race([test.imageState(uri.toString(), 'Uncertified Organic Farmers Org'), sleep(6000).then(() => null)]);
  await until(async () => (state = await look()) !== null && state.naturalWidth > 0, "the pack's logo loads on the canvas", 60000).catch((error) => {
    throw new Error(`${error.message}: ${JSON.stringify(state)}`);
  });
  assert.match(state.src, /uofo-sop\/companies\/uofo\/assets\/uofo-logo\.png/);
  assert.equal(state.naturalWidth, 480);

  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  packs.uninstallPack('uofo-sop', shared);
  console.log('[L2 test] a profile pack in the shared profiles folder: listed by the picker (library 0.1.0), named by name, its logo loads on the canvas: passed');
}

exports.profilePacksStep = profilePacksStep;

exports.run = async function run() {
  const extension = vscode.extensions.getExtension('gh4.pagemd-editor');
  const info = await extension.activate();
  await profilePacksStep(info.test);
};
