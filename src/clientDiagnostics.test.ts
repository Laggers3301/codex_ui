// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clientErrorDetails, sanitizeClientDiagnostic } from '../shared/clientDiagnostics';
const id = '12345678-1234-1234-1234-123456789abc';
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    clear: vi.fn(() => values.clear())
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('retains safe stack coordinates and categories but never exception text, URLs, query strings or extra fields', () => {
  const error = new TypeError('Cannot read properties of undefined (secret prompt, token=sk-private)');
  error.stack = 'TypeError: secret\n at render (https://private.example/assets/index-abc.js:123:45?token=private)\n at /home/private/secrets.json:1:2';
  const row = sanitizeClientDiagnostic({ id, scope: 'message', ...clientErrorDetails(error, '\n at MarkdownMessage (https://private.example/assets/index-abc.js:1:2)'),
    viewport: [390, 844], userId: 'spoof', message: error.message, headers: { authorization: 'secret' }, build: '/assets/index-abc.js?token=private',
    threadId: 'a private prompt', browser: 'iPhone private', platform: 'ios' });
  expect(row?.code).toBe('property_access');expect(row?.frames).toEqual(['/assets/index-abc.js:123:45']);
  expect(row?.components).toEqual(['MarkdownMessage']);
  expect(row?.build).toBeNull();expect(row?.threadId).toBeNull();expect(row?.browser).toBe('other');
  expect(JSON.stringify(row)).not.toMatch(/secret|token|prompt|private|spoof|authorization|example/);
});
it('recognizes production React error numbers without recording the URL arguments', () => {
  expect(clientErrorDetails(new Error('Minified React error #185; https://react.dev/errors/185?args[]=secret')).reactCode).toBe(185);
  expect(sanitizeClientDiagnostic({ id, scope: 'window', frames: Array(100).fill('/assets/app.js:1:2'), viewport: [Infinity, 99999] })?.frames).toHaveLength(12);
  expect(sanitizeClientDiagnostic({ id, scope: 'window', viewport: [Infinity, 99999] })?.viewport).toEqual([0, 10000]);
  expect(sanitizeClientDiagnostic({ id: '../secret', scope: 'message' })).toBeNull();
});
it('persists offline diagnostics across refresh, deduplicates loops, and uploads only sanitized data', async () => {
  vi.resetModules();localStorage.setItem('codex-web-user-id', 'alice');
  const fetcher = vi.fn().mockRejectedValue(new Error('offline'));vi.stubGlobal('fetch', fetcher);
  const { reportClientError } = await import('./clientDiagnostics');
  const error = new Error('private text');
  const first = reportClientError(error, 'message');
  expect(first).toMatch(/^[0-9a-f-]{36}$/);expect(reportClientError(error, 'message')).toBeNull();
  expect(fetcher).toHaveBeenCalledOnce();
  expect(String(fetcher.mock.calls[0][1].body)).not.toContain('private text');
  const saved = JSON.parse(localStorage.getItem('codex-web-client-errors:v1:alice')!);
  expect(saved[0].pending).toBe(true);expect(saved[0].diagnostic.id).toBe(first);
});
it('still reports when browser storage is unavailable and never throws on hostile error objects', async () => {
  vi.resetModules();vi.mocked(localStorage.getItem).mockImplementation(() => { throw new Error('disabled'); });
  vi.mocked(localStorage.setItem).mockImplementation(() => { throw new Error('full'); });
  const fetcher = vi.fn().mockResolvedValue({ ok: true });vi.stubGlobal('fetch', fetcher);
  const { reportClientError } = await import('./clientDiagnostics');
  expect(reportClientError(new Error('value'), 'window')).toMatch(/^[0-9a-f-]{36}$/);
  expect(fetcher).toHaveBeenCalledOnce();
  expect(() => reportClientError({ get message() { throw new Error('getter'); } }, 'message')).not.toThrow();
});
it('records uncaught errors and unhandled rejections and removes its listeners', async () => {
  vi.resetModules();vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
  const { installClientDiagnostics } = await import('./clientDiagnostics');
  localStorage.setItem('codex-web-user-id', 'alice');const remove = installClientDiagnostics();
  window.dispatchEvent(new ErrorEvent('error', { error: new TypeError('secret') }));
  const event = new Event('unhandledrejection');Object.defineProperty(event, 'reason', { value: new RangeError('secret') });
  window.dispatchEvent(event);
  expect(JSON.parse(localStorage.getItem('codex-web-client-errors:v1:alice')!)).toHaveLength(2);
  const removed = vi.spyOn(window, 'removeEventListener');remove();
  expect(removed).toHaveBeenCalledWith('error', expect.any(Function));
  expect(removed).toHaveBeenCalledWith('unhandledrejection', expect.any(Function));
  expect(JSON.parse(localStorage.getItem('codex-web-client-errors:v1:alice')!)).toHaveLength(2);
});
it('does not move an upload acknowledgement into the next signed-in user cache', async () => {
  vi.resetModules();let complete!: (value: { ok: boolean }) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { complete = resolve; })));
  localStorage.setItem('codex-web-user-id', 'alice');
  const { reportClientError } = await import('./clientDiagnostics');
  reportClientError(new Error('private'), 'message');
  localStorage.setItem('codex-web-user-id', 'bob');
  complete({ ok: true });await Promise.resolve();await Promise.resolve();
  expect(localStorage.getItem('codex-web-client-errors:v1:bob')).toBeNull();
  expect(JSON.parse(localStorage.getItem('codex-web-client-errors:v1:alice')!)[0].pending).toBe(false);
});
