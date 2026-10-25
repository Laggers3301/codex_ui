/** Report capability/preference, not a made-up server-load or FPS judgement.
 * The upstream explicitly documents partial displacement support on WebKit/Gecko. */
export function composerGlassMode(userAgent: string, reducedMotion: boolean): "original" | "browser-partial" | "reduced-motion" {
  if (reducedMotion) return "reduced-motion";
  return /(?:Chrome|Chromium|Edg)\//.test(userAgent) && !/CriOS/.test(userAgent) ? "original" : "browser-partial";
}
