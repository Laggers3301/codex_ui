import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ProjectStore } from "./db.js";
import { consoleMcpScope } from "./browserRoutes.js";
import { ScheduledTaskStore, type ScheduleRule } from "./scheduledTasks.js";

const rule = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("once"), at: z.string().datetime({ offset: true }), timezone: z.string().min(1).max(128) }).strict(),
  z.object({ kind: z.literal("interval"), intervalMinutes: z.number().int().min(5).max(525600), timezone: z.string().min(1).max(128) }).strict(),
  z.object({ kind: z.enum(["daily", "weekdays"]), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), timezone: z.string().min(1).max(128) }).strict(),
  z.object({ kind: z.literal("weekly"), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7), timezone: z.string().min(1).max(128) }).strict()
]);
const argsSchema = z.object({
  action: z.enum(["list", "get", "create", "update", "pause", "resume", "delete"]),
  taskId: z.string().uuid().optional(), threadId: z.string().min(1).max(200).optional(),
  scope: z.enum(["current", "user"]).optional(), title: z.string().trim().min(1).max(160).optional(),
  prompt: z.string().trim().min(1).max(20000).optional(), schedule: rule.optional(), enabled: z.boolean().optional(),
  confirm: z.boolean().optional()
}).strict();

export const scheduledTaskTool = {
  name: "scheduled_tasks",
  description: "管理当前登录用户的 Codex Web 定时任务。可查看、新建、更新、暂停、继续及删除；默认绑定当前会话。list scope=user 可查找同一用户其他会话的任务，再用准确 taskId 管理。时间必须含明确 IANA 时区，单次时间应含 UTC 偏移。只在用户明确要求后修改；重名或时间有歧义先澄清。暂停不会撤回已经排队的运行。仅在工具返回成功后声称已保存。",
  inputSchema: {
    type: "object", additionalProperties: false, required: ["action"],
    properties: {
      action: { type: "string", enum: ["list", "get", "create", "update", "pause", "resume", "delete"] },
      taskId: { type: "string", description: "从 list/get 得到的准确任务 ID。" },
      threadId: { type: "string", description: "显式指定本人其他会话；新建默认使用当前会话。" },
      scope: { type: "string", enum: ["current", "user"], description: "list 默认 current；user 查询本人的全部会话任务。" },
      title: { type: "string" }, prompt: { type: "string", description: "每次唤醒会话时真正提交给模型的任务指令，不是时间说明。" },
      schedule: { type: "object", additionalProperties: false, required: ["kind", "timezone"], properties: {
        kind: { type: "string", enum: ["once", "interval", "daily", "weekdays", "weekly"] },
        timezone: { type: "string", description: "IANA 时区，例如 Asia/Shanghai。" },
        at: { type: "string", description: "once: ISO 8601 日期时间，含 Z 或 UTC 偏移。" },
        intervalMinutes: { type: "integer", minimum: 5, maximum: 525600 },
        time: { type: "string", description: "daily/weekdays/weekly: HH:mm 当地时间。" },
        weekdays: { type: "array", items: { type: "integer", minimum: 0, maximum: 6 }, description: "weekly: 0 周日、1 周一、…、6 周六。" }
      } },
      enabled: { type: "boolean" }, confirm: { type: "boolean", description: "用户明确要求删除后设置 true。" }
    }
  }
} as const;

export function manageScheduledTask(
  tasks: ScheduledTaskStore, store: ProjectStore,
  scope: { userId: string; projectId: string; threadId: string | null }, input: unknown
) {
  const args = argsSchema.parse(input);
  if (!scope.threadId) throw new Error("当前工具尚未绑定到会话，请在会话创建后重试。");
  const visible = tasks.listForUser(scope.userId).filter(t => store.getProject(t.projectId, scope.userId) && store.userCanAccessThread(t.threadId, scope.userId, t.projectId));
  if (args.action === "list") return { data: visible.filter(t => args.scope === "user" || t.threadId === (args.threadId ?? scope.threadId)).map(t => ({ ...t, projectName: store.getProject(t.projectId, scope.userId)?.name })), now: new Date().toISOString(), defaultTimezone: "Asia/Shanghai", currentThreadId: scope.threadId };
  if (args.action === "create") {
    if (!args.prompt || !args.schedule) throw new Error("创建任务需要 prompt 和 schedule。");
    const threadId = args.threadId ?? scope.threadId;
    const owner = store.getThreadOwner(threadId);
    if (!owner || owner.userId !== scope.userId || !store.userCanAccessThread(threadId, scope.userId, owner.projectId) || !store.getProject(owner.projectId, scope.userId)) throw new Error("目标会话不存在或不属于当前用户。");
    return { data: tasks.create({ userId: scope.userId, projectId: owner.projectId, threadId, title: args.title ?? args.prompt.slice(0, 80), prompt: args.prompt, schedule: args.schedule as ScheduleRule, enabled: args.enabled ?? true }) };
  }
  const task = visible.find(t => t.id === args.taskId);
  if (!task) throw new Error("任务不存在或不属于当前用户；请先 list 查找准确 taskId。");
  if (args.threadId && args.threadId !== task.threadId) throw new Error("任务与指定会话不匹配。");
  if (args.action === "get") return { data: task };
  const warning = task.pendingRun || task.history.at(-1)?.status === "queued" ? "该任务已有运行被提交；暂停、更新或删除不会撤回已排队的消息。" : undefined;
  if (args.action === "delete") {
    if (!args.confirm) throw new Error("删除需要用户明确要求，并设置 confirm=true。");
    return { ok: tasks.delete(task.id, scope.userId), ...(warning ? { warning } : {}) };
  }
  const patch = args.action === "pause" ? { enabled: false }
    : args.action === "resume" ? { enabled: true, ...(args.schedule ? { schedule: args.schedule as ScheduleRule } : {}) }
    : Object.fromEntries(Object.entries(args).filter(([key, value]) => ["title", "prompt", "schedule", "enabled"].includes(key) && value !== undefined));
  if (!Object.keys(patch).length) throw new Error("更新任务至少需要一个修改字段。");
  return { data: tasks.update(task.id, scope.userId, patch), ...(warning ? { warning } : {}) };
}

export function registerScheduledTaskMcp(app: FastifyInstance, store: ProjectStore, tasks: ScheduledTaskStore) {
  app.post("/api/schedules/mcp", async (req, reply) => {
    const scope = consoleMcpScope(req.headers);
    if (!scope) return reply.code(401).send({ error: "Unauthorized." });
    const rpc = req.body as any;
    const id = rpc?.id ?? null;
    const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
    if (!rpc || rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") return fail(-32600, "Invalid JSON-RPC request.");
    if (rpc.method === "notifications/initialized") return reply.code(202).send();
    if (rpc.method === "initialize") return { jsonrpc: "2.0", id, result: { protocolVersion: ["2025-03-26", "2024-11-05"].includes(rpc.params?.protocolVersion) ? rpc.params.protocolVersion : "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "codex-schedules", version: "1.0.0" } } };
    if (rpc.method === "ping") return { jsonrpc: "2.0", id, result: {} };
    if (rpc.method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: [scheduledTaskTool] } };
    if (rpc.method !== "tools/call") return fail(-32601, "Method not found.");
    if (rpc.params?.name !== scheduledTaskTool.name) return fail(-32602, "Unknown tool.");
    try {
      const result = manageScheduledTask(tasks, store, scope, rpc.params.arguments ?? {});
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: false } };
    } catch (error) {
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: error instanceof z.ZodError ? "参数格式错误，请按照工具 schema 填写。" : error instanceof Error ? error.message : "任务操作失败。" }], isError: true } };
    }
  });
}
