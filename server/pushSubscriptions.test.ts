import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectStore } from "./db.js";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("push subscription ownership", () => {
  it("only returns the logged-in user's subscriptions and reassigns a shared browser endpoint", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-push-test-"));
    temporaryDirectories.push(directory);
    const store = new ProjectStore(path.join(directory, "test.sqlite"));
    const subscription = { endpoint: "https://web.push.apple.com/example", keys: { p256dh: "public", auth: "secret" } };
    try {
      store.savePushSubscription("alice", subscription);
      expect(store.listPushSubscriptions("alice")).toEqual([subscription]);
      expect(store.listPushSubscriptions("bob")).toEqual([]);
      store.savePushSubscription("bob", subscription);
      expect(store.listPushSubscriptions("alice")).toEqual([]);
      expect(store.listPushSubscriptions("bob")).toEqual([subscription]);
      store.removePushSubscription("alice", subscription.endpoint);
      expect(store.listPushSubscriptions("bob")).toEqual([subscription]);
      store.removePushSubscription("bob", subscription.endpoint);
      expect(store.listPushSubscriptions("bob")).toEqual([]);
    } finally {
      store.close();
    }
  });
});
