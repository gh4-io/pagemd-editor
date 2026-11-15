/// <reference path="./packs-modules.d.ts" />
// @pagemd-editor/output-pagemd/packs (phase L3): the one place in the editor that imports @pagemd/packs (layer rule R4), re-exported for the
// host's "Get Profile Packs" service. Node only (zlib, crypto, fs); the host imports it, the webview never does.
export {
  EXIT,
  MAX_INDEX,
  MAX_PACK,
  PackError,
  compareVersions,
  defaultTarget,
  findElsewhere,
  installPack,
  latestPacks,
  listInstalled,
  otherProfileFolders,
  parseIndex,
  readZip,
  uninstallPack,
  verifyPack,
  writeZip,
} from '@pagemd/packs';
export type { IndexPack, InstallResult, InstalledPack, PackIndex, VerifiedPack } from '@pagemd/packs';
