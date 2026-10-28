import fs from "node:fs";
import path from "node:path";
import webpush from "web-push";
import { serverConfig } from "./config.js";
import type { ProjectStore } from "./db.js";
import { pushPreviewText } from "./pushProtocol.js";

const keyPath = path.join(serverConfig.dataDir, "web-push-vapid.json");
let initializedKeys: { publicKey: string; privateKey: string } | null = null;

function keys(): { publicKey: string; privateKey: string } {
  if (initializedKeys) return initializedKeys;
  fs.mkdirSync(serverConfig.dataDir, { recursive: true });
  try {
    const created = webpush.generateVAPIDKeys();
    fs.writeFileSync(keyPath, JSON.stringify(created), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stored = JSON.parse(fs.readFileSync(keyPath, "utf8")) as { publicKey: string; privateKey: string };
  if (!stored.publicKey || !stored.privateKey) throw new Error("Invalid Web Push VAPID keys.");
  // Apple Push rejects localhost subjects, even when the signature is valid.
  webpush.setVapidDetails(process.env.CODEX_WEB_VAPID_SUBJECT || "https://codex.example.com", stored.publicKey, stored.privateKey);
  initializedKeys = stored;
  return stored;
}

export function pushPublicKey(): string {
  return keys().publicKey;
}

export async function sendUserPush(
  store: ProjectStore,
  userId: string,
  payload: { type: "completed" | "approval" | "question" | "test"; threadId: string; projectId?: string; title: string; body: string; preview?: string }
): Promise<{ subscriptions: number; accepted: number; failed: number }> {
  const subscriptions = store.listPushSubscriptions(userId);
  if (!subscriptions.length) return { subscriptions: 0, accepted: 0, failed: 0 };
  keys();
  const results = await Promise.all(subscriptions.map(async (subscription) => {
    try {
      const { preview, ...message } = payload;
      if (subscription.includePreview !== false) {
        const name = pushPreviewText(store.getThreadOwner(payload.threadId)?.displayName || "Codex 对话", 48);
        message.title = `${name} · ${payload.type === "question" ? "等待回答" : payload.type === "completed" ? "回答完成" : payload.type === "approval" ? "等待批准" : "通知测试"}`;
        message.body = pushPreviewText(preview || payload.body);
      }
      await webpush.sendNotification(subscription, JSON.stringify(message), { TTL: 3600, timeout: 10_000, urgency: payload.type === "completed" ? "normal" : "high" });
      return true;
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      if (statusCode === 404 || statusCode === 410) store.removePushSubscription(userId, subscription.endpoint);
      else console.warn("Web Push delivery failed", { userId, statusCode, error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }));
  return { subscriptions: subscriptions.length, accepted: results.filter(Boolean).length, failed: results.filter(value => !value).length };
}
