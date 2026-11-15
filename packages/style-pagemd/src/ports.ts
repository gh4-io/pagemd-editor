/// <reference path="./pagemd-modules.d.ts" />
// The resolver's ports for one document (P5, amendment 6): the injected file system, pagemd's folder as the
// defaults (R-128), the document's folder as the working folder unless the host says otherwise.
import { posix, type Ports } from '@pagemd/resolver';
import type { StyleEnvironment } from './types.ts';

export function portsOf(documentPath: string, env: StyleEnvironment): Ports {
  const P = env.path ?? posix;
  return {
    fs: env.fs,
    env: {
      defaultsPath: env.pagemdPath,
      cwd: env.cwd ?? P.dirname(documentPath),
      path: P,
      ...(env.homePath ? { homePath: env.homePath } : {}),
      ...(env.sharedProfilesPath ? { sharedProfilesPath: env.sharedProfilesPath } : {}),
    },
    ...(env.log ? { log: env.log } : {}),
    ...(env.cache ? { cache: env.cache } : {}),
  };
}
