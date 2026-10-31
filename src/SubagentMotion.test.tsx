// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { SubagentActivity } from "./SubagentActivity";
import type { AgentEntry } from "./subagentPresentation";

it("keeps small activity rows and SVG identities stable through toggles while still updating live state", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host), onOpen = vi.fn();
  const agents: AgentEntry[] = [0, 1, 2].map(i => ({ id: String(i), name: `/root/test-${i}`, state: "running", model: "gpt-6.1-sol" }));
  try {
    await act(async () => root.render(<SubagentActivity agents={agents} onOpen={onOpen} parentRunning />));
    const button = host.querySelector<HTMLButtonElement>(".subagentCurrentActivity>.toolRevealClip>.threadActivityHeading")!;
    const rows = [...host.querySelectorAll(".subagentRow")], icons = [...host.querySelectorAll("svg")];
    const reveal = host.querySelector(".subagentRows")!.closest(".toolReveal")!;
    expect(rows).toHaveLength(3); expect(reveal.getAttribute("aria-hidden")).toBe("true");
    for (let i = 0; i < 4; i++) {
      await act(async () => button.click());
      expect([...host.querySelectorAll(".subagentRow")]).toEqual(rows);
      expect([...host.querySelectorAll("svg")]).toEqual(icons);
      expect(reveal.getAttribute("aria-hidden")).toBe(i % 2 === 0 ? "false" : "true");
    }
    await act(async () => root.render(<SubagentActivity agents={agents.map((a, i) => i ? a : { ...a, model: "gpt-6.1-terra", state: "completed" })} onOpen={onOpen} parentRunning />));
    expect(host.querySelector(".subagentRows")!.textContent).toContain("gpt-6.1-terra");
    expect(host.querySelector(".subagentRows")!.textContent).toContain("已完成");
    await act(async () => (host.querySelector(".subagentRow") as HTMLButtonElement).click());
    expect(onOpen).toHaveBeenCalledTimes(1);
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});
