export interface SelectMenuViewport { width: number; height: number; left?: number; top?: number }
export interface SelectMenuAnchor { left: number; right: number; top: number; bottom: number; width: number }

export function selectMenuPosition(anchor: SelectMenuAnchor, desiredWidth: number, desiredHeight: number, viewport: SelectMenuViewport) {
  const margin = 8, gap = 7;
  const leftEdge = (viewport.left ?? 0) + margin;
  const topEdge = (viewport.top ?? 0) + margin;
  const rightEdge = (viewport.left ?? 0) + viewport.width - margin;
  const bottomEdge = (viewport.top ?? 0) + viewport.height - margin;
  const width = Math.max(1, Math.min(Math.max(anchor.width, desiredWidth), viewport.width - margin * 2));
  const below = Math.max(0, bottomEdge - anchor.bottom - gap);
  const above = Math.max(0, anchor.top - gap - topEdge);
  const height = Math.min(360, desiredHeight);
  const opensAbove = below < height && above > below;
  const maxHeight = Math.max(1, Math.min(360, opensAbove ? above : below, viewport.height - margin * 2));
  const shownHeight = Math.min(height, maxHeight);
  const top = Math.max(topEdge, Math.min(opensAbove ? anchor.top - gap - shownHeight : anchor.bottom + gap, bottomEdge - shownHeight));
  return { left: Math.max(leftEdge, Math.min(anchor.right - width, rightEdge - width)), top, width, maxHeight };
}
