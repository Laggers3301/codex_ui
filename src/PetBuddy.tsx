import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Check as PanelCheck, Plus as PanelPlus, Search as PanelSearch, X as PanelX } from "./PanelIcons";
import { listPets, patchPetPreferences, uploadPetAtlas, type PetPreferences, type PetRecord } from "./api";
import { drawLaughFrame, drawSpriteFrame, isValidAtlasSize, PET_CELL, PET_FRAME_COUNTS, PET_ROW_BY_STATUS, spriteSourceRect, type PetStatus } from "./petSprite";
import { mergePetPreferenceResponse, movePetPosition, normalizePetPosition, petPositionToPixels, shouldStartPetDrag, shouldTriggerPetLaugh } from "./petPreferences";
import { createPetImageCache, type PetImageCache } from "./petImageCache";
import "./petBuddy.css";

const initial: PetPreferences = { pets: [], activePetId: null, visible: false, position: null };

function useExitPresence(open: boolean, duration = 300) {
  const [present, setPresent] = useState(open);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    if (open) { setPresent(true); setClosing(false); return; }
    if (!present) return;
    setClosing(true);
    const timer = window.setTimeout(() => { setPresent(false); setClosing(false); }, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : duration);
    return () => window.clearTimeout(timer);
  }, [open, present, duration]);
  return { present, closing };
}

function petAtlasUrl(pet: PetRecord): string { return pet.spritesheetUrl; }

const PetSpriteFrame = memo(function PetSpriteFrame({ pet, image, status, cache }: { pet: PetRecord; image: HTMLImageElement; status: PetStatus; cache: PetImageCache }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const laughImageRef = useRef<HTMLImageElement | null>(null);
  const frameRef = useRef(0);
  const [laughReady, setLaughReady] = useState(false);
  const row = PET_ROW_BY_STATUS[status === "laughing" ? "idle" : status];
  useEffect(() => {
    laughImageRef.current = null;
    setLaughReady(false);
  }, [pet.id]);
  useEffect(() => {
    if (status !== "laughing" || !pet.laughSpritesheetUrl) return;
    let disposed = false;
    const request = cache.acquire({ url: pet.laughSpritesheetUrl, kind: "laugh", version: pet.version });
    void request.promise.then((decoded) => {
      if (disposed) return;
      laughImageRef.current = decoded;
      setLaughReady(true);
    }).catch(() => {});
    return () => { disposed = true; request.release(); };
  }, [cache, pet.id, pet.version, pet.laughSpritesheetUrl, status]);
  useEffect(() => {
    frameRef.current = 0;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    let raf = 0;
    let last = 0;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const laughing = status === "laughing" && Boolean(pet.laughSpritesheetUrl && laughReady && laughImageRef.current);
    const draw = () => {
      if (laughing && laughImageRef.current) drawLaughFrame(context, laughImageRef.current, canvas, frameRef.current);
      else drawSpriteFrame(context, image, canvas, row, frameRef.current);
    };
    draw();
    const paint = (time: number) => {
      if (document.hidden || motion.matches) { raf = 0; return; }
      if (time - last >= 145) {
        last = time;
        frameRef.current = (frameRef.current + 1) % (laughing ? PET_CELL.columns : PET_FRAME_COUNTS[row]);
        draw();
      }
      raf = requestAnimationFrame(paint);
    };
    const start = () => { if (raf || document.hidden || motion.matches) return; last = 0; raf = requestAnimationFrame(paint); };
    const onVisibility = () => { if (document.hidden) { cancelAnimationFrame(raf); raf = 0; } else start(); };
    const onMotion = () => { if (motion.matches) { cancelAnimationFrame(raf); raf = 0; draw(); } else start(); };
    document.addEventListener("visibilitychange", onVisibility);
    motion.addEventListener("change", onMotion);
    start();
    return () => { cancelAnimationFrame(raf); document.removeEventListener("visibilitychange", onVisibility); motion.removeEventListener("change", onMotion); };
  }, [image, laughReady, pet.id, pet.version, pet.laughSpritesheetUrl, row, status]);
  return <canvas ref={canvasRef} width={192} height={208} aria-hidden="true" />;
});

type DisplayedPet = { pet: PetRecord; image: HTMLImageElement };
const PetSprite = memo(function PetSprite({ pet, status, cache, revision, onError }: { pet: PetRecord; status: PetStatus; cache: PetImageCache; revision: number; onError: (error: string) => void }) {
  const [displayed, setDisplayed] = useState<DisplayedPet | null>(null);
  const [previous, setPrevious] = useState<DisplayedPet | null>(null);
  const displayedRef = useRef<DisplayedPet | null>(null);
  const transitionTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    let disposed = false;
    const request = cache.acquire({ url: petAtlasUrl(pet), kind: "atlas", version: pet.version });
    void request.promise.then((image) => {
      if (disposed) return;
      const old = displayedRef.current;
      if (old?.pet.id === pet.id && old.image === image) return;
      const next = { pet, image };
      window.clearTimeout(transitionTimer.current);
      displayedRef.current = next;
      setPrevious(old);
      setDisplayed(next);
      transitionTimer.current = window.setTimeout(() => setPrevious(null), window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 380);
    }).catch((error) => {
      if (!disposed && error?.name !== "AbortError") onError(error instanceof Error ? error.message : "宠物动画加载失败。");
    });
    return () => { disposed = true; request.release(); };
  }, [cache, pet.id, pet.version, pet.spritesheetUrl, revision, onError]);
  useEffect(() => () => window.clearTimeout(transitionTimer.current), []);
  return <div className="petSpriteStack" data-pet-id={displayed?.pet.id} data-pending={displayed?.pet.id !== pet.id ? "true" : "false"} aria-busy={displayed?.pet.id !== pet.id}>
    {!displayed ? <div className="petSpritePreview"><PetThumbnail pet={pet} /></div> : null}
    {[previous, displayed].filter((item): item is DisplayedPet => Boolean(item)).map((item) => <div key={item.pet.id} className={`petSpriteLayer ${item === previous ? "leaving" : "entering"}`} data-pet-id={item.pet.id}>
      <PetSpriteFrame pet={item.pet} image={item.image} status={status} cache={cache} />
    </div>)}
  </div>;
});

const PetThumbnail = memo(function PetThumbnail({ pet }: { pet: PetRecord }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let disposed = false;
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      const canvas = canvasRef.current;
      const context = canvas?.getContext("2d");
      if (!disposed && canvas && context) {
        if (pet.thumbnailUrl && image.naturalWidth === PET_CELL.width && image.naturalHeight === PET_CELL.height) {
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
        } else if (!pet.thumbnailUrl && isValidAtlasSize(image.naturalWidth, image.naturalHeight, pet.version)) {
          const rect = spriteSourceRect(PET_ROW_BY_STATUS.idle, 0);
          context.drawImage(image, rect.x, rect.y, rect.width, rect.height, 0, 0, canvas.width, canvas.height);
        }
      }
    };
    image.src = pet.thumbnailUrl ?? petAtlasUrl(pet);
    return () => { disposed = true; };
  }, [pet.id, pet.version, pet.spritesheetUrl, pet.thumbnailUrl]);
  return <canvas ref={canvasRef} width={192} height={208} aria-hidden="true" />;
});

export const PetBuddy = memo(function PetBuddy({ status = "idle" }: { status?: PetStatus }) {
  const [prefs, setPrefs] = useState(initial);
  const [loaded, setLoaded] = useState(false);
  const [picker, setPicker] = useState(false);
  const [search, setSearch] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [laughing, setLaughing] = useState(false);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [actionStatus, setActionStatus] = useState<PetStatus | null>(null);
  const [selectionRevision, setSelectionRevision] = useState(0);
  const committedPrefsRef = useRef<Pick<PetPreferences, "activePetId" | "visible" | "position">>({ activePetId: null, visible: false, position: null });
  const mountedRef = useRef(false);
  const mutationSeqRef = useRef(0);
  const mutationQueueRef = useRef<Promise<void>>(Promise.resolve());
  const requestsRef = useRef(new Set<AbortController>());
  const laughTimerRef = useRef<number | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const wasPickerOpenRef = useRef(false);
  const dialogRef = useRef<HTMLElement>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);
  const imageCacheRef = useRef<PetImageCache | null>(null);
  if (!imageCacheRef.current) imageCacheRef.current = createPetImageCache();
  const imageCache = imageCacheRef.current;
  const picked = prefs.pets.find((pet) => pet.id === prefs.activePetId);
  const floatPresence = useExitPresence(prefs.visible && Boolean(picked), 420);
  const pickerPresence = useExitPresence(picker, 220);
  useEffect(() => {
    mountedRef.current = true;
    const controller = new AbortController();
    requestsRef.current.add(controller);
    void listPets(controller.signal).then((data) => { if (!controller.signal.aborted) { const loadedPrefs = data.prefs ? mergePetPreferenceResponse(data, data) : data; committedPrefsRef.current = { activePetId: loadedPrefs.activePetId, visible: loadedPrefs.visible, position: loadedPrefs.position }; setPrefs(loadedPrefs); setPosition(loadedPrefs.position ? normalizedToPixels(loadedPrefs.position) : null); } }).catch(() => {}).finally(() => { if (!controller.signal.aborted) setLoaded(true); requestsRef.current.delete(controller); });
    return () => {
      mountedRef.current = false;
      for (const request of requestsRef.current) request.abort();
      requestsRef.current.clear();
      imageCache.clear();
      if (laughTimerRef.current !== null) window.clearTimeout(laughTimerRef.current);
    };
  }, []);
  useEffect(() => {
    const openPicker = () => { previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setPicker(true); };
    window.addEventListener("codex:open-pets", openPicker);
    return () => window.removeEventListener("codex:open-pets", openPicker);
  }, []);
  useEffect(() => {
    if (picker && loaded) {
      wasPickerOpenRef.current = true;
      const focusables = () => [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])].filter((element) => element.offsetParent !== null);
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") { event.preventDefault(); setPicker(false); return; }
        if (event.key !== "Tab") return;
        const items = focusables();
        if (!items.length) { event.preventDefault(); dialogRef.current?.focus(); return; }
        const first = items[0]; const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      };
      window.addEventListener("keydown", onKeyDown);
      const searchInput = dialogRef.current?.querySelector<HTMLInputElement>(".petSearch input");
      (searchInput ?? focusables()[0] ?? dialogRef.current)?.focus({ preventScroll: true });
      return () => window.removeEventListener("keydown", onKeyDown);
    }
    if (wasPickerOpenRef.current) {
      wasPickerOpenRef.current = false;
      if (previousFocusRef.current?.isConnected) previousFocusRef.current.focus();
      else document.querySelector<HTMLElement>(".v2AccountTrigger")?.focus();
    }
  }, [picker, loaded]);
  useEffect(() => {
    const action = (event: Event) => {
      const next = (event as CustomEvent<PetStatus>).detail;
      if (!next || !["approved", "complete", "failed"].includes(next)) return;
      setActionStatus(next);
      window.setTimeout(() => { if (mountedRef.current) setActionStatus((current) => current === next ? null : current); }, 2400);
    };
    window.addEventListener("codex:pet-action", action);
    return () => window.removeEventListener("codex:pet-action", action);
  }, []);
  const save = useCallback((patch: Partial<Pick<PetPreferences, "activePetId" | "visible" | "position">>) => {
    setError("");
    setPrefs((value) => mergePetPreferenceResponse(value, patch));
    const sequence = ++mutationSeqRef.current;
    const controller = new AbortController();
    requestsRef.current.add(controller);
    mutationQueueRef.current = mutationQueueRef.current.catch(() => {}).then(async () => {
      if (controller.signal.aborted) return;
      try {
        const result = await patchPetPreferences(patch, controller.signal);
        committedPrefsRef.current = mergePetPreferenceResponse(committedPrefsRef.current, result);
        if (!mountedRef.current || controller.signal.aborted || sequence !== mutationSeqRef.current) return;
        setPrefs((current) => mergePetPreferenceResponse(current, result));
      } catch (caught) {
        if (mountedRef.current && !controller.signal.aborted && sequence === mutationSeqRef.current) {
          setPrefs((current) => mergePetPreferenceResponse(current, { prefs: committedPrefsRef.current }));
          setPosition(committedPrefsRef.current.position ? normalizedToPixels(committedPrefsRef.current.position) : null);
          setError(caught instanceof Error ? caught.message : "保存失败");
        }
      } finally { requestsRef.current.delete(controller); }
    });
  }, []);
  const preloadPet = (pet: PetRecord) => imageCache.preload({ url: petAtlasUrl(pet), kind: "atlas", version: pet.version });
  const choosePet = (pet: PetRecord) => {
    preloadPet(pet);
    setSelectionRevision((value) => value + 1);
    setLaughing(false);
    if (laughTimerRef.current !== null) window.clearTimeout(laughTimerRef.current);
    laughTimerRef.current = null;
    // Selecting a character must preserve this device's current show/hide
    // intent even if another device previously changed the saved preference.
    save({ activePetId: pet.id, visible: prefs.visible });
  };
  const triggerLaugh = useCallback(() => {
    if (!picked?.laughSpritesheetUrl) return;
    if (laughTimerRef.current !== null) window.clearTimeout(laughTimerRef.current);
    setLaughing(true);
    laughTimerRef.current = window.setTimeout(() => {
      if (mountedRef.current) setLaughing(false);
      laughTimerRef.current = null;
    }, 2400);
  }, [picked?.laughSpritesheetUrl]);
  const upload = async (file?: File) => {
    if (!file) return;
    if (!/^image\/(png|webp)$/.test(file.type)) { setError("请选择透明 PNG 或 WebP 图集。"); return; }
    setUploading(true); setError("");
    const controller = new AbortController();
    requestsRef.current.add(controller);
    try {
      const result = await uploadPetAtlas(file, file.name.replace(/\.[^.]+$/, "") || "我的宠物", controller.signal);
      if (mountedRef.current && !controller.signal.aborted) { setPrefs((value) => ({ ...value, pets: [...value.pets, result.pet] })); setError(""); }
    } catch (caught) { if (mountedRef.current && !controller.signal.aborted) setError(caught instanceof Error ? caught.message : "上传失败"); }
    finally { requestsRef.current.delete(controller); if (mountedRef.current) setUploading(false); }
  };
  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!shouldStartPetDrag(Boolean((event.target as HTMLElement).closest("button")))) return;
    const rect = event.currentTarget.getBoundingClientRect();
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: rect.left, originY: rect.top, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX; const dy = event.clientY - drag.startY;
    if (Math.abs(dx) + Math.abs(dy) > 5) { drag.moved = true; setDragging(true); }
    if (!drag.moved) return;
    setPosition(movePetPosition({ x: drag.originX, y: drag.originY }, { x: dx, y: dy }, { width: window.innerWidth, height: window.innerHeight }, { width: 96, height: 104 }, maxPetTop()));
  };
  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.moved) {
      const rect = event.currentTarget.getBoundingClientRect();
      const normalized = normalizePetPosition(rect.left, rect.top, { width: window.innerWidth, height: window.innerHeight }, { width: rect.width, height: rect.height });
      setPosition(normalizedToPixels(normalized)); save({ position: normalized });
    }
    if (shouldTriggerPetLaugh(drag.moved, Boolean(picked?.laughSpritesheetUrl))) triggerLaugh();
    dragRef.current = null; window.setTimeout(() => setDragging(false), 0);
  };
  function maxPetTop() {
    const composerTop = document.querySelector<HTMLElement>(".composer")?.getBoundingClientRect().top;
    return Math.max(8, Math.min(window.innerHeight - 116, composerTop == null ? window.innerHeight - 260 : composerTop - 108));
  }
  function normalizedToPixels(value: { x: number; y: number }) { return petPositionToPixels(value, { width: window.innerWidth, height: window.innerHeight }, { width: 96, height: 104 }, maxPetTop()); }
  useEffect(() => {
    if (!prefs.position) return;
    const resize = () => setPosition(normalizedToPixels(prefs.position!));
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [prefs.position]);
  if (!loaded) return null;
  return <>
    {pickerPresence.present ? <div className={`petPickerScrim${pickerPresence.closing ? " closing" : ""}`} aria-hidden={pickerPresence.closing} inert={pickerPresence.closing} onClick={(event) => { if (event.target === event.currentTarget) { event.preventDefault(); event.stopPropagation(); setPicker(false); } }}>
      <section ref={dialogRef} className="petPicker uiGlassSurface" role="dialog" aria-modal="true" aria-label="选择宠物" tabIndex={-1}>
        <header><div><strong>我的宠物</strong><small>在页面角落陪伴当前会话</small></div><button type="button" aria-label="关闭" onClick={() => setPicker(false)}><PanelX size={17} /></button></header>
        <label className="petSearch"><PanelSearch size={16} /><span className="petSearchInput"><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索宠物" autoFocus /></span></label>
        <div className="petGrid">{prefs.pets.filter((pet) => pet.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map((pet) => <button className={`petChoice${pet.id === prefs.activePetId ? " selected" : ""}`} type="button" key={pet.id} onPointerEnter={(event) => { if (event.pointerType === "mouse") preloadPet(pet); }} onFocus={() => preloadPet(pet)} onPointerDown={() => preloadPet(pet)} onClick={() => choosePet(pet)}><PetThumbnail pet={pet} /><span>{pet.name}</span>{pet.id === prefs.activePetId ? <PanelCheck size={14} /> : null}</button>)}</div>
        <label className="petUpload"><PanelPlus size={15} />{uploading ? "正在上传…" : "上传自己的图集"}<input type="file" accept="image/png,image/webp" disabled={uploading} onChange={(event) => { void upload(event.target.files?.[0]); event.currentTarget.value = ""; }} /></label>
        {error ? <p className="petError" role="alert">{error}</p> : null}
        {picked ? <button className="petVisibilityToggle" type="button" onClick={() => { save({ visible: !prefs.visible }); setPicker(false); }}>{prefs.visible ? "隐藏宠物" : "显示宠物"}</button> : <p className="petEmpty">{prefs.pets.length ? "未选择宠物" : "尚无宠物；可上传 v1/v2 透明 PNG 或 WebP 图集。"}</p>}
      </section>
    </div> : null}
    {floatPresence.present && picked ? <div className={`petBuddyFloat${dragging ? " dragging" : ""}${floatPresence.closing ? " closing" : ""}`} aria-hidden={floatPresence.closing} style={position ? { left: position.x, top: position.y } : undefined} onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
      <PetSprite pet={picked} status={laughing ? "laughing" : actionStatus ?? status} cache={imageCache} revision={selectionRevision} onError={setError} />
      <button type="button" aria-label="隐藏宠物" title="隐藏宠物" onPointerDown={(event) => event.stopPropagation()} onClick={() => save({ visible: false })}>隐藏</button>
    </div> : null}
  </>;
});
