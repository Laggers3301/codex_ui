import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

test("worker displays completed/question pushes even with a visible page, and opens the correct conversation", async () => {
  const handlers = {}, notifications = [], messages = [];
  let focused = false;
  const self = { location: { origin: "https://example.test" }, addEventListener: (type, handler) => { handlers[type] = handler; },
    registration: { showNotification: async (title, options) => notifications.push({ title, options }) },
    clients: { matchAll: async () => [{ visibilityState: "visible", url: "https://example.test/", postMessage: m => messages.push(m), focus: async () => { focused = true; } }] } };
  vm.runInNewContext(fs.readFileSync(new URL("../public/sw.js", import.meta.url), "utf8"), { self, URL });
  for (const type of ["completed", "question"]) {
    let pending;
    handlers.push({ data: { json: () => ({ type, title: "测试", threadId: "thread", projectId: "project" }) }, waitUntil: promise => { pending = promise; } });
    await pending;
  }
  assert.equal(notifications.length, 2);
  assert.equal(notifications[1].options.tag, "codex-thread");
  assert.equal(notifications[0].options.tag, notifications[1].options.tag);
  let pending;
  handlers.notificationclick({ notification: { close() {}, data: notifications[1].options.data }, waitUntil: promise => { pending = promise; } });
  await pending;
  assert.equal(messages[0].threadId, "thread");
  assert.equal(messages[0].projectId, "project");
  assert.equal(focused, true);
});
