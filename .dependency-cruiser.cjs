// Layer rules for pagemd-editor (docs/architecture/layered-architecture.md §2, roadmap checkpoint 2).
// Each layer only uses the layers below it. Rules are written as folder PATTERNS, so a package that a
// later phase creates (preset-gfm, plugin-find, style-pagemd, output-html, components/ribbon, …) is
// covered the moment its folder exists. Run: npm run lint:layers (part of npm run check).
// test/layer-rules/layer-rules.test.ts plants a wrong-direction import for every rule and expects a failure.

// The only packages allowed to import @pagemd/* (roadmap checkpoint 2, rule R4).
const PAGEMD_ALLOWED = '^packages/(preset-pagemd|style-pagemd|plugin-diagnostics|output-pagemd)/';
// @pagemd/* before P4 is unresolved (module name); after P4 it resolves through a file: link into the
// pagemd-common checkout (real path) or node_modules.
const PAGEMD_TARGET = ['^@pagemd/', '(^|/)node_modules/@pagemd/', '(^|/)pagemd-common/'];

/**
 * Rule: files matching `from` may import workspace code only from `allowed`, plus their own package
 * (`own`; `$1` is the package folder captured by `from`).
 */
const onlyBelow = (name, comment, from, own, allowed) => ({
  name,
  comment,
  severity: 'error',
  from: { path: from },
  to: { path: '^(packages|apps)/', pathNot: [own, ...allowed] },
});

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // ── general hygiene ──
    { name: 'no-circular', severity: 'error', comment: 'Packages must not import each other in a circle.', from: {}, to: { circular: true } },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      comment: 'Every import must resolve (catches typos and missing dependencies). vscode is provided by VS Code at runtime; @pagemd/* is checked by its own rule.',
      from: {},
      to: { couldNotResolve: true, pathNot: ['^vscode$', '^@pagemd/'] },
    },
    { name: 'packages-not-to-apps', severity: 'error', comment: 'No package may import the app.', from: { path: '^packages/' }, to: { path: '^apps/' } },

    // ── the layer cake, bottom to top ──
    onlyBelow('core-is-the-bottom', 'core imports no other workspace package.', '^packages/core/', '^packages/core/', []),
    onlyBelow('transformer-uses-core-only', 'transformer may import core only.', '^packages/transformer/', '^packages/transformer/', ['^packages/core/']),
    onlyBelow('lossless-uses-transformer-core', 'lossless may import transformer and core only.', '^packages/lossless/', '^packages/lossless/', ['^packages/(core|transformer)/']),
    onlyBelow('presets-use-transformer-core', 'A preset may import transformer and core only (not other presets, plugins, components, lossless).', '^packages/(preset-[^/]+)/', '^packages/$1/', ['^packages/(core|transformer)/']),
    onlyBelow('plugins-use-transformer-core', 'A feature plugin may import core and transformer only (not other plugins, presets, components, lossless).', '^packages/(plugin-[^/]+)/', '^packages/$1/', ['^packages/(core|transformer)/']),
    onlyBelow('styles-use-core', 'A style provider may import core only.', '^packages/(style-[^/]+)/', '^packages/$1/', ['^packages/core/']),
    onlyBelow('outputs-use-core', 'An output provider may import core only.', '^packages/(output-[^/]+)/', '^packages/$1/', ['^packages/core/']),
    onlyBelow('components-use-core', 'A component may import core only; it asks the registry, never a preset or plugin.', '^packages/components/([^/]+)/', '^packages/components/$1/', ['^packages/core/']),

    // ── outside dependencies ──
    {
      name: 'pagemd-only-in-allowed-packages',
      severity: 'error',
      comment: 'Only preset-pagemd, style-pagemd, plugin-diagnostics and output-pagemd may import @pagemd/* (R4, invariants I1/I6/I7).',
      from: { pathNot: PAGEMD_ALLOWED },
      to: { path: PAGEMD_TARGET },
    },
    {
      name: 'style-pagemd-only-in-host',
      severity: 'error',
      comment: 'Only apps/vscode/host may import style-pagemd: it reads files, so it runs on the host; the webview gets its answer as messages (P5, amendment 12).',
      from: { pathNot: ['^apps/vscode/host/', '^packages/style-pagemd/'] },
      to: { path: '^packages/style-pagemd/' },
    },
    {
      name: 'outputs-only-in-host',
      severity: 'error',
      comment: 'Only apps/vscode/host may import an output provider: they read and write files and output-pagemd runs pagemd itself, so they run on the host; the webview asks for a preview or an export as messages (P10).',
      from: { pathNot: ['^apps/vscode/host/', '^packages/(output-[^/]+)/'] },
      to: { path: '^packages/output-[^/]+/' },
    },
    {
      name: 'diagnostics-checks-only-in-host',
      severity: 'error',
      comment: 'Only apps/vscode/host may import plugin-diagnostics/check: it runs @pagemd/validate over files, so it runs on the host; the webview gets the results as messages (P14, R-189).',
      from: { pathNot: ['^apps/vscode/host/', '^packages/plugin-diagnostics/'] },
      to: { path: '^packages/plugin-diagnostics/src/check' },
    },
    {
      name: 'diagnostics-hints-stay-pagemd-free',
      severity: 'error',
      comment: "plugin-diagnostics' webview side (every file but check.ts) imports neither @pagemd/* nor check.ts, so the webview bundle never carries the checks (P14).",
      from: { path: '^packages/plugin-diagnostics/src/', pathNot: '^packages/plugin-diagnostics/src/(check\\.ts|pagemd-modules\\.d\\.ts)$' },
      to: { path: [...PAGEMD_TARGET, '^packages/plugin-diagnostics/src/check'] },
    },
    {
      name: 'image-editor-dialogs-only',
      severity: 'error',
      comment: 'components/image-editor holds the image tools\' dialog only (P15, D30; narrowed in P27, ADR-0019: the pixel edits are gone): no ProseMirror, no markdown or YAML reader, no other workspace package. Shapes, the picture keys and their YAML are preset-pagemd\'s; the app joins the two.',
      from: { path: '^packages/components/image-editor/' },
      to: { path: ['(^|/)node_modules/(prosemirror-[^/]+|markdown-it|yaml|js-yaml)/', '^packages/', ...PAGEMD_TARGET], pathNot: '^packages/components/image-editor/' },
    },
    {
      name: 'vscode-only-in-host',
      severity: 'error',
      comment: 'Only apps/vscode/host may import the vscode API (invariant I5).',
      from: { pathNot: '^apps/vscode/host/' },
      to: { path: ['^vscode$', '(^|/)node_modules/@types/vscode/'] },
    },
    {
      name: 'host-and-webview-apart',
      severity: 'error',
      comment: 'Host (Node) and webview (browser) talk only through messages (invariant I5); neither imports the other.',
      from: { path: '^apps/vscode/(host|webview)/' },
      to: { path: '^apps/vscode/(host|webview)/', pathNot: '^apps/vscode/$1/' },
    },
    {
      name: 'shared-stays-neutral',
      severity: 'error',
      comment: 'apps/vscode/shared (the message contract) is used by both sides, so it imports neither host nor webview (I5).',
      from: { path: '^apps/vscode/shared/' },
      to: { path: '^apps/vscode/(host|webview)/' },
    },
    onlyBelow('shared-uses-core-only', 'The message contract may use core types only.', '^apps/vscode/shared/', '^apps/vscode/shared/', ['^packages/core/']),
  ],
  options: {
    // pagemd-common is linked with file: paths (R-40), so its modules resolve to their real path outside this
    // repo: the import is checked (pagemd-only-in-allowed-packages), its own files are not (their repo does, P4).
    doNotFollow: { path: ['node_modules', '(^|/)pagemd-common/'] },
    exclude: { path: ['(^|/)dist/', '(^|/)test/', '\\.test\\.ts$'] },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.web.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.js', '.mjs', '.cjs', '.json'],
    },
  },
};
