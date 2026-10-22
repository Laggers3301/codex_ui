/** A real draft or an explicitly empty new-conversation welcome owns the glow. */
export const AMBIENT_FADE_MS = 1100;

export function createAmbientActivity(onChange: (active: boolean) => void) {
  let active = false;
  let composing = false;
  let disposed = false;
  let draft = false;
  let welcome = false;
  let recording = false;
  const update = (next: boolean) => {
    if (disposed || active === next) return;
    active = next;
    onChange(next);
  };
  const publish = () => update(draft || welcome || composing || recording);
  const input = (hasContent = true) => {
    if (disposed) return;
    draft = hasContent;
    publish();
  };
  return {
    input,
    recording(next: boolean) { if (!disposed) { recording = next; publish(); } },
    sync(hasContent: boolean, isWelcome: boolean) { if (!disposed) { draft = hasContent; welcome = isWelcome; if (!draft && !welcome) composing = false; publish(); } },
    compositionStart() { if (!disposed) { composing = true; publish(); } },
    compositionEnd(hasContent = draft) { composing = false; input(hasContent); },
    stop() { draft = false; welcome = false; composing = false; recording = false; update(false); },
    dispose() { disposed = true; },
  };
}
