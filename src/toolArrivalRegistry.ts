/** Client receipt/view identity, never a comparison with the server clock. */
export class ToolArrivalRegistry {
  private entries = new Map<string, number | null>();
  private remember(id: string, view: number | null) {
    if (this.entries.has(id)) return;
    this.entries.set(id, view);
    if (this.entries.size > 4096) this.entries.delete(this.entries.keys().next().value!);
  }
  snapshot(ids: string[]) { for (const id of ids) this.remember(id, null); }
  receive(id: string, view: number | null) { this.remember(id, view); }
  belongsToLiveView(id: string, view: number) { return this.entries.get(id) === view; }
}
