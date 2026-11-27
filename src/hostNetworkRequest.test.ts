import { request as httpRequest } from "node:http";
import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { registerHostResourceRoutes } from "../server/hostResources";
import { HostNetworkProbe } from "../server/hostNetwork";

vi.mock("../server/auth.js", () => ({
  authenticatedUserFromHeaders: (headers: { cookie?: string }) => headers.cookie === "fixture-session" ? "fixture" : null
}));

it("runs the browser HTTPS check when a proxy forwards the POST using chunked encoding", async () => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  const { checkHostNetwork } = await import("./api");
  const probe = vi.fn(async () => ({ status: "reachable" as const, message: "fixture HTTPS connected", httpStatus: 200, proxyStatus: 200 }));
  const app = Fastify();
  registerHostResourceRoutes(app, undefined, new HostNetworkProbe(probe));
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    // Exercise the real API helper and Fastify parser over HTTP. A proxy may
    // forward an HTTP/2 POST as chunked HTTP/1.1, including an empty POST.
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
      const headers = Object.fromEntries(new Headers(init.headers));
      const request = httpRequest(new URL(url, origin), {
        method: init.method, signal: init.signal ?? undefined, agent: false,
        headers: { ...headers, cookie: "fixture-session", "transfer-encoding": "chunked" }
      }, response => {
        const chunks: Buffer[] = [];
        response.on("data", chunk => chunks.push(Buffer.from(chunk)));
        response.on("error", reject);
        response.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode })));
      });
      request.on("error", reject);
      request.end(typeof init.body === "string" ? init.body : undefined);
    }));
    const result = await checkHostNetwork(new AbortController().signal);
    expect(result.data).toMatchObject({ target: "www.google.com", protocol: "HTTPS", viaProxy: true, status: "reachable", httpStatus: 200 });
    expect(probe).toHaveBeenCalledTimes(1);
  } finally {
    vi.unstubAllGlobals();
    await app.close();
  }
});
