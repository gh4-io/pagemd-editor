// The build-numbering scheme (R-234, AD-RC-01..): every .vsix handed over for testing is a release candidate "<next minor>-rc.N".
// `npm run package:rc` bumps N, then builds; plain `npm run package` never changes the number; `npm run package -- --release`
// drops the "-rc.N" for the final version (a published "-rcN" stays as it is). The committed number is the LAST BUILT one ("0.0.1-rc.0" = nothing built yet).
// These are pure functions (no file access) so the tests can try them without touching the real package.json.
const RC = /^(\d+)\.(\d+)\.(\d+)-rc\.(\d+)$/;
const FINAL = /^(\d+)\.(\d+)\.(\d+)$/;
// A PUBLISHED release candidate is "X.Y.Z-rcN" with no dot (R-271: the first release is v0.0.1-rc1). The dotted "-rc.N" is the
// working build count; a published number is never counted up or changed by a build, so `--release` keeps it as it is.
const PUBLISHED = /^(\d+)\.(\d+)\.(\d+)-rc(\d+)$/;

/** The next version for `mode`: 'rc' (rc.N to rc.N+1; a final X.Y.Z starts the next minor, X.(Y+1).0-rc.1) or 'release' (drops "-rc.N"). */
export function bumpVersion(version, mode) {
  const rc = RC.exec(version);
  const final = FINAL.exec(version);
  const published = PUBLISHED.exec(version);
  if (!rc && !final && !published) throw new Error(`build-version: "${version}" is neither X.Y.Z nor X.Y.Z-rc.N nor X.Y.Z-rcN`);
  if (published) {
    if (mode === 'release') return version; // exactly the published number: the release copy carries 0.0.1-rc1, not 0.0.1
    if (mode === 'rc') return `${published[1]}.${published[2]}.${published[3]}-rc${Number(published[4]) + 1}`;
  }
  if (mode === 'rc') return rc ? `${rc[1]}.${rc[2]}.${rc[3]}-rc.${Number(rc[4]) + 1}` : `${final[1]}.${Number(final[2]) + 1}.0-rc.1`;
  if (mode === 'release') {
    if (!rc) throw new Error(`build-version: "${version}" is already a final version; there is no -rc.N to drop`);
    return `${rc[1]}.${rc[2]}.${rc[3]}`;
  }
  throw new Error(`build-version: unknown mode "${mode}" (use rc or release)`);
}

/**
 * Replaces the version in package.json text and in package-lock.json text (its "apps/vscode" entry), keeping everything else
 * byte for byte, so the bump is one small reviewable change. Throws when a file does not hold the expected current version.
 */
export function rewriteVersion(packageText, lockText, from, to) {
  const pkg = /^(  "version": ")([^"]+)(",)$/m;
  if (pkg.exec(packageText)?.[2] !== from) throw new Error(`build-version: package.json does not say version ${from}`);
  const lock = /("apps\/vscode": \{\n\s+"name": "pagemd-editor",\n\s+"version": ")([^"]+)(")/;
  if (lock.exec(lockText)?.[2] !== from) throw new Error(`build-version: package-lock.json's apps/vscode entry does not say version ${from}`);
  return { packageText: packageText.replace(pkg, `$1${to}$3`), lockText: lockText.replace(lock, `$1${to}$3`) };
}
