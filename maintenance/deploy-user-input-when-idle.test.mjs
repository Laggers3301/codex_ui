import assert from "node:assert/strict";
import { test } from "node:test";
import { idleDecision, waitForQuiet } from "./deploy-user-input-when-idle.mjs";

test("requires every user's active turn and visible request to finish, while tolerating only the known cancelled legacy request", () => {
  const health = { codexPendingApprovals: 1 }, pool = { accounts: [{ activeRequests: 0 }] };
  const idle = { active: [], pending: [] };
  assert.equal(idleDecision([idle], health, pool, 1).idle, true);
  assert.equal(idleDecision([idle], health, pool).idle, false);
  assert.equal(idleDecision([idle, { active: [{ status: "running" }], pending: [] }], health, pool, 1).idle, false);
  assert.equal(idleDecision([{ active: [], pending: [{ id: "question" }] }], health, pool, 1).idle, false);
  assert.equal(idleDecision([idle], { codexPendingApprovals: 2 }, pool, 1).idle, false);
  assert.equal(idleDecision([idle], health, { accounts: [{ activeRequests: 1 }] }, 1).idle, false);
  assert.equal(idleDecision([{ unknown: true }], health, pool, 1).idle, false);
  assert.equal(idleDecision([idle], null, null, 1).idle, false);
});

test("a new turn during the quiet window resets the wait, including the final confirmation", async () => {
  let time = 0, read = 0;
  const stages = [];
  const states = [false, true, true, true, false, true, true, true, true];
  const state = await waitForQuiet(async () => ({ idle: states[read++] ?? true }), (_state, stage) => stages.push(stage),
    { now: () => time, pollMs: 30, quietMs: 60, pause: async ms => { time += ms; } });
  assert.equal(state.idle, true);
  assert.equal(read, 9);
  assert.equal(time, 180);
  assert.equal(stages.filter(stage => stage === "waiting_for_idle").length, 2);
});
