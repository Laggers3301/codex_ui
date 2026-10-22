import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { CodexBridge } from "./codexBridge.js";
import type { ProjectStore } from "./db.js";
import { closeSideChat, SideChatError } from "./sideChats.js";

const createSchema = z.object({ selectedText: z.string().trim().min(1).max(6000), modelProfileId: z.string().min(1).max(200) }).strict();
const draftSchema = z.object({ id: z.string().min(1).max(100), draft: z.string().max(100_000), modelProfileId: z.string().min(1).max(200), expectedRequestId: z.string().max(200).nullable() }).strict();
type Params = { id: string; threadId: string };

export function registerSideChatRoutes(app: FastifyInstance, bridge: CodexBridge, store: ProjectStore, userIdFromRequest: (request: FastifyRequest) => string): void {
  const url = "/api/projects/:id/threads/:threadId/side-chat";
  const authorize = (request: FastifyRequest<{ Params: Params }>) => {
    const userId = userIdFromRequest(request);
    if (!store.userCanAccessThread(request.params.threadId, userId, request.params.id)) throw new SideChatError("主会话不可访问。", 403);
    return userId;
  };
  const status = (error: unknown) => error instanceof SideChatError ? error.statusCode : error instanceof z.ZodError ? 400 : 502;
  const message = (error: unknown) => error instanceof Error ? error.message : String(error);
  app.get<{ Params: Params }>(url, async (request, reply) => {
    try {
      const userId = authorize(request);
      reply.header("Cache-Control", "no-store");
      return { data: store.sideChats.get(request.params.threadId, userId, request.params.id) };
    } catch (error) { return reply.code(status(error)).send({ error: message(error) }); }
  });
  app.post<{ Params: Params }>(url, async (request, reply) => {
    try {
      const userId = authorize(request), input = createSchema.parse(request.body);
      return { data: store.sideChats.create(request.params.threadId, userId, request.params.id, input.selectedText, input.modelProfileId) };
    } catch (error) { return reply.code(status(error)).send({ error: message(error) }); }
  });
  app.patch<{ Params: Params }>(url, async (request, reply) => {
    try {
      const userId = authorize(request), input = draftSchema.parse(request.body);
      const side = store.sideChats.get(request.params.threadId, userId, request.params.id);
      if (side?.id !== input.id) throw new SideChatError("侧边会话已关闭或更换。", 409);
      return { data: store.sideChats.saveDraft(side.id, userId, input.draft, input.modelProfileId, input.expectedRequestId) };
    } catch (error) { return reply.code(status(error)).send({ error: message(error) }); }
  });
  app.delete<{ Params: Params; Querystring: { id?: string } }>(url, async (request, reply) => {
    try {
      const userId = authorize(request), side = store.sideChats.get(request.params.threadId, userId, request.params.id);
      if (!request.query.id) throw new SideChatError("缺少侧边会话标识。", 400);
      if (side && side.id !== request.query.id) throw new SideChatError("侧边会话已更换，请刷新后重试。", 409);
      if (side) await closeSideChat(bridge, store, side);
      return { ok: true, data: store.sideChats.get(request.params.threadId, userId, request.params.id) };
    } catch (error) { return reply.code(status(error)).send({ error: message(error) }); }
  });
}
