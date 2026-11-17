// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { RenderBoundary } from './RenderBoundary';
import { VirtualConversation } from './VirtualConversation';
import { reportClientError } from './clientDiagnostics';
vi.mock('./clientDiagnostics', () => ({ reportClientError: vi.fn(() => 'test-error-id') }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function fixture() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const node = document.createElement('div'), root = createRoot(node);
  return { node, root };
}
it('keeps sibling messages and composer mounted, offers plain text, and retries only on request', async () => {
  const { node, root } = fixture(); let broken = true, renders = 0;
  function Message() { renders++; if (broken) throw new Error('private prompt must not appear'); return <p>recovered</p>; }
  const tree = (text = 'plain **source**') => <>
    <p>neighbor</p><RenderBoundary scope="message" resetKey="m1" rawText={text}><Message /></RenderBoundary><textarea aria-label="composer" />
  </>;
  try {
    await act(() => root.render(tree()));
    const composer = node.querySelector('textarea');
    expect(node.textContent).toContain('neighbor');
    expect(node.textContent).toContain('plain **source**');
    expect(node.textContent).not.toContain('private prompt');
    expect(node.querySelector('.appRenderFallback')).toBeNull();
    const attempts = renders;
    await act(() => root.render(tree('stream continued')));
    expect(renders).toBe(attempts);
    broken = false;
    await act(() => node.querySelector('button')!.click());
    expect(node.textContent).toContain('recovered');
    expect(node.querySelector('textarea')).toBe(composer);
    expect(vi.mocked(reportClientError)).toHaveBeenCalledWith(expect.any(Error), 'message', expect.any(String));
  } finally { await act(() => root.unmount()); }
});
it('resets errors when message identity changes, not on every streaming update', async () => {
  const { node, root } = fixture();
  function Broken(): React.ReactNode { throw new TypeError('private value'); }
  try {
    await act(() => root.render(<RenderBoundary scope="turn" resetKey="t1"><Broken /></RenderBoundary>));
    expect(node.querySelector('[role=alert]')).not.toBeNull();
    await act(() => root.render(<RenderBoundary scope="turn" resetKey="t2"><p>next turn</p></RenderBoundary>));
    expect(node.textContent).toBe('next turn');
  } finally { await act(() => root.unmount()); }
});
it('isolates deferred turn preparation errors inside the actual conversation row', async () => {
  const { node, root } = fixture();
  function BrokenTurn(): React.ReactNode { throw new Error('turn preparation failed'); }
  try {
    await act(() => root.render(<><header>navigation</header><VirtualConversation threadKey="project:thread">
      <section key="first">older good turn</section><BrokenTurn key="bad" /><section key="last">newer good turn</section>
    </VirtualConversation><textarea /></>));
    expect(node.querySelectorAll('.messageRenderFallback')).toHaveLength(1);
    expect(node.textContent).toContain('older good turn');expect(node.textContent).toContain('newer good turn');
    expect(node.querySelector('header')).not.toBeNull();expect(node.querySelector('textarea')).not.toBeNull();
  } finally { await act(() => root.unmount()); }
});
it('shows an honest application fallback without exposing the raw exception', async () => {
  const { node, root } = fixture();
  function Broken(): React.ReactNode { throw new Error('token=private-secret'); }
  try {
    await act(() => root.render(<RenderBoundary scope="application"><Broken /></RenderBoundary>));
    expect(node.querySelector('.appRenderFallback')).not.toBeNull();
    expect(node.textContent).toContain('重新加载');expect(node.textContent).not.toContain('private-secret');
    expect(node.textContent).toContain('test-error-id');
  } finally { await act(() => root.unmount()); }
});
