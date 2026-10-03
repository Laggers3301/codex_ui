import { describe, expect, it } from 'vitest';
import { isPublicAddress, validateBrowserUrl, BrowserNetworkError } from './browserNetwork.js';
import { createBrowserProxy } from './browserNetwork.js';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { connect as tcpConnect, createServer as createTcpServer } from 'node:net';
import type { AddressInfo } from 'node:net';

function listen(server: { listen: (port: number, host: string, callback: () => void) => unknown; address: () => string | AddressInfo | null }): Promise<number> {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}
function closeServer(server: { close: (cb?: (error?: Error) => void) => unknown }): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}
function proxyRequest(proxy: Awaited<ReturnType<typeof createBrowserProxy>>, target: string, authorization = `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}`) {
  const endpoint = new URL(proxy.server);
  return new Promise<{ status: number; body: string; challenge?: string }>((resolve, reject) => {
    const req = httpRequest({ host: endpoint.hostname, port: Number(endpoint.port), path: target, headers: { 'proxy-authorization': authorization } }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => body += chunk); res.on('end', () => resolve({ status: res.statusCode || 0, body, challenge: res.headers['proxy-authenticate'] }));
    });
    req.on('error', reject); req.end();
  });
}

describe('browser network URL and address guards', () => {
  it('allows public literals and rejects private and special ranges', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) expect(isPublicAddress(ip)).toBe(true);
    for (const ip of ['127.0.0.1', '10.0.0.1', '172.31.1.1', '192.168.1.1', '169.254.4.3', '100.64.0.1', '224.0.0.1', '::1', '::', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '2001:db8::1', '2002:0808:0808::1']) expect(isPublicAddress(ip)).toBe(false);
  });
  it('accepts only public HTTP(S) URLs on default ports without credentials', () => {
    expect(validateBrowserUrl('https://example.com/path').hostname).toBe('example.com');
    for (const url of ['file:///etc/passwd', 'http://localhost/', 'http://127.1/', 'http://[::ffff:7f00:1]/', 'http://user:pass@example.com/', 'http://example.com:8080/']) {
      expect(() => validateBrowserUrl(url), url).toThrow(BrowserNetworkError);
    }
  });
});

describe('authenticated browser proxy', () => {
  it('authenticates, challenges unsupported clients, forwards via the resolved pinned IP, and strips proxy credentials', async () => {
    let requestHost = '';
    const upstream = createHttpServer((req, res) => { requestHost = req.headers.host || ''; res.end(`ok:${req.url}:${req.headers['proxy-authorization'] || 'clean'}`); });
    const upstreamPort = await listen(upstream);
    const dialed: Array<{ host: string; port: number; family: number }> = [];
    const proxy = await createBrowserProxy({ lookup: async () => [{ address: '8.8.8.8', family: 4 }], connect: options => { dialed.push(options); return tcpConnect({ host: '127.0.0.1', port: upstreamPort }); } });
    try {
      const target = await proxyRequest(proxy, 'http://example.test/a?q=1');
      expect(target).toEqual({ status: 200, body: 'ok:/a?q=1:clean', challenge: undefined });
      expect(requestHost).toBe('example.test');
      expect(dialed).toEqual([{ host: '8.8.8.8', port: 80, family: 4 }]);
      const denied = await proxyRequest(proxy, 'http://example.test/', 'Basic wrong');
      expect(denied.status).toBe(407);
      expect(denied.challenge).toMatch(/^Basic\s/);
    } finally { await proxy.close(); await closeServer(upstream); }
  });

  it('rejects mixed public/private DNS answers and nonstandard ports before dialing', async () => {
    let dials = 0;
    const proxy = await createBrowserProxy({ lookup: async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }], connect: () => { dials++; throw new Error('must not dial'); } });
    try {
      expect((await proxyRequest(proxy, 'http://mixed.test/')).status).toBe(403);
      expect((await proxyRequest(proxy, 'http://mixed.test:8080/')).status).toBe(400);
      expect(dials).toBe(0);
    } finally { await proxy.close(); }
  });

  it('uses a configured trusted HTTP egress gateway only after pinning and tunnels the selected IP', async () => {
    let connectRequest = '', tunnelRequest = '';
    const gateway = createTcpServer(socket => {
      let handshake = '', tunneled = false, request = '';
      socket.on('data', chunk => {
        if (!tunneled) {
          handshake += chunk.toString();
          const end = handshake.indexOf('\r\n\r\n');
          if (end >= 0) {
            connectRequest = handshake.slice(0, end);
            tunneled = true;
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          }
          return;
        }
        request += chunk.toString();
        if (request.includes('\r\n\r\n')) {
          tunnelRequest = request;
          socket.end('HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\ngateway-ok');
        }
      });
    });
    const gatewayPort = await listen(gateway);
    const dialed: Array<{ host: string; port: number; family: number }> = [];
    const proxy = await createBrowserProxy({ upstreamProxy: `http://alice:secret@127.0.0.1:${gatewayPort}`, lookup: async () => [{ address: '8.8.8.8', family: 4 }], connect: options => { dialed.push(options); return tcpConnect(options); } });
    try {
      expect(await proxyRequest(proxy, 'http://example.test/a')).toMatchObject({ status: 200, body: 'gateway-ok' });
      expect(connectRequest).toContain('CONNECT 8.8.8.8:80 HTTP/1.1');
      expect(connectRequest).toContain(`Proxy-Authorization: Basic ${Buffer.from('alice:secret').toString('base64')}`);
      expect(tunnelRequest).toContain('GET /a HTTP/1.1');
      expect(tunnelRequest.toLowerCase()).toContain('host: example.test');
      expect(tunnelRequest).not.toContain('Proxy-Authorization');
      expect(dialed).toEqual([]); // User-selected destinations never bypass the configured gateway.
    } finally { await proxy.close(); await closeServer(gateway); }
  });

  it('tunnels CONNECT without decrypting and closes active sockets on shutdown', async () => {
    const upstream = createTcpServer(socket => socket.pipe(socket));
    const upstreamPort = await listen(upstream);
    const dialed: Array<{ host: string; port: number; family: number }> = [];
    const proxy = await createBrowserProxy({ lookup: async () => [{ address: '1.1.1.1', family: 4 }], connect: options => { dialed.push(options); return tcpConnect({ host: '127.0.0.1', port: upstreamPort }); } });
    const endpoint = new URL(proxy.server);
    const client = tcpConnect({ host: endpoint.hostname, port: Number(endpoint.port) });
    try {
      await new Promise<void>((resolve, reject) => { client.once('connect', resolve); client.once('error', reject); });
      client.write(`CONNECT example.test:443 HTTP/1.1\r\nHost: example.test:443\r\nProxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}\r\n\r\n`);
      let received = Buffer.alloc(0);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('CONNECT timed out')), 3000);
        client.on('data', chunk => { received = Buffer.concat([received, chunk]); if (received.includes(Buffer.from('\r\n\r\n'))) { clearTimeout(timer); resolve(); } });
        client.once('error', reject);
      });
      expect(received.toString()).toContain('200 Connection Established');
      expect(dialed).toEqual([{ host: '1.1.1.1', port: 443, family: 4 }]);
      const opaque = Buffer.from([0x16, 0x03, 0x03, 0x00, 0x02, 0xaa, 0xbb]);
      const echoed = new Promise<Buffer>((resolve, reject) => { const chunks: Buffer[] = []; const timer = setTimeout(() => reject(new Error('tunnel payload timed out')), 3000); const onData = (chunk: Buffer) => { chunks.push(chunk); const all = Buffer.concat(chunks); if (all.length >= opaque.length) { clearTimeout(timer); client.off('data', onData); resolve(all); } }; client.on('data', onData); });
      client.write(opaque);
      expect((await echoed).subarray(0, opaque.length)).toEqual(opaque);
      const closed = new Promise<void>(resolve => client.once('close', () => resolve()));
      await proxy.close();
      await closed;
    } finally { client.destroy(); await closeServer(upstream); }
  });
});
