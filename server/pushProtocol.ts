import { z } from "zod";
import { parseQuestionTool, readLiveQuestionNotification } from "../src/questionTool.js";

export function validatePushEndpoint(endpoint: string): void {
  const url = new URL(endpoint);
  const hosts = new Set(["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"]);
  const microsoft = /^[a-z0-9-]+\.notify\.windows\.com$/.test(url.hostname);
  if (url.protocol !== "https:" || (!hosts.has(url.hostname) && !microsoft) || url.username || url.password || url.port) {
    throw new Error("Unsupported browser push endpoint.");
  }
}

export const pushSubscriptionSchema = z.object({
  endpoint: z.string().url().max(2048),
  expirationTime: z.number().finite().nonnegative().nullable().optional(),
  includePreview: z.boolean().optional(),
  keys: z.object({ p256dh: z.string().min(32).max(256), auth: z.string().min(8).max(128) }).strict()
}).strict().transform(({ endpoint, keys, includePreview }) => ({ endpoint, keys, ...(includePreview === undefined ? {} : { includePreview }) }));

export function pushPreviewText(value: string, limit = 140): string {
  const text = value.slice(0, 4000).replace(/```[\s\S]*?(?:```|$)/g, "[代码]")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "[图片]").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "[链接]").replace(/[#*_`>]/g, "").replace(/[\s\u0000-\u001f]+/g, " ").trim();
  const characters = Array.from(text);
  return characters.length > limit ? characters.slice(0, limit).join("") + "…" : text;
}

/** Explicit question metadata only: ordinary assistant prose never triggers push. */
export function questionNotificationIdentity(envelope: unknown): { threadId: string; itemId: string } | null {
  const question = readLiveQuestionNotification(envelope);
  if (!question || !parseQuestionTool(question.tool, question.input)?.length) return null;
  return { threadId: question.threadId, itemId: question.itemId };
}
