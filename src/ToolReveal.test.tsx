import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolReveal } from "./ToolReveal";

describe("deferred tool disclosure rendering", () => {
  it("does not parse or render a collapsed bundle's children", () => {
    const expensiveChildren = vi.fn(() => <div>large tool output</div>);
    expect(renderToStaticMarkup(<ToolReveal open={false}>{expensiveChildren}</ToolReveal>)).toBe("");
    expect(expensiveChildren).not.toHaveBeenCalled();
  });
  it("renders restored open content immediately", () => {
    const children = vi.fn(() => <div>tool details</div>);
    expect(renderToStaticMarkup(<ToolReveal open>{children}</ToolReveal>)).toContain("tool details");
    expect(children).toHaveBeenCalledOnce();
  });
});
