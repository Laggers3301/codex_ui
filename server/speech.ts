import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { authenticatedUserFromHeaders } from "./auth.js";
import { serverConfig } from "./config.js";

const maxBytes = 8 * 1024 * 1024;
type Transcription = { text: string; elapsedMs: number; durationSeconds: number; model: string; timings?: { receiveMs: number; decodeMs: number; inferenceMs: number } };
export function registerSpeechRoutes(app: FastifyInstance, options: {
  transcribe?: (bytes: Buffer, signal: AbortSignal) => Promise<Transcription>;
  ready?: () => Promise<boolean>;
} = {}) {
  const inFlight = new Set<string>();
  // Recordings are transient memory only, owner-scoped and globally bounded.
  const uploads = new Map<string, { user: string; mime: string; expires: number; bytes: number; activeTransfers: number; parts: Map<number, Buffer> }>();
  let bufferedBytes = 0;
  let activeTransfers = 0;
  const dropUpload = (id: string) => {
    const item = uploads.get(id);
    if (item) bufferedBytes -= item.bytes;
    uploads.delete(id);
  };
  const sweep = () => { for (const [id, item] of uploads) if (item.expires <= Date.now()) dropUpload(id); };
  const cleanup = setInterval(sweep, 15000); cleanup.unref();
  app.addHook("onClose", async () => { clearInterval(cleanup); uploads.clear(); bufferedBytes = 0; });
  const audioMime = (value: string) => /^(audio\/(webm|mp4|mpeg|wav|x-wav|ogg)|video\/webm)(?:;|$)/i.test(value);
  const token = () => fs.readFileSync(path.join(serverConfig.dataDir, "stt-private", "worker-token"), "utf8").trim();
  const workerRequest = async (route: string, bytes?: Buffer, signal = AbortSignal.timeout(3000)): Promise<{ ok: boolean; status: number; data: Transcription & { error?: string } }> => {
    const directory = path.join(serverConfig.dataDir, "stt-private");
    const endpoint = fs.readFileSync(path.join(directory, "endpoint"), "utf8").trim();
    const url = new URL(route, endpoint);
    if (url.protocol !== "https:") throw new Error("语音接口必须启用 TLS");
    return new Promise((resolve, reject) => {
      const req = https.request(url, { method: bytes ? "POST" : "GET", signal,
        ca: fs.readFileSync(path.join(directory, "server.crt")),
        headers: { "x-speech-token": token(), ...(bytes ? { "content-type": "application/octet-stream", "content-length": bytes.length } : {}) },
      }, response => {
        const chunks: Buffer[] = []; let size = 0;
        response.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 128 * 1024) req.destroy(new Error("识别结果过大")); else chunks.push(chunk); });
        response.on("error", reject);
        response.on("end", () => { try { resolve({ ok: response.statusCode === 200, status: response.statusCode ?? 503, data: JSON.parse(Buffer.concat(chunks).toString()) }); } catch (error) { reject(error); } });
      });
      req.on("error", reject); req.end(bytes);
    });
  };
  const transcribe = options.transcribe ?? (async (bytes, signal) => {
    const response = await workerRequest("/transcribe", bytes, signal);
    const data = response.data;
    if (!response.ok) throw Object.assign(new Error(data.error ?? "语音转换失败"), { statusCode: response.status });
    return data;
  });
  const ready = options.ready ?? (async () => {
    try { return (await workerRequest("/health")).ok; }
    catch { return false; }
  });
  const recognize = async (bytes: Buffer, mime: string, recorderFinalizeMs: unknown, uploadMs: number) => {
    const started = performance.now();
    const result = await transcribe(bytes, AbortSignal.timeout(180000));
    const workerMs = Math.round(performance.now() - started);
    const finalize = Number(recorderFinalizeMs);
    const timingId = randomUUID();
    app.log.info({ event: "speech_timing", timingId, audioBytes: bytes.length, audioMime: mime,
      durationSeconds: result.durationSeconds, uploadMs: Math.round(uploadMs), workerMs,
      recorderFinalizeMs: Number.isFinite(finalize) && finalize >= 0 && finalize <= 120000 ? Math.round(finalize) : undefined,
      timings: result.timings }, "Speech timing (no audio or transcript retained)");
    return { ...result, timingId, serverTimings: { uploadMs: Math.round(uploadMs), workerMs, totalMs: Math.round(uploadMs + workerMs) } };
  };
  const failure = (reply: import("fastify").FastifyReply, error: unknown) => {
    const status = Number((error as { statusCode?: number }).statusCode);
    return reply.code([413, 422, 429].includes(status) ? status : 503).send({
      error: [413, 422, 429].includes(status) ? (error as Error).message : "语音服务暂不可用或识别超时，请稍后重试（原输入不会清空）",
    });
  };
  app.post("/api/speech/uploads", async (request, reply) => {
    const user = authenticatedUserFromHeaders(request.headers);
    if (!user) return reply.code(401).send({ error: "请先登录" });
    const mime = (request.body as { mime?: unknown } | null)?.mime;
    if (typeof mime !== "string" || !audioMime(mime)) return reply.code(415).send({ error: "录音格式不支持" });
    sweep();
    if (inFlight.has(user) || uploads.size >= 64 || [...uploads.values()].some(item => item.user === user)) return reply.code(429).send({ error: "上一段录音尚未完成" });
    const id = randomUUID();
    uploads.set(id, { user, mime, expires: Date.now() + 720000, bytes: 0, activeTransfers: 0, parts: new Map() });
    return { id, combinedTail: true };
  });
  app.post<{ Params: { id: string; index: string } }>("/api/speech/uploads/:id/:index", async (request, reply) => {
    const user = authenticatedUserFromHeaders(request.headers);
    if (!user) return reply.code(401).send({ error: "请先登录" });
    const item = uploads.get(request.params.id);
    if (!item || item.user !== user || item.expires <= Date.now()) return reply.code(404).send({ error: "录音已取消或过期" });
    const index = Number(request.params.index);
    if (!/^\d+$/.test(request.params.index) || !Number.isInteger(index) || index < 0 || index > 511) return reply.code(400).send({ error: "录音分片无效" });
    if (activeTransfers >= 8 || item.activeTransfers >= 2) return reply.code(429).send({ error: "语音上传繁忙，请稍后重试" });
    activeTransfers++; item.activeTransfers++;
    try {
    const file = await request.file({ limits: { files: 1, fields: 0, parts: 1, fileSize: maxBytes } });
    if (!file || !audioMime(file.mimetype)) return reply.code(415).send({ error: "录音格式不支持" });
    const bytes = await file.toBuffer();
    // A cancelled/replaced session must not be resurrected by late upload callbacks.
    if (uploads.get(request.params.id) !== item || item.expires <= Date.now()) return reply.code(404).send({ error: "录音已取消或过期" });
    if (item.parts.has(index)) return reply.code(409).send({ error: "录音分片重复" });
    if (!bytes.length || file.file.truncated || item.bytes + bytes.length > maxBytes || bufferedBytes + bytes.length > 64 * 1024 * 1024) {
      dropUpload(request.params.id); return reply.code(413).send({ error: "录音过大或语音服务忙，请重试" });
    }
    item.parts.set(index, bytes); item.bytes += bytes.length; bufferedBytes += bytes.length;
    return { received: bytes.length };
    } finally { activeTransfers--; item.activeTransfers--; }
  });
  app.delete<{ Params: { id: string } }>("/api/speech/uploads/:id", async (request, reply) => {
    const user = authenticatedUserFromHeaders(request.headers);
    if (!user) return reply.code(401).send({ error: "请先登录" });
    const item = uploads.get(request.params.id);
    if (item && item.user !== user) return reply.code(404).send({ error: "录音不存在" });
    dropUpload(request.params.id); return { cancelled: true };
  });
  app.post<{ Params: { id: string } }>("/api/speech/uploads/:id/complete", async (request, reply) => {
    const user = authenticatedUserFromHeaders(request.headers);
    if (!user) return reply.code(401).send({ error: "请先登录" });
    const item = uploads.get(request.params.id);
    if (!item || item.user !== user || item.expires <= Date.now()) return reply.code(404).send({ error: "录音已取消或过期" });
    const uploadStarted = performance.now();
    let count: unknown = (request.body as { parts?: unknown } | null)?.parts;
    let tail: Buffer | undefined;
    if (request.isMultipart()) {
      if (activeTransfers >= 8 || item.activeTransfers >= 2) return reply.code(429).send({ error: "语音上传繁忙，请稍后重试" });
      activeTransfers++; item.activeTransfers++;
      try {
        for await (const part of request.parts({ limits: { files: 1, fields: 1, parts: 2, fileSize: maxBytes } })) {
          if (part.type === "file") {
            if (part.fieldname !== "audio" || !audioMime(part.mimetype)) return reply.code(415).send({ error: "录音格式不支持" });
            tail = await part.toBuffer();
            if (part.file.truncated) return reply.code(413).send({ error: "录音过大" });
          } else if (part.fieldname === "parts" && typeof part.value === "string" && /^\d+$/.test(part.value)) count = Number(part.value);
        }
      } finally { activeTransfers--; item.activeTransfers--; }
      if (!tail?.length) return reply.code(400).send({ error: "录音尾片为空" });
      // Cancel and concurrent completion must never resurrect consumed audio.
      if (uploads.get(request.params.id) !== item || item.expires <= Date.now()) return reply.code(404).send({ error: "录音已取消或过期" });
      if (item.bytes + tail.length > maxBytes) { dropUpload(request.params.id); return reply.code(413).send({ error: "录音过大" }); }
    }
    if (typeof count !== "number" || !Number.isInteger(count) || count < (tail ? 0 : 1) || count > 512 || item.parts.size !== count || Array.from({ length: count }, (_, i) => !item.parts.has(i)).some(Boolean)) return reply.code(409).send({ error: "录音上传尚未完成" });
    if (inFlight.has(user)) return reply.code(429).send({ error: "上一段语音仍在转换" });
    const bytes = Buffer.concat([...Array.from({ length: count }, (_, i) => item.parts.get(i)!), ...(tail ? [tail] : [])]);
    dropUpload(request.params.id); inFlight.add(user);
    try { return await recognize(bytes, item.mime, request.headers["x-speech-finalize-ms"], tail ? performance.now() - uploadStarted : 0); }
    catch (error) { return failure(reply, error); }
    finally { inFlight.delete(user); }
  });
  app.post("/api/speech/timing", async (request, reply) => {
    if (!authenticatedUserFromHeaders(request.headers)) return reply.code(401).send({ error: "请先登录" });
    const body = request.body as Record<string, unknown> | null;
    if (!body || typeof body.timingId !== "string" || !/^[a-f0-9-]{36}$/i.test(body.timingId)) return reply.code(400).send({ error: "计时无效" });
    const timings: Record<string, number> = {};
    for (const key of ["finalizeMs", "pendingUploadMs", "requestMs", "renderMs", "totalMs", "serverMs", "preuploadedBytes", "audioBytes"]) {
      const value = body[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= (key.endsWith("Bytes") ? maxBytes : 180000)) timings[key] = Math.round(value);
    }
    request.log.info({ event: "speech_client_timing", timingId: body.timingId, ...timings }, "Speech browser timing (no content)");
    return { received: true };
  });
  app.get("/api/speech/status", async (request, reply) => {
    if (!authenticatedUserFromHeaders(request.headers)) return reply.code(401).send({ error: "请先登录" });
    return { ready: await ready(), maxSeconds: 600, model: "Qwen3-ASR-1.7B" };
  });
  app.post("/api/speech/transcribe", async (request, reply) => {
    const user = authenticatedUserFromHeaders(request.headers);
    if (!user) return reply.code(401).send({ error: "请先登录" });
    if (inFlight.has(user)) return reply.code(429).send({ error: "上一段语音仍在转换，请稍候" });
    inFlight.add(user);
    const started = performance.now();
    try {
      const file = await request.file({ limits: { files: 1, fields: 0, parts: 1, fileSize: maxBytes } });
      if (!file || !audioMime(file.mimetype)) {
        return reply.code(415).send({ error: "请上传浏览器录制的音频" });
      }
      const bytes = await file.toBuffer();
      const uploaded = performance.now();
      if (file.file.truncated || bytes.length > maxBytes) return reply.code(413).send({ error: "录音过大，请缩短到 10 分钟内" });
      if (!bytes.length) return reply.code(422).send({ error: "录音为空，请重新录音" });
      return await recognize(bytes, file.mimetype, request.headers["x-speech-finalize-ms"], uploaded - started);
    } catch (error) {
      return failure(reply, error);
    } finally { inFlight.delete(user); }
  });
}
