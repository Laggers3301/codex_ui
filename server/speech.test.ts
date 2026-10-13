import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { describe, expect, it, vi } from "vitest";
import { createSessionCookie } from "./auth.js";
import { registerSpeechRoutes } from "./speech.js";

describe("authenticated dictation", () => {
  it("rejects unauthenticated access and exposes the real model", async () => {
    const app = Fastify(); await app.register(multipart);
    registerSpeechRoutes(app, { ready: async () => true });
    try {
      expect((await app.inject({ url: "/api/speech/status" })).statusCode).toBe(401);
      expect((await app.inject({ url: "/api/speech/status", headers: { cookie: createSessionCookie("qa-user").split(";")[0] } })).json()).toMatchObject({ ready: true, model: "Qwen3-ASR-1.7B" });
    } finally { await app.close(); }
  });
  it("transcribes only audio, preserves Chinese/English, and safely reports upstream failure", async () => {
    const app = Fastify(); await app.register(multipart);
    const transcribe = vi.fn().mockResolvedValue({ text: "你好 Codex", elapsedMs: 120, durationSeconds: 2, model: "Qwen3-ASR-1.7B" });
    registerSpeechRoutes(app, { transcribe });
    const send = (mime: string) => app.inject({ method: "POST", url: "/api/speech/transcribe", headers: { cookie: createSessionCookie("qa-user").split(";")[0], "content-type": "multipart/form-data; boundary=speech" }, payload: `--speech\r\nContent-Disposition: form-data; name="audio"; filename="recording"\r\nContent-Type: ${mime}\r\n\r\naudio bytes\r\n--speech--\r\n` });
    try {
      expect((await send("text/plain")).statusCode).toBe(415);
      expect(transcribe).not.toHaveBeenCalled();
      expect((await send("audio/mp4")).json().text).toBe("你好 Codex");
      transcribe.mockRejectedValueOnce(Object.assign(new Error("没有识别到文字"), { statusCode: 422 }));
      expect((await send("audio/webm")).statusCode).toBe(422);
      transcribe.mockRejectedValueOnce(new Error("private network detail"));
      const response = await send("audio/webm");
      expect(response.statusCode).toBe(503); expect(response.body).not.toContain("private network");
    } finally { await app.close(); }
  });
  it("preuploads ordered fragments, isolates owners, removes cancelled audio and completes once", async () => {
    const app = Fastify(); await app.register(multipart);
    const transcribe = vi.fn().mockResolvedValue({ text: "你好 Codex", elapsedMs: 50, durationSeconds: 8, model: "Qwen3-ASR-1.7B" });
    registerSpeechRoutes(app, { transcribe });
    const headers = { cookie: createSessionCookie("qa-user").split(";")[0] };
    const other = { cookie: createSessionCookie("sample-user").split(";")[0] };
    const create = () => app.inject({ method: "POST", url: "/api/speech/uploads", headers, payload: { mime: "audio/mp4" } });
    const part = (id: string, index: number, text: string, owner = headers) => app.inject({ method: "POST", url: `/api/speech/uploads/${id}/${index}`, headers: { ...owner, "content-type": "multipart/form-data; boundary=speech" }, payload: `--speech\r\nContent-Disposition: form-data; name="audio"; filename="fragment"\r\nContent-Type: audio/mp4\r\n\r\n${text}\r\n--speech--\r\n` });
    try {
      expect((await app.inject({ method: "POST", url: "/api/speech/uploads", payload: { mime: "audio/mp4" } })).statusCode).toBe(401);
      const { id } = (await create()).json();
      expect((await create()).statusCode).toBe(429);
      expect((await part(id, 0, "steal", other)).statusCode).toBe(404);
      expect((await app.inject({ method: "DELETE", url: `/api/speech/uploads/${id}`, headers: other })).statusCode).toBe(404);
      expect((await part(id, 1, "second")).statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: `/api/speech/uploads/${id}/complete`, headers, payload: { parts: 2 } })).statusCode).toBe(409);
      expect((await part(id, 0, "first")).statusCode).toBe(200);
      expect((await part(id, 0, "first")).statusCode).toBe(409);
      const result = await app.inject({ method: "POST", url: `/api/speech/uploads/${id}/complete`, headers, payload: { parts: 2 } });
      expect(result.json()).toMatchObject({ text: "你好 Codex", serverTimings: { uploadMs: 0 } });
      expect(transcribe.mock.calls[0][0].toString()).toBe("firstsecond");
      expect((await app.inject({ method: "POST", url: `/api/speech/uploads/${id}/complete`, headers, payload: { parts: 2 } })).statusCode).toBe(404);
      expect(transcribe).toHaveBeenCalledTimes(1);
      const next = (await create()).json().id;
      await app.inject({ method: "DELETE", url: `/api/speech/uploads/${next}`, headers });
      expect((await part(next, 0, "late")).statusCode).toBe(404);
      const tailSession = (await create()).json();
      expect(tailSession.combinedTail).toBe(true);
      const completeTail = (id: string, count: number, owner = headers) => app.inject({ method: "POST", url: `/api/speech/uploads/${id}/complete`, headers: { ...owner, "content-type": "multipart/form-data; boundary=speech" }, payload: `--speech\r\nContent-Disposition: form-data; name="parts"\r\n\r\n${count}\r\n--speech\r\nContent-Disposition: form-data; name="audio"; filename="tail"\r\nContent-Type: audio/mp4\r\n\r\ntail\r\n--speech--\r\n` });
      expect((await completeTail(tailSession.id, 0, other)).statusCode).toBe(404);
      expect((await completeTail(tailSession.id, 1)).statusCode).toBe(409);
      expect((await part(tailSession.id, 0, "prefix")).statusCode).toBe(200);
      expect((await completeTail(tailSession.id, 1)).statusCode).toBe(200);
      expect(transcribe.mock.calls[1][0].toString()).toBe("prefixtail");
      expect((await completeTail(tailSession.id, 1)).statusCode).toBe(404);
      const shortSession = (await create()).json().id;
      expect((await completeTail(shortSession, 0)).statusCode).toBe(200);
      expect(transcribe.mock.calls[2][0].toString()).toBe("tail");
      expect(transcribe).toHaveBeenCalledTimes(3);
      const longSession = (await create()).json().id;
      expect((await part(longSession, 150, "long recording fragment")).statusCode).toBe(200);
      expect((await part(longSession, 512, "out of bounds")).statusCode).toBe(400);
      await app.inject({ method: "DELETE", url: `/api/speech/uploads/${longSession}`, headers });
    } finally { await app.close(); }
  });
});
