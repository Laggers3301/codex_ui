import { useEffect, useRef, type MutableRefObject } from "react";
import type { VoiceAmbientDetail } from "../ambient/voiceAmbient";

/** Bar geometry in CSS px. A silent bar is a round dot (height = width). */
const BAR = 2.4, PITCH = 5, STEP_MS = 55, RIGHT_PAD = 3;

/** Next history value: fast attack so syllables read as bars, slower release so a burst leaves a tail. */
export function waveStep(previous: number, level: number, peak: number) {
  const target = Math.max(0, Math.min(1, Math.max(level, peak * .9)));
  const prior = Number.isFinite(previous) ? Math.max(0, Math.min(1, previous)) : 0;
  return prior + (target - prior) * (target > prior ? .75 : .32);
}

/** Bar height for a 0..1 value: dot-sized at silence, up to `max` for loud speech. */
export function waveHeight(value: number, max: number, dot = BAR) {
  const v = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  return dot + (Math.max(dot, max) - dot) * Math.pow(v, .85);
}

/**
 * Recording waveform for the composer (phone capsule and desktop control row): one bar per ~55 ms, newest at the right edge and
 * scrolling left. Silence is a row of dots across the whole width; speech grows the bars up and
 * down from the centre line. Fed by the recorder's own analyser (no second microphone request).
 */
export function VoiceWave({ sink, className = "mobileUiVoiceCanvas" }: { sink: MutableRefObject<((detail: VoiceAmbientDetail) => void) | null>; className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const node = canvas.current, context = node?.getContext("2d");
    if (!node || !context) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let width = 0, height = 0, color = "255,255,255", raf = 0, last = performance.now(), acc = 0, value = 0, level = 0, peak = 0;
    const values: number[] = [];
    const resize = () => {
      const ratio = Math.min(3, window.devicePixelRatio || 1), box = node.getBoundingClientRect();
      width = box.width; height = box.height;
      node.width = Math.max(1, Math.round(width * ratio)); node.height = Math.max(1, Math.round(height * ratio));
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      const parsed = getComputedStyle(node).color.match(/[\d.]+/g);
      if (parsed && parsed.length >= 3) color = parsed.slice(0, 3).join(",");
    };
    resize();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
    observer?.observe(node);
    sink.current = detail => { level = detail.level; peak = Math.max(peak, detail.instant ?? detail.level); };
    const draw = (phase: number) => {
      context.clearRect(0, 0, width, height);
      const columns = Math.ceil(width / PITCH) + 2, middle = height / 2, max = height * .88;
      for (let k = 0; k < columns; k++) {
        const v = values[values.length - 1 - k] ?? 0, h = waveHeight(v, max);
        const x = width - RIGHT_PAD - BAR / 2 - (k + phase) * PITCH;
        if (x < -BAR) break;
        context.globalAlpha = .3 + v * .62;
        context.fillStyle = `rgb(${color})`;
        context.beginPath();
        if (typeof context.roundRect === "function") context.roundRect(x - BAR / 2, middle - h / 2, BAR, h, BAR / 2);
        else context.rect(x - BAR / 2, middle - h / 2, BAR, h);
        context.fill();
      }
    };
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (document.hidden) { last = now; return; }
      acc += Math.min(now - last, 200); last = now;
      while (acc >= STEP_MS) {
        value = waveStep(value, level, peak); peak = 0; acc -= STEP_MS;
        values.push(value); if (values.length > 400) values.splice(0, values.length - 300);
      }
      draw(reduced ? 0 : acc / STEP_MS);
    };
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); observer?.disconnect(); sink.current = null; };
  }, [sink]);
  return <canvas ref={canvas} className={className} aria-hidden="true" />;
}
