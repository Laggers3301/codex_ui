import { describe, expect, it, vi } from "vitest";
import type { PetPreferences } from "./api";
import { mergePetPreferenceResponse, movePetPosition, normalizePetPosition, petPositionToPixels, selectPet, shouldStartPetDrag, shouldTriggerPetLaugh } from "./petPreferences";
import { atlasDimensions, drawLaughFrame, drawSpriteFrame, isValidAtlasSize, isValidLaughStripSize, laughSourceRect, PET_CELL, PET_FRAME_COUNTS, PET_ROW_BY_STATUS, spriteSourceRect } from "./petSprite";

describe("pet atlas renderer contract", () => {
  it("validates exact v1/v2 atlas dimensions and fixed cells", () => {
    expect(atlasDimensions(1)).toEqual({ width: 1536, height: 1872, rows: 9 });
    expect(atlasDimensions(2)).toEqual({ width: 1536, height: 2288, rows: 11 });
    expect(isValidAtlasSize(1536, 1872, 1)).toBe(true);
    expect(isValidAtlasSize(1536, 2288, 2)).toBe(true);
    expect(isValidAtlasSize(1536, 2080, 2)).toBe(false);
    expect(PET_CELL).toEqual({ width: 192, height: 208, columns: 8 });
    expect(PET_FRAME_COUNTS).toEqual([6, 8, 8, 4, 5, 8, 6, 6, 6]);
  });

  it("maps thread actions to the contract rows and calculates frame crops", () => {
    expect(PET_ROW_BY_STATUS).toEqual({ idle: 0, running: 7, approved: 3, complete: 8, failed: 5, needsInput: 6 });
    expect(spriteSourceRect(PET_ROW_BY_STATUS.running, 5)).toEqual({ x: 960, y: 1456, width: 192, height: 208 });
    expect(spriteSourceRect(PET_ROW_BY_STATUS.failed, 4)).toEqual({ x: 768, y: 1040, width: 192, height: 208 });
    const context = { clearRect: vi.fn(), drawImage: vi.fn() } as unknown as CanvasRenderingContext2D;
    const canvas = { width: 96, height: 104 } as HTMLCanvasElement;
    const image = {} as CanvasImageSource;
    drawSpriteFrame(context, image, canvas, PET_ROW_BY_STATUS.complete, 2);
    expect(context.clearRect).toHaveBeenCalledWith(0, 0, 96, 104);
    expect(context.drawImage).toHaveBeenCalledWith(image, 384, 1664, 192, 208, 0, 0, 96, 104);
  });

  it("accepts the optional eight-frame laugh strip without changing either main atlas layout", () => {
    expect(isValidLaughStripSize(1536, 208)).toBe(true);
    expect(isValidLaughStripSize(1536, 2288)).toBe(false);
    expect(laughSourceRect(7)).toEqual({ x: 1344, y: 0, width: 192, height: 208 });
    const context = { clearRect: vi.fn(), drawImage: vi.fn() } as unknown as CanvasRenderingContext2D;
    const canvas = { width: 96, height: 104 } as HTMLCanvasElement;
    const strip = {} as CanvasImageSource;
    drawLaughFrame(context, strip, canvas, 7);
    expect(context.drawImage).toHaveBeenCalledWith(strip, 1344, 0, 192, 208, 0, 0, 96, 104);
    expect(atlasDimensions(2).rows).toBe(11);
  });
});

describe("pet preferences and placement", () => {
  const prefs: PetPreferences = {
    pets: [{ id: "pet-a", name: "A", version: 1, spritesheetUrl: "/api/pets/a/spritesheet" }],
    activePetId: null,
    visible: false,
    position: null
  };

  it("keeps selection independent from visibility", () => {
    expect(selectPet(prefs, "pet-a")).toEqual({ ...prefs, activePetId: "pet-a", visible: false });
  });

  it("does not begin a drag from the hide control or treat a drag as a laugh tap", () => {
    expect(shouldStartPetDrag(true)).toBe(false);
    expect(shouldStartPetDrag(false)).toBe(true);
    expect(shouldTriggerPetLaugh(true, true)).toBe(false);
    expect(shouldTriggerPetLaugh(false, false)).toBe(false);
    expect(shouldTriggerPetLaugh(false, true)).toBe(true);
  });

  it("merges prefs-only PATCH responses without losing pet records", () => {
    expect(mergePetPreferenceResponse(prefs, { prefs: { activePetId: "pet-a", visible: true } })).toEqual({ ...prefs, activePetId: "pet-a", visible: true });
  });

  it("commits flat production responses so failed switches retain the last shown state", () => {
    const initialCommitted = { activePetId: "milk", visible: false, position: null };
    const shown = mergePetPreferenceResponse(initialCommitted, { activePetId: "milk", visible: true, position: null });
    expect(shown).toEqual({ activePetId: "milk", visible: true, position: null });
    const optimistic = { ...prefs, activePetId: "codex", visible: true };
    expect(mergePetPreferenceResponse(optimistic, { prefs: shown })).toEqual({ ...prefs, activePetId: "milk", visible: true });
    expect(mergePetPreferenceResponse(shown, { activePetId: "codex", visible: true })).toEqual({ ...shown, activePetId: "codex" });
  });

  it("normalizes, restores and clamps pointer positions to the viewport/composer bound", () => {
    const normalized = normalizePetPosition(500, 200, { width: 1000, height: 800 }, { width: 100, height: 100 });
    expect(normalized).toEqual({ x: 500 / 900, y: 200 / 700 });
    expect(petPositionToPixels({ x: normalized.x, y: 0.8 }, { width: 500, height: 600 }, { width: 100, height: 100 }, 240)).toEqual({ x: 400 * (500 / 900), y: 240 });
    expect(movePetPosition({ x: 20, y: 50 }, { x: 900, y: 500 }, { width: 300, height: 500 }, { width: 96, height: 104 }, 180)).toEqual({ x: 204, y: 180 });
  });
});
