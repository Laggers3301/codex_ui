import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { nextToolCount, RollingToolCount, TOOL_ARRIVAL_MAX_DELAY_MS } from "./ToolActivityMotion";

describe("tool activity motion", () => {
  it("keeps restored counts exact and accessible without replay", () => {
    const html = renderToStaticMarkup(<RollingToolCount count={1234} />);
    expect(html).toContain('aria-label="1234"');
    expect(html).toContain('data-moving="false"');
  });
  it("advances monotonically without overshooting for small and large bursts", () => {
    for (const target of [2, 9, 10, 100, 10000]) {
      let value = 1;
      for (let step = 0; step < 6; step++) {
        const next = step === 5 ? target : nextToolCount(value, target);
        expect(next).toBeGreaterThanOrEqual(value);
        expect(next).toBeLessThanOrEqual(target);
        value = next;
      }
      expect(value).toBe(target);
    }
    expect(nextToolCount(20, 2)).toBe(2);
    expect(TOOL_ARRIVAL_MAX_DELAY_MS).toBeLessThanOrEqual(160);
  });
  it("only a newly arriving live cluster starts its counter from one", () => {
    expect(renderToStaticMarkup(<RollingToolCount count={17} arrive />)).toContain('class="toolCountGlyph">1</span>');
    expect(renderToStaticMarkup(<RollingToolCount count={17} />)).toContain('class="toolCountGlyph">17</span>');
  });
});
