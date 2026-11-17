/** Allowlist only: no raw messages, prompts, URLs, headers or error objects. */
export const clientErrorCodes = [
  'unknown', 'react', 'update_depth', 'hooks_order', 'invalid_child',
  'property_access', 'stack_overflow', 'chunk_load', 'resource_load', 'dialog_state'
] as const;
export type ClientErrorScope = 'application' | 'message' | 'turn' | 'window' | 'unhandled-rejection';
export interface ClientDiagnostic {
  version: 1; id: string; scope: ClientErrorScope; code: typeof clientErrorCodes[number];
  errorName: string; reactCode: number | null; frames: string[]; components: string[];
  build: string | null; threadId: string | null;
  browser: string; platform: string; viewport: [number, number];
}
const scopes = ['application', 'message', 'turn', 'window', 'unhandled-rejection'];
const names = ['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'DOMException'];
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const asset = /^\/assets\/[A-Za-z0-9_.-]{1,150}\.m?js$/;
const frame = /^\/assets\/[A-Za-z0-9_.-]{1,150}\.m?js:\d{1,9}:\d{1,9}$/;
const dimension = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(10000, Math.round(value))) : 0;
export function sanitizeClientDiagnostic(value: unknown): ClientDiagnostic | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (!uuid(row.id) || !scopes.includes(String(row.scope))) return null;
  const strings = (input: unknown, valid: RegExp, max: number) => Array.isArray(input)
    ? input.filter((item): item is string => typeof item === 'string' && valid.test(item)).slice(0, max) : [];
  return {
    version: 1, id: row.id, scope: row.scope as ClientErrorScope,
    code: clientErrorCodes.includes(row.code as never) ? row.code as ClientDiagnostic['code'] : 'unknown',
    errorName: names.includes(String(row.errorName)) ? String(row.errorName) : 'Error',
    reactCode: Number.isInteger(row.reactCode) && Number(row.reactCode) > 0 && Number(row.reactCode) < 10000 ? Number(row.reactCode) : null,
    frames: strings(row.frames, frame, 12), components: strings(row.components, /^[A-Za-z_$][\w$]{0,63}$/, 12),
    build: typeof row.build === 'string' && asset.test(row.build) ? row.build : null,
    threadId: uuid(row.threadId) ? row.threadId : null,
    browser: ['safari', 'chromium', 'firefox', 'other'].includes(String(row.browser)) ? String(row.browser) : 'other',
    platform: ['ios', 'android', 'desktop', 'other'].includes(String(row.platform)) ? String(row.platform) : 'other',
    viewport: Array.isArray(row.viewport) ? [dimension(row.viewport[0]), dimension(row.viewport[1])] : [0, 0]
  };
}

/** Derive a fixed category, never retain the text that triggered the error. */
export function clientErrorDetails(error: unknown, componentStack = '') {
  const object = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const message = String(object.message ?? (typeof error === 'string' ? error : '')).slice(0, 4000);
  const stack = typeof object.stack === 'string' ? object.stack.slice(0, 12000) : '';
  const reactCode = message.match(/(?:Minified React error #|react\.dev\/errors\/)(\d+)/)?.[1];
  const code: ClientDiagnostic['code'] = reactCode ? 'react'
    : /Maximum update depth/i.test(message) ? 'update_depth'
    : /Rendered (?:more|fewer) hooks|change in the order of Hooks/i.test(message) ? 'hooks_order'
    : /Objects are not valid as a React child/i.test(message) ? 'invalid_child'
    : /Cannot (?:read|set) propert|undefined is not an object|null is not an object/i.test(message) ? 'property_access'
    : /call stack|too much recursion/i.test(message) ? 'stack_overflow'
    : /dynamically imported module|Loading chunk|Importing a module script failed/i.test(message) ? 'chunk_load'
    : /showModal|InvalidStateError/i.test(message) ? 'dialog_state' : 'unknown';
  return {
    code, reactCode: reactCode ? Number(reactCode) : null,
    errorName: names.includes(String(object.name)) ? String(object.name) : 'Error',
    frames: [...stack.matchAll(/\/assets\/[A-Za-z0-9_.-]{1,150}\.m?js:\d{1,9}:\d{1,9}/g)].map(match => match[0]).slice(0, 12),
    components: [...componentStack.slice(0, 8000).matchAll(/^\s+at ([A-Za-z_$][\w$]{0,63})(?:\s|\()/gm)].map(match => match[1]).slice(0, 12)
  };
}
