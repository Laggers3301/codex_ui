import { describe, expect, it } from "vitest";
import { codexProcessCommand } from "./codexBridge.js";

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
        unitPrefix: "codex-agent-account-b", slice: "codex-workers.slice",
        memoryHigh: "3G", memoryMax: "4G", memorySwapMax: "256M"
      }
    }, "test1234")).toEqual({
      command: "/usr/bin/systemd-run",
      args: [
        "--user", "--scope", "--collect", "--quiet", "--slice=codex-workers.slice",
        "--unit=codex-agent-account-b-test1234", "-p", "MemoryHigh=3G",
        "-p", "MemoryMax=4G", "-p", "MemorySwapMax=256M",
        "--", "/bin/codex", "app-server", "--listen", "stdio://"
      ]
    });
  });
});
