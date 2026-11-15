// Runs INSIDE the VS Code test host. Phase L3 (R-263, R-264): "pagemd: Get Profile Packs…" against a folder source. A library folder
// (the real packs checked into pagemd-common, with their index.json) is named in the setting; the command installs one pack into the
// shared profiles folder of this run (run.mjs sets PAGEMD_CONFIG_DIR to a temporary folder: the user's real one is never touched); a
// document names the pack by name, the profile picker lists it, and its logo loads on the canvas; then the command removes it again.
// Not covered here: the GitHub path (sign-in, API, redirects) runs against local servers in apps/vscode/test/pack-source.test.ts,
// because the test host has no GitHub account. Part of suite.cjs (the step after L2's) and runnable alone:
// PMD_SUITE=get-profile-packs.cjs node test/vscode/run.mjs (after `npm run build`).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');

const VIEW_TYPE = 'pagemd-editor.editor';
const FIXTURES = path.join(__dirname, '..', '..', '..', 'pagemd-common', 'packages', 'packs', 'test', 'fixtures', 'library');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what, ms = 15000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await check()) return;
  throw new Error(`Timed out waiting for: ${what}`);
}

async function getProfilePacksStep(test) {
  const configDir = process.env.PAGEMD_CONFIG_DIR;
  assert.ok(configDir && configDir.startsWith(os.tmpdir()), `PAGEMD_CONFIG_DIR must be a temporary folder in a test run (it is ${configDir})`);
  const shared = path.join(configDir, 'profiles');
  assert.ok(!fs.existsSync(path.join(shared, 'uofo-sop.json')), 'the shared folder starts without the pack');

  // The library folder: index.json + the two zips (a copy; the fixtures are not touched).
  const library = fs.mkdtempSync(path.join(os.tmpdir(), 'pmd-l3-library-'));
  for (const name of fs.readdirSync(FIXTURES)) fs.copyFileSync(path.join(FIXTURES, name), path.join(library, name));
  const config = vscode.workspace.getConfiguration('pagemdEditor');
  await config.update('profilePacks.source', library, vscode.ConfigurationTarget.Global);

  try {
    const done = await vscode.commands.executeCommand('pagemd.getProfilePacks', { install: ['uofo-sop'] });
    assert.deepEqual(
      done.map((o) => [o.id, o.action, o.result]),
      [['uofo-sop', 'install', 'done']],
      `the command did not install: ${JSON.stringify(done)}`,
    );
    assert.ok(fs.existsSync(path.join(shared, 'uofo-sop.json')), 'the profile file is in the shared folder');
    assert.ok(fs.existsSync(path.join(shared, 'uofo-sop', 'manifest.json')), 'the manifest is in the shared folder');
    assert.ok(!fs.existsSync(path.join(shared, 'pml-sop-ink.json')), 'only the chosen pack was installed');

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pmd-l3-'));
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    const file = path.join(root, 'sop.md');
    fs.writeFileSync(file, '---\nprofile: uofo-sop\ntitle: A fetched pack\ndocument_id: SOP-1\n---\n# A fetched pack\n\nText.\n');
    const uri = vscode.Uri.file(file);
    await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
    await test.whenReady(uri.toString());

    const choices = await test.profiles(uri.toString());
    const pack = choices.find((c) => c.name === 'uofo-sop');
    assert.ok(pack, `the picker does not list the installed pack: ${JSON.stringify(choices.map((c) => c.name))}`);
    assert.equal(pack.source, 'library');
    assert.equal(pack.version, '0.1.0');

    await vscode.commands.executeCommand('pagemd.printLayout');
    let state = null;
    const look = () => Promise.race([test.imageState(uri.toString(), 'Uncertified Organic Farmers Org'), sleep(6000).then(() => null)]);
    await until(async () => (state = await look()) !== null && state.naturalWidth > 0, "the fetched pack's logo loads on the canvas", 60000).catch((error) => {
      throw new Error(`${error.message}: ${JSON.stringify(state)}`);
    });
    assert.equal(state.naturalWidth, 480);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    const removed = await vscode.commands.executeCommand('pagemd.getProfilePacks', { remove: ['uofo-sop'] });
    assert.deepEqual(removed.map((o) => [o.id, o.action, o.result]), [['uofo-sop', 'remove', 'done']]);
    assert.ok(!fs.existsSync(path.join(shared, 'uofo-sop.json')), 'Remove took the profile away');

    // An unplugged source: nothing installs, nothing is thrown, the command answers with the empty plan.
    await config.update('profilePacks.source', path.join(library, 'unplugged'), vscode.ConfigurationTarget.Global);
    const offline = await vscode.commands.executeCommand('pagemd.getProfilePacks', { install: ['uofo-sop'] });
    assert.deepEqual(offline, []);
    assert.ok(!fs.existsSync(path.join(shared, 'uofo-sop.json')), 'an unreachable source installs nothing');
  } finally {
    await config.update('profilePacks.source', undefined, vscode.ConfigurationTarget.Global);
  }
  console.log('[L3 test] pagemd: Get Profile Packs on a folder source: installed one pack into the shared folder, the picker lists it, its logo loads, Remove works, an unplugged source is harmless: passed');
}

exports.getProfilePacksStep = getProfilePacksStep;

exports.run = async function run() {
  const extension = vscode.extensions.getExtension('gh4.pagemd-editor');
  const info = await extension.activate();
  await getProfilePacksStep(info.test);
};
