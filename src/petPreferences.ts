import type { PetPreferenceResponse, PetPreferences } from "./api";

type Position = { x: number; y: number };
type Viewport = { width: number; height: number };
type Size = { width: number; height: number };

export function normalizePetPosition(left: number, top: number, viewport: Viewport, size: Size): Position {
  return {
    x: clamp(left / Math.max(1, viewport.width - size.width)),
    y: clamp(top / Math.max(1, viewport.height - size.height))
  };
}

export function petPositionToPixels(position: Position, viewport: Viewport, size: Size, maxTop = viewport.height - size.height): Position {
  return {
    x: clamp(position.x) * Math.max(0, viewport.width - size.width),
    y: Math.min(clamp(position.y) * Math.max(0, viewport.height - size.height), Math.max(0, maxTop))
  };
}

export function movePetPosition(origin: Position, delta: Position, viewport: Viewport, size: Size, maxTop: number): Position {
  return {
    x: Math.min(Math.max(0, origin.x + delta.x), Math.max(0, viewport.width - size.width)),
    y: Math.min(Math.max(8, origin.y + delta.y), Math.max(8, Math.min(viewport.height - size.height, maxTop)))
  };
}

export function selectPet(prefs: PetPreferences, activePetId: string | null): PetPreferences {
  return { ...prefs, activePetId };
}

export function shouldStartPetDrag(targetIsButton: boolean): boolean { return !targetIsButton; }
export function shouldTriggerPetLaugh(didMove: boolean, hasLaughStrip: boolean): boolean { return !didMove && hasLaughStrip; }

export function mergePetPreferenceResponse<T extends Pick<PetPreferences, "activePetId" | "visible" | "position">>(current: T, response: PetPreferenceResponse): T {
  const fields = response.prefs ?? response;
  return {
    ...current,
    ...(fields.activePetId !== undefined ? { activePetId: fields.activePetId } : {}),
    ...(fields.visible !== undefined ? { visible: fields.visible } : {}),
    ...(fields.position !== undefined ? { position: fields.position } : {})
  };
}

function clamp(value: number): number { return Math.max(0, Math.min(1, value)); }
