/** Only the card's own summary is a toggle. Expanded input/output is selectable. */
const pointerStarts = new WeakMap<HTMLElement, { clientX: number; clientY: number }>();
export function recordToolDisclosurePointerDown(card: HTMLElement, point: { clientX: number; clientY: number }): void {
  pointerStarts.set(card, { clientX: point.clientX, clientY: point.clientY });
}
export function isToolSummaryClick(target: EventTarget | null, card: HTMLElement, pointer?: { clientY: number; clientX?: number; detail?: number }): boolean {
  const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  if (!element || element.closest("a,button,input,textarea,select,[contenteditable=true]")) return false;
  const summary = element.closest(".messageMeta");
  const ownSummary = card.querySelector<HTMLElement>(":scope > .messageMeta");
  if (!ownSummary || (summary && summary !== ownSummary)) return false;
  // Distinguish THIS gesture's drag from a click, not the page's leftover
  // selection. Never prevent pointerdown: native text selection must still work.
  const start = pointerStarts.get(card);
  pointerStarts.delete(card);
  if (start && pointer && pointer.detail !== 0 && pointer.clientX !== undefined
    && Math.hypot(pointer.clientX - start.clientX, pointer.clientY - start.clientY) > 5) return false;
  if (summary === ownSummary) return true;
  // The icon, right chevron and row padding are article pseudo-elements, not
  // descendants of messageMeta. Restore that whole header band as a hit area.
  if (element !== card) return false;
  if (!card.classList.contains("toolExpanded")) return true;
  if (!pointer) return false;
  const box = ownSummary.getBoundingClientRect();
  return pointer.clientY >= card.getBoundingClientRect().top && pointer.clientY <= box.bottom + 4;
}
