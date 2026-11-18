/** Keeps the screen on while the user is dictating, like a native voice-input screen. Best effort: browsers refuse in
 *  battery-saver modes or when unsupported, and the lock is dropped whenever the page is hidden, so it is taken again
 *  when the page becomes visible. Returns the function that lets the screen sleep again. */
export function holdScreenAwake(): () => void {
  let sentinel: WakeLockSentinel | null = null;
  let released = false;
  const acquire = async () => {
    if (released || sentinel || document.visibilityState !== "visible" || !navigator.wakeLock) return;
    try {
      const lock = await navigator.wakeLock.request("screen");
      if (released) { void lock.release().catch(() => {}); return; }
      sentinel = lock;
      lock.addEventListener("release", () => { if (sentinel === lock) sentinel = null; });
    } catch { /* Low-power mode or no permission: dictation still works, the screen may dim. */ }
  };
  const onVisible = () => { if (document.visibilityState === "visible") void acquire(); };
  document.addEventListener("visibilitychange", onVisible);
  void acquire();
  return () => {
    released = true;
    document.removeEventListener("visibilitychange", onVisible);
    const lock = sentinel; sentinel = null;
    void lock?.release().catch(() => {});
  };
}
