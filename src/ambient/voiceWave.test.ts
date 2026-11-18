import { expect, it } from "vitest";
import { voiceInstant } from "./voiceAmbient";
import { waveHeight, waveStep } from "../mobile/VoiceWave";

it("measures one block of samples without smoothing", () => {
  const block = (gain: number) => new Float32Array(1024).fill(gain);
  expect(voiceInstant(block(.001))).toBe(0);
  expect(voiceInstant(block(.2))).toBeGreaterThan(voiceInstant(block(.02)));
  expect(voiceInstant(block(1))).toBeLessThanOrEqual(1);
  expect(Number.isFinite(voiceInstant(new Float32Array([NaN, Infinity])))).toBe(true);
});

it("draws silence as dots and speech as bars that attack fast and release slowly", () => {
  expect(waveHeight(0, 30)).toBe(2.4);
  expect(waveHeight(1, 30)).toBe(30);
  expect(waveHeight(Number.NaN, 30)).toBe(2.4);
  let value = waveStep(0, 0, 0);
  expect(value).toBe(0);
  value = waveStep(value, .2, .9);
  expect(value).toBeGreaterThan(.55);
  const loud = value;
  value = waveStep(value, 0, 0);
  expect(value).toBeLessThan(loud);
  expect(value).toBeGreaterThan(loud * .5);
  expect(waveStep(Number.NaN, 2, 2)).toBeLessThanOrEqual(1);
});
