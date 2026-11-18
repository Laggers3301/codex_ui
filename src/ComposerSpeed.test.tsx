// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ComposerSpeedIcon, ComposerSpeedSelect, canUseUltrafast, composerSpeedOptions, effectiveComposerSpeed, readComposerSpeed } from "./ComposerSpeed";
import type { ModelProfile } from "./types";
const profile: ModelProfile = { id: "gpt-6.2-sol:low", model: "gpt-6.2-sol", label: "Sol", effort: "low", ultrafastAccounts: ["pro"] };
it("migrates saved Fast preferences and gates Ultra Fast by the bound account", () => {
  expect(readComposerSpeed("true")).toBe("fast"); expect(readComposerSpeed("false")).toBe("standard");
  expect(readComposerSpeed("ultrafast")).toBe("ultrafast");
  expect(canUseUltrafast(profile)).toBe(true); expect(canUseUltrafast(profile, "pro")).toBe(true);
  expect(canUseUltrafast(profile, "plus")).toBe(false);
  expect(effectiveComposerSpeed("ultrafast", profile, "plus")).toBe("standard");
});
it.each([false, true])("offers the same three distinct speeds on mobile=%s", async mobile => {
  const node = document.createElement("div"), root = createRoot(node), change = vi.fn();
  try {
    await act(async () => root.render(<ComposerSpeedSelect mobile={mobile} ultrafast value="standard" onChange={change} />));
    const select = node.querySelector("select")!;
    expect([...select.options].map(o => o.value)).toEqual(["standard", "fast", "ultrafast"]);
    expect([...select.options].map(o => o.textContent)).toEqual(["标准", "快速", "超快"]);
    await act(async () => { select.value = "ultrafast"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(change).toHaveBeenCalledWith("ultrafast");
    await act(async () => root.render(<ComposerSpeedSelect mobile={mobile} ultrafast={false} value="standard" onChange={change} />));
    expect(node.textContent).not.toContain("超快");
  } finally { await act(async () => root.unmount()); }
});
it("lists the desktop menu options in the same order, with Ultra Fast only when the bound account allows it", () => {
  expect(composerSpeedOptions(false).map(option => option.value)).toEqual(["standard", "fast"]);
  expect(composerSpeedOptions(true).map(option => option.label)).toEqual(["标准", "快速", "超快"]);
  expect(composerSpeedOptions(true).every(option => option.detail.length > 0)).toBe(true);
});
it("draws a different glyph for each speed tier", () => {
  const html = (speed: "standard" | "fast" | "ultrafast") => renderToStaticMarkup(<ComposerSpeedIcon speed={speed} />);
  expect(html("standard")).not.toContain('fill="currentColor"');
  expect(html("fast")).toContain('fill="currentColor"');
  expect(html("ultrafast")).toContain('data-speed="ultrafast"');
  expect(new Set([html("standard"), html("fast"), html("ultrafast")]).size).toBe(3);
});
