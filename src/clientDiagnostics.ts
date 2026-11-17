import { clientErrorDetails, sanitizeClientDiagnostic, type ClientDiagnostic, type ClientErrorScope } from '../shared/clientDiagnostics';
const endpoint = '/api/client-diagnostics';
const recent = new Map<string, number>();
const cacheKey = () => {
  try { return `codex-web-client-errors:v1:${localStorage.getItem('codex-web-user-id') ?? 'unknown'}`; }
  catch { return 'codex-web-client-errors:v1:unknown'; }
};
function diagnosticId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
type SavedError = { time: string; pending: boolean; diagnostic: ClientDiagnostic };
function stored(key = cacheKey()): SavedError[] {
  try {
    const rows: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(rows) ? rows.slice(-10).flatMap(row => {
      const diagnostic = sanitizeClientDiagnostic(row?.diagnostic);
      return diagnostic ? [{ time: typeof row.time === 'string' ? row.time.slice(0, 30) : '', pending: row.pending === true, diagnostic }] : [];
    }) : [];
  } catch { return []; }
}
function remember(diagnostic: ClientDiagnostic, pending: boolean, key: string) {
  try {
    const rows = stored(key).filter(row => row.diagnostic.id !== diagnostic.id);
    rows.push({ time: new Date().toISOString(), pending, diagnostic });
    localStorage.setItem(key, JSON.stringify(rows.slice(-10)));
  } catch { /* Private mode / full storage must not break recovery. */ }
}
async function upload(diagnostic: ClientDiagnostic, key: string) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(endpoint, { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(diagnostic),
      keepalive: true, signal: controller.signal });
    if (response.ok) remember(diagnostic, false, key);
  } catch { /* Retained locally for the next load; never retry in a loop. */ }
  finally { window.clearTimeout(timer); }
}
/** Reporting itself is a no-throw path, including disabled browser storage. */
export function reportClientError(error: unknown, scope: ClientErrorScope, componentStack = ''): string | null {
  try {
    const details = clientErrorDetails(error, componentStack);
    const build = document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.getAttribute('src') ?? null;
    const threadId = new URL(location.href).searchParams.get('thread');
    const fingerprint = JSON.stringify([scope, details, build, threadId]);
    const now = Date.now();
    for (const [key, time] of recent) if (now - time > 60000) recent.delete(key);
    if (recent.has(fingerprint) || recent.size >= 12) return null;
    recent.set(fingerprint, now);
    const agent = navigator.userAgent;
    const diagnostic = sanitizeClientDiagnostic({ version: 1, id: diagnosticId(), scope, ...details, build, threadId,
      browser: /Firefox|FxiOS/.test(agent) ? 'firefox' : /Chrome|Chromium|CriOS|Edg/.test(agent) ? 'chromium' : /Safari/.test(agent) ? 'safari' : 'other',
      platform: /iPhone|iPad|iPod/.test(agent) || navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1 ? 'ios' : /Android/.test(agent) ? 'android' : 'desktop',
      viewport: [innerWidth, innerHeight] });
    if (!diagnostic) return null;
    const key = cacheKey();
    remember(diagnostic, true, key);
    void upload(diagnostic, key);
    return diagnostic.id;
  } catch { return null; }
}
export function installClientDiagnostics(): () => void {
  const error = (event: ErrorEvent) => { reportClientError(event.error ?? event.message, 'window'); };
  const rejection = (event: PromiseRejectionEvent) => { reportClientError(event.reason, 'unhandled-rejection'); };
  window.addEventListener('error', error);
  window.addEventListener('unhandledrejection', rejection);
  // Only the matching signed-in user's pending records may be replayed.
  void fetch('/api/auth/me', { credentials: 'same-origin' }).then(response => response.ok ? response.json() : null).then(body => {
    if (body?.data?.username !== localStorage.getItem('codex-web-user-id')) return;
    const key = cacheKey();
    for (const row of stored(key).filter(row => row.pending).slice(-3)) void upload(row.diagnostic, key);
  }).catch(() => {});
  return () => { window.removeEventListener('error', error); window.removeEventListener('unhandledrejection', rejection); };
}
