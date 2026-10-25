import { memo, useId, useLayoutEffect, useRef, useState } from "react";
import LiquidGlass from "liquid-glass-react";
import { composerGlassMode } from "./composerGlassPolicy";
import "./composerLiquidGlass.css";

const stationaryGlassPointer = { x: 0, y: 0 };

/** Use the upstream optical renderer on ONE decorative backing layer.
 * The editor, popovers and control hit targets are not reparented or warped.
 * CSS, not delayed measurements/remounts, owns every visible surface's size.
 * Pointer movement updates highlights only; it never stretches the editor. */
export const ComposerGlassMaterial = memo(function ComposerGlassMaterial({ variant = "composer" }: { variant?: "composer" | "topbar" }) {
  const prefix = variant === "topbar" ? "topbar" : "composer";
  const backdropProperty = variant === "topbar" ? "--topbar-backdrop-optics" : "--composer-backdrop-optics";
  const anchor = useRef<HTMLSpanElement>(null);
  const hostRef = useRef<HTMLElement | null>(null);
  const fastFilterId = useId();
  const [mapHref, setMapHref] = useState<string>();
  const [pointerOffset, setPointerOffset] = useState(stationaryGlassPointer);
  const [ready, setReady] = useState(false);
  const [light, setLight] = useState(false);
  useLayoutEffect(() => {
    const host = anchor.current?.parentElement;
    if (!host) return;
    hostRef.current = host;
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    let pointerFrame = 0;
    let pointerX = 0, pointerY = 0;
    const pointer = (event: PointerEvent) => {
      if (variant !== "composer" || event.pointerType === "touch" || motion.matches) return;
      pointerX = event.clientX; pointerY = event.clientY;
      if (pointerFrame) return;
      pointerFrame = requestAnimationFrame(() => {
        pointerFrame = 0;
        const bounds = host.getBoundingClientRect();
        if (!bounds.width || !bounds.height) return;
        setPointerOffset({ x: (pointerX - bounds.left - bounds.width / 2) / bounds.width * 100,
          y: (pointerY - bounds.top - bounds.height / 2) / bounds.height * 100 });
      });
    };
    const updateMotion = () => {
      host.dataset.glassOptics = composerGlassMode(navigator.userAgent, motion.matches);
      host.dataset.glassEngine = "liquid-glass-react@1.1.1";
      host.dataset.glassPolicy = "original-no-fps-downgrade";
      host.dataset.glassLayout = "css-locked";
    };
    const updateTheme = () => setLight(document.documentElement.dataset.theme === "light");
    const theme = new MutationObserver(updateTheme);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    motion.addEventListener("change", updateMotion);
    host.addEventListener("pointermove", pointer, { passive: true });
    updateMotion(); updateTheme(); setReady(true);
    return () => {
      theme.disconnect();
      motion.removeEventListener("change", updateMotion);
      host.removeEventListener("pointermove", pointer);
      cancelAnimationFrame(pointerFrame);
      delete host.dataset.glassOptics; delete host.dataset.glassEngine; delete host.dataset.glassPolicy;
      delete host.dataset.glassLayout;
      hostRef.current = null;
    };
  }, [variant]);
  useLayoutEffect(() => {
    if (!ready) return;
    const host = hostRef.current;
    const filter = host?.querySelector<SVGFilterElement>(`.${prefix}OriginalPane filter`);
    if (!host || !filter) return;
    const image = filter.querySelector("feImage")?.getAttribute("href");
    if (!image) return;
    setMapHref(image);
    host.dataset.glassPipeline = "single-displacement";
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      if (composerGlassMode(navigator.userAgent, motion.matches) === "original") {
        // Filter the BACKDROP, not the empty foreground span. Applying an SVG
        // foreground filter only proved it was attached, not that it refracted
        // any transcript pixels. Keep blur in the same, real sampling pass.
        host.style.setProperty(backdropProperty, `url("#${fastFilterId}") blur(${variant === "topbar" ? 8 : 12}px) saturate(1.12)`);
        host.dataset.glassBackdrop = "svg-backdrop";
      } else {
        host.style.removeProperty(backdropProperty);
        host.dataset.glassBackdrop = "blur-fallback";
      }
    };
    motion.addEventListener("change", update);
    update();
    return () => {
      motion.removeEventListener("change", update);
      host.style.removeProperty(backdropProperty);
      delete host.dataset.glassBackdrop;
      delete host.dataset.glassPipeline;
    };
  }, [ready, prefix, backdropProperty, variant, fastFilterId]);
  return <>
    <span ref={anchor} className="composerGlassAnchor" aria-hidden="true" />
    {ready ? <div className={`${prefix}OriginalLayer`} data-ready="true" aria-hidden="true">
      {/* Preserve the upstream lens map and real backdrop displacement, without
          three colour-separated displacement passes and their blend graph.
          This definition is static during scrolling, typing and streaming. */}
      <svg className={`${prefix}FastDefs`} aria-hidden="true" focusable="false">
        <defs><filter id={fastFilterId} x="-35%" y="-35%" width="170%" height="170%" colorInterpolationFilters="sRGB">
          <feImage href={mapHref} x="0" y="0" width="100%" height="100%" preserveAspectRatio="xMidYMid slice" result="DISPLACEMENT_MAP" />
          <feDisplacementMap in="SourceGraphic" in2="DISPLACEMENT_MAP" scale={-(variant === "topbar" ? 16 : 70) * (light ? .5 : 1)} xChannelSelector="R" yChannelSelector="B" />
        </filter></defs>
      </svg>
      <LiquidGlass
        className={`${prefix}OriginalPane`}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
        cornerRadius={variant === "topbar" ? 10 : 26}
        displacementScale={variant === "topbar" ? 16 : 70}
        aberrationIntensity={variant === "topbar" ? 1 : 2}
        padding="0"
        mouseContainer={hostRef}
        globalMousePos={stationaryGlassPointer}
        mouseOffset={variant === "topbar" ? stationaryGlassPointer : pointerOffset}
        overLight={light}
        elasticity={0}
      ><span className="composerGlassFiller" /></LiquidGlass>
    </div> : null}
  </>;
});
