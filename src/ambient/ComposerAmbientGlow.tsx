import { memo, useEffect, useRef } from "react";
import { AMBIENT_FADE_MS, createAmbientActivity } from "./ambientActivity";
import type { AmbientTheme, mountPaperAmbient } from "./paperAmbient";
import { VOICE_AMBIENT_EVENT, type VoiceAmbientDetail } from "./voiceAmbient";
import "./composerAmbientGlow.css";

type Renderer = ReturnType<typeof mountPaperAmbient>;
let paperModule: Promise<typeof import("./paperAmbient")> | undefined;
const loadPaper = () => paperModule ??= import("./paperAmbient").catch(error => { paperModule = undefined; throw error; });

/** A decorative sibling under the transcript, never a filter on text or an editor ancestor. */
export const ComposerAmbientGlow = memo(function ComposerAmbientGlow({ theme, hasDraft = false, welcome = false }: { theme: AmbientTheme; hasDraft?: boolean; welcome?: boolean }) {
  const layer = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const renderer = useRef<Renderer | undefined>(undefined);
  const currentTheme = useRef(theme);
  const content = useRef({ hasDraft, welcome });
  const activityRef = useRef<ReturnType<typeof createAmbientActivity> | undefined>(undefined);
  content.current = { hasDraft, welcome };
  currentTheme.current = theme;
  useEffect(() => { renderer.current?.setTheme(theme); }, [theme]);

  useEffect(() => {
    const element = layer.current;
    const canvasHost = host.current;
    const conversation = element?.closest(".conversation");
    const composer = conversation?.querySelector<HTMLElement>(".composer:not(.temporaryAskComposer)");
    if (!element || !canvasHost || !composer) return;
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    let alive = true;
    let active = false;
    let starting = false;
    let visible = true;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    const startRenderer = async () => {
      if (starting || renderer.current || motion.matches || !active || document.hidden || !visible) return;
      starting = true;
      try {
        const module = await loadPaper();
        if (!alive || !active || document.hidden || !visible || motion.matches) return;
        renderer.current = module.mountPaperAmbient(canvasHost, currentTheme.current);
        renderer.current.setRunning(true);
        element.dataset.renderer = "paper";
      } catch {
        // Decorative failures must never propagate into the conversation/error boundary.
        canvasHost.replaceChildren();
        canvasHost.dataset.renderer = "fallback";
        element.dataset.renderer = "fallback";
      } finally { starting = false; }
    };
    const activity = createAmbientActivity(next => {
      active = next;
      element.dataset.active = String(next);
      clearTimeout(stopTimer);
      if (next) {
        if (!document.hidden && visible && !motion.matches) renderer.current?.setRunning(true);
        void startRenderer();
      } else {
        stopTimer = setTimeout(() => renderer.current?.setRunning(false), AMBIENT_FADE_MS);
      }
    });
    activityRef.current = activity;
    activity.sync(content.current.hasDraft, content.current.welcome);
    const voice = (event: Event) => {
      const detail = (event as CustomEvent<VoiceAmbientDetail>).detail;
      if (!detail || typeof detail.recording !== "boolean") return;
      const level = detail.recording && Number.isFinite(detail.level) ? Math.max(0, Math.min(1, detail.level)) : 0;
      element.dataset.recording = String(detail.recording);
      element.style.setProperty("--ambient-voice-x", String(1 + level * .075));
      element.style.setProperty("--ambient-voice-y", String(1 + level * .19));
      activity.recording(detail.recording);
    };
    const isEditor = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest(".composerRichInput, textarea"));
    const hasContent = (target: EventTarget | null) => content.current.hasDraft || Boolean(target instanceof HTMLTextAreaElement ? target.value.trim() : target instanceof Element && target.textContent?.replace(/\u200b/g, "").trim());
    const input = (event: Event) => { if (isEditor(event.target)) activity.input(hasContent(event.target)); };
    const compositionStart = (event: Event) => { if (isEditor(event.target)) activity.compositionStart(); };
    const compositionEnd = (event: Event) => { if (isEditor(event.target)) activity.compositionEnd(hasContent(event.target)); };
    const focusIn = (event: Event) => {
      // Warm only the small lazy module on focus; focus never makes the glow visible.
      if (isEditor(event.target) && !motion.matches) void loadPaper().catch(() => {});
    };
    const visibility = () => {
      if (document.hidden || !visible) {
        renderer.current?.setRunning(false);
      } else if (active && !motion.matches) {
        renderer.current?.setRunning(true);
        void startRenderer();
      }
    };
    const motionChange = () => {
      if (motion.matches) renderer.current?.setRunning(false);
      else if (active && !document.hidden && visible) { renderer.current?.setRunning(true); void startRenderer(); }
    };
    const observer = new IntersectionObserver(([entry]) => { visible = Boolean(entry?.isIntersecting); visibility(); });
    observer.observe(element);
    composer.addEventListener("input", input);
    composer.addEventListener(VOICE_AMBIENT_EVENT, voice);
    composer.addEventListener("compositionstart", compositionStart);
    composer.addEventListener("compositionend", compositionEnd);
    composer.addEventListener("focusin", focusIn);
    document.addEventListener("visibilitychange", visibility);
    motion.addEventListener("change", motionChange);
    return () => {
      alive = false;
      activity.dispose();
      activityRef.current = undefined;
      clearTimeout(stopTimer);
      observer.disconnect();
      composer.removeEventListener("input", input);
      composer.removeEventListener(VOICE_AMBIENT_EVENT, voice);
      composer.removeEventListener("compositionstart", compositionStart);
      composer.removeEventListener("compositionend", compositionEnd);
      composer.removeEventListener("focusin", focusIn);
      document.removeEventListener("visibilitychange", visibility);
      motion.removeEventListener("change", motionChange);
      renderer.current?.dispose();
      renderer.current = undefined;
    };
  }, []);
  useEffect(() => { activityRef.current?.sync(hasDraft, welcome); }, [hasDraft, welcome]);

  return <div ref={layer} className="composerAmbientGlow" data-mode={welcome ? "welcome" : "draft"} data-active="false" data-renderer="pending" aria-hidden="true" inert>
    <div className="composerAmbientGlowField"><div ref={host} className="composerAmbientGlowCanvas" /></div>
  </div>;
});
