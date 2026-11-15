# pagemd-editor

A Word-like, page-accurate visual editor for [pagemd](https://github.com/gh4-io/pagemd) documents inside VS Code.
You write on pages that already look like the final PDF, and every save changes only what you edited.

- **Using the extension:** [apps/vscode/README.md](apps/vscode/README.md) (views, commands, settings).
- **Requirements for building:** Node 24 (`.nvmrc`), and the sibling repositories
  [pagemd](https://github.com/gh4-io/pagemd) and [pagemd-common](https://github.com/gh4-io/pagemd-common) cloned
  next to this one (the editor builds pagemd's runtime from `../pagemd`, and its tests read both).

```bash
git clone https://github.com/gh4-io/pagemd.git
git clone https://github.com/gh4-io/pagemd-common.git
git clone https://github.com/gh4-io/pagemd-editor.git
cd pagemd-editor
npm install
npm run build      # the extension bundles
npm run check      # types and layer rules
npm test           # unit tests
npm run package    # pagemd-editor-<version>.vsix
```

## Licence

Apache License 2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE). The libraries bundled into the extension and
their licences are listed in [apps/vscode/ThirdPartyNotices.txt](apps/vscode/ThirdPartyNotices.txt).
