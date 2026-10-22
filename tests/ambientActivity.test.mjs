import { test } from "node:test";
import assert from "node:assert/strict";
import { createAmbientActivity } from "../src/ambient/ambientActivity.ts";

test("mount alone is idle, a real draft stays active even after long pauses", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const changes = [];
  const activity = createAmbientActivity(value => changes.push(value));
  activity.sync(false, false); assert.deepEqual(changes, []);
  activity.input(); activity.sync(true, false); t.mock.timers.tick(60000);
  assert.deepEqual(changes, [true]);
  activity.input(false); assert.deepEqual(changes, [true, false]); activity.dispose();
});
test("sending/clearing fades once and a later draft starts again", () => {
  const changes = [];
  const activity = createAmbientActivity(value => changes.push(value));
  activity.sync(true, false); activity.sync(false, false); activity.sync(false, false);
  activity.sync(true, false);
  assert.deepEqual(changes, [true, false, true]); activity.dispose();
});
test("empty homepage welcomes the user, selecting an existing thread hides it", () => {
  const changes = [];
  const activity = createAmbientActivity(value => changes.push(value));
  activity.sync(false, true); activity.sync(true, true); activity.sync(false, true);
  assert.deepEqual(changes, [true]);
  activity.sync(false, false); assert.deepEqual(changes, [true, false]); activity.dispose();
});
test("Chinese IME composition stays active and cancels cleanly without committed text", () => {
  const changes = [];
  const activity = createAmbientActivity(value => changes.push(value));
  activity.compositionStart(); activity.compositionEnd(false);
  activity.compositionStart(); activity.compositionEnd(true);
  activity.sync(false, false);
  assert.deepEqual(changes, [true, false, true, false]); activity.dispose();
});
test("a focused empty editor keeps the glow through draft sync and slow IME updates", () => {
  const changes = [];
  const activity = createAmbientActivity(value => changes.push(value));
  activity.sync(false, true);
  activity.focus(true);
  activity.compositionStart();
  activity.sync(false, false);
  activity.sync(false, false);
  assert.deepEqual(changes, [true]);
  activity.compositionEnd(false);
  assert.deepEqual(changes, [true]);
  activity.focus(false);
  assert.deepEqual(changes, [true, false]);
  activity.dispose();
});
test("focus alone lights an empty editor and blur fades an empty existing conversation", () => {
  const changes = [];
  const activity = createAmbientActivity(value => changes.push(value));
  activity.sync(false, false);
  activity.focus(true); activity.sync(false, false); activity.input(false);
  assert.deepEqual(changes, [true]);
  activity.focus(false);
  assert.deepEqual(changes, [true, false]);
  activity.dispose();
});
test("sending during composition still clears the glow", () => {
  const changes = [];
  const activity = createAmbientActivity(value => changes.push(value));
  activity.compositionStart(); activity.sync(true, false); activity.sync(false, false);
  assert.deepEqual(changes, [true, false]); activity.dispose();
});
test("disposed controllers cannot start another animation", () => {
  const changes = [];
  const activity = createAmbientActivity(value => changes.push(value));
  activity.input(); activity.dispose(); activity.input(false); activity.sync(false, true); activity.stop();
  assert.deepEqual(changes, [true]);
});
test("recording lights an empty thread, survives draft sync, and cancel fades it", () => {
  const changes = [];
  const activity = createAmbientActivity(value => changes.push(value));
  activity.recording(true); activity.sync(false, false); activity.input(false);
  assert.deepEqual(changes, [true]);
  activity.recording(false); activity.recording(false);
  assert.deepEqual(changes, [true, false]); activity.dispose();
});
test("stopping recording preserves an existing draft or the welcome glow", () => {
  const changes = [];
  const activity = createAmbientActivity(value => changes.push(value));
  activity.recording(true); activity.sync(true, false); activity.recording(false);
  assert.deepEqual(changes, [true]);
  activity.sync(false, true); activity.recording(true); activity.recording(false);
  assert.deepEqual(changes, [true]);
  activity.sync(false, false); assert.deepEqual(changes, [true, false]);
  activity.dispose(); activity.recording(true); assert.deepEqual(changes, [true, false]);
});
