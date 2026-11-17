// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { MobileModelFields } from "./MobileModelFields";
import type { ModelProfile } from "./types";

const profiles: ModelProfile[] = [
  { id: "a:high", model: "a", label: "Model A high", effort: "high" },
  { id: "a:medium", model: "a", label: "Model A medium", effort: "medium" },
  { id: "b:high", model: "b", label: "Model B high", effort: "high" },
  { id: "b:low", model: "b", label: "Model B low", effort: "low" },
  { id: "c:low", model: "c", label: "Model C low", effort: "low" },
  { id: "c:high", model: "c", label: "Model C high", effort: "high", availability: "disabled" },
  { id: "off:high", model: "off", label: "Offline high", effort: "high", availability: "not-connected" },
];

it("uses native model and effort selects, preserving real available profile IDs", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const node = document.createElement("div"), root = createRoot(node), onChange = vi.fn();
  const select = async (label: string, value: string) => {
    const element = node.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
    await act(() => { element.value = value; element.dispatchEvent(new Event("change", { bubbles: true })); });
  };
  try {
    await act(() => root.render(<MobileModelFields value="a:high" profiles={profiles} disabled={false} onChange={onChange} onOpen={() => {}} />));
    expect(node.querySelectorAll('select')).toHaveLength(2);
    expect(node.querySelector('option[value="off"]')?.hasAttribute('disabled')).toBe(true);
    expect(node.querySelector('option[value="a"]')?.textContent).toBe('Model A');
    await select("模型", "b"); expect(onChange).toHaveBeenLastCalledWith("b:high");
    await select("模型", "c"); expect(onChange).toHaveBeenLastCalledWith("c:low");
    await select("推理强度", "a:medium"); expect(onChange).toHaveBeenLastCalledWith("a:medium");
  } finally { await act(() => root.unmount()); vi.unstubAllGlobals(); }
});

it("keeps both controls disabled while running and a fixed effort uneditable", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const node = document.createElement("div"), root = createRoot(node);
  try {
    await act(() => root.render(<MobileModelFields value="a:high" profiles={profiles} disabled onChange={() => {}} onOpen={() => {}} />));
    expect([...node.querySelectorAll('select')].every(select => select.disabled)).toBe(true);
    await act(() => root.render(<MobileModelFields value="c:low" profiles={profiles} disabled={false} onChange={() => {}} onOpen={() => {}} />));
    expect(node.querySelector<HTMLSelectElement>('select[aria-label="模型"]')?.disabled).toBe(false);
    expect(node.querySelector<HTMLSelectElement>('select[aria-label="推理强度"]')?.disabled).toBe(true);
  } finally { await act(() => root.unmount()); vi.unstubAllGlobals(); }
});
