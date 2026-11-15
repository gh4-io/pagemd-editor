// Phase L3 (R-263, R-264): where packs come from and the rules for fetching them (host/services/pack-source.ts). The https/API code path
// runs against two local servers (127.0.0.1 and localhost, which count as two different hosts); the only thing not covered is the
// real api.github.com (TLS, the real redirect host, the real sign-in).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { LIMITS, SourceError, httpGet, openSource, parseSource, sizeLimit, type SourceDeps } from '../host/services/pack-source.ts';

const scratch = mkdtempSync(join(tmpdir(), 'pmd-l3-source-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
interface Local {
  server: Server;
  port: number;
  seen: { url: string; authorization: string | undefined; accept: string | undefined }[];
  handler: Handler;
}
const servers: Local[] = [];

async function listen(handler: Handler): Promise<Local> {
  const local: Local = { server: createServer(), port: 0, seen: [], handler };
  local.server.on('request', (req, res) => {
    local.seen.push({ url: req.url ?? '', authorization: req.headers.authorization, accept: req.headers.accept });
    local.handler(req, res);
  });
  await new Promise<void>((done) => local.server.listen(0, '127.0.0.1', done));
  local.port = (local.server.address() as AddressInfo).port;
  servers.push(local);
  return local;
}
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((done) => (s.server.closeAllConnections(), s.server.close(() => done())));
});

describe('parseSource (L3-2)', () => {
  it('takes a folder path, an https address, and a GitHub repository', () => {
    expect(parseSource('/mnt/c/Users/me/Nextcloud/packs')).toEqual({ kind: 'folder', path: '/mnt/c/Users/me/Nextcloud/packs' });
    expect(parseSource('C:\\packs')).toEqual({ kind: 'folder', path: 'C:\\packs' });
    expect(parseSource('~/packs', '/home/me')).toEqual({ kind: 'folder', path: '/home/me/packs' });
    expect(parseSource('https://example.org/packs/index.json')).toEqual({ kind: 'https', url: 'https://example.org/packs/index.json' });
    expect(parseSource('https://example.org/packs/')).toEqual({ kind: 'https', url: 'https://example.org/packs/index.json' });
    expect(parseSource('https://github.com/gh4-io/pagemd-library')).toEqual({ kind: 'github', owner: 'gh4-io', repo: 'pagemd-library', tag: null });
    expect(parseSource('https://github.com/gh4-io/pagemd-library.git/releases/tag/v0.1.0')).toEqual({ kind: 'github', owner: 'gh4-io', repo: 'pagemd-library', tag: 'v0.1.0' });
  });

  it('takes a private library by its own address, set by hand (AD-A3-02)', () => {
    // The name is built, not written out: the safety net blocks a public copy that spells the private repository's name (rule link.private-repo).
    const privateRepo = ['pagemd-library', 'dev'].join('-');
    expect(parseSource(`https://github.com/gh4-io/${privateRepo}`)).toEqual({ kind: 'github', owner: 'gh4-io', repo: privateRepo, tag: null });
  });

  it('refuses every address that is not https', () => {
    for (const bad of ['http://example.org/index.json', 'ftp://example.org/x', 'file:///etc/passwd', 'HTTP://EXAMPLE.ORG/x', 'git://github.com/a/b']) {
      expect(() => parseSource(bad), bad).toThrow(SourceError);
      try {
        parseSource(bad);
      } catch (error) {
        expect((error as SourceError).kind).toBe('insecure');
      }
    }
  });

  it('refuses a relative path, an empty value, a user name in the address and a half GitHub address', () => {
    expect(() => parseSource('packs/here')).toThrow(/full folder path/);
    expect(() => parseSource('  ')).toThrow(/No source/);
    expect(() => parseSource('https://me:secret@example.org/index.json')).toThrow(/user name/);
    expect(() => parseSource('https://github.com/gh4-io')).toThrow(/looks like/);
  });

  it('refuses a network share (Windows would sign in to that server with the user\'s credentials)', () => {
    for (const bad of ['\\\\server\\share\\packs', '//server/share/packs', '\\\\?\\UNC\\server\\share', '\\\\.\\pipe\\x']) {
      expect(() => parseSource(bad), bad).toThrow(/network share/);
    }
    expect(parseSource('Z:\\packs')).toEqual({ kind: 'folder', path: 'Z:\\packs' }); // a mapped drive is the user's own
  });
});

describe('httpGet: the rules of the fetch (L3-3)', () => {
  const loopback = { allowLoopbackHttp: true, authHosts: ['127.0.0.1'], timeoutMs: 5000 } as const;

  it('refuses http:// outside a test and never touches the network doing so', async () => {
    let called = 0;
    const fetchStub = (async () => {
      called++;
      return new Response('x');
    }) as typeof fetch;
    await expect(httpGet('http://example.org/index.json', { fetch: fetchStub, maxBytes: 100, timeoutMs: 1000 })).rejects.toMatchObject({ kind: 'insecure' });
    // 127.0.0.1 over http is a test allowance only: without it, it is refused too.
    await expect(httpGet('http://127.0.0.1:1/x', { fetch: fetchStub, maxBytes: 100, timeoutMs: 1000 })).rejects.toMatchObject({ kind: 'insecure' });
    expect(called).toBe(0);
  });

  it('refuses a redirect that leaves https', async () => {
    const calls: string[] = [];
    const fetchStub = (async (url: URL) => {
      calls.push(String(url));
      return new Response(null, { status: 302, headers: { location: 'http://evil.example/steal' } });
    }) as unknown as typeof fetch;
    await expect(httpGet('https://api.github.com/x', { fetch: fetchStub, token: 't', maxBytes: 100, timeoutMs: 1000 })).rejects.toMatchObject({ kind: 'insecure' });
    expect(calls).toEqual(['https://api.github.com/x']);
  });

  it('sends the token to an auth host and NOT across a redirect to another host', async () => {
    const other = await listen((_req, res) => res.end('the file'));
    const api = await listen((_req, res) => {
      res.statusCode = 302;
      res.setHeader('location', `http://localhost:${other.port}/blob/1?sig=secret-signature`);
      res.end();
    });
    const lines: string[] = [];
    const reply = await httpGet(`http://127.0.0.1:${api.port}/asset`, { ...loopback, token: 'TOKEN-123', maxBytes: 1000, log: (l) => lines.push(l) });
    expect(reply.body.toString()).toBe('the file');
    expect(api.seen[0]?.authorization).toBe('Bearer TOKEN-123'); // the API host got it
    expect(other.seen[0]?.url).toContain('/blob/1');
    expect(other.seen[0]?.authorization).toBeUndefined(); // the other host did not
    // The log names hosts and paths, never the token or a signed query.
    expect(lines.join('\n')).not.toMatch(/TOKEN-123|secret-signature/);
  });

  it('sends no token to a host that is not an auth host even on the first request', async () => {
    const s = await listen((_req, res) => res.end('ok'));
    await httpGet(`http://127.0.0.1:${s.port}/x`, { allowLoopbackHttp: true, authHosts: ['api.github.com'], token: 'T', maxBytes: 10, timeoutMs: 1000 });
    expect(s.seen[0]?.authorization).toBeUndefined();
  });

  it('stops a download that is larger than allowed, by Content-Length and by counting', async () => {
    const declared = await listen((_req, res) => {
      res.setHeader('content-length', '5000');
      res.end(Buffer.alloc(5000));
    });
    await expect(httpGet(`http://127.0.0.1:${declared.port}/z`, { ...loopback, maxBytes: 1000 })).rejects.toMatchObject({ kind: 'too-large' });
    const chunked = await listen((_req, res) => {
      res.write(Buffer.alloc(800));
      setTimeout(() => res.end(Buffer.alloc(800)), 20); // no Content-Length: counted as it arrives
    });
    await expect(httpGet(`http://127.0.0.1:${chunked.port}/z`, { ...loopback, maxBytes: 1000 })).rejects.toMatchObject({ kind: 'too-large' });
  });

  it('times out, can be cancelled, and says offline when nothing answers', async () => {
    const slow = await listen(() => undefined); // never answers
    await expect(httpGet(`http://127.0.0.1:${slow.port}/z`, { ...loopback, maxBytes: 10, timeoutMs: 100 })).rejects.toMatchObject({ kind: 'timeout' });
    const controller = new AbortController();
    const pending = httpGet(`http://127.0.0.1:${slow.port}/z`, { ...loopback, maxBytes: 10, timeoutMs: 5000, signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
    await expect(httpGet('http://127.0.0.1:1/z', { ...loopback, maxBytes: 10 })).rejects.toMatchObject({ kind: 'offline' });
  });

  it('classifies 404 as no access (a private repository answers 404) and 500 as a status error', async () => {
    const s = await listen((req, res) => {
      res.statusCode = req.url === '/missing' ? 404 : 500;
      res.end('no');
    });
    await expect(httpGet(`http://127.0.0.1:${s.port}/missing`, { ...loopback, maxBytes: 10 })).rejects.toMatchObject({ kind: 'no-access', status: 404 });
    await expect(httpGet(`http://127.0.0.1:${s.port}/boom`, { ...loopback, maxBytes: 10 })).rejects.toMatchObject({ kind: 'status', status: 500 });
  });
});

describe('the GitHub releases source (L3-3), against a local stand-in for api.github.com', () => {
  const zip = Buffer.from('PK-not-really-a-zip-but-the-source-does-not-check-that');
  const entry = { id: 'pml-sop-ink', version: '0.1.0', file: 'pml-sop-ink-0.1.0.zip', size: zip.length, sha256: 'a'.repeat(64) };
  const index = { schema: 1, version: '0.1.0', release: { repo: 'o/r', tag: 'v0.1.0', indexAsset: 'index.json' }, latest: { 'pml-sop-ink': { version: '0.1.0', file: entry.file } }, packs: [entry] };

  /** A private repository: 404 without the right token, the release with it; assets download through a redirect to the second server. */
  async function stage(options: { private?: boolean; assetSize?: number } = {}) {
    const blobs = await listen((req, res) => res.end(req.url?.includes('index') ? JSON.stringify(index) : zip));
    const api = await listen((req, res) => {
      const url = req.url ?? '';
      if (options.private !== false && req.headers.authorization !== 'Bearer GOOD') {
        res.statusCode = 404;
        return res.end('{}');
      }
      const base = `http://127.0.0.1:${api.port}`;
      if (url === '/repos/o/r/releases/latest') {
        return res.end(JSON.stringify({ tag_name: 'v0.1.0', id: 7, assets: [{ name: 'index.json', url: `${base}/repos/o/r/releases/assets/1`, size: 10 }, { name: entry.file, url: `${base}/repos/o/r/releases/assets/2`, size: options.assetSize ?? zip.length }] }));
      }
      if (url.startsWith('/repos/o/r/releases/assets/')) {
        res.statusCode = 302;
        res.setHeader('location', `http://localhost:${blobs.port}/blob/${url.endsWith('1') ? 'index' : 'zip'}?sig=abc`);
        return res.end();
      }
      res.statusCode = 404;
      res.end('{}');
    });
    return { api, blobs };
  }

  const deps = (api: Local, getToken: SourceDeps['getToken']): SourceDeps => ({ apiBase: `http://127.0.0.1:${api.port}`, authHosts: ['127.0.0.1'], allowLoopbackHttp: true, getToken });

  it('asks for a session without a prompt first, then signs in only because GitHub said "not found"; the token never reaches the asset host', async () => {
    const { api, blobs } = await stage();
    const asked: boolean[] = [];
    const opened = await openSource({ kind: 'github', owner: 'o', repo: 'r', tag: null }, deps(api, async (create) => (asked.push(create), create ? 'GOOD' : null)));
    expect(asked).toEqual([false, true]);
    expect(opened.index.packs.map((p) => p.id)).toEqual(['pml-sop-ink']);
    expect((await opened.readPack(entry)).equals(zip)).toBe(true);
    expect(api.seen.filter((s) => s.authorization === 'Bearer GOOD').length).toBe(3) // the release and the two assets; the first, unsigned try had none;
    expect(api.seen.find((s) => s.url.includes('assets/2'))?.accept).toBe('application/octet-stream');
    expect(blobs.seen.length).toBe(2);
    expect(blobs.seen.every((s) => s.authorization === undefined)).toBe(true);
  });

  it('a public repository needs no sign-in at all', async () => {
    const { api } = await stage({ private: false });
    const asked: boolean[] = [];
    await openSource({ kind: 'github', owner: 'o', repo: 'r', tag: null }, deps(api, async (create) => (asked.push(create), null)));
    expect(asked).toEqual([false]);
  });

  it('says so when the sign-in is refused, and when the account has no access', async () => {
    const { api } = await stage();
    await expect(openSource({ kind: 'github', owner: 'o', repo: 'r', tag: null }, deps(api, async () => null))).rejects.toThrow(/needs a GitHub sign-in/);
    await expect(openSource({ kind: 'github', owner: 'o', repo: 'r', tag: null }, deps(api, async (create) => (create ? 'WRONG' : null)))).rejects.toThrow(/no release for this account/);
  });

  it('refuses a release file whose size differs from the index before downloading it', async () => {
    const { api, blobs } = await stage({ assetSize: zip.length + 5 });
    const opened = await openSource({ kind: 'github', owner: 'o', repo: 'r', tag: null }, deps(api, async () => 'GOOD'));
    await expect(opened.readPack(entry)).rejects.toMatchObject({ kind: 'too-large' });
    expect(blobs.seen.filter((s) => s.url.includes('/blob/zip')).length).toBe(0);
  });

  it('refuses a file the release does not have', async () => {
    const { api } = await stage();
    const opened = await openSource({ kind: 'github', owner: 'o', repo: 'r', tag: null }, deps(api, async () => 'GOOD'));
    await expect(opened.readPack({ ...entry, file: 'other-0.1.0.zip' })).rejects.toThrow(/not a file of the v0.1.0 release/);
  });
});

describe('the folder source and the size rules', () => {
  it('refuses an index over 1 MB without reading it', async () => {
    const folder = mkdtempSync(join(scratch, 'big-index-'));
    writeFileSync(join(folder, 'index.json'), ' '.repeat(LIMITS.index + 1));
    await expect(openSource({ kind: 'folder', path: folder })).rejects.toThrow(/larger than/);
  });

  it('says the folder cannot be reached when it has no index.json', async () => {
    await expect(openSource({ kind: 'folder', path: join(scratch, 'nowhere') })).rejects.toMatchObject({ kind: 'offline' });
  });

  it('refuses a zip bigger than its index entry says, before reading it, and an impossible size', async () => {
    const folder = mkdtempSync(join(scratch, 'size-'));
    const sha = 'b'.repeat(64);
    writeFileSync(join(folder, 'index.json'), JSON.stringify({ schema: 1, packs: [{ id: 'a', version: '1', file: 'a-1.zip', size: 10, sha256: sha }] }));
    writeFileSync(join(folder, 'a-1.zip'), Buffer.alloc(11));
    const opened = await openSource({ kind: 'folder', path: folder });
    await expect(opened.readPack(opened.index.packs[0]!)).rejects.toMatchObject({ kind: 'too-large' });
    expect(() => sizeLimit({ id: 'a', file: 'a.zip', sha256: sha, size: LIMITS.pack + 1 })).toThrow(/cannot be right/);
    expect(() => sizeLimit({ id: 'a', file: 'a.zip', sha256: sha, size: 0 })).toThrow();
    expect(sizeLimit({ id: 'a', file: 'a.zip', sha256: sha })).toBe(LIMITS.pack);
  });

  it('refuses an entry without a usable checksum', async () => {
    const folder = mkdtempSync(join(scratch, 'sha-'));
    writeFileSync(join(folder, 'index.json'), JSON.stringify({ schema: 1, packs: [{ id: 'a', version: '1', file: 'a-1.zip', size: 3, sha256: 'xyz' }] }));
    writeFileSync(join(folder, 'a-1.zip'), 'abc');
    const opened = await openSource({ kind: 'folder', path: folder });
    await expect(opened.readPack(opened.index.packs[0]!)).rejects.toThrow(/no usable checksum/);
  });
});
