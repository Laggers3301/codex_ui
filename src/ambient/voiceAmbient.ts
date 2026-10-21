/** Local-only amplitude envelope; no samples leave the browser through this channel. */
export const VOICE_AMBIENT_EVENT = "codex-voice-ambient";
export type VoiceAmbientDetail = { recording: boolean; level: number };

export function voiceEnvelope(samples: Float32Array, previous: number, elapsedMs: number) {
  let power = 0;
  for (const sample of samples) power += Number.isFinite(sample) ? sample * sample : 0;
  const rms = samples.length ? Math.sqrt(power / samples.length) : 0;
  // Ignore quiet room noise; compress speech dynamics instead of flashing on peaks.
  const target = Math.max(0, Math.min(1, (20 * Math.log10(Math.max(rms, 1e-6)) + 52) / 34));
  const prior = Number.isFinite(previous) ? Math.max(0, Math.min(1, previous)) : 0;
  const dt = Number.isFinite(elapsedMs) ? Math.max(0, Math.min(100, elapsedMs)) : 0;
  return prior + (target - prior) * (1 - Math.exp(-dt / (target > prior ? 130 : 420)));
}

/** Reuse the recorder's stream, never request another microphone or play it aloud. */
export function startVoiceAmbient(stream: MediaStream, publish: (detail: VoiceAmbientDetail) => void) {
  let context: AudioContext | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let analyser: AnalyserNode | undefined;
  let timer = 0;
  let stopped = false;
  let level = 0;
  let last = performance.now();
  const releaseAnalysis = () => {
    if (timer) window.clearInterval(timer);
    timer = 0;
    document.removeEventListener("visibilitychange", visibility);
    try { source?.disconnect(); analyser?.disconnect(); } catch { /* Already disconnected. */ }
    source = undefined; analyser = undefined;
    if (context && context.state !== "closed") void context.close().catch(() => {});
    context = undefined;
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    releaseAnalysis();
    publish({ recording: false, level: 0 });
  };
  const visibility = () => {
    if (document.hidden) {
      level = 0;
      publish({ recording: true, level: 0 });
      if (context?.state === "running") void context.suspend().catch(() => {});
    } else if (!stopped) {
      last = performance.now();
      if (context?.state === "suspended") void context.resume().catch(() => {});
    }
  };
  publish({ recording: true, level: 0 });
  try {
    const Constructor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Constructor) return stop;
    context = new Constructor();
    source = context.createMediaStreamSource(stream);
    analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser); // Intentionally no destination connection / audible feedback.
    const samples = new Float32Array(analyser.fftSize);
    document.addEventListener("visibilitychange", visibility);
    if (context.state === "suspended") void context.resume().catch(() => {});
    visibility();
    timer = window.setInterval(() => {
      if (stopped || document.hidden || context?.state !== "running") return;
      try {
        analyser!.getFloatTimeDomainData(samples);
        const now = performance.now();
        level = voiceEnvelope(samples, level, now - last);
        last = now;
        publish({ recording: true, level });
      } catch {
        releaseAnalysis();
        publish({ recording: true, level: 0 });
      } // Decoration must never interrupt MediaRecorder/ASR.
    }, 50);
  } catch {
    // Unsupported analysis still shows the normal recording glow; ASR stays usable.
    releaseAnalysis();
  }
  return stop;
}
