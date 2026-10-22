/** Bounded motion on the decorative canvas only. Pause time is never accumulated. */
export function ambientMotion(elapsedMs: number) {
  const t = Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0) / 1000;
  return {
    frame: 12000 + t * 620,
    x: 4.8 * Math.sin(t * .62) + 1.2 * Math.sin(t * .27),
    y: 2.2 * Math.sin(t * .43),
    scale: 1.12 + .018 * Math.sin(t * .38),
  };
}
