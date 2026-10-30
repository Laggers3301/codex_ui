import { useCallback, useEffect, useRef, useState } from "react";

export function useMobileHeaderControls(scope: string, delay = 5000) {
  const [mobile, setMobile] = useState(() => window.matchMedia("(max-width: 720px)").matches);
  const [revealed, setRevealed] = useState(false);
  const controls = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = useCallback(() => { if (timer.current !== null) clearTimeout(timer.current); timer.current = null; }, []);
  const arm = useCallback(() => {
    cancel();
    const hide = () => {
      // Never retract a control from under an open menu or keyboard focus.
      const host = controls.current;
      if (host?.querySelector('[aria-expanded="true"],:focus-visible') || document.querySelector('.trackedQuotaDialog,.quotaPopover')) {
        timer.current = setTimeout(hide, delay);
        return;
      }
      timer.current = null; setRevealed(false);
    };
    timer.current = setTimeout(hide, delay);
  }, [cancel, delay]);
  const reveal = useCallback(() => { setRevealed(true); arm(); }, [arm]);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 720px)");
    const change = () => { setMobile(media.matches); cancel(); setRevealed(false); };
    media.addEventListener("change", change);
    return () => { media.removeEventListener("change", change); cancel(); };
  }, [cancel]);
  useEffect(() => { cancel(); setRevealed(false); }, [scope, cancel]);
  return { mobile, revealed, reveal, arm, controls };
}
