import { memo, useEffect, useRef, useState } from "react";
import { createSpeechPreupload, reportSpeechTiming } from "./api";
import { Mic, LoaderCircle, X } from "./PanelIcons";
import { startVoiceAmbient, VOICE_AMBIENT_EVENT } from "./ambient/voiceAmbient";
import "./voiceInput.css";

/** The parent keys this component by user/thread, preventing cross-thread dictation. */
export const VoiceInput = memo(function VoiceInput({ onText }: { onText: (text: string) => void }) {
  const [phase, setPhase] = useState<"idle" | "permission" | "recording" | "converting">("idle");
  const [error, setError] = useState("");
  const [seconds, setSeconds] = useState(0);
  const [cancelHint, setCancelHint] = useState(false);
  const [notice, setNotice] = useState("");
  const [noticePresent, setNoticePresent] = useState(false);
  const noticeOpen = phase !== "idle" || Boolean(error);
  useEffect(() => {
    if (noticeOpen) { setNoticePresent(true); setNotice(error || (phase === "recording" ? `${seconds}s · ${cancelHint ? "松开取消" : "点击结束，上滑取消"}` : phase === "permission" ? "正在打开麦克风…" : "正在识别中英文…")); return; }
    const timer = window.setTimeout(() => setNoticePresent(false), 240);
    return () => window.clearTimeout(timer);
  }, [noticeOpen, error, phase, seconds, cancelHint]);
  type Recording = { cancelled: boolean; recorder: MediaRecorder | null; stream: MediaStream | null; controller: AbortController | null; timer: number; finalizeTimer: number; startedAt: number; stoppedAt: number; upload: ReturnType<typeof createSpeechPreupload> | null; stopAmbient: (() => void) | null };
  const voiceRoot = useRef<HTMLDivElement>(null);
  const current = useRef<Recording | null>(null);
  const mounted = useRef(true);
  const permitted = useRef(false);
  const pointer = useRef<{ y: number; held: boolean; timer: number } | null>(null);
  const suppressClick = useRef(false);
  const callback = useRef(onText); callback.current = onText;
  const release = (session: Recording) => {
    session.stopAmbient?.(); session.stopAmbient = null;
    window.clearInterval(session.timer); window.clearTimeout(session.finalizeTimer);
    session.stream?.getTracks().forEach(track => track.stop());
  };
  const stop = (cancel = false) => {
    const session = current.current;
    if (!session) return;
    window.clearInterval(session.timer);
    if (cancel) {
      // Invalidate before stop(): browsers may dispatch callbacks synchronously.
      session.cancelled = true; current.current = null; session.controller?.abort(); session.upload?.cancel();
      if (session.recorder?.state === "recording") session.recorder.stop();
      release(session); if (mounted.current) setPhase("idle"); return;
    }
    if (session.recorder?.state !== "recording") return;
    session.stopAmbient?.(); session.stopAmbient = null;
    session.stoppedAt = performance.now();
    if (mounted.current) setPhase("converting");
    session.finalizeTimer = window.setTimeout(() => {
      if (current.current !== session) return;
      stop(true); if (mounted.current) setError("浏览器未完成录音封装，请重新录音");
    }, 10000);
    session.recorder.stop();
    // Keep tracks alive until the final dataavailable/onstop has flushed MP4.
  };
  useEffect(() => {
    mounted.current = true;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") stop(true); };
    window.addEventListener("keydown", onKey);
    return () => { mounted.current = false; window.clearTimeout(pointer.current?.timer); stop(true); window.removeEventListener("keydown", onKey); };
  }, []);
  async function start() {
    if (current.current) return;
    setError("");
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      setError("请通过 HTTPS 打开网页，并使用支持录音的浏览器"); return;
    }
    const session: Recording = { cancelled: false, recorder: null, stream: null, controller: null, timer: 0, finalizeTimer: 0, startedAt: 0, stoppedAt: 0, upload: null, stopAmbient: null };
    current.current = session; setPhase("permission");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: { ideal: 1 } }, video: false });
      if (!mounted.current || session.cancelled || current.current !== session) { stream.getTracks().forEach(track => track.stop()); return; }
      permitted.current = true; session.stream = stream;
      const mime = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find(type => MediaRecorder.isTypeSupported(type));
      // 64 kbps mono is sufficient for high-quality speech without Safari's
      // potentially much larger default AAC uploads. The browser may negotiate.
      const recorder = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 64000 });
      session.recorder = recorder; const chunks: Blob[] = [];
      session.upload = createSpeechPreupload(recorder.mimeType || mime || "audio/webm");
      recorder.ondataavailable = event => { if (event.data.size && !session.cancelled) {
        chunks.push(event.data);
        session.upload?.add(event.data.type ? event.data : new Blob([event.data], { type: recorder.mimeType || mime || "audio/webm" }), recorder.state === "inactive");
      } };
      recorder.onstop = async () => {
        release(session);
        if (session.cancelled || !mounted.current || current.current !== session) return;
        setPhase("converting"); const controller = new AbortController(); session.controller = controller;
        const timeout = window.setTimeout(() => controller.abort(), 185000);
        try {
          const blob = new Blob(chunks, { type: recorder.mimeType || mime || "audio/webm" });
          if (!blob.size) throw new Error("录音为空，请稍等片刻再结束录音");
          const finalizeMs = session.stoppedAt ? performance.now() - session.stoppedAt : 0;
          const { result, pendingUploadMs, requestMs } = await session.upload!.finish(blob, controller.signal, finalizeMs);
          if (mounted.current && !session.cancelled && current.current === session) {
            const rendered = performance.now();
            callback.current(result.text);
            // Animate only an independent new text block; never fade existing
            // draft text or delay inserting the recognized result.
            window.requestAnimationFrame(() => {
              if (!mounted.current || session.cancelled || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
              const block = document.querySelector(".composerRichEditor [contenteditable=true]")?.lastElementChild;
              if (block instanceof HTMLElement && block.textContent?.trim() === result.text.trim()) {
                block.animate([{ opacity: .45, transform: "translateY(3px)" }, { opacity: 1, transform: "translateY(0)" }],
                  { duration: 220, easing: "cubic-bezier(.16,1,.3,1)" });
              }
            });
            // Two animation frames approximate input paint, not just setState.
            window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
              const timing = { timingId: result.timingId, finalizeMs, pendingUploadMs, requestMs,
                renderMs: performance.now() - rendered, totalMs: performance.now() - session.stoppedAt,
                serverMs: result.serverTimings?.totalMs, preuploadedBytes: session.upload?.bytes, audioBytes: blob.size };
              window.dispatchEvent(new CustomEvent("codex-speech-timing", { detail: timing }));
              reportSpeechTiming(timing);
            }));
          }
        } catch (caught) {
          if (mounted.current && !session.cancelled && current.current === session) setError(caught instanceof Error ? caught.message : "语音转换失败，请重试");
        } finally {
          window.clearTimeout(timeout);
          session.upload?.cancel();
          if (current.current === session) { current.current = null; if (mounted.current) setPhase("idle"); }
        }
      };
      recorder.onerror = () => { if (current.current === session) { stop(true); if (mounted.current) setError("录音中断，请检查麦克风"); } };
      recorder.start(2000); session.startedAt = performance.now(); setSeconds(0); setPhase("recording");
      const composer = voiceRoot.current?.closest(".composer:not(.temporaryAskComposer)");
      if (composer) session.stopAmbient = startVoiceAmbient(stream, detail => {
        composer.dispatchEvent(new CustomEvent(VOICE_AMBIENT_EVENT, { detail }));
      });
      let elapsed = 0;
      session.timer = window.setInterval(() => { if (current.current !== session) return; elapsed++; setSeconds(elapsed); if (elapsed >= 600) stop(); }, 1000);
    } catch (caught) {
      release(session); session.upload?.cancel();
      if (current.current !== session || !mounted.current) return;
      current.current = null; setPhase("idle"); setError(caught instanceof DOMException && caught.name === "NotAllowedError" ? "请在 Safari 的本网站设置中允许麦克风，然后重新录音" : "无法打开麦克风，请检查设备是否被占用");
    }
  }
  return <div ref={voiceRoot} className="voiceInput">
    <button type="button" className={`iconButton voiceButton ${phase}`} aria-label={phase === "recording" ? "结束录音并转成文字" : "语音输入"}
      title="点击开始／结束录音；按住录音，上滑取消（最长 10 分钟）" disabled={phase === "converting" || phase === "permission"}
      onPointerDown={event => {
        if (phase !== "idle") return;
        suppressClick.current = false;
        event.currentTarget.setPointerCapture(event.pointerId);
        const gesture = { y: event.clientY, held: false, timer: 0 };
        pointer.current = gesture;
        // First permission request starts on click, AFTER pointerup. A native
        // permission prompt must never be counted as a long recording press.
        if (permitted.current) gesture.timer = window.setTimeout(() => {
          if (pointer.current !== gesture) return;
          gesture.held = true; suppressClick.current = true; void start();
        }, 450);
      }}
      onPointerMove={event => { if (pointer.current) setCancelHint(pointer.current.y - event.clientY > 60); }}
      onPointerUp={event => {
        const p = pointer.current; pointer.current = null;
        window.clearTimeout(p?.timer);
        if (p?.held) {
          const session = current.current;
          if (p.y - event.clientY > 60) stop(true);
          else if (session?.recorder?.state === "recording" && performance.now() - session.startedAt >= 300) stop();
          // A permission sheet may have consumed the hold; don't submit an
          // empty clip immediately after granting access. Continue in tap mode.
        }
        setCancelHint(false);
      }}
      onPointerCancel={() => { const p = pointer.current; pointer.current = null; suppressClick.current = false; window.clearTimeout(p?.timer); if (p?.held && current.current?.recorder?.state === "recording") stop(true); setCancelHint(false); }}
      onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } if (phase === "recording") stop(); else if (phase === "idle") void start(); }}>
      {phase === "converting" || phase === "permission" ? <LoaderCircle size={18} className="voiceSpinner" /> : <Mic size={18} />}
    </button>
    {noticePresent ? <div className={`voiceNotice${noticeOpen ? "" : " closing"}`} role="status" inert={!noticeOpen}>
      <span>{notice}</span>
      <button type="button" aria-label="取消语音输入" onClick={() => { stop(true); setError(""); }}><X size={14} /></button>
    </div> : null}
  </div>;
});
