/** A scrolling virtualizer may defer its normal element measurement. Newly
 * prepended variable-height rows must never paint using the 260px estimate. */
export function measureCommittedConversationRows(container: HTMLElement, resize: (index: number, height: number) => void): void {
  for (const row of container.querySelectorAll<HTMLElement>(":scope > .virtualConversationSizer > .virtualConversationRow")) {
    const index = Number(row.dataset.index), height = row.offsetHeight;
    if (Number.isInteger(index) && index >= 0 && row.dataset.index !== undefined && height > 0) resize(index, height);
  }
}
