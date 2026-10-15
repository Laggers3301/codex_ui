import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createCrossAccountForkSnapshot } from "./crossAccountFork.js";

describe("cross-account native fork snapshot", () => {
  it("changes only history mode and drops a concurrently partial trailing line", async () => {
    const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "fork-snapshot-test-"));
    const sessions = path.join(root, "sessions");
    const source = path.join(sessions, "2026", "rollout.jsonl");
    await fsPromises.mkdir(path.dirname(source), { recursive: true });
    const metadata = { type: "session_meta", payload: { id: "thread-1", history_mode: "paginated", note: "中文" } };
    const complete = { type: "response_item", payload: { type: "message", role: "user", content: "最新任务" } };
    await fsPromises.writeFile(source, `${JSON.stringify(metadata)}\n${JSON.stringify(complete)}\n{"partial":`, "utf8");

    const snapshot = await createCrossAccountForkSnapshot(source, sessions);
    try {
      const lines = (await fsPromises.readFile(snapshot.path, "utf8")).trimEnd().split("\n");
      expect(JSON.parse(lines[0]).payload).toMatchObject({ id: "thread-1", history_mode: "legacy", note: "中文" });
      expect(JSON.parse(lines[1])).toEqual(complete);
      expect(lines).toHaveLength(2);
      expect(fs.statSync(snapshot.path).mode & 0o777).toBe(0o600);
    } finally {
      await snapshot.remove();
      await fsPromises.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a source outside the owning sessions root", async () => {
    const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "fork-snapshot-boundary-"));
    const sessions = path.join(root, "sessions");
    const outside = path.join(root, "outside.jsonl");
    await fsPromises.mkdir(sessions);
    await fsPromises.writeFile(outside, '{}\n');
    try {
      await expect(createCrossAccountForkSnapshot(outside, sessions)).rejects.toThrow(/不在所属账号/);
    } finally {
      await fsPromises.rm(root, { recursive: true, force: true });
    }
  });
});
