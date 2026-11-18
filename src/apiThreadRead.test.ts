import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

let api: typeof import("./api");
beforeAll(async () => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
  api = await import("./api");
});
afterEach(() => vi.unstubAllGlobals());

describe.each(["thread", "subagent"] as const)("%s history response", kind => {
  const read = () => kind === "thread"
    ? api.readThread("thread/1", "project", { cursor: "cursor", fresh: true, limit: 12 })
    : api.readSubagentThread("project", "parent", "thread/1", { beforeCursor: "cursor", limit: 12 });
  const reply = (body: unknown) => vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)));

  it("accepts empty and populated histories and preserves pagination metadata", async () => {
    for (const turns of [[], [{ id: "turn-1", items: [] }]]) {
      const body = { thread: { id: "thread/1", turns }, history: { totalItems: 4, nextBefore: 2, hasOlder: true, nextCursor: "older" } };
      reply(body);
      expect(await read()).toEqual(body);
      expect(fetch).toHaveBeenCalledWith(expect.stringContaining("thread%2F1?"), expect.objectContaining({ cache: "no-store" }));
    }
  });

  it.each([
    null,
    {},
    { history: { totalItems: 1 } },
    { data: { thread: { id: "thread/1", turns: [] } } },
    { thread: null },
    { thread: {} },
    { thread: { id: "", turns: [] } },
    { thread: { id: "thread/1" } },
    { thread: { id: "thread/1", turns: null } }
  ])("rejects incomplete successful responses before consumers read thread.id: %j", async body => {
    reply(body);
    await expect(read()).rejects.toThrow("会话内容响应不完整");
  });

  it("rejects a different thread instead of displaying or caching it", async () => {
    reply({ thread: { id: "another-thread", turns: [] } });
    await expect(read()).rejects.toThrow("返回的会话与请求的会话不一致");
  });

  it.each(["", '{"thread":', "<html>Login or proxy response</html>"])("reports invalid JSON without turning it into an empty object: %j", async body => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 200 })));
    await expect(read()).rejects.toThrow("服务器响应无法解析（HTTP 200，/api/");
  });

  it("preserves server errors and allows a later read to recover", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "Thread is not visible for this logged-in user." }, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ thread: { id: "thread/1", turns: [] } })));
    await expect(read()).rejects.toThrow("Thread is not visible for this logged-in user.");
    expect((await read()).thread.id).toBe("thread/1");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([new Response("Upstream unavailable", { status: 502 }), Response.json(null, { status: 503 })])("keeps non-JSON or null HTTP failures actionable", async response => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response.clone()));
    await expect(read()).rejects.toThrow(`Request failed: ${response.status}`);
  });
});

it("forwards subagent cancellation without converting it into an empty history", async () => {
  const controller = new AbortController();
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("Aborted", "AbortError")));
  controller.abort();
  await expect(api.readSubagentThread("project", "parent", "child", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ signal: controller.signal }));
});
