import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { CodexBridge, codexProcessCommand } from "./codexBridge.js";

describe("Codex process isolation", () => {
  it("preserves the legacy launch when isolation is disabled", () => {
    expect(codexProcessCommand({ command: "/bin/codex", args: ["app-server"] })).toEqual({
      command: "/bin/codex", args: ["app-server"]
    });
  });

  it("runs each app-server in a bounded, independently named scope", () => {
    expect(codexProcessCommand({
      command: "/bin/codex", args: ["app-server", "--listen", "stdio://"],
      scope: {
        unitPrefix: "codex-agent-100002", slice: "codex-workers.slice",
        memoryHigh: "3G", memoryMax: "4G", memorySwapMax: "256M"
      }
    }, "test1234")).toEqual({
      command: "/usr/bin/systemd-run",
      args: [
        "--user", "--scope", "--collect", "--quiet", "--slice=codex-workers.slice",
        "--unit=codex-agent-100002-test1234", "-p", "MemoryHigh=3G",
        "-p", "MemoryMax=4G", "-p", "MemorySwapMax=256M",
        "--", "/bin/codex", "app-server", "--listen", "stdio://"
      ]
    });
  });

  it("measures the account scope and discounts only clean inactive file cache", () => {
    const bridge = new CodexBridge({ command: "/bin/codex", args: [], scope: {
      unitPrefix: "codex-agent-test", slice: "codex-workers.slice", memoryHigh: "3G", memoryMax: "4G", memorySwapMax: "0" } });
    Object.assign(bridge, { proc: { pid: 12345 } });
    const reader = vi.spyOn(fs, "readFileSync").mockImplementation((file) => {
      const name = String(file);
      if (name.endsWith("/cgroup")) return "0::/user.slice/codex-agent-test-abcd.scope\n";
      if (name.endsWith("memory.max")) return "4000\n";
      if (name.endsWith("memory.high")) return "max\n";
      if (name.endsWith("memory.current")) return "1800\n";
      if (name.endsWith("memory.stat")) return "inactive_file 500\nfile_dirty 100\nfile_writeback 50\n";
      throw new Error("unexpected file");
    });
    try {
      expect(bridge.getMemoryHeadroom()).toBe(2550);
      reader.mockImplementation(() => { throw new Error("scope unavailable"); });
      expect(bridge.getMemoryHeadroom()).toBe(0);
    } finally { reader.mockRestore(); }
  });

  it("honors the parent slice's tighter soft memory budget", () => {
    const bridge = new CodexBridge({ command: "/bin/codex", args: [], scope: {
      unitPrefix: "codex-agent-test", slice: "codex-workers.slice", memoryHigh: "3G", memoryMax: "4G", memorySwapMax: "0" } });
    Object.assign(bridge, { proc: { pid: 12345 } });
    const reader = vi.spyOn(fs, "readFileSync").mockImplementation((file) => {
      const name = String(file);
      if (name.endsWith("/cgroup")) return "0::/user.slice/codex-agent-test-abcd.scope\n";
      if (name.endsWith("memory.max")) return "4000\n";
      if (name.endsWith("memory.high")) return name.includes("codex-agent-test-abcd.scope/") ? "3500\n" : "2000\n";
      if (name.endsWith("memory.current")) return "1800\n";
      if (name.endsWith("memory.stat")) return "inactive_file 500\nfile_dirty 100\nfile_writeback 50\n";
      throw new Error("unexpected file");
    });
    try { expect(bridge.getMemoryHeadroom()).toBe(550); }
    finally { reader.mockRestore(); }
  });
});
