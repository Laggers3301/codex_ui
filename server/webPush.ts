import fs from "node:fs";
import path from "node:path";
import webpush from "web-push";
import { serverConfig } from "./config.js";
import type { ProjectStore } from "./db.js";

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
  webpush.setVapidDetails(process.env.CODEX_WEB_VAPID_SUBJECT || "https://localhost", stored.publicKey, stored.privateKey);
  initializedKeys = stored;
  return stored;
}

export function pushPublicKey(): string {
  return keys().publicKey;
}

export async function sendUserPush(
  store: ProjectStore,
  userId: string,
  payload: { type: "completed" | "approval"; threadId: string; projectId?: string; title: string; body: string }
): Promise<void> {
  const subscriptions = store.listPushSubscriptions(userId);
  if (!subscriptions.length) return;
  keys();
  await Promise.all(subscriptions.map(async (subscription) => {
    try {
      await webpush.sendNotification(subscription, JSON.stringify(payload), { TTL: 3600, urgency: payload.type === "approval" ? "high" : "normal" });
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      if (statusCode === 404 || statusCode === 410) store.removePushSubscription(userId, subscription.endpoint);
      else console.warn("Web Push delivery failed", { userId, statusCode, error: error instanceof Error ? error.message : String(error) });
    }
  }));
}
