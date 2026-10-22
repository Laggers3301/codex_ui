import { test } from "node:test";
import assert from "node:assert/strict";
import { ambientMotion } from "../src/ambient/ambientMotion.ts";
test("motion is visible during a brief typing burst, rather than just fading an unmoving field", () => {
  const start = ambientMotion(0), later = ambientMotion(1800);
  assert.ok(Math.abs(later.x - start.x) > 3);
  assert.ok(Math.abs(later.y - start.y) > 1);
  assert.ok(later.frame - start.frame > 1000);
});
test("travel and breathing always remain bounded; no loops snap back to an initial frame", () => {
  let previous = ambientMotion(0);
  for (let ms = 33; ms <= 120000; ms += 33) {
    const next = ambientMotion(ms);
    assert.ok(Math.abs(next.x) <= 6 && Math.abs(next.y) <= 2.2);
    assert.ok(next.scale >= 1.102 && next.scale <= 1.138);
    assert.ok(Math.abs(next.x - previous.x) < .13);
    assert.ok(next.frame > previous.frame);
    previous = next;
  }
});
