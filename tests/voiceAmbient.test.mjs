import { test } from "node:test";
import assert from "node:assert/strict";
import { voiceEnvelope, startVoiceAmbient } from "../src/ambient/voiceAmbient.ts";

test("speech amplitude expands the field smoothly, quiet noise does not", () => {
  const samples = gain => new Float32Array(1024).fill(gain);
  assert.equal(voiceEnvelope(samples(.001), 0, 50), 0);
  const quiet = voiceEnvelope(samples(.01), 0, 50);
  const loud = voiceEnvelope(samples(.2), 0, 50);
  assert.ok(loud > quiet && loud < .4, "no instant jump to full size");
  let level = 0;
  for (let i = 0; i < 20; i++) level = voiceEnvelope(samples(.2), level, 50);
  assert.ok(level > .95 && level <= 1);
  const decay = voiceEnvelope(samples(0), level, 50);
  assert.ok(decay < level && decay > level * .8, "quiet periods release gently");
  assert.ok(Number.isFinite(voiceEnvelope(new Float32Array([NaN, Infinity]), NaN, Infinity)));
});

test("meter lifecycle releases only analysis resources; repeated cancel/restart remains usable", async () => {
  const originalWindow = globalThis.window, originalDocument = globalThis.document;
  let callback, active = 0, closes = 0, disconnected = 0, tracksStopped = 0;
  const listeners = new Set();
  class Context {
    state = "running";
    createMediaStreamSource() { return { connect() {}, disconnect() { disconnected++; } }; }
    createAnalyser() { return { fftSize: 1024, getFloatTimeDomainData(array) { array.fill(.1); }, disconnect() { disconnected++; } }; }
    close() { this.state = "closed"; closes++; return Promise.resolve(); }
    suspend() { this.state = "suspended"; return Promise.resolve(); }
    resume() { this.state = "running"; return Promise.resolve(); }
  }
  globalThis.window = { AudioContext: Context, setInterval(fn) { callback = fn; active++; return active; }, clearInterval() { active--; } };
  globalThis.document = { hidden: false, addEventListener(_type, fn) { listeners.add(fn); }, removeEventListener(_type, fn) { listeners.delete(fn); } };
  try {
    const stream = { getTracks() { return [{ stop() { tracksStopped++; } }]; } };
    for (let i = 0; i < 3; i++) {
      const events = [];
      const stop = startVoiceAmbient(stream, event => events.push(event));
      assert.deepEqual(events[0], { recording: true, level: 0 });
      callback(); assert.ok(events.at(-1).level > 0);
      document.hidden = true; for (const listener of listeners) listener();
      assert.equal(events.at(-1).level, 0);
      document.hidden = false; for (const listener of listeners) listener();
      callback(); assert.ok(events.at(-1).level > 0);
      stop(); stop();
      assert.deepEqual(events.at(-1), { recording: false, level: 0 });
      assert.equal(active, 0); assert.equal(listeners.size, 0);
    }
    assert.equal(closes, 3); assert.equal(disconnected, 6); assert.equal(tracksStopped, 0);
    delete window.AudioContext;
    const fallback = [];
    const stop = startVoiceAmbient(stream, event => fallback.push(event));
    assert.deepEqual(fallback, [{ recording: true, level: 0 }]);
    stop(); assert.deepEqual(fallback.at(-1), { recording: false, level: 0 });
  } finally {
    globalThis.window = originalWindow; globalThis.document = originalDocument;
  }
});
