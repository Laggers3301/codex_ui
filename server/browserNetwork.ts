import { Agent, createServer, request as httpRequest } from 'node:http';
import { connect as netConnect, isIP, Socket } from 'node:net';
import { lookup } from 'node:dns/promises';
import { randomBytes } from 'node:crypto';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import type { AddressInfo } from 'node:net';

export class BrowserNetworkError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) { super(message); this.name = 'BrowserNetworkError'; this.statusCode = statusCode; }
}

function ipv4Number(s: string): number | null {
  if (isIP(s) !== 4) return null;
  return s.split('.').reduce((n, x) => ((n * 256) + Number(x)) >>> 0, 0);
}
function in4(n: number, base: number, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (n & mask) === (base & mask);
}
function ipv6Bytes(input: string): number[] | null {
  let s = input.toLowerCase().split('%')[0];
  if (isIP(s) !== 6) return null;
  const halves = s.split('::');
  const parse = (part: string) => part ? part.split(':').flatMap(x => x.includes('.') ? (() => { const n = ipv4Number(x); return n === null ? [] : [((n >>> 16) & 65535).toString(16), (n & 65535).toString(16)]; })() : [x]) : [];
  const a = parse(halves[0]), b = parse(halves[1] || '');
  const words = halves.length === 2 ? [...a, ...Array(8 - a.length - b.length).fill('0'), ...b] : a;
  if (words.length !== 8) return null;
  return words.flatMap(w => { const n = parseInt(w, 16); return [n >> 8, n & 255]; });
}
function isPublicV6(ip: string): boolean {
  const b = ipv6Bytes(ip); if (!b) return false;
  const allZero = b.every(x => x === 0), loopback = b.slice(0, 15).every(x => x === 0) && b[15] === 1;
  if (allZero || loopback) return false;
  const mapped = b.slice(0, 10).every(x => x === 0) && b[10] === 255 && b[11] === 255;
  if (mapped) return isPublicAddress(b.slice(12).join('.'));
  // Only globally-routable unicast 2000::/3. Exclude special-purpose and transition ranges.
  if ((b[0] & 0xe0) !== 0x20) return false;
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] <= 1) return false; // 2001::/23 special-purpose / transition
  if (b[0] === 0x20 && b[1] === 0x02) return false; // 6to4
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return false; // documentation
  return true;
}
export function isPublicAddress(address: string): boolean {
  const s = address.trim().replace(/^\[|\]$/g, '');
  const n = ipv4Number(s);
  if (n !== null) {
    return ![
      [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8],
      [0xa9fe0000, 16], [0xac100000, 12], [0xc0a80000, 16], [0xc0000000, 24],
      [0xc0000200, 24], [0xc0586300, 24], [0xc6120000, 15], [0xc6336400, 24],
      [0xcb007100, 24], [0xe0000000, 4], [0xf0000000, 4],
    ].some(([base, bits]) => in4(n, base as number, bits as number));
  }
  return isPublicV6(s);
}

export function validateBrowserUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new BrowserNetworkError('Invalid URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new BrowserNetworkError('Only public HTTP(S) URLs are allowed');
  const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
  if ((url.protocol === 'http:' && port !== 80) || (url.protocol === 'https:' && port !== 443)) throw new BrowserNetworkError('Target port is not allowed');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || (isIP(hostname) && !isPublicAddress(hostname))) throw new BrowserNetworkError('Private destinations are not allowed');
  return url;
}

type ProxyDependencies = {
  /** Test seam: resolution is still subjected to the production public-IP policy. */
  lookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  /** Test seam: receives only the selected, already-validated address. */
  connect?: (options: { host: string; port: number; family: number }) => Socket;
  upstreamProxy?: string;
};

export async function createBrowserProxy(options: ProxyDependencies = {}): Promise<{ server: string; username: string; password: string; close: () => Promise<void> }> {
  const username = randomBytes(18).toString('hex'), password = randomBytes(32).toString('hex');
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer();
  const trackSocket = <T extends Socket>(socket: T): T => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); return socket; };
  let active = 0;
  const auth = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const denied = (res: import('node:http').ServerResponse, code: number, message: string) => { res.writeHead(code, { 'content-type': 'text/plain', connection: 'close', ...(code === 407 ? { 'proxy-authenticate': 'Basic realm="browser-proxy"' } : {}) }); res.end(message); };
  const connect = options.connect || (socketOptions => netConnect(socketOptions));
  const configuredProxy = options.upstreamProxy ?? process.env.CODEX_WEB_BROWSER_EGRESS_PROXY;
  let egressProxy: URL | undefined;
  if (configuredProxy) {
    try {
      egressProxy = new URL(configuredProxy);
      if (egressProxy.protocol !== 'http:' || !egressProxy.hostname || egressProxy.pathname !== '/' || egressProxy.search || egressProxy.hash) throw new Error();
    } catch { throw new BrowserNetworkError('Invalid configured egress proxy'); }
  }
  const connectPinned = async (host: string, port: number, family: number): Promise<Socket> => {
    if (!egressProxy) {
      const socket = trackSocket(connect({ host, port, family }));
      if (!socket.connecting) return socket;
      await new Promise<void>((resolveConnection, reject) => {
        const timer = setTimeout(() => { socket.destroy(); reject(new Error('Upstream connect timeout')); }, 10_000);
        socket.once('connect', () => { clearTimeout(timer); resolveConnection(); });
        socket.once('error', error => { clearTimeout(timer); reject(error); });
      });
      return socket;
    }
    const gatewayHost = egressProxy.hostname.replace(/^\[|\]$/g, '');
    const socket = trackSocket(netConnect({ host: gatewayHost, port: Number(egressProxy.port || 80) }));
    const authority = family === 6 ? `[${host}]:${port}` : `${host}:${port}`;
    const proxyAuth = egressProxy.username || egressProxy.password
      ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(egressProxy.username)}:${decodeURIComponent(egressProxy.password)}`).toString('base64')}\r\n`
      : '';
    socket.setTimeout(10_000);
    try {
      await new Promise<void>((resolveConnection, reject) => {
        const timer = setTimeout(() => { socket.destroy(); reject(new Error('Egress proxy connect timeout')); }, 10_000);
        socket.once('connect', () => { clearTimeout(timer); resolveConnection(); });
        socket.once('error', error => { clearTimeout(timer); reject(error); });
      });
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${proxyAuth}Proxy-Connection: keep-alive\r\n\r\n`);
      let buffered = Buffer.alloc(0);
      await new Promise<void>((resolveResponse, reject) => {
        const onData = (chunk: Buffer) => {
          buffered = Buffer.concat([buffered, chunk]);
          if (buffered.length > 16384) { reject(new Error('Egress proxy headers too large')); return; }
          const end = buffered.indexOf('\r\n\r\n'); if (end < 0) return;
          socket.off('data', onData);
          if (!/^HTTP\/1\.[01] 200\b/.test(buffered.subarray(0, end).toString())) { reject(new Error('Egress proxy CONNECT rejected')); return; }
          const extra = buffered.subarray(end + 4); if (extra.length) socket.unshift(extra);
          resolveResponse();
        };
        socket.on('data', onData); socket.once('error', reject); socket.once('timeout', () => reject(new Error('Egress proxy timeout')));
      });
      socket.setTimeout(0);
      return socket;
    } catch (error) { socket.destroy(); throw error; }
  };
  // Resolve through the same trusted egress path, then CONNECT the validated IP.
  // Local DNS can return polluted public addresses even while the proxy works.
  // Resolving only A records is intentional: all actual destination sockets use
  // these exact IPv4 addresses, never an unchecked remote hostname/AAAA answer.
  const dnsCache = new Map<string, { expires: number; rows: Array<{ address: string; family: number }> }>();
  const dnsPending = new Map<string, Promise<Array<{ address: string; family: number }>>>();
  const resolve = options.lookup || (async (host: string) => {
    if (!egressProxy) return lookup(host, { all: true, verbatim: true });
    const cached = dnsCache.get(host);
    if (cached && cached.expires > Date.now()) return cached.rows;
    if (dnsPending.has(host)) return dnsPending.get(host)!;
    const pending = (async () => {
      const socket = await connectPinned('1.1.1.1', 443, 4);
      const agent = new HttpsAgent({ keepAlive: false });
      agent.createConnection = () => tlsConnect({ socket, servername: 'cloudflare-dns.com', rejectUnauthorized: true });
      try {
        const answer = await new Promise<{ Status?: number; Answer?: Array<{ type: number; data: string; TTL: number }> }>((done, fail) => {
          const req = httpsRequest(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`, { agent, headers: { accept: 'application/dns-json' } }, res => {
            let data = '';
            res.on('data', chunk => { data += chunk.toString(); if (data.length > 65536) req.destroy(new Error('DNS response too large')); });
            res.on('error', fail);
            res.on('end', () => {
              if (res.statusCode !== 200) return fail(new Error('Secure DNS unavailable'));
              try { done(JSON.parse(data)); } catch { fail(new Error('Invalid secure DNS response')); }
            });
          });
          req.setTimeout(8000, () => req.destroy(new Error('Secure DNS timeout')));
          req.on('error', fail); req.end();
        });
        if (answer.Status !== 0) throw new BrowserNetworkError('Secure DNS lookup failed');
        const records = answer.Answer?.filter(row => row.type === 1) || [];
        const rows = records.map(row => ({ address: row.data, family: 4 }));
        if (!rows.length || rows.some(row => isIP(row.address) !== 4)) throw new BrowserNetworkError('Secure DNS has no public IPv4 answer');
        if (dnsCache.size >= 256) dnsCache.delete(dnsCache.keys().next().value!);
        dnsCache.set(host, { rows, expires: Date.now() + Math.min(60, ...records.map(row => Math.max(0, row.TTL || 0))) * 1000 });
        return rows;
      } finally { agent.destroy(); socket.destroy(); }
    })().finally(() => { dnsPending.delete(host); });
    dnsPending.set(host, pending); return pending;
  });
  const resolvePublic = async (host: string) => {
    if (isIP(host)) { if (!isPublicAddress(host)) throw new BrowserNetworkError('Private destination', 403); return [{ address: host, family: isIP(host) }]; }
    const rows = await resolve(host);
    if (!rows.length || rows.some(r => !isPublicAddress(r.address))) throw new BrowserNetworkError('Private destination', 403);
    return rows;
  };
  server.on('connection', socket => { trackSocket(socket); socket.on('error', () => socket.destroy()); socket.setTimeout(60_000, () => socket.destroy()); });
  server.on('request', async (req, res) => {
    if (req.headers['proxy-authorization'] !== auth) return denied(res, 407, 'Proxy authentication required');
    if (++active > 128) { active--; return denied(res, 503, 'Proxy busy'); }
    let abortUpstream: (() => void) | undefined;
    res.once('close', () => { active = Math.max(0, active - 1); abortUpstream?.(); });
    try {
      if (req.headers.upgrade) return denied(res, 501, 'Upgrade not supported');
      const u = validateBrowserUrl(req.url || '');
      const addresses = await resolvePublic(u.hostname.replace(/^\[|\]$/g, ''));
      const chosen = addresses[0];
      const headers: import('node:http').OutgoingHttpHeaders = { ...req.headers, host: u.host };
      delete headers['proxy-authorization']; delete headers['proxy-connection'];
      const agent = new Agent({ keepAlive: false });
      if (egressProxy) {
        agent.createConnection = (_agentOptions, callback) => {
          void connectPinned(chosen.address, Number(u.port || 80), chosen.family).then(socket => callback!(null, socket), error => callback!(error as Error, null as unknown as Socket));
          return undefined;
        };
      } else {
        agent.createConnection = () => trackSocket(connect({ host: chosen.address, port: Number(u.port || 80), family: chosen.family }));
      }
      const upstream = httpRequest({ host: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), method: req.method, path: `${u.pathname}${u.search}`, headers, agent }, upstreamRes => {
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers); upstreamRes.pipe(res);
      });
      abortUpstream = () => upstream.destroy();
      upstream.once('close', () => agent.destroy());
      upstream.setTimeout(10_000, () => upstream.destroy(new Error('connect timeout')));
      upstream.on('error', () => { if (!res.headersSent) denied(res, 502, 'Upstream unavailable'); else res.destroy(); });
      req.pipe(upstream);
    } catch (e) { denied(res, e instanceof BrowserNetworkError ? e.statusCode : 502, 'Request denied'); }
  });
  server.on('connect', async (req, client, head) => {
    if (req.headers['proxy-authorization'] !== auth) { client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="browser-proxy"\r\nConnection: close\r\n\r\n'); return; }
    if (++active > 128) { active--; client.end('HTTP/1.1 503 Proxy Busy\r\nConnection: close\r\n\r\n'); return; }
    let upstream: import('node:net').Socket | undefined;
    const finish = () => { active = Math.max(0, active - 1); };
    client.once('close', finish);
    client.on('error', () => upstream?.destroy());
    try {
      const u = validateBrowserUrl(`https://${req.url}/`);
      if (!u.port && !(req.url || '').endsWith(':443')) throw new BrowserNetworkError('Target port is not allowed');
      const host = u.hostname.replace(/^\[|\]$/g, ''), addresses = await resolvePublic(host), chosen = addresses[0];
      upstream = await connectPinned(chosen.address, 443, chosen.family);
      upstream.setTimeout(10_000, () => upstream?.destroy());
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client);
      upstream.once('error', () => { client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); });
      client.once('close', () => upstream?.destroy());
    } catch { client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); }
  });
  server.on('error', () => { for (const socket of sockets) socket.destroy(); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const addr = server.address() as AddressInfo;
  return { server: `http://127.0.0.1:${addr.port}`, username, password, close: () => new Promise<void>(resolve => { for (const s of sockets) s.destroy(); server.close(() => resolve()); }) };
}
