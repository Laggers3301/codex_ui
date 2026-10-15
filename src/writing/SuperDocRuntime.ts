import type { SuperDoc as SuperDocClass } from "superdoc";

type SuperDocRuntime = { SuperDoc: typeof SuperDocClass };

declare global {
  interface Window {
    __codexSuperDocRuntime130?: SuperDocRuntime;
  }
}

let runtimePromise: Promise<SuperDocRuntime> | undefined;

function loadSuperDocRuntime(): Promise<SuperDocRuntime> {
  if (window.__codexSuperDocRuntime130) return Promise.resolve(window.__codexSuperDocRuntime130);
  if (runtimePromise) return runtimePromise;

  runtimePromise = new Promise<SuperDocRuntime>((resolve, reject) => {
    const script = document.createElement("script");
    const timeout = window.setTimeout(() => {
      script.remove();
      reject(new Error("Timed out loading the local SuperDoc runtime."));
    }, 90_000);
    script.type = "module";
    // Older gateways served .mjs as an immutable generic download. A versioned
    // URL avoids retaining that wrong MIME classification in browser caches.
    script.src = "/vendor/superdoc-1.30.0/loader.mjs?v=esm-20261002";
    script.onload = () => {
      window.clearTimeout(timeout);
      const runtime = window.__codexSuperDocRuntime130;
      if (runtime) resolve(runtime);
      else reject(new Error("The local SuperDoc runtime did not initialize."));
    };
    script.onerror = () => {
      window.clearTimeout(timeout);
      script.remove();
      reject(new Error("Could not load the local SuperDoc runtime."));
    };
    document.head.append(script);
  }).catch(error => {
    runtimePromise = undefined;
    throw error;
  });

  return runtimePromise;
}

const runtime = await loadSuperDocRuntime();
export const SuperDoc = runtime.SuperDoc;
