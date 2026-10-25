import { describe, expect, it } from "vitest";
import { composerGlassOverBudget, composerLensMap } from "./composerGlassOptics";
describe("bounded composer glass optics", () => {
  it("keeps the centre neutral and bends opposite edges in opposite directions", () => {
    const map = composerLensMap(900,200,24);
    const pixel = (x:number,y:number) => [...map.data.slice((y*map.width+x)*4,(y*map.width+x)*4+4)];
    expect(pixel(Math.floor(map.width/2),Math.floor(map.height/2))).toEqual([128,128,128,255]);
    expect(pixel(0,Math.floor(map.height/2))[0]).toBeLessThan(128);
    expect(pixel(map.width-1,Math.floor(map.height/2))[0]).toBeGreaterThan(128);
  });
  it("bounds allocations even for huge viewports and rejects invalid geometry", () => {
    expect(composerLensMap(100000,100000).data.length).toBeLessThanOrEqual(192*96*4);
    expect(()=>composerLensMap(Infinity,100)).toThrow();
    expect(()=>composerLensMap(0,100)).toThrow();
    expect(composerLensMap(10,10,999).data.length).toBe(400);
  });
  it("downgrades slow surfaces without treating a single scheduling blip as failure", () => {
    expect(composerGlassOverBudget(Array(28).fill(16.7))).toBe(false);
    expect(composerGlassOverBudget([...Array(27).fill(16.7),90])).toBe(false);
    expect(composerGlassOverBudget(Array(28).fill(33.3))).toBe(true);
    expect(composerGlassOverBudget([200])).toBe(false);
  });
});
