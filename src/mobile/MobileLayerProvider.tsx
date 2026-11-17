import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { createMobileLayers } from "./mobileLayers";

const Context = createContext<ReturnType<typeof createMobileLayers> | null>(null);
export function MobileLayerProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const manager = useRef<ReturnType<typeof createMobileLayers> | null>(null);
  // Construct before child layout/effects can register. No listeners on desktop.
  if (!manager.current) manager.current = createMobileLayers(window);
  useEffect(() => {
    if (!enabled) manager.current?.dispose();
    return () => { manager.current?.dispose(); };
  }, [enabled]);
  return <Context.Provider value={enabled ? manager.current : null}>{children}</Context.Provider>;
}
export function useMobileLayer(open: boolean, close: () => void) {
  const manager = useContext(Context), callback = useRef(close); callback.current = close;
  useEffect(() => open && manager ? manager.register(() => callback.current()) : undefined, [manager, open]);
}
