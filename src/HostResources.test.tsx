// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { readHostResources } from "./api";
import { useHostResources } from "./HostResources";
vi.mock("./api", () => ({ readHostResources: vi.fn(), checkHostNetwork: vi.fn() }));

it("treats malformed resource responses as unavailable instead of breaking the app", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.mocked(readHostResources).mockResolvedValue({ data: [] } as never);
  function Probe() { const state = useHostResources("fixture"); return <p>{state.error ? "unavailable" : state.data ? "ready" : "loading"}</p>; }
  const node = document.createElement("div"); document.body.append(node);
  const root = createRoot(node);
  try {
    await act(async () => root.render(<Probe />));
    expect(node.textContent).toBe("unavailable");
  } finally {
    await act(async () => root.unmount()); node.remove(); hidden.mockRestore(); vi.unstubAllGlobals();
  }
});
