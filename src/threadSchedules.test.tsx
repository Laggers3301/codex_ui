import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ThreadSchedule } from "./threadSchedules";

let scheduleStatusLabel: (schedule: ThreadSchedule) => string;
beforeAll(async () => {
  vi.stubGlobal("localStorage", {getItem: () => null, setItem: () => undefined});
  ({scheduleStatusLabel} = await import("./ThreadSchedules"));
});

const schedule = (overrides: Partial<ThreadSchedule>): ThreadSchedule => ({
  id: "schedule-1", title: "task", prompt: "prompt", enabled: true,
  schedule: {kind:"once",at:"2030-01-01T10:00:00.000Z",timezone:"UTC"}, ...overrides
});

describe("thread schedule presentation", () => {
  it("prioritizes terminal and failure statuses over disabled state", () => {
    expect(scheduleStatusLabel(schedule({enabled:false,status:"failed"}))).toBe("上次失败");
    expect(scheduleStatusLabel(schedule({enabled:false,status:"completed"}))).toBe("已完成");
    expect(scheduleStatusLabel(schedule({enabled:false,status:"paused"}))).toBe("已暂停");
  });

  it("distinguishes a queued run from a model-completed task", () => {
    expect(scheduleStatusLabel(schedule({status:"queued"}))).toBe("已提交");
    expect(scheduleStatusLabel(schedule({status:"completed"}))).toBe("已完成");
  });
});
