// pagemd's environment on the host (phase L2-1, L2-3, F6): the folders every lookup the editor makes starts from, built in one
// place. Before L2 the styles, the checks and the profile picker each built their own and disagreed on the home folder
// (`os.homedir()` in two, `HOME ?? USERPROFILE` in the third). Now all three take theirs from here:
//   - home: `os.homedir()` (what pagemd's own `nodeEnv()` uses);
//   - the shared profiles folder: pagemd's rule (@pagemd/resolver `sharedProfilesFolderInfo`, through style-pagemd): `$PAGEMD_CONFIG_DIR/profiles`
//     when PAGEMD_CONFIG_DIR is set in VS Code's environment, else %LOCALAPPDATA%\pagemd\profiles on Windows (and from WSL),
//     ~/Library/Application Support/pagemd/profiles on macOS, ${XDG_DATA_HOME:-~/.local/share}/pagemd/profiles on Linux.
// Read from the process environment each time (cheap: at most a few folder checks under WSL); the log names the folder once.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { SHARED_FOLDER_REASONS, sharedProfilesFolderInfo, type SharedFolderInfo } from '@pagemd-editor/style-pagemd';

export interface PagemdEnvironment {
  /** The user's home folder (`~/.pagemd/`). */
  homePath: string;
  /** The shared profiles folder (profile packs). It may not exist. */
  sharedProfilesPath: string;
  /** Why that folder (PAGEMD_CONFIG_DIR, windows, wsl-user, wsl-only-user, macos, xdg). */
  sharedProfilesReason: SharedFolderInfo['reason'];
}

/** Where the environment is read from (tests pass their own). */
export interface EnvironmentSource {
  env?: Record<string, string | undefined>;
  platform?: string;
  homePath?: string;
  exists?: (path: string) => boolean;
  list?: (path: string) => string[];
  osRelease?: string;
}

let logged: string | null = null;

/** The folders pagemd's lookups start from, the same for the canvas, the checks, Files in Use and the profile picker. */
export function pagemdEnvironment(log?: (line: string) => void, source: EnvironmentSource = {}): PagemdEnvironment {
  const homePath = source.homePath ?? os.homedir();
  const info = sharedProfilesFolderInfo({
    platform: source.platform ?? process.platform,
    env: source.env ?? process.env,
    homePath,
    exists: source.exists ?? ((p) => fs.existsSync(p)),
    list: source.list ?? ((p) => fs.readdirSync(p)),
    osRelease: source.osRelease ?? os.release(),
    path: nodePath,
  });
  const line = `Shared profiles folder: ${info.path} (${SHARED_FOLDER_REASONS[info.reason]})`;
  if (log && logged !== line) {
    logged = line;
    log(line);
  }
  return { homePath, sharedProfilesPath: info.path, sharedProfilesReason: info.reason };
}
