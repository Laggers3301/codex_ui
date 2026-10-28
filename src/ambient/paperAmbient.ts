import { ShaderMount, meshGradientFragmentShader, getShaderColorFromString } from "@paper-design/shaders";
import { ambientMotion } from "./ambientMotion";

export type AmbientTheme = "dark" | "light";
const palettes = {
  dark: ["#101225", "#3438a0", "#563b92", "#191d48"],
  light: ["#e7ecff", "#96b8f8", "#b69af0", "#c7d8fc"],
};

/** One small GPU surface. Paper's own continuous loop stays off; cap ours at 30fps. */
export function mountPaperAmbient(host: HTMLElement, theme: AmbientTheme) {
  const mount = new ShaderMount(host, meshGradientFragmentShader, {
    u_colors: palettes[theme].map(color => getShaderColorFromString(color)),
    u_colorsCount: 4,
    u_distortion: .58, u_swirl: .13, u_grainMixer: 0, u_grainOverlay: 0,
    u_fit: 2, u_scale: .92, u_rotation: 0,
    u_originX: .5, u_originY: .5, u_offsetX: .08, u_offsetY: 0,
    u_worldWidth: 0, u_worldHeight: 0,
  }, { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: "low-power" }, 0, 12000, .5, 160_000);
  let raf = 0;
  let running = false;
  let last = 0;
  let elapsed = 0;
  let disposed = false;
  let drawn = 0;
  const draw = (now: number) => {
    if (!running || disposed) return;
    // Keep the last rendered glow while the transcript moves. The shared
    // passive scroll observer clears this marker after momentum scrolling.
    // Reset time so the light resumes smoothly, rather than jumping ahead.
    if (document.documentElement.hasAttribute('data-glass-scrolling')) {
      last = now;
      raf = requestAnimationFrame(draw);
      return;
    }
    const delta = now - last;
    if (delta >= 1000 / 30) {
      // Do not jump across time spent hidden or paused.
      elapsed += Math.min(delta, 80);
      const flow = ambientMotion(elapsed);
      // Extra travel lets the broad light visibly drift during a short typing burst.
      // It cannot move the editor/foreground or trigger layout/resize observers.
      host.style.transform = `translate3d(${flow.x.toFixed(3)}%, ${flow.y.toFixed(3)}%, 0) scale(${flow.scale.toFixed(4)})`;
      mount.setFrame(flow.frame);
      host.dataset.motionPhase = String(Math.round(elapsed));
      last = now - (delta % (1000 / 30));
      host.dataset.drawnFrames = String(++drawn);
    }
    raf = requestAnimationFrame(draw);
  };
  const pause = () => { running = false; cancelAnimationFrame(raf); raf = 0; };
  const contextLost = () => { pause(); host.dataset.renderer = "fallback"; };
  mount.canvasElement.addEventListener("webglcontextlost", contextLost);
  host.dataset.renderer = "paper";
  return {
    setRunning(next: boolean) {
      if (disposed || next === running || host.dataset.renderer !== "paper") return;
      if (!next) return pause();
      running = true;
      last = performance.now();
      raf = requestAnimationFrame(draw);
    },
    setTheme(next: AmbientTheme) {
      if (!disposed) mount.setUniforms({ u_colors: palettes[next].map(color => getShaderColorFromString(color)) });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      pause();
      mount.canvasElement.removeEventListener("webglcontextlost", contextLost);
      const context = mount.canvasElement.getContext("webgl2");
      mount.dispose();
      context?.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}
