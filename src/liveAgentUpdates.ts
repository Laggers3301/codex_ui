export interface AgentTextState {
  threadId: string | null; turnId: string | null; text: string; startedAt: string;
  sequence?: number; sourceItemId?: string;
  completed?: boolean; streamState?: "streaming" | "completed" | "interrupted" | "superseded";
}
export type AgentWireUpdate = Omit<AgentTextState, 'text'> & { text?: string; delta?: string; textOffset?: number };
/** Offsets detect a missing base; recover via live.state instead of corrupting text. */
export function applyLiveAgentUpdate(base: AgentTextState | undefined, wire: AgentWireUpdate): AgentTextState | null {
  // Completion/supersession is monotonic within an item. A late draft packet
  // must not resurrect an abandoned attempt or overwrite committed text.
  if (base && (base.completed || base.streamState === "superseded") && wire.completed !== true) return base;
  let text: string;
  if (typeof wire.text === 'string') text = wire.text;
  else {
    if (typeof wire.delta !== 'string' || wire.textOffset !== (base?.text.length ?? 0)) return null;
    text = (base?.text ?? '') + wire.delta;
  }
  return { threadId: wire.threadId, turnId: wire.turnId, text, startedAt: wire.startedAt, sequence: wire.sequence, sourceItemId: wire.sourceItemId, completed: wire.completed, streamState: wire.streamState };
}
