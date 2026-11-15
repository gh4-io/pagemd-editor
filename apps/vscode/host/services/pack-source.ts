// Where profile packs come from (phase L3, R-263, R-264): a folder (a local or Nextcloud folder holding `index.json` and the zips), an
// `https://` address of an `index.json`, or the library's GitHub releases (a private repo, read with the user's VS Code GitHub sign-in).
// This file is the ONLY place in the editor that touches the network (a test scans for that), and it never imports `vscode`, so it is
// tested without VS Code. Rules, all checked here:
//   - https only (an `http://` address is refused); a redirect may not leave https;
//   - the sign-in token goes only to the hosts in `authHosts` (api.github.com, github.com), and is dropped on a redirect to any other host
//     (GitHub redirects an asset download to a short-lived address on another host); it is never logged, never in an error message;
//   - every request has a timeout and a size limit (the index 1 MB, a zip the size its index entry says, never over the pack limit);
//   - everything is read into memory; the caller checks the checksum and the pack's contents before anything is written.
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { EXIT, MAX_INDEX, MAX_PACK, PackError, parseIndex, type IndexPack, type PackIndex } from '@pagemd-editor/output-pagemd/packs';

export const GITHUB_API = 'https://api.github.com';
/** The hosts that may receive the sign-in token. Asset downloads redirect elsewhere; the token does not follow. */
export const GITHUB_AUTH_HOSTS: readonly string[] = ['api.github.com', 'github.com'];
/** The library's repository (offered by the command when no source is set). */
export const LIBRARY_REPO_URL = 'https://github.com/gh4-io/pagemd-library';
export const LIMITS = { index: MAX_INDEX, release: 4 * 1024 * 1024, pack: MAX_PACK, requestMs: 30_000, packMs: 180_000, redirects: 5 } as const;

export type SourceErrorKind = 'bad-source' | 'insecure' | 'offline' | 'timeout' | 'cancelled' | 'status' | 'too-large' | 'bad-reply' | 'no-access';

/** A source that cannot be read; `kind` lets the caller say the right thing (offline is not an error to shout about). */
export class SourceError extends Error {
  constructor(
    message: string,
    readonly kind: SourceErrorKind,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SourceError';
  }
}

export type SourceSpec =
  | { kind: 'folder'; path: string }
  | { kind: 'github'; owner: string; repo: string; tag: string | null }
  | { kind: 'https'; url: string };

/** What `profilePacks.source` holds: a folder path or an `https://` address. Anything else (http, file, ftp, a relative path) is refused. */
export function parseSource(text: string, homePath = ''): SourceSpec {
  const value = text.trim();
  if (value === '') throw new SourceError('No source is set.', 'bad-source');
  const scheme = /^([a-z][a-z0-9+.-]+):\/\//i.exec(value);
  if (scheme) {
    if (scheme[1]!.toLowerCase() !== 'https') throw new SourceError(`Only https:// addresses are accepted, not ${scheme[1]!.toLowerCase()}:// (a pack source must be encrypted).`, 'insecure');
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new SourceError(`"${value}" is not a web address.`, 'bad-source');
    }
    if (url.username || url.password) throw new SourceError('A source address may not contain a user name or password.', 'bad-source');
    if (url.hostname.toLowerCase() === 'github.com') {
      const parts = url.pathname.split('/').filter(Boolean);
      const [owner, rawRepo] = parts;
      if (!owner || !rawRepo) throw new SourceError('A GitHub source looks like https://github.com/<owner>/<repository>.', 'bad-source');
      const repo = rawRepo.replace(/\.git$/, '');
      const name = /^[A-Za-z0-9_.-]+$/;
      if (!name.test(owner) || !name.test(repo)) throw new SourceError('That GitHub owner or repository name has characters GitHub does not allow.', 'bad-source');
      const tag = parts[2] === 'releases' && parts[3] === 'tag' && parts[4] ? decodeURIComponent(parts[4]) : null;
      return { kind: 'github', owner, repo, tag };
    }
    // Any other address: the index.json itself, or the folder that holds it.
    url.hash = '';
    if (!url.pathname.toLowerCase().endsWith('.json')) url.pathname = `${url.pathname.replace(/\/+$/, '')}/index.json`;
    return { kind: 'https', url: url.toString() };
  }
  // A network share (\\server\share, //server/share, \\?\UNC\…) is refused: on Windows, opening one makes the computer sign in to
  // that server with the user's Windows credentials (security review of L3, item 5). A mapped drive letter is the user's own choice.
  if (/^[\\/]{2}/.test(value)) throw new SourceError(`"${value}" is a network share; copy the packs to a folder on this computer (a synced folder such as Nextcloud is fine), or use an https:// address.`, 'bad-source');
  const expanded = value === '~' || value.startsWith('~/') || value.startsWith('~\\') ? nodePath.join(homePath, value.slice(1)) : value;
  if (!nodePath.isAbsolute(expanded) && !/^[A-Za-z]:[\\/]/.test(expanded)) throw new SourceError(`"${value}" is not a full folder path (give the whole path, or an https:// address).`, 'bad-source');
  return { kind: 'folder', path: expanded };
}

/** Words for the picker and the log. */
export function describeSource(spec: SourceSpec): string {
  if (spec.kind === 'folder') return spec.path;
  if (spec.kind === 'github') return `GitHub ${spec.owner}/${spec.repo} (${spec.tag ? `release ${spec.tag}` : 'latest release'})`;
  return spec.url;
}

// ── HTTP ──

export interface HttpOptions {
  /** The `fetch` to use (the extension host's: VS Code gives it the proxy and certificate settings). */
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  /** Sent as `Authorization: Bearer` only to a host in `authHosts`, on every hop. */
  token?: string | null;
  authHosts?: readonly string[];
  maxBytes: number;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Tests only: allow `http://127.0.0.1` / `localhost` (a local server). Never set by the command. */
  allowLoopbackHttp?: boolean;
  log?: (line: string) => void;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const isLoopback = (host: string): boolean => host === '127.0.0.1' || host === 'localhost' || host === '[::1]';

function checkUrl(url: URL, options: HttpOptions): void {
  if (url.protocol === 'https:') return;
  if (url.protocol === 'http:' && options.allowLoopbackHttp && isLoopback(url.hostname)) return;
  throw new SourceError(`Refused ${url.protocol}//${url.hostname}: only https:// addresses are used.`, 'insecure');
}

/** One GET with the rules above. Returns the body (in memory) and the status. */
export async function httpGet(start: string, options: HttpOptions): Promise<{ status: number; body: Buffer; headers: Headers }> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const authHosts = options.authHosts ?? GITHUB_AUTH_HOSTS;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);
  const onAbort = (): void => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener('abort', onAbort);
  try {
    let current = new URL(start);
    for (let hop = 0; hop <= LIMITS.redirects; hop++) {
      checkUrl(current, options);
      const headers: Record<string, string> = { 'User-Agent': 'pagemd-editor', ...options.headers };
      if (options.token && authHosts.includes(current.hostname) && (current.protocol === 'https:' || options.allowLoopbackHttp)) headers['Authorization'] = `Bearer ${options.token}`;
      // The log names the host and path, never the query (a redirect address carries a short-lived signature) and never a header.
      options.log?.(`GET ${current.hostname}${current.pathname}${hop > 0 ? ' (redirected)' : ''}`);
      let response: Response;
      try {
        response = await doFetch(current, { headers, redirect: 'manual', signal: controller.signal });
      } catch (error) {
        if (options.signal?.aborted) throw new SourceError('Cancelled.', 'cancelled');
        if (timedOut) throw new SourceError(`${current.hostname} did not answer in time.`, 'timeout');
        const cause = (error as { cause?: { code?: string } } | undefined)?.cause?.code;
        throw new SourceError(`Could not reach ${current.hostname}${cause ? ` (${cause})` : ''}.`, 'offline');
      }
      if (REDIRECTS.has(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => undefined);
        if (!location) throw new SourceError(`${current.hostname} answered a redirect without an address.`, 'bad-reply', response.status);
        current = new URL(location, current);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new SourceError(`${current.hostname} answered HTTP ${response.status}.`, response.status === 401 || response.status === 403 || response.status === 404 ? 'no-access' : 'status', response.status);
      }
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > options.maxBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw new SourceError(`The download is ${declared} bytes; the limit here is ${options.maxBytes}.`, 'too-large');
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      const reader = response.body?.getReader();
      try {
        while (reader) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > options.maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw new SourceError(`The download is larger than the ${options.maxBytes} bytes allowed; it was stopped.`, 'too-large');
          }
          chunks.push(value);
        }
      } catch (error) {
        if (error instanceof SourceError) throw error;
        if (options.signal?.aborted) throw new SourceError('Cancelled.', 'cancelled');
        if (timedOut) throw new SourceError(`${current.hostname} stopped answering in time.`, 'timeout');
        throw new SourceError(`The download from ${current.hostname} broke off.`, 'offline');
      }
      return { status: response.status, body: Buffer.concat(chunks), headers: response.headers };
    }
    throw new SourceError('Too many redirects.', 'bad-reply');
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

// ── The opened source ──

export interface OpenedSource {
  /** For messages ("GitHub gh4-io/pagemd-library (latest release)"). */
  label: string;
  kind: SourceSpec['kind'];
  index: PackIndex;
  /** The zip of one index entry, in memory, at most the size its entry says. The caller verifies it. */
  readPack(entry: IndexPack, signal?: AbortSignal): Promise<Buffer>;
}

export interface SourceDeps {
  fetch?: typeof fetch;
  /** The GitHub sign-in: `create` false asks for an existing session without a prompt; true may show VS Code's sign-in. Returns the token or null. */
  getToken?: (create: boolean) => Promise<string | null>;
  apiBase?: string;
  authHosts?: readonly string[];
  allowLoopbackHttp?: boolean;
  homePath?: string;
  log?: (line: string) => void;
}

/** The size a pack's zip may be: what its index entry says, never over the pack limit. */
export function sizeLimit(entry: IndexPack): number {
  if (entry.size === undefined) return LIMITS.pack;
  if (!Number.isInteger(entry.size) || entry.size <= 0 || entry.size > LIMITS.pack) throw new PackError(`${entry.file}: the index gives a size (${String(entry.size)}) that cannot be right (the limit is ${LIMITS.pack} bytes).`, EXIT.usage);
  return entry.size;
}

const SHA = /^[0-9a-f]{64}$/i;
function checkEntry(entry: IndexPack): void {
  if (!SHA.test(entry.sha256)) throw new PackError(`${entry.file}: the index has no usable checksum, so the pack is not installed.`, EXIT.usage);
}

export async function openSource(spec: SourceSpec, deps: SourceDeps = {}, signal?: AbortSignal): Promise<OpenedSource> {
  if (spec.kind === 'folder') return openFolder(spec.path);
  if (spec.kind === 'https') return openHttps(spec.url, deps, signal);
  return openGithub(spec, deps, signal);
}

function openFolder(folder: string): OpenedSource {
  const indexFile = nodePath.join(folder, 'index.json');
  let stat: fs.Stats;
  try {
    stat = fs.statSync(indexFile);
  } catch {
    throw new SourceError(`There is no index.json in ${folder}.`, 'offline');
  }
  if (!stat.isFile()) throw new SourceError(`${indexFile} is not a file.`, 'bad-reply');
  if (stat.size > MAX_INDEX) throw new PackError(`${indexFile} is larger than ${MAX_INDEX} bytes`, EXIT.usage);
  const index = parseIndex(fs.readFileSync(indexFile, 'utf8'), indexFile);
  return {
    label: folder,
    kind: 'folder',
    index,
    async readPack(entry) {
      checkEntry(entry);
      const limit = sizeLimit(entry);
      const file = nodePath.join(folder, entry.file);
      const st = fs.lstatSync(file, { throwIfNoEntry: false });
      if (!st?.isFile()) throw new SourceError(`${entry.file} is not in ${folder}.`, 'bad-reply');
      if (st.size > limit) throw new SourceError(`${entry.file} is ${st.size} bytes; its index entry says ${limit}. Refused before it was read.`, 'too-large');
      return fs.readFileSync(file);
    },
  };
}

async function openHttps(url: string, deps: SourceDeps, signal?: AbortSignal): Promise<OpenedSource> {
  const common = { fetch: deps.fetch, authHosts: deps.authHosts, allowLoopbackHttp: deps.allowLoopbackHttp, log: deps.log, signal };
  const reply = await httpGet(url, { ...common, maxBytes: LIMITS.index, timeoutMs: LIMITS.requestMs, headers: { Accept: 'application/json' } });
  const index = parseIndex(reply.body.toString('utf8'), url);
  return {
    label: url,
    kind: 'https',
    index,
    async readPack(entry, packSignal) {
      checkEntry(entry);
      const got = await httpGet(new URL(entry.file, url).toString(), { ...common, signal: packSignal ?? signal, maxBytes: sizeLimit(entry), timeoutMs: LIMITS.packMs });
      return got.body;
    },
  };
}

interface Asset {
  name: string;
  url: string;
  size?: number;
}

function assetsOf(value: unknown): Asset[] {
  if (!Array.isArray(value)) return [];
  const out: Asset[] = [];
  for (const a of value as Record<string, unknown>[]) {
    if (a && typeof a['name'] === 'string' && typeof a['url'] === 'string') out.push({ name: a['name'], url: a['url'], ...(typeof a['size'] === 'number' ? { size: a['size'] } : {}) });
  }
  return out;
}

async function openGithub(spec: Extract<SourceSpec, { kind: 'github' }>, deps: SourceDeps, signal?: AbortSignal): Promise<OpenedSource> {
  const api = deps.apiBase ?? GITHUB_API;
  const apiHost = new URL(api).hostname;
  const common = { fetch: deps.fetch, authHosts: deps.authHosts ?? GITHUB_AUTH_HOSTS, allowLoopbackHttp: deps.allowLoopbackHttp, log: deps.log, signal };
  const repoPath = `/repos/${spec.owner}/${spec.repo}`;
  const releaseUrl = `${api}${repoPath}/releases/${spec.tag ? `tags/${encodeURIComponent(spec.tag)}` : 'latest'}`;
  const json = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };

  // First with a session VS Code already has (no prompt), else with none (a public repository needs no sign-in); only when GitHub says
  // "not found / not allowed" is the sign-in dialog shown, because a private repository answers 404 to a stranger.
  let token = (await deps.getToken?.(false)) ?? null;
  let release: Record<string, unknown>;
  const fetchRelease = async (): Promise<Record<string, unknown>> => {
    const reply = await httpGet(releaseUrl, { ...common, token, maxBytes: LIMITS.release, timeoutMs: LIMITS.requestMs, headers: json });
    try {
      return JSON.parse(reply.body.toString('utf8')) as Record<string, unknown>;
    } catch {
      throw new SourceError('GitHub did not answer with a release.', 'bad-reply');
    }
  };
  try {
    release = await fetchRelease();
  } catch (error) {
    if (!(error instanceof SourceError) || error.kind !== 'no-access') throw error;
    if (!token && deps.getToken) {
      token = await deps.getToken(true);
      if (token) {
        try {
          release = await fetchRelease();
        } catch (second) {
          if (second instanceof SourceError && second.kind === 'no-access') throw new SourceError(`GitHub says ${spec.owner}/${spec.repo} has no release for this account (HTTP ${second.status}). Sign in with the GitHub account that can see the repository.`, 'no-access', second.status);
          throw second;
        }
      } else {
        throw new SourceError(`${spec.owner}/${spec.repo} needs a GitHub sign-in to read its releases, and none was given.`, 'no-access', error.status);
      }
    } else {
      throw new SourceError(`GitHub says ${spec.owner}/${spec.repo} has no release for this account (HTTP ${error.status}). Sign in with the GitHub account that can see the repository.`, 'no-access', error.status);
    }
  }
  const assets = assetsOf(release['assets']);
  const download = (asset: Asset, maxBytes: number, timeoutMs: number, s?: AbortSignal): Promise<Buffer> => {
    // The release's own asset address must be on the API host: a reply cannot point the token somewhere else.
    if (new URL(asset.url).hostname !== apiHost) throw new SourceError(`The release lists ${asset.name} at an address outside ${apiHost}; refused.`, 'bad-reply');
    return httpGet(asset.url, { ...common, signal: s ?? signal, token, maxBytes, timeoutMs, headers: { Accept: 'application/octet-stream' } }).then((r) => r.body);
  };
  const indexAsset = assets.find((a) => a.name === 'index.json');
  if (!indexAsset) throw new SourceError(`The ${String(release['tag_name'] ?? 'latest')} release of ${spec.owner}/${spec.repo} has no index.json.`, 'bad-reply');
  const index = parseIndex((await download(indexAsset, LIMITS.index, LIMITS.requestMs)).toString('utf8'), 'index.json');
  const tag = String(release['tag_name'] ?? '');
  return {
    label: `GitHub ${spec.owner}/${spec.repo} (${tag || 'release'})`,
    kind: 'github',
    index,
    async readPack(entry, packSignal) {
      checkEntry(entry);
      const limit = sizeLimit(entry);
      let asset = assets.find((a) => a.name === entry.file);
      if (!asset && typeof release['id'] === 'number') {
        // A release with many files: the release object may list only some; ask for the pages.
        for (let page = 1; page <= 10 && !asset; page++) {
          let more: Asset[];
          try {
            const reply = await httpGet(`${api}${repoPath}/releases/${release['id']}/assets?per_page=100&page=${page}`, { ...common, signal: packSignal ?? signal, token, maxBytes: LIMITS.release, timeoutMs: LIMITS.requestMs, headers: json });
            more = assetsOf(JSON.parse(reply.body.toString('utf8')));
          } catch (error) {
            if (error instanceof SourceError && error.kind === 'cancelled') throw error;
            break; // the page could not be read: the file is not found below
          }
          asset = more.find((a) => a.name === entry.file);
          if (more.length < 100) break;
        }
      }
      if (!asset) throw new SourceError(`${entry.file} is not a file of the ${tag} release; not installed.`, 'bad-reply');
      if (asset.size !== undefined && entry.size !== undefined && asset.size !== entry.size) throw new SourceError(`${entry.file}: the release has ${asset.size} bytes, the index says ${entry.size}; refused before downloading.`, 'too-large');
      return download(asset, limit, LIMITS.packMs, packSignal);
    },
  };
}
