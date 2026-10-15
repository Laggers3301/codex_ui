import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  isOpen: false,
  statusListener: null as null | ((status: string) => void),
  cleanup: null as null | (() => void),
  send: vi.fn(),
  setState: vi.fn(),
}));
vi.mock("./codexSocket", () => ({ codexSocket: {
  get isOpen() { return harness.isOpen; },
  send: harness.send,
  subscribe: () => () => {},
  subscribeStatus: (listener: (status: string) => void) => {
    harness.statusListener = listener;
    return () => { harness.statusListener = null; };
  },
} }));
vi.mock("react", () => ({
  useRef: (current: unknown) => ({ current }),
  useState: (initial: unknown) => [initial, harness.setState],
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => (() => void)) => { harness.cleanup = effect(); },
}));
import { useThreadGoal } from "./threadGoal";

beforeEach(() => {
  vi.useFakeTimers();
  harness.isOpen = false;
  harness.send.mockReset();
  harness.setState.mockReset();
});
afterEach(() => { harness.cleanup?.(); vi.useRealTimers(); });

describe("goal state initialization", () => {
  it("waits for open before querying a restored conversation", () => {
    useThreadGoal("thread-1", "user-1");
    expect(harness.send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    harness.isOpen = true;
    harness.statusListener?.("open");
    expect(harness.send).toHaveBeenCalledOnce();
    expect(harness.send.mock.calls[0][0]).toMatchObject({ type: "goal.get", threadId: "thread-1", userId: "user-1" });
  });

  it("queries immediately if connected before the hook subscribes", () => {
    harness.isOpen = true;
    useThreadGoal("thread-1", "user-1");
    expect(harness.send).toHaveBeenCalledOnce();
  });

  it("does not retry a disconnected goal mutation when the socket opens", () => {
    harness.send.mockImplementation(() => { throw new Error("WebSocket is not connected."); });
    const goal = useThreadGoal("thread-1", "user-1");
    goal.set("目标");
    expect(harness.send.mock.calls[0][0]).toMatchObject({ type: "goal.set" });
    harness.send.mockImplementation(() => {});
    harness.isOpen = true;
    harness.statusListener?.("open");
    expect(harness.send.mock.calls.map(([message]) => message.type)).toEqual(["goal.set", "goal.get"]);
  });
});
