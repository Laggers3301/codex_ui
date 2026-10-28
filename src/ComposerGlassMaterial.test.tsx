// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ComposerGlassMaterial } from './ComposerGlassMaterial';
vi.mock('liquid-glass-react', () => ({ default: () => null }));
it('shares one passive scroll observer and restores optics after scrolling settles', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  const add = vi.spyOn(document, 'addEventListener');
  const node = document.createElement('div'); document.body.append(node);
  const root = createRoot(node);
  try {
    await act(async () => root.render(<><div><ComposerGlassMaterial /></div><button><ComposerGlassMaterial variant="topbar" /></button></>));
    const listeners = add.mock.calls.filter(([type]) => type === 'scroll');
    expect(listeners).toHaveLength(1);
    expect(listeners[0][2]).toEqual({ capture: true, passive: true });
    document.dispatchEvent(new Event('scroll'));
    expect(document.documentElement.hasAttribute('data-glass-scrolling')).toBe(true);
    vi.advanceTimersByTime(100); document.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(100);
    expect(document.documentElement.hasAttribute('data-glass-scrolling')).toBe(true);
    vi.advanceTimersByTime(61);
    expect(document.documentElement.hasAttribute('data-glass-scrolling')).toBe(false);
    document.dispatchEvent(new Event('scroll'));
    await act(async () => root.unmount());
    expect(document.documentElement.hasAttribute('data-glass-scrolling')).toBe(false);
  } finally { if (node.childNodes.length) await act(async () => root.unmount()); node.remove(); add.mockRestore(); vi.unstubAllGlobals(); vi.useRealTimers(); }
});
