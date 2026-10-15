export type PetStatus = "idle" | "running" | "approved" | "complete" | "failed" | "needsInput" | "laughing";

export const PET_CELL = { width: 192, height: 208, columns: 8 } as const;
export const PET_FRAME_COUNTS = [6, 8, 8, 4, 5, 8, 6, 6, 6] as const;
// Row indices follow the v2 contract: idle 0, waiting 6, work/running 7, review 8.
export const PET_ROW_BY_STATUS: Record<Exclude<PetStatus, "laughing">, number> = {
  idle: 0,
  running: 7,
  approved: 3,
  complete: 8,
  failed: 5,
  needsInput: 6
};

export function atlasDimensions(version: 1 | 2) {
  return { width: 1536, height: version === 1 ? 1872 : 2288, rows: version === 1 ? 9 : 11 };
}

export function isValidAtlasSize(width: number, height: number, version: 1 | 2): boolean {
  const expected = atlasDimensions(version);
  return width === expected.width && height === expected.height;
}

export function isValidLaughStripSize(width: number, height: number): boolean {
  return width === PET_CELL.width * PET_CELL.columns && height === PET_CELL.height;
}

export function laughSourceRect(frame: number) {
  return { x: (frame % PET_CELL.columns) * PET_CELL.width, y: 0, width: PET_CELL.width, height: PET_CELL.height };
}

export function spriteSourceRect(row: number, frame: number) {
  return { x: (frame % PET_FRAME_COUNTS[row]) * PET_CELL.width, y: row * PET_CELL.height, width: PET_CELL.width, height: PET_CELL.height };
}

export function drawSpriteFrame(
  context: CanvasRenderingContext2D,
  image: CanvasImageSource,
  canvas: HTMLCanvasElement,
  row: number,
  frame: number
): void {
  const source = spriteSourceRect(row, frame);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, source.x, source.y, source.width, source.height, 0, 0, canvas.width, canvas.height);
}

export function drawLaughFrame(context: CanvasRenderingContext2D, image: CanvasImageSource, canvas: HTMLCanvasElement, frame: number): void {
  const source = laughSourceRect(frame);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, source.x, source.y, source.width, source.height, 0, 0, canvas.width, canvas.height);
}
