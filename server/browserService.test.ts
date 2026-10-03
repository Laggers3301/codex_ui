import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserService } from "./browserService.js";

// Explicit opt-in because these checks launch a real sandboxed Chromium in a
// resource-limited scope. They never use account credentials or send model calls.
describe.skipIf(process.env.BROWSER_INTEGRATION !== "1")("isolated browser interactions", () => {
  const service = new BrowserService();
  let page: any;
  beforeAll(async () => {
    await service.open("alice", "thread-a");
    page = (service as any).sessions.get("alice\0thread-a").page;
    await page.setContent('<title>Browser fixture</title><label>Name<input id="name"></label><button id="save" onclick="document.querySelector(\'#result\').textContent=document.querySelector(\'#name\').value">Save</button><p id="result"></p>');
  }, 30_000);
  afterAll(async () => { await service.dispose(); });
  it("reads real DOM and emits a JPEG without sharing sessions", async () => {
    const result = await service.action("alice", "thread-a", { action: "snapshot" }, "agent");
    expect(result.text).toContain("Browser fixture");
    expect(result.text).toContain("Save");
    expect(result.image).toMatch(/^data:image\/jpeg;base64,/);
    expect(service.get("bob", "thread-a")).toBeNull();
    expect(service.frame("bob", "thread-a")).toBeNull();
  });
  it("does not click before approval and cancels pending actions on takeover", async () => {
    const pending = service.action("alice", "thread-a", { action: "click", selector: "#save" }, "agent");
    // Attach a rejection handler immediately; takeover deliberately rejects it.
    const result = pending.catch(error => error.message);
    const approval = service.get("alice", "thread-a")!.pendingApproval;
    expect(approval?.kind).toBe("action");
    expect(await page.locator("#result").textContent()).toBe("");
    await service.control("alice", "thread-a", "human");
    expect(await result).toMatch(/未获批准|暂停|取消/);
    await expect(service.action("alice", "thread-a", { action: "snapshot" }, "agent")).rejects.toThrow(/接管/);
  });
  it("does not share cookies between users or conversations", async () => {
    const first = (service as any).sessions.get("alice\0thread-a");
    await first.context.addCookies([{ name: "qa-session", value: "alice-only", domain: "example.com", path: "/" }]);
    for (const [user, thread] of [["alice", "thread-b"], ["bob", "thread-a"]]) {
      await service.open(user, thread);
      const other = (service as any).sessions.get(`${user}\0${thread}`);
      expect(await other.context.cookies("https://example.com")).toEqual([]);
      await service.close(user, thread);
    }
  });
  it("supports real manual typing and clicking", async () => {
    await service.action("alice", "thread-a", { action: "type", selector: "#name", text: "人工接管正常" }, "human");
    await service.action("alice", "thread-a", { action: "click", selector: "#save" }, "human");
    expect(await page.locator("#result").textContent()).toBe("人工接管正常");
  });
  it("executes an agent interaction only after its exact approval", async () => {
    await service.control("alice", "thread-a", "agent");
    const pending = service.action("alice", "thread-a", { action: "click", selector: "#name" }, "agent");
    const approval = service.get("alice", "thread-a")!.pendingApproval!;
    service.approve("alice", "thread-a", approval.id, true);
    await pending;
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("name");
    expect(service.get("alice", "thread-a")!.status).toBe("ready");
  });
  it("rejects private destinations and unsupported protocols", async () => {
    for (const url of ["http://127.0.0.1", "http://100.100.100.200", "file:///etc/passwd"]) {
      await expect(service.action("alice", "thread-a", { action: "navigate", url }, "agent")).rejects.toThrow();
    }
  });
  it("requires consent for a first website and leaves the page unchanged on rejection", async () => {
    const before = page.url();
    const pending = service.action("alice", "thread-a", { action: "navigate", url: "https://example.com" }, "agent");
    const caught = pending.catch(error => error.message);
    const approval = service.get("alice", "thread-a")!.pendingApproval!;
    expect(approval.kind).toBe("navigate");
    service.approve("alice", "thread-a", approval.id, false);
    expect(await caught).toMatch(/未获批准/);
    expect(page.url()).toBe(before);
  });
  it("keeps independent tab DOM, scroll and screenshots, with exact tab scope", async () => {
    await service.control("alice", "thread-a", "human");
    const firstId = service.get("alice", "thread-a")!.activeTabId;
    await page.setContent('<title>First tab</title><input id="keep" value="draft survives"><div style="height:3000px">First</div>');
    await page.evaluate(() => scrollTo(0, 260));
    const created = await service.action("alice", "thread-a", { action: "new_tab" }, "human");
    const secondId = created.state.activeTabId;
    expect(secondId).not.toBe(firstId);
    const second = (service as any).sessions.get("alice\0thread-a").page;
    await second.setContent('<title>Second tab</title><h1>Second</h1>');
    await service.action("alice", "thread-a", { action: "snapshot", tabId: secondId }, "human");
    expect(service.frame("alice", "thread-a", firstId)).toBeNull();
    await expect(service.action("alice", "thread-a", { action: "click", selector: "#keep", tabId: firstId }, "human")).rejects.toThrow(/切换/);
    await expect(service.action("alice", "thread-a", { action: "switch_tab", tabId: "00000000-0000-4000-8000-000000000000" }, "human")).rejects.toThrow(/不属于/);
    await service.action("alice", "thread-a", { action: "switch_tab", tabId: firstId }, "human");
    expect((service as any).sessions.get("alice\0thread-a").page).toBe(page);
    expect(await page.locator("#keep").inputValue()).toBe("draft survives");
    expect(await page.evaluate(() => scrollY)).toBe(260);
    expect(service.get("alice", "thread-a")!.title).toBe("First tab");
    await service.control("alice", "thread-a", "agent");
    const snapshot = await service.action("alice", "thread-a", { action: "snapshot" }, "agent");
    expect(JSON.parse(snapshot.text).tabs).toHaveLength(2);
    expect(JSON.parse(snapshot.text).activeTabId).toBe(firstId);
    await service.control("alice", "thread-a", "human");
    await service.action("alice", "thread-a", { action: "close_tab", tabId: secondId }, "human");
    expect(service.get("alice", "thread-a")!.activeTabId).toBe(firstId);
    expect(service.get("alice", "thread-a")!.tabs).toHaveLength(1);
  });
  it("allows one clicked popup without replacing the original and blocks background popup spam", async () => {
    await page.setContent('<title>Opener</title><button id="open" onclick="window.open(\'about:blank\',\'_blank\')">Open new</button>');
    const firstId = service.get("alice", "thread-a")!.activeTabId;
    await service.action("alice", "thread-a", { action: "click", selector: "#open" }, "human");
    const state = service.get("alice", "thread-a")!;
    expect(state.tabs).toHaveLength(2);
    expect(state.activeTabId).not.toBe(firstId);
    await service.action("alice", "thread-a", { action: "close_tab" }, "human");
    expect(service.get("alice", "thread-a")!.activeTabId).toBe(firstId);
    const unsolicited = await (service as any).sessions.get("alice\0thread-a").context.newPage().catch(() => null);
    if (unsolicited && !unsolicited.isClosed()) await unsolicited.waitForEvent("close", { timeout: 2000 });
    expect(service.get("alice", "thread-a")!.tabs).toHaveLength(1);
  });
  it("caps tabs and validates destinations before allocating a new page", async () => {
    const original = service.get("alice", "thread-a")!.activeTabId;
    await expect(service.action("alice", "thread-a", { action: "new_tab", url: "http://127.0.0.1" }, "human")).rejects.toThrow();
    expect(service.get("alice", "thread-a")!.tabs).toHaveLength(1);
    for (let i = 0; i < 5; i++) await service.action("alice", "thread-a", { action: "new_tab" }, "human");
    await expect(service.action("alice", "thread-a", { action: "new_tab" }, "human")).rejects.toThrow(/上限|最多/);
    for (const tab of service.get("alice", "thread-a")!.tabs) if (tab.id !== original) await service.action("alice", "thread-a", { action: "close_tab", tabId: tab.id }, "human");
    expect(service.get("alice", "thread-a")!.tabs).toHaveLength(1);
  }, 30_000);
  it("does not resurrect a user-stopped browser from model calls", async () => {
    await service.close("alice", "thread-a");
    expect(service.frame("alice", "thread-a")).toBeNull();
    await expect(service.action("alice", "thread-a", { action: "snapshot" }, "agent")).rejects.toThrow(/已停止/);
  });
});
