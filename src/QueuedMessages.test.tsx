// @vitest-environment jsdom
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("./ComposerGlassMaterial", () => ({ ComposerGlassMaterial: () => null }));
vi.mock("./AccountUpdateIndicator", () => ({ AccountUpdateIndicator: () => <span className="accountUpdateIndicator" /> }));
import { QueuedMessages } from "./QueuedMessages";
import { confirmQueuedSubmission, restoreQueuedSubmission, type QueuedSubmission } from "./queuedSubmissions";

const entries: QueuedSubmission[] = ["第一条", "第二条", "第三条"].map((text, index) => ({ id: `q${index + 1}`, clientUserMessageId: `client-${index}`, input: [{ type: "text", text }] }));
const textFor = (entry: QueuedSubmission) => entry.input[0].text ?? "";
afterEach(() => vi.unstubAllGlobals());

it("expands the queue and steers the chosen non-head message without consuming the others", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host), steered: string[] = [];
  function Fixture() {
    const [queue, setQueue] = useState(entries);
    return <QueuedMessages entries={queue} fallbackEntry={entries[0]} closing={false} canSteer textFor={textFor}
      onSteer={entry => { steered.push(entry.id); setQueue(current => current.filter(item => item.id !== entry.id)); }}
      onRemove={() => {}} onSave={() => true} onOpenSideChat={() => {}} />;
  }
  try {
    await act(async () => root.render(<Fixture />));
    expect(host.querySelectorAll("[data-queued-id]")).toHaveLength(1);
    expect(host.querySelector(".accountUpdateIndicator")).toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>(".queuedQueueToggle")!.click());
    expect(host.querySelectorAll("[data-queued-id]")).toHaveLength(3);
    expect(host.querySelector(".accountUpdateIndicator")).toBeNull();
    expect(steered).toEqual([]);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-queued-id="q3"] .queuedSteerButton')!.click());
    expect(steered).toEqual(["q3"]);
    expect([...host.querySelectorAll<HTMLElement>("[data-queued-id]")].map(element => element.dataset.queuedId)).toEqual(["q1", "q2"]);
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it("scopes edit, side-chat and removal to the selected row and keeps editor Escape from reaching conversation shortcuts", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host), save = vi.fn(() => true), side = vi.fn(), remove = vi.fn(), shortcut = vi.fn();
  window.addEventListener("keydown", shortcut);
  try {
    await act(async () => root.render(<QueuedMessages entries={entries} fallbackEntry={entries[0]} closing={false} canSteer textFor={textFor}
      onSteer={() => {}} onRemove={remove} onSave={save} onOpenSideChat={side} />));
    await act(async () => host.querySelector<HTMLButtonElement>(".queuedQueueToggle")!.click());
    const more = () => host.querySelector<HTMLButtonElement>('[data-queued-id="q2"] button[aria-expanded]')!;
    await act(async () => more().click());
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>(".queuedSubmissionMenu button")].find(button => button.textContent === "编辑消息")!.click());
    const input = host.querySelector<HTMLInputElement>(".queuedEditInput")!;
    expect(input.value).toBe("第二条");
    await act(async () => host.querySelector<HTMLButtonElement>('[data-queued-id="q2"] .queuedSteerButton')!.click());
    expect(save).toHaveBeenCalledWith(entries[1], "第二条");
    await act(async () => more().click());
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>(".queuedSubmissionMenu button")].find(button => button.textContent === "在侧边聊天中打开")!.click());
    expect(side).toHaveBeenCalledWith(entries[1]);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-queued-id="q3"] button[aria-label^="移除"]')!.click());
    expect(remove).toHaveBeenCalledWith(entries[2]);
    await act(async () => more().click());
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>(".queuedSubmissionMenu button")].find(button => button.textContent === "编辑消息")!.click());
    await act(async () => host.querySelector<HTMLInputElement>(".queuedEditInput")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(shortcut).not.toHaveBeenCalled();
    expect(host.querySelector(".queuedEditInput")).toBeNull();
  } finally { window.removeEventListener("keydown", shortcut); await act(async () => root.unmount()); host.remove(); }
});

it("keeps unconfirmed entries disabled and does not expose steer controls when unavailable", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const pending = { ...entries[0], id: "pending:q1" };
  const render = (canSteer: boolean) => <QueuedMessages entries={[pending]} fallbackEntry={pending} closing={false} canSteer={canSteer} textFor={textFor}
    onSteer={() => {}} onRemove={() => {}} onSave={() => true} onOpenSideChat={() => {}} />;
  try {
    await act(async () => root.render(render(true)));
    expect(host.querySelector<HTMLButtonElement>(".queuedSteerButton")?.disabled).toBe(true);
    expect(host.querySelector(".queuedIconButton")).toBeNull();
    await act(async () => root.render(render(false)));
    expect(host.querySelector(".queuedSteerButton")).toBeNull();
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it("keeps mobile queue editing, steering and cancellation shared without inheriting desktop classes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host), steer = vi.fn(), remove = vi.fn(), save = vi.fn(() => true), side = vi.fn();
  const render = (queue = entries) => <QueuedMessages mobile entries={queue} fallbackEntry={queue[0]} closing={false} canSteer textFor={textFor}
    onSteer={steer} onRemove={remove} onSave={save} onOpenSideChat={side} />;
  try {
    await act(async () => root.render(render()));
    expect(host.querySelector(".queuedSubmissionStrip,.queuedSubmissionText,.accountUpdateIndicator")).toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>(".mobileUiQueuedQueueToggle")!.click());
    expect(host.querySelectorAll("[data-queued-id]")).toHaveLength(3);
    const more = () => host.querySelector<HTMLButtonElement>('[data-queued-id="q2"] button[aria-expanded]')!;
    const menu = (label: string) => [...host.querySelectorAll<HTMLButtonElement>(".mobileUiQueuedSubmissionMenu button")].find(button => button.textContent === label)!;
    await act(async () => more().click());
    await act(async () => menu("编辑消息").click());
    expect(host.querySelector<HTMLInputElement>(".mobileUiQueuedEditInput")!.value).toBe("第二条");
    await act(async () => host.querySelector<HTMLButtonElement>('[data-queued-id="q2"] .mobileUiQueuedSteerButton')!.click());
    expect(save).toHaveBeenCalledWith(entries[1], "第二条");
    await act(async () => more().click());
    await act(async () => menu("在侧边聊天中打开").click());
    expect(side).toHaveBeenCalledWith(entries[1]);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-queued-id="q3"] .mobileUiQueuedSteerButton')!.click());
    expect(steer).toHaveBeenCalledWith(entries[2]);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-queued-id="q2"] button[aria-label^="移除"]')!.click());
    expect(remove).toHaveBeenCalledWith(entries[1]);
    await act(async () => root.render(render([{ ...entries[0], id: "pending:q1" }])));
    expect(host.querySelector<HTMLButtonElement>(".mobileUiQueuedSteerButton")?.disabled).toBe(true);
    expect(host.querySelector(".mobileUiQueuedIconButton")).toBeNull();
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it("restores a failed non-head steer between surviving neighbours rather than at the queue head", () => {
  const restored = restoreQueuedSubmission([entries[0], entries[2]], entries[1], entries.map(entry => entry.id));
  expect(restored.map(entry => entry.id)).toEqual(["q1", "q2", "q3"]);
  expect(restoreQueuedSubmission([entries[2]], entries[1], entries.map(entry => entry.id)).map(entry => entry.id)).toEqual(["q2", "q3"]);
});

it("keeps a refreshed entry and restores before newly added messages without duplicates", () => {
  const refreshed = [{ ...entries[1], input: [{ type: "text", text: "服务端新内容" }] }];
  expect(restoreQueuedSubmission(refreshed, entries[1], ["q1", "q2", "q3"])).toBe(refreshed);
  const added = { ...entries[0], id: "q4" };
  expect(restoreQueuedSubmission([entries[0], added], entries[1], ["q1", "q2", "q3"]).map(entry => entry.id)).toEqual(["q1", "q2", "q4"]);
});

it("confirms the pending row directly from queue/add without waiting for queue/list", () => {
  const pending = { ...entries[1], id: "pending:request-2", clientUserMessageId: "request-2" };
  const accepted = { ...entries[1], clientUserMessageId: "request-2" };
  expect(confirmQueuedSubmission([entries[0], pending, entries[2]], "request-2", accepted))
    .toEqual([entries[0], accepted, entries[2]]);
});

it("does not duplicate a listed confirmation or resurrect a consumed pending row", () => {
  const pending = { ...entries[1], id: "pending:request-2", clientUserMessageId: "request-2" };
  const accepted = { ...entries[1], clientUserMessageId: "request-2" };
  expect(confirmQueuedSubmission([entries[0], accepted, pending], "request-2", accepted)).toEqual([entries[0], accepted]);
  const consumed = [entries[0]];
  expect(confirmQueuedSubmission(consumed, "request-2", accepted)).toBe(consumed);
});

it("keeps unconfirmed entries pending for legacy, malformed or mismatched acknowledgements", () => {
  const pending = [{ ...entries[0], id: "pending:request-1", clientUserMessageId: "request-1" }];
  for (const value of [undefined, {}, { id: "q1" }, { id: "q1", input: [null] },
    { ...entries[0], clientUserMessageId: "other-request" }, { ...entries[0], id: "pending:q1" }]) {
    expect(confirmQueuedSubmission(pending, "request-1", value)).toBe(pending);
  }
});
