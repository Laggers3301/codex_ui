/** Drafts and IME preedit light the glow; clearing text fades it with focus intact. */
export const AMBIENT_FADE_MS = 1100;

export function createAmbientActivity(onChange: (active: boolean) => void) {
  let active = false;
  let composing = false;
  let disposed = false;
  let draft = false;
  let welcome = false;
  let recording = false;
  let welcomeAllowed = true;
  const update = (next: boolean) => {
    if (disposed || active === next) return;
    active = next;
    onChange(next);
  };
  const publish = () => update(draft || (welcome && welcomeAllowed) || composing || recording);
  const input = (hasContent = true) => {
    if (disposed) return;
    welcomeAllowed = false;
    draft = hasContent;
    publish();
  };
  return {
    input,
    recording(next: boolean) { if (!disposed) { recording = next; publish(); } },
    sync(hasContent: boolean, isWelcome: boolean) {
      if (disposed) return;
      const enteringWelcome = isWelcome && !welcome;
      if (enteringWelcome) welcomeAllowed = true;
      const clearedDraft = draft && !hasContent;
      draft = hasContent; welcome = isWelcome;
      if (draft || (clearedDraft && !enteringWelcome)) welcomeAllowed = false;
      if (clearedDraft) composing = false;
      publish();
    },
    compositionStart() { if (!disposed) { composing = true; welcomeAllowed = false; publish(); } },
    compositionEnd(hasContent = draft) { composing = false; input(hasContent); },
    stop() { draft = false; welcome = false; composing = false; recording = false; welcomeAllowed = true; update(false); },
    dispose() { disposed = true; },
  };
}
