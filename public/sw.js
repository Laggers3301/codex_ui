self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let message;
    try { message = event.data?.json(); } catch { return; }
    if (!message || typeof message.threadId !== "string") return;
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (windows.some((client) => client.visibilityState === "visible")) return;
    const url = new URL("/", self.location.origin);
    url.searchParams.set("thread", message.threadId);
    if (message.projectId) url.searchParams.set("project", message.projectId);
    await self.registration.showNotification(message.title || "Codex 有新进展", {
      body: message.body || "点开查看会话",
      tag: `codex-${message.type}-${message.threadId}`,
      icon: "/chatgpt-favicon.svg",
      data: { url: url.href, threadId: message.threadId, projectId: message.projectId }
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const data = event.notification.data || {};
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const client = windows.find((item) => new URL(item.url).origin === self.location.origin);
    if (client) {
      client.postMessage({ type: "codex.openThread", threadId: data.threadId, projectId: data.projectId });
      await client.focus();
    } else if (data.url) {
      await self.clients.openWindow(data.url);
    }
  })());
});
