import { lazy, Suspense, useState, type ComponentType, type ReactNode } from "react";
import { RenderBoundary } from "./RenderBoundary";
import "./lazyPanel.css";

export type PreloadableLazy<P extends object> = ComponentType<P> & { preload: () => void };

/**
 * React.lazy for a named export, plus preload(): hover/focus/touch handlers call it so the chunk is
 * usually cached before the panel mounts. The import promise is shared, and a failed load is dropped
 * so the next preload() or a fresh page can fetch it again.
 *
 * Once the module has loaded, new mounts render the real component directly. Going through React.lazy
 * again would still suspend for a tick and React holds a revealed fallback for ~300ms, which made
 * preloaded panels slower than the old static import. The choice is made once per mount so an
 * already-mounted panel never switches element type (and never loses its state).
 */
export function lazyNamed<M extends Record<string, unknown>, K extends keyof M & string>(
  load: () => Promise<M>, name: K
): PreloadableLazy<M[K] extends ComponentType<infer P> ? P & object : never> {
  type P = M[K] extends ComponentType<infer Props> ? Props & object : never;
  let pending: Promise<{ default: ComponentType<P> }> | undefined;
  let loaded: ComponentType<P> | undefined;
  const request = () => (pending ??= load().then(module => {
    loaded = module[name] as unknown as ComponentType<P>;
    return { default: loaded };
  }).catch(error => { pending = undefined; throw error; }));
  const Deferred = lazy(request);
  const Panel = ((props: P) => {
    const [Inner] = useState<ComponentType<P>>(() => loaded ?? Deferred);
    return <Inner {...props} />;
  }) as PreloadableLazy<P>;
  Panel.displayName = `Lazy(${name})`;
  Panel.preload = () => { void request().catch(() => {}); };
  return Panel;
}

/** Local Suspense + error boundary: no wrapper DOM once loaded, an inert placeholder while loading. */
export function LazyPane({ label, fallback, children }: { label: string; fallback?: ReactNode; children: ReactNode }) {
  return <RenderBoundary scope="window">
    <Suspense fallback={fallback ?? <div className="lazyPaneFallback" role="status" aria-busy="true" aria-label={`正在加载${label}`}><span>正在加载{label}…</span></div>}>
      {children}
    </Suspense>
  </RenderBoundary>;
}
