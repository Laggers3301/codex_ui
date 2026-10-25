/** Static, bounded rim map: neutral in the centre, curved at the edges.
 * Generate only on settled geometry changes, never per token/pointer move. */
export function composerLensMap(width: number, height: number, radius = 24) {
  if (![width, height, radius].every(Number.isFinite) || width <= 0 || height <= 0) throw new Error("Invalid glass geometry");
  const w = Math.max(2, Math.min(192, Math.ceil(width))), h = Math.max(2, Math.min(96, Math.ceil(height)));
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const px = (x + .5) / w * width - width / 2, py = (y + .5) / h * height - height / 2;
    const qx = Math.abs(px) - (width / 2 - r), qy = Math.abs(py) - (height / 2 - r);
    const vx = Math.max(qx, 0), vy = Math.max(qy, 0), length = Math.hypot(vx, vy);
    const depth = -(length + Math.min(Math.max(qx, qy), 0) - r);
    const bend = depth >= 0 ? Math.pow(Math.max(0, 1 - depth / 13), 2) : 0;
    const nx = length ? vx / length * Math.sign(px) : qx > qy ? Math.sign(px) : 0;
    const ny = length ? vy / length * Math.sign(py) : qy >= qx ? Math.sign(py) : 0;
    const i = (y * w + x) * 4;
    data[i] = 128 + nx * bend * 92; data[i + 1] = 128 + ny * bend * 92;
    data[i + 2] = 128; data[i + 3] = 255;
  }
  return { width: w, height: h, data };
}
/** Conservative one-way downgrade, not a permanent animation loop. */
export function composerGlassOverBudget(intervals: number[]) {
  const samples = intervals.filter(value => Number.isFinite(value) && value > 0);
  if (samples.length < 16) return false;
  return samples.reduce((a, b) => a + b, 0) / samples.length > 24
    || [...samples].sort((a, b) => a - b)[Math.floor(samples.length * .9)] > 35;
}
