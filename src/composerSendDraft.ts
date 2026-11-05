/** Returning a failed submission must never overwrite text typed afterwards. */
export function restoreSubmittedText(current: string, submitted: string): string {
  if (!current.trim()) return submitted;
  if (!submitted.trim() || current.trim() === submitted.trim()) return current;
  return `${submitted}\n\n${current}`;
}
